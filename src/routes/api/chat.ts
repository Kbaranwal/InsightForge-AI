import { createFileRoute } from "@tanstack/react-router";
import { convertToCoreMessages, streamText, type Message } from "ai";
import { createClient } from "@supabase/supabase-js";
import { createGateway, DEFAULT_MODEL } from "@/lib/ai-gateway.server";
import type { Database } from "@/integrations/supabase/types";
import type { ColumnMeta } from "@/lib/datasets.functions";
import {
  classifyColumns, detectRevenuePair, withDerivedFields, derivedRevenueColumn,
  type RoleColumn,
} from "@/lib/analysis/column-roles";

type Row = Record<string, unknown>;

function coerceNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function numericStats(rows: Row[], name: string) {
  const nums: number[] = [];
  for (const r of rows) {
    const n = coerceNum(r[name]);
    if (n !== null) nums.push(n);
  }
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / nums.length;
  const sorted = [...nums].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    count: nums.length,
    sum,
    mean,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function categoryCounts(rows: Row[], name: string, limit = 8) {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = r[name];
    if (v === null || v === undefined || v === "") continue;
    const k = String(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function groupSums(rows: Row[], dim: string, metric: string, limit = 8) {
  const map = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    const dv = r[dim];
    if (dv === null || dv === undefined || dv === "") continue;
    const n = coerceNum(r[metric]);
    if (n === null) continue;
    const k = String(dv);
    const cur = map.get(k) ?? { sum: 0, count: 0 };
    cur.sum += n; cur.count += 1;
    map.set(k, cur);
  }
  return [...map.entries()]
    .map(([value, s]) => ({ value, sum: s.sum, avg: s.sum / s.count, count: s.count }))
    .sort((a, b) => b.sum - a.sum)
    .slice(0, limit);
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(Math.round(n * 100) / 100);
}

function buildStatsContext(rows: Row[], cols: ColumnMeta[], totalRowCount: number) {
  // Identifier columns (OrderID, InvoiceNumber, ...) are keys, not measures:
  // they are never summed, averaged or broken down.
  const { roles } = classifyColumns(cols as RoleColumn[], totalRowCount || rows.length);
  const numeric = cols.filter((c) => roles[c.name] === "metric");
  const identifiers = cols.filter((c) => roles[c.name] === "identifier");
  const categorical = cols.filter((c) => roles[c.name] === "categorical");
  const scale = rows.length > 0 && totalRowCount > rows.length ? totalRowCount / rows.length : 1;

  const numericBlock = numeric.map((c) => {
    const s = numericStats(rows, c.name);
    if (!s) return `- ${c.name}: no numeric values in sample`;
    const est = scale > 1
      ? ` | est. full-dataset sum≈${fmt(s.sum * scale)} (scaled from ${rows.length}/${totalRowCount} rows)`
      : "";
    return `- ${c.name}: sum=${fmt(s.sum)} mean=${fmt(s.mean)} median=${fmt(s.median)} min=${fmt(s.min)} max=${fmt(s.max)} count=${s.count}${est}`;
  }).join("\n");

  const catBlock = categorical.slice(0, 8).map((c) => {
    const top = categoryCounts(rows, c.name, 8);
    if (!top.length) return `- ${c.name}: (empty)`;
    return `- ${c.name}: ${top.map((t) => `${t.value}=${t.count}`).join(", ")}`;
  }).join("\n");

  const breakdowns: string[] = [];
  const topCats = categorical.slice(0, 3);
  const topMetrics = numeric.slice(0, 3);
  for (const dim of topCats) {
    for (const metric of topMetrics) {
      const g = groupSums(rows, dim.name, metric.name, 6);
      if (!g.length) continue;
      breakdowns.push(`${metric.name} by ${dim.name}: ${g.map((x) => `${x.value}(sum=${fmt(x.sum)}, avg=${fmt(x.avg)}, n=${x.count})`).join(" | ")}`);
    }
  }

  const idBlock = identifiers.length
    ? identifiers.map((c) => `- ${c.name}: identifier (${c.unique} distinct values) — count records only, never sum/average`).join("\n")
    : "(none)";

  return `IDENTIFIER COLUMNS (keys — use for counting/lookup only):
${idBlock}

METRIC COLUMN STATS (computed from ${rows.length} sample rows${scale > 1 ? `, dataset has ${totalRowCount} rows total` : ""}):
${numericBlock || "(none)"}

CATEGORICAL TOP VALUES:
${catBlock || "(none)"}

CROSS BREAKDOWNS (metric sums by dimension):
${breakdowns.slice(0, 12).join("\n") || "(none computed)"}`;
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as { messages?: Message[]; datasetId?: string };
          const messages = body.messages;
          const datasetId = body.datasetId;
          if (!Array.isArray(messages) || !datasetId) return new Response("Bad request", { status: 400 });

          const auth = request.headers.get("authorization") ?? "";
          const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
          if (!token) return new Response("Unauthorized", { status: 401 });

          const url = process.env.SUPABASE_URL!;
          const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
          const supabase = createClient<Database>(url, key, {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { data: user } = await supabase.auth.getUser(token);
          if (!user.user) return new Response("Unauthorized", { status: 401 });

          const { data: ds, error } = await supabase.from("datasets").select("*").eq("id", datasetId).single();
          if (error || !ds) return new Response("Not found", { status: 404 });

          const baseCols = ds.columns as unknown as ColumnMeta[];
          const baseRows = (ds.sample_rows as unknown as Row[]) ?? [];
          const revenuePair = detectRevenuePair(baseCols as RoleColumn[], ds.row_count || baseRows.length);
          const rows = withDerivedFields(baseRows, revenuePair);
          const cols = revenuePair && !baseCols.some((c) => c.name === revenuePair.name)
            ? [...baseCols, derivedRevenueColumn(rows, revenuePair) as unknown as ColumnMeta]
            : baseCols;
          const sampleForModel = rows.slice(0, 40);
          const colDesc = cols.map((c) => `${c.name} [${c.type}] unique=${c.unique} missing=${c.missing}`).join("\n");
          const stats = buildStatsContext(rows, cols, ds.row_count);

          const system = `You are InsightIQ, a senior AI data analyst. Answer the user's questions using the dataset context below.

HOW TO ANSWER
- Do the math yourself. Use the pre-computed COLUMN STATS and CROSS BREAKDOWNS to answer aggregate questions (totals, averages, top/bottom, breakdowns) directly — do NOT refuse just because a specific column name isn't present.
- When the user asks about a concept that maps to an existing column under a different name (e.g. "total sales", "revenue", "spend", "amount") map it to the closest available metric column (like "Purchase Amount (USD)") and answer, briefly noting which column you used.
- When the user asks for something that truly cannot be derived from any column (e.g. "profit" without cost/margin data), first give the closest useful metric you CAN compute (e.g. total revenue / total purchase amount, average order value), then in one short line note what additional column would be needed for the exact metric requested.
- Never say "I cannot" without first providing the closest useful analysis.
- NEVER compute averages, totals, trends or correlations on identifier columns (order IDs, invoice numbers, customer IDs). If asked, explain they are record keys and give the record count instead.
- Prefer derived/headline revenue metrics (e.g. "Revenue (calculated)" = Quantity x UnitPrice) over raw quantity/price columns when answering about sales, revenue or totals.
- When numbers come from the sample and the full dataset is larger, say "based on the sample" and give the estimated full-dataset figure using the scaling shown in the stats.
- Format answers with markdown: short intro, then bullet points or a table. Bold the key number. Keep it concise.

DATASET "${ds.name}" — ${ds.row_count.toLocaleString()} rows, ${cols.length} columns.

COLUMNS:
${colDesc}

${stats}

SAMPLE ROWS (first ${sampleForModel.length}, JSON):
${JSON.stringify(sampleForModel).slice(0, 8000)}`;

          const last = messages[messages.length - 1];
          if (last?.role === "user") {
            await supabase.from("chat_messages").insert({
              user_id: user.user.id, dataset_id: datasetId, role: "user", content: String(last.content).slice(0, 8000),
            });
          }

          const gateway = createGateway();
          const result = streamText({
            model: gateway(DEFAULT_MODEL),
            system,
            messages: convertToCoreMessages(messages),
            temperature: 0.2,
            async onFinish({ text }) {
              await supabase.from("chat_messages").insert({
                user_id: user.user.id, dataset_id: datasetId, role: "assistant", content: text.slice(0, 16000),
              });
            },
          });
          return result.toDataStreamResponse();
        } catch (e) {
          console.error("chat error", e);
          return new Response(e instanceof Error ? e.message : "Error", { status: 500 });
        }
      },
    },
  },
});
