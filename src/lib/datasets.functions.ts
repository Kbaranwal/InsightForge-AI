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
const ReportSpec = z.object({
  title: z.string(),
  subtitle: z.string(),
  sections: z.array(z.object({
    heading: z.string(),
    body: z.string(),
    bullets: z.array(z.string()).nullable(),
  })),
  conclusion: z.string(),
});
export type Report = z.infer<typeof ReportSpec>;

export type Dashboard = z.infer<typeof DashboardSpec>;
export type Insights = z.infer<typeof InsightsSpec>;
export type Understanding = z.infer<typeof UnderstandingSpec>;

export interface ForecastPoint { period: string; value: number; projected: boolean }
export interface Forecast {
  metric: string;
  time_column: string;
  method: string;
  points: ForecastPoint[];
  narrative: string;
  trend: "up" | "down" | "flat";
  change_pct: number;
}
export interface ForecastBundle { forecasts: Forecast[] }

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
  sampleRows: z.array(z.record(z.string(), z.unknown())).max(500),
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
    const { data: ds } = await context.supabase.from("datasets").select("storage_path, name").eq("id", data.id).single();
    if (ds?.storage_path) {
      await context.supabase.storage.from("datasets").remove([ds.storage_path]);
    }
    const { error } = await context.supabase.from("datasets").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "dataset.delete", resource_type: "dataset", resource_id: data.id,
      metadata: { name: ds?.name } as unknown as never,
    });
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
    await checkRateLimit(context.supabase as never, context.userId, "analysis.run", 20);

    const { data: ds, error } = await context.supabase.from("datasets").select("*").eq("id", data.id).single();
    if (error || !ds) throw new Error(error?.message ?? "Dataset not found");

    await context.supabase.from("datasets").update({ status: "analyzing" }).eq("id", data.id);
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "analysis.run", resource_type: "dataset", resource_id: data.id,
      metadata: { model: HEAVY_MODEL } as unknown as never,
    });

    const gateway = createGateway();
    const dsCtx = buildDatasetContext(ds as never);

    function extractJson(text: string): unknown | null {
      if (!text) return null;
      const cleaned = text.replace(/```json\s*|\s*```/g, "").trim();
      try { return JSON.parse(cleaned); } catch { /* try substring */ }
      const first = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");
      if (first >= 0 && last > first) {
        try { return JSON.parse(cleaned.slice(first, last + 1)); } catch { /* ignore */ }
      }
      return null;
    }

    async function guarded<T>(prompt: string, schema: z.ZodType<T>, model: string): Promise<T | null> {
      const models = model === HEAVY_MODEL ? [HEAVY_MODEL, DEFAULT_MODEL] : [model];
      for (const m of models) {
        try {
          const { object } = await generateObject({
            model: gateway(m),
            schema: schema as never,
            mode: "json",
            prompt: `${prompt}\n\nRespond with ONLY a valid JSON object matching the schema. No prose, no markdown fences.`,
            temperature: 0.2,
          });
          return object as T;
        } catch (e) {
          const raw = (e as { text?: string })?.text;
          if (raw) {
            const parsed = extractJson(raw);
            if (parsed) {
              const safe = schema.safeParse(parsed);
              if (safe.success) return safe.data;
            }
          }
          console.error(`[analyze] guarded(${m}) failed:`, e instanceof Error ? e.message : e);
        }
      }
      return null;
    }

    try {
      let understanding = await guarded(
        `You are a senior data analyst. Analyze the dataset below and describe it.\n\n${dsCtx}\n\nReturn JSON matching the schema. domain: business domain in 1-3 words. purpose: what this data is used for. key_entities: main things this data describes. time_column: column that represents time or null. metric_columns: numeric measures. dimension_columns: categorical fields to group by. data_quality_notes: any issues you see. pii_columns: any personally identifiable columns.`,
        UnderstandingSpec, DEFAULT_MODEL
      );
      if (!understanding) understanding = fallbackUnderstanding(ds as never);

      let dashboard = await guarded(
        `You are a senior data visualization expert. Given the dataset context and its analysis, design an executive dashboard.\n\n${dsCtx}\n\nANALYSIS:\n${JSON.stringify(understanding)}\n\nRules:\n- Return 3-6 KPI cards with clear labels, computed values (as strings, formatted with units/%/$/commas when appropriate). Use the sample rows and stats — never fabricate numbers not derivable from the data.\n- Return 3-6 charts. Choose types wisely: line/area for time series, bar for comparisons across categories, pie for share breakdowns (max 6 slices), scatter for correlations, table for reference lists.\n- For each chart set x (the field on x-axis), y (fields to plot; usually 1), optional groupBy (nullable), and aggregation (sum/avg/count/min/max/none).\n- Every chart and KPI MUST have a plain-English explanation.\n- Only use columns that exist. Prefer a time column for at least one chart if present.\n- Title: a concise dashboard title.`,
        DashboardSpec, HEAVY_MODEL
      );
      if (!dashboard) dashboard = fallbackDashboard(ds as never, understanding);

      let insights = await guarded(
        `You are a senior data scientist. Study the dataset and produce insights, anomalies, and recommendations.\n\n${dsCtx}\n\nANALYSIS:\n${JSON.stringify(understanding)}\n\nRules:\n- 3-6 insights: title + specific detail + evidence (which columns / values support it).\n- 0-4 anomalies: outliers, quality issues, or surprising values.\n- 3-5 recommendations: concrete next actions with an impact rating.\n- executive_summary: 2-3 tight paragraphs an executive can read in 30 seconds. Never invent facts.`,
        InsightsSpec, HEAVY_MODEL
      );
      if (!insights) insights = fallbackInsights(ds as never, understanding);

      const forecasts = computeForecasts(
        ds.sample_rows as Array<Record<string, unknown>>,
        understanding,
      );

      const { error: insErr } = await context.supabase.from("analyses").insert({
        dataset_id: data.id,
        user_id: context.userId,
        understanding: understanding as unknown as never,
        dashboard: dashboard as unknown as never,
        insights: { insights: insights.insights, anomalies: insights.anomalies } as unknown as never,
        recommendations: insights.recommendations as unknown as never,
        executive_summary: insights.executive_summary,
        forecasts: ({ forecasts } as unknown as never),
        model: HEAVY_MODEL,
      });
      if (insErr) throw new Error(insErr.message);

      await context.supabase.from("datasets").update({ status: "ready" }).eq("id", data.id);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Analysis failed";
      console.error("[analyze] fatal:", msg);
      await context.supabase.from("datasets").update({ status: "failed", error_message: msg }).eq("id", data.id);
      throw e;
    }
  });

