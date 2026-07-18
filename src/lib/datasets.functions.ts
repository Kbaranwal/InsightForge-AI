import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { generateObject, NoObjectGeneratedError } from "ai";
import { createGateway, HEAVY_MODEL, DEFAULT_MODEL } from "./ai-gateway.server";

// ---------- Types ----------
export type ColumnType = "number" | "integer" | "string" | "boolean" | "date" | "datetime" | "category" | "unknown";
export interface ColumnMeta {
  name: string;
  type: ColumnType;
  missing: number;
  unique: number;
  min?: number | string | null;
  max?: number | string | null;
  mean?: number | null;
  stddev?: number | null;
  top?: Array<{ value: string; count: number }>;
  isDate?: boolean;
  isNumeric?: boolean;
  role?: string;
}

const KPISpec = z.object({
  label: z.string(),
  value: z.string(),
  subvalue: z.string().nullable(),
  trend: z.enum(["up", "down", "flat", "none"]).nullable(),
  explanation: z.string(),
});
const ChartSpec = z.object({
  id: z.string(),
  type: z.enum(["line", "bar", "area", "pie", "scatter", "table"]),
  title: z.string(),
  description: z.string(),
  x: z.string().nullable(),
  y: z.array(z.string()),
  groupBy: z.string().nullable(),
  aggregation: z.enum(["sum", "avg", "count", "min", "max", "none"]),
  explanation: z.string(),
});
const DashboardSpec = z.object({
  title: z.string(),
  kpis: z.array(KPISpec),
  charts: z.array(ChartSpec),
});
const InsightsSpec = z.object({
  insights: z.array(z.object({ title: z.string(), detail: z.string(), evidence: z.string() })),
  anomalies: z.array(z.object({ title: z.string(), detail: z.string() })),
  recommendations: z.array(z.object({ title: z.string(), detail: z.string(), impact: z.enum(["high", "medium", "low"]) })),
  executive_summary: z.string(),
});
const UnderstandingSpec = z.object({
  domain: z.string(),
  purpose: z.string(),
  key_entities: z.array(z.string()),
  time_column: z.string().nullable(),
  metric_columns: z.array(z.string()),
  dimension_columns: z.array(z.string()),
  data_quality_notes: z.array(z.string()),
  pii_columns: z.array(z.string()),
});

export type Dashboard = z.infer<typeof DashboardSpec>;
export type Insights = z.infer<typeof InsightsSpec>;
export type Understanding = z.infer<typeof UnderstandingSpec>;

// ---------- Column profiling ----------
function profileColumns(rows: Array<Record<string, unknown>>): ColumnMeta[] {
  if (!rows.length) return [];
  const names = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const dateRe = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?([ T]\d{1,2}:\d{2}(:\d{2})?)?/;
  return names.map((name) => {
    const values = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined && v !== "");
    const missing = rows.length - values.length;
    const uniqueSet = new Set(values.map(String));
    const nums = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
    const isNumeric = nums.length > 0 && nums.length / Math.max(values.length, 1) > 0.8;
    const isDate = !isNumeric && values.length > 0 &&
      values.slice(0, 50).filter((v) => dateRe.test(String(v))).length / Math.min(values.length, 50) > 0.7;
    let type: ColumnType = "string";
    let mean: number | null = null, stddev: number | null = null, min: number | string | null = null, max: number | string | null = null;
    if (isNumeric) {
      type = nums.every((n) => Number.isInteger(n)) ? "integer" : "number";
      mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      stddev = Math.sqrt(nums.reduce((a, b) => a + (b - (mean ?? 0)) ** 2, 0) / nums.length);
      min = Math.min(...nums); max = Math.max(...nums);
    } else if (isDate) {
      type = "datetime";
      const sorted = [...values].map(String).sort();
      min = sorted[0]; max = sorted[sorted.length - 1];
    } else if (uniqueSet.size <= Math.max(20, values.length * 0.1)) {
      type = "category";
    }
    const counts = new Map<string, number>();
    for (const v of values) { const k = String(v); counts.set(k, (counts.get(k) || 0) + 1); }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }));
    return { name, type, missing, unique: uniqueSet.size, min, max, mean, stddev, top, isDate, isNumeric };
  });
}

// ---------- Server functions ----------

const createInput = z.object({
  name: z.string().min(1).max(200),
  fileName: z.string().max(255),
  fileSize: z.number().int().nonnegative(),
  storagePath: z.string().nullable(),
  rowCount: z.number().int().nonnegative(),
  sampleRows: z.array(z.record(z.unknown())).max(500),
});

export const createDataset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => createInput.parse(v))
  .handler(async ({ data, context }) => {
    const columns = profileColumns(data.sampleRows);
    const { data: row, error } = await context.supabase
      .from("datasets")
      .insert({
        user_id: context.userId,
        name: data.name,
        file_name: data.fileName,
        file_size: data.fileSize,
        storage_path: data.storagePath,
        row_count: data.rowCount,
        column_count: columns.length,
        columns: columns as unknown as never,
        sample_rows: data.sampleRows.slice(0, 200) as unknown as never,
        status: "uploaded",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "dataset.create", resource_type: "dataset", resource_id: row.id,
      metadata: { name: data.name, rows: data.rowCount, cols: columns.length } as unknown as never,
    });
    return { id: row.id };
  });

