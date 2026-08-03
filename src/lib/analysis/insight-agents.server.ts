/**
 * Server-only agents for anomaly explanation and natural-language query intent.
 *
 * Kept out of the *.functions.ts wrapper so server-function splitting never
 * strips these helpers from the bundle.
 */

import { z } from "zod";
import { generateObject } from "ai";
import { createGateway, DEFAULT_MODEL } from "@/lib/ai-gateway.server";
import type { Anomaly } from "@/lib/analysis/anomalies";
import type { QueryIntent } from "@/lib/analysis/nl-query";
import type { RoleColumn } from "@/lib/analysis/column-roles";

export const IntentSchema = z.object({
  groupBy: z.string().nullable(),
  metric: z.string().nullable(),
  aggregation: z.enum(["sum", "avg", "count", "min", "max"]),
  filter: z
    .object({
      column: z.string(),
      op: z.enum(["eq", "neq", "gt", "lt", "contains"]),
      value: z.string(),
    })
    .nullable(),
  chartType: z.enum(["bar", "pie", "line", "table"]),
  clarification: z.string().nullable(),
  title: z.string(),
});

const ExplanationSchema = z.object({
  explanations: z.array(z.object({ id: z.string(), text: z.string() })),
});

function schemaBlock(columns: RoleColumn[]): string {
  return columns
    .map((c) => {
      const stats = c.isNumeric
        ? `min=${c.min} max=${c.max} mean=${typeof c.mean === "number" ? c.mean.toFixed(2) : "?"}`
        : c.top?.length
        ? `examples=${c.top.slice(0, 4).map((t) => t.value).join(", ")}`
        : "";
      return `- ${c.name} [role=${c.role ?? "unknown"}] unique=${c.unique} ${stats}`;
    })
    .join("\n");
}

/** Ask the AI for a STRUCTURED INTENT ONLY — never for computed numbers. */
export async function inferQueryIntent(args: {
  question: string;
  datasetName: string;
  columns: RoleColumn[];
  sampleRows: Array<Record<string, unknown>>;
}): Promise<QueryIntent> {
  const gateway = createGateway();
  const prompt = `You translate a business question into a STRUCTURED QUERY INTENT for the dataset "${args.datasetName}".

COLUMNS (name, analytical role, stats):
${schemaBlock(args.columns)}

SAMPLE ROWS (JSON):
${JSON.stringify(args.sampleRows.slice(0, 12)).slice(0, 4000)}

USER QUESTION: "${args.question}"

RULES — follow exactly:
1. NEVER compute or return any number, total or statistic. Return only the intent; the application computes real values from the data.
2. "metric" MUST be a column with role=metric, or null when the user is counting records.
3. NEVER use a role=identifier column as the metric (order IDs, invoice numbers, customer IDs). If the user asks to sum/average one, set clarification explaining it is a record key.
4. "groupBy" MUST be a role=categorical or role=time column, or null for a single overall number.
5. Map business words to the closest real column (e.g. "sales"/"revenue"/"spend" → the revenue or amount metric column). Prefer a derived metric such as "Revenue (calculated)" when present.
6. chartType: "line" when groupBy is the time column, "pie" when the grouping has 6 or fewer categories, "bar" otherwise, "table" when there is no grouping.
7. filter: only when the user clearly restricts the data (e.g. "in 2024", "for the West region"); otherwise null.
8. clarification: set a short, friendly follow-up question ONLY when the request is ambiguous or no column can answer it — and then leave the other fields at their best guess.
9. title: a short human label for the result, e.g. "Total Revenue by Region".

Use exact, case-sensitive column names.`;

  const { object } = await generateObject({
    model: gateway(DEFAULT_MODEL),
    schema: IntentSchema,
    mode: "json",
    prompt,
    temperature: 0.1,
  });
  return object as QueryIntent;
}

/**
 * Add plain-English explanations to detected anomalies, using the row context.
 * Falls back to the deterministic statistical text when the model is unavailable.
 */
export async function explainAnomalies(args: {
  datasetName: string;
  anomalies: Anomaly[];
  columns: RoleColumn[];
}): Promise<Anomaly[]> {
  const subset = args.anomalies.slice(0, 20);
  if (!subset.length) return args.anomalies;
  try {
    const gateway = createGateway();
    const listing = subset
      .map(
        (a) =>
          `id=${a.id} | column=${a.column} | value=${a.value} | expected ${a.expectedMin}..${a.expectedMax} | ${a.deviation}σ ${a.direction} | method=${a.method} | row: ${JSON.stringify(a.context)}`,
      )
      .join("\n");
    const { object } = await generateObject({
      model: gateway(DEFAULT_MODEL),
      schema: ExplanationSchema,
      mode: "json",
      prompt: `You are a senior data analyst reviewing statistical anomalies in the dataset "${args.datasetName}".

COLUMNS:
${schemaBlock(args.columns)}

DETECTED ANOMALIES:
${listing}

For EACH anomaly return one plain-English sentence (max 30 words) explaining what is unusual and what in the row context might explain it. Be concrete, reference the actual values, and never invent data that is not shown. Return one entry per id, using the exact id strings.`,
      temperature: 0.2,
    });
    const parsed = object as z.infer<typeof ExplanationSchema>;
    const map = new Map((parsed.explanations ?? []).map((e) => [e.id, e.text]));
    return args.anomalies.map((a) => ({ ...a, explanation: map.get(a.id)?.trim() || a.explanation }));

  } catch (e) {
    console.error("[anomalies] explanation failed:", e instanceof Error ? e.message : e);
    return args.anomalies;
  }
}