// ---------- Deterministic fallbacks so the dashboard is never empty ----------
function fallbackUnderstanding(ds: { name: string; columns: unknown }): Understanding {
  const cols = ds.columns as ColumnMeta[];
  const timeCol = cols.find((c) => c.isDate)?.name ?? null;
  const metrics = cols.filter((c) => c.isNumeric).map((c) => c.name);
  const dims = cols.filter((c) => !c.isNumeric && !c.isDate && c.unique <= 50).map((c) => c.name);
  return {
    domain: "General",
    purpose: `Analytical overview of ${ds.name}.`,
    key_entities: dims.slice(0, 3),
    time_column: timeCol,
    metric_columns: metrics,
    dimension_columns: dims,
    data_quality_notes: cols.filter((c) => c.missing > 0).slice(0, 3).map((c) => `${c.name} has ${c.missing} missing values`),
    pii_columns: [],
  };
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
}

function fallbackDashboard(ds: { name: string; row_count: number; columns: unknown }, u: Understanding): Dashboard {
  const cols = ds.columns as ColumnMeta[];
  const metrics = cols.filter((c) => c.isNumeric).slice(0, 3);
  const kpis: Dashboard["kpis"] = [
    { label: "Rows", value: ds.row_count.toLocaleString(), subvalue: `${cols.length} columns`, trend: "none" as const, explanation: "Total records in the dataset." },
    ...metrics.map((m) => ({
      label: `Avg ${m.name}`,
      value: fmtNum(m.mean ?? 0),
      subvalue: `min ${fmtNum(Number(m.min))} · max ${fmtNum(Number(m.max))}`,
      trend: "none" as const,
      explanation: `Mean of ${m.name} across sampled rows.`,
    })),
  ].slice(0, 4);

  const charts: Dashboard["charts"] = [];
  const dim = u.dimension_columns?.[0] ?? cols.find((c) => !c.isNumeric && !c.isDate && c.unique <= 20)?.name ?? null;
  const metric = metrics[0]?.name ?? null;
  if (u.time_column && metric) {
    charts.push({
      id: "ts", type: "line", title: `${metric} over time`,
      description: `Trend of ${metric} across ${u.time_column}.`,
      x: u.time_column, y: [metric], groupBy: null, aggregation: "sum",
      explanation: `Shows how ${metric} evolves over ${u.time_column}.`,
    });
  }
  if (dim && metric) {
    charts.push({
      id: "bd", type: "bar", title: `${metric} by ${dim}`,
      description: `Comparison of ${metric} across ${dim}.`,
      x: dim, y: [metric], groupBy: null, aggregation: "sum",
      explanation: `Aggregates ${metric} for each ${dim}.`,
    });
  }
  if (dim) {
    charts.push({
      id: "pie", type: "pie", title: `Share by ${dim}`,
      description: `Distribution of records across ${dim}.`,
      x: dim, y: ["count"], groupBy: null, aggregation: "count",
      explanation: `Portion of rows falling into each ${dim} category.`,
    });
  }
  if (metrics.length >= 2) {
    charts.push({
      id: "sc", type: "scatter", title: `${metrics[0].name} vs ${metrics[1].name}`,
      description: `Relationship between two key metrics.`,
      x: metrics[0].name, y: [metrics[1].name], groupBy: null, aggregation: "none",
      explanation: `Explores whether ${metrics[0].name} and ${metrics[1].name} correlate.`,
    });
  }
  return {
    title: `${ds.name} — Overview`,
    kpis,
    charts: charts.length ? charts : [{
      id: "tbl", type: "table", title: "Sample rows",
      description: "First rows of the dataset.",
      x: null, y: cols.slice(0, 6).map((c) => c.name), groupBy: null, aggregation: "none",
      explanation: "Raw sample for reference.",
    }],
  };
}