export const listDatasets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("datasets")
      .select("id, name, file_name, file_size, row_count, column_count, status, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  });

export const getDataset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const { data: ds, error } = await context.supabase
      .from("datasets").select("*").eq("id", data.id).single();
    if (error) throw new Error(error.message);
    const { data: analysis } = await context.supabase
      .from("analyses").select("*").eq("dataset_id", data.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    return { dataset: ds, analysis };
  });

export const deleteDataset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const { data: ds } = await context.supabase.from("datasets").select("storage_path").eq("id", data.id).single();
    if (ds?.storage_path) {
      await context.supabase.storage.from("datasets").remove([ds.storage_path]);
    }
    const { error } = await context.supabase.from("datasets").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ---------- AI Analysis ----------

function buildDatasetContext(ds: {
  name: string; row_count: number; columns: unknown; sample_rows: unknown;
}) {
  const cols = ds.columns as ColumnMeta[];
  const sample = (ds.sample_rows as Array<Record<string, unknown>>).slice(0, 30);
  const colSummary = cols.map((c) => {
    const stats = c.isNumeric
      ? `min=${c.min} max=${c.max} mean=${c.mean?.toFixed(2)} stddev=${c.stddev?.toFixed(2)}`
      : c.isDate
      ? `range=${c.min}..${c.max}`
      : `top=${c.top?.slice(0, 3).map((t) => `${t.value}(${t.count})`).join(", ")}`;
    return `- ${c.name} [${c.type}] unique=${c.unique} missing=${c.missing} ${stats}`;
  }).join("\n");
  return `Dataset: "${ds.name}" | ${ds.row_count.toLocaleString()} rows, ${cols.length} columns.

COLUMNS:
${colSummary}

SAMPLE ROWS (first ${sample.length} rows, JSON):
${JSON.stringify(sample).slice(0, 8000)}`;
}

export const analyzeDataset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const { data: ds, error } = await context.supabase.from("datasets").select("*").eq("id", data.id).single();
    if (error || !ds) throw new Error(error?.message ?? "Dataset not found");

    await context.supabase.from("datasets").update({ status: "analyzing" }).eq("id", data.id);

    const gateway = createGateway();
    const dsCtx = buildDatasetContext(ds as never);

    async function guarded<T>(prompt: string, schema: z.ZodType<T>, model: string): Promise<T | null> {
      try {
        const { object } = await generateObject({
          model: gateway(model),
          schema: schema as never,
          prompt,
          temperature: 0.2,
        });
        return object as T;
      } catch (e) {
        if (NoObjectGeneratedError.isInstance(e)) {
          try { return schema.parse(JSON.parse((e as { text?: string }).text ?? "")); } catch { return null; }
        }
        throw e;
      }
    }

    try {
      const understanding = await guarded(
        `You are a senior data analyst. Analyze the dataset below and describe it.\n\n${dsCtx}\n\nReturn JSON matching the schema. domain: business domain in 1-3 words. purpose: what this data is used for. key_entities: main things this data describes. time_column: column that represents time or null. metric_columns: numeric measures. dimension_columns: categorical fields to group by. data_quality_notes: any issues you see. pii_columns: any personally identifiable columns.`,
        UnderstandingSpec, DEFAULT_MODEL
      );

      const dashboard = await guarded(
        `You are a senior data visualization expert. Given the dataset context and its analysis, design an executive dashboard.\n\n${dsCtx}\n\nANALYSIS:\n${JSON.stringify(understanding)}\n\nRules:\n- Return 3-6 KPI cards with clear labels, computed values (as strings, formatted with units/%/$/commas when appropriate). Use the sample rows and stats — never fabricate numbers not derivable from the data.\n- Return 3-6 charts. Choose types wisely: line/area for time series, bar for comparisons across categories, pie for share breakdowns (max 6 slices), scatter for correlations, table for reference lists.\n- For each chart set x (the field on x-axis), y (fields to plot; usually 1), optional groupBy, and aggregation (sum/avg/count/min/max/none).\n- Every chart and KPI MUST have a plain-English explanation.\n- Only use columns that exist. Prefer a time column for at least one chart if present.\n- Title: a concise dashboard title.`,
        DashboardSpec, HEAVY_MODEL
      );

      const insights = await guarded(
        `You are a senior data scientist. Study the dataset and produce insights, anomalies, and recommendations.\n\n${dsCtx}\n\nANALYSIS:\n${JSON.stringify(understanding)}\n\nRules:\n- 3-6 insights: title + specific detail + evidence (which columns / values support it).\n- 0-4 anomalies: outliers, quality issues, or surprising values.\n- 3-5 recommendations: concrete next actions with an impact rating.\n- executive_summary: 2-3 tight paragraphs an executive can read in 30 seconds. Never invent facts.`,
        InsightsSpec, HEAVY_MODEL
      );

      const { error: insErr } = await context.supabase.from("analyses").insert({
        dataset_id: data.id,
        user_id: context.userId,
        understanding: understanding as unknown as never,
        dashboard: dashboard as unknown as never,
        insights: (insights ? { insights: insights.insights, anomalies: insights.anomalies } : null) as unknown as never,
        recommendations: (insights?.recommendations ?? null) as unknown as never,
        executive_summary: insights?.executive_summary ?? null,
        model: HEAVY_MODEL,
      });
      if (insErr) throw new Error(insErr.message);

      await context.supabase.from("datasets").update({ status: "ready" }).eq("id", data.id);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Analysis failed";
      await context.supabase.from("datasets").update({ status: "failed", error_message: msg }).eq("id", data.id);
      throw e;
    }
  });