function fallbackInsights(ds: { row_count: number; columns: unknown }, u: Understanding): Insights {
  const cols = ds.columns as ColumnMeta[];
  const missing = cols.filter((c) => c.missing > 0);
  const metrics = cols.filter((c) => c.isNumeric);
  const insights: Insights["insights"] = [
    { title: "Dataset size", detail: `${ds.row_count.toLocaleString()} rows across ${cols.length} columns.`, evidence: "row_count, column_count" },
    ...metrics.slice(0, 2).map((m) => ({
      title: `${m.name} distribution`,
      detail: `${m.name} ranges from ${fmtNum(Number(m.min))} to ${fmtNum(Number(m.max))} with a mean of ${fmtNum(m.mean ?? 0)}.`,
      evidence: `min/max/mean of ${m.name}`,
    })),
  ];
  if (u.dimension_columns?.[0]) {
    insights.push({ title: "Primary segmentation", detail: `${u.dimension_columns[0]} is the main categorical dimension for slicing this data.`, evidence: `unique values of ${u.dimension_columns[0]}` });
  }
  const anomalies = missing.slice(0, 3).map((c) => ({
    title: `Missing values in ${c.name}`, detail: `${c.name} has ${c.missing} missing entries — verify data quality upstream.`,
  }));
  return {
    insights,
    anomalies,
    recommendations: [
      { title: "Validate data quality", detail: "Investigate columns with missing values and confirm ingestion is complete.", impact: missing.length ? "high" : "low" },
      { title: "Explore key metrics", detail: `Drill into ${metrics[0]?.name ?? "core metrics"} across ${u.dimension_columns?.[0] ?? "dimensions"} for deeper patterns.`, impact: "medium" },
      { title: "Track trend over time", detail: u.time_column ? `Monitor ${metrics[0]?.name ?? "metrics"} against ${u.time_column} to catch shifts early.` : "Add a time dimension to enable trend analysis.", impact: "medium" },
    ],
    executive_summary: `This dataset covers ${ds.row_count.toLocaleString()} records across ${cols.length} columns${u.domain ? ` in the ${u.domain} domain` : ""}. Key metrics include ${metrics.slice(0, 3).map((m) => m.name).join(", ") || "n/a"}. Use the dashboard to explore trends and segment performance.`,
  };
}

// ---------- Forecasting (linear regression on time series) ----------
function computeForecasts(
  rows: Array<Record<string, unknown>>,
  understanding: Understanding | null,
): Forecast[] {
  if (!understanding?.time_column || !understanding.metric_columns?.length) return [];
  const timeCol = understanding.time_column;
  const parsed = rows
    .map((r) => ({ t: new Date(String(r[timeCol])).getTime(), r }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  if (parsed.length < 4) return [];

  const out: Forecast[] = [];
  for (const metric of understanding.metric_columns.slice(0, 4)) {
    const pts = parsed
      .map(({ t, r }) => ({ t, v: Number(r[metric]) }))
      .filter((p) => Number.isFinite(p.v));
    if (pts.length < 4) continue;

    const n = pts.length;
    const meanT = pts.reduce((a, p) => a + p.t, 0) / n;
    const meanV = pts.reduce((a, p) => a + p.v, 0) / n;
    const num = pts.reduce((a, p) => a + (p.t - meanT) * (p.v - meanV), 0);
    const den = pts.reduce((a, p) => a + (p.t - meanT) ** 2, 0);
    const slope = den === 0 ? 0 : num / den;
    const intercept = meanV - slope * meanT;
    const step = (pts[n - 1].t - pts[0].t) / Math.max(n - 1, 1);

    const points: ForecastPoint[] = pts.map((p) => ({
      period: new Date(p.t).toISOString().slice(0, 10),
      value: Math.round(p.v * 1000) / 1000,
      projected: false,
    }));
    for (let i = 1; i <= 6; i++) {
      const t = pts[n - 1].t + step * i;
      points.push({
        period: new Date(t).toISOString().slice(0, 10),
        value: Math.round((intercept + slope * t) * 1000) / 1000,
        projected: true,
      });
    }

    const first = pts[0].v, last = pts[n - 1].v;
    const changePct = first === 0 ? 0 : ((last - first) / Math.abs(first)) * 100;
    const trend: Forecast["trend"] = Math.abs(changePct) < 2 ? "flat" : changePct > 0 ? "up" : "down";
    out.push({
      metric,
      time_column: timeCol,
      method: "linear-regression",
      points,
      trend,
      change_pct: Math.round(changePct * 10) / 10,
      narrative: `${metric} has moved ${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}% across the observed period. A linear projection extrapolates the next 6 periods at the same rate. Treat projections as directional guidance, not commitments — real-world seasonality and shocks are not modeled.`,
    });
  }
  return out;
}

// ---------- Rate limiting (ad-hoc, audit_logs-backed) ----------
// Simple per-user hourly window; not distributed, best-effort.
async function checkRateLimit(
  supabase: { from: (t: string) => { select: (c: string, o?: unknown) => { eq: (...a: unknown[]) => { gte: (...a: unknown[]) => Promise<{ count: number | null }> } } } },
  userId: string,
  action: string,
  perHour: number,
) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  // deno-lint-ignore no-explicit-any
  const { count } = await (supabase as any)
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("action", action)
    .gte("created_at", since);
  if ((count ?? 0) >= perHour) {
    throw new Error(`Rate limit reached (${perHour}/hour for ${action}). Try again later.`);
  }
}

// ---------- Report Generation Agent ----------
export const generateReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    await checkRateLimit(context.supabase as never, context.userId, "report.generate", 10);

    const { data: ds, error } = await context.supabase.from("datasets").select("*").eq("id", data.id).single();
    if (error || !ds) throw new Error(error?.message ?? "Dataset not found");
    const { data: analysis } = await context.supabase
      .from("analyses").select("*").eq("dataset_id", data.id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!analysis) throw new Error("Run the analysis first before generating a report.");

    const gateway = createGateway();
    const dsCtx = buildDatasetContext(ds as never);

    const prompt = `You are a senior data consultant writing an executive-grade narrative report about a dataset.
Base every statement strictly on the analysis and dataset provided — do not invent facts.

${dsCtx}

UNDERSTANDING:
${JSON.stringify(analysis.understanding)}

DASHBOARD:
${JSON.stringify(analysis.dashboard)}

INSIGHTS + ANOMALIES + RECOMMENDATIONS:
${JSON.stringify(analysis.insights)}
${JSON.stringify(analysis.recommendations)}

FORECASTS:
${JSON.stringify(analysis.forecasts)}

Write a full report with:
- title: concise, business-oriented
- subtitle: one-line framing
- sections: 5-8 sections, each with a clear heading (e.g. Executive Overview, Data Profile, Key Findings, Anomalies & Risks, Forecasts & Outlook, Recommendations, Methodology, Limitations). Each section body should be 2-4 well-written paragraphs. Use bullets only where a list is clearly the right format (recommendations, risks, methodology steps). Set bullets to null when not used.
- conclusion: 1-2 paragraphs synthesizing the takeaway and next steps.
Tone: crisp, confident, honest about uncertainty. No filler.`;

    let report: Report | null = null;
    try {
      const { object } = await generateObject({
        model: gateway(HEAVY_MODEL),
        schema: ReportSpec as never,
        prompt,
        temperature: 0.3,
      });
      report = object as Report;
    } catch (e) {
      if (NoObjectGeneratedError.isInstance(e)) {
        try { report = ReportSpec.parse(JSON.parse((e as { text?: string }).text ?? "")); } catch { report = null; }
      } else throw e;
    }
    if (!report) throw new Error("Report generation failed. Please try again.");

    const { error: upErr } = await context.supabase
      .from("analyses").update({ report: report as unknown as never }).eq("id", analysis.id);
    if (upErr) throw new Error(upErr.message);

    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "report.generate", resource_type: "dataset", resource_id: data.id,
      metadata: { sections: report.sections.length } as unknown as never,
    });

    return { report };
  });

// ---------- Audit log listing ----------
export const listAuditLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("audit_logs")
      .select("id, action, resource_type, resource_id, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return data;
  });

