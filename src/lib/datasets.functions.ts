import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { generateObject, NoObjectGeneratedError } from "ai";
import { createGateway, HEAVY_MODEL, DEFAULT_MODEL } from "./ai-gateway.server";
import {
  classifyColumns, detectRevenuePair, withDerivedFields, derivedRevenueColumn,
  type ColumnRole, type RoleColumn,
} from "./analysis/column-roles";
import { detectAnomalies } from "./analysis/anomalies";
import { explainAnomalies } from "./analysis/insight-agents.server";


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
  const metas: ColumnMeta[] = names.map((name) => {
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
  // Tag every column with its analytical role (identifier / metric / categorical / time)
  const { roles } = classifyColumns(metas as RoleColumn[], rows.length);
  for (const m of metas) m.role = roles[m.name];
  return metas;
}

/** Columns that may be used as measures (never identifiers). */
function metricColumns(cols: ColumnMeta[]): ColumnMeta[] {
  return cols.filter((c) => c.role === "metric");
}
function isIdentifier(c: ColumnMeta | null | undefined): boolean {
  return c?.role === "identifier";
}

/**
 * Build the analysis-ready view of a dataset: sample rows enriched with any
 * derived metric (e.g. Quantity × UnitPrice → Revenue) and matching column meta.
 */
function prepareAnalysis(ds: { row_count: number; columns: unknown; sample_rows: unknown }) {
  const cols = [...((ds.columns as ColumnMeta[]) ?? [])];
  const rawRows = (ds.sample_rows as Array<Record<string, unknown>>) ?? [];
  const pair = detectRevenuePair(cols as RoleColumn[], ds.row_count || rawRows.length);
  const rows = withDerivedFields(rawRows, pair);
  if (pair && !cols.some((c) => c.name === pair.name)) {
    cols.push(derivedRevenueColumn(rows, pair) as unknown as ColumnMeta);
  }
  // Ensure roles exist for legacy datasets profiled before classification existed.
  const { roles } = classifyColumns(cols as RoleColumn[], ds.row_count || rawRows.length || 1);
  for (const c of cols) c.role = (c.role as ColumnRole) ?? roles[c.name];
  return { cols, rows, derived: pair };
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
    const baseColumns = profileColumns(data.sampleRows);
    // Derive Revenue (Quantity × UnitPrice) at ingest so every downstream
    // consumer — charts, forecasts, chat — sees the same enriched schema.
    const pair = detectRevenuePair(baseColumns as RoleColumn[], data.rowCount || data.sampleRows.length);
    const enrichedRows = withDerivedFields(data.sampleRows, pair);
    const columns = pair ? profileColumns(enrichedRows) : baseColumns;
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
        sample_rows: enrichedRows.slice(0, 200) as unknown as never,

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
  const { cols, rows, derived } = prepareAnalysis(ds);
  const sample = rows.slice(0, 30);
  const colSummary = cols.map((c) => {
    const stats = c.isNumeric
      ? `min=${c.min} max=${c.max} mean=${c.mean?.toFixed(2)} stddev=${c.stddev?.toFixed(2)}`
      : c.isDate
      ? `range=${c.min}..${c.max}`
      : `top=${c.top?.slice(0, 3).map((t) => `${t.value}(${t.count})`).join(", ")}`;
    return `- ${c.name} [${c.type}] role=${c.role ?? "unknown"} unique=${c.unique} missing=${c.missing} ${stats}`;
  }).join("\n");
  const ids = cols.filter((c) => c.role === "identifier").map((c) => c.name);
  const roleNote = `\nCOLUMN ROLES — obey strictly:\n- IDENTIFIER columns${ids.length ? ` (${ids.join(", ")})` : " (none)"} are record keys. NEVER average, sum, trend, correlate, forecast or KPI them. Use them only for counting records or as labels.\n- METRIC columns are the only valid measures.\n- CATEGORICAL columns are for grouping/segmentation only, never averaged.${derived ? `\n- "${derived.name}" is a DERIVED metric = ${derived.quantity} × ${derived.price}. Prefer it over the raw ${derived.quantity}/${derived.price} columns for totals, trends, peaks and KPIs.` : ""}`;
  return `Dataset: "${ds.name}" | ${ds.row_count.toLocaleString()} rows, ${cols.length} columns.

COLUMNS:
${colSummary}
${roleNote}



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
        `You are a senior data analyst. Analyze the dataset below and describe it.\n\n${dsCtx}\n\nReturn JSON matching the schema. domain: business domain in 1-3 words. purpose: what this data is used for. key_entities: main things this data describes. time_column: column that represents time or null. metric_columns: ONLY columns with role=metric (never role=identifier, never IDs/codes/numbers). dimension_columns: columns with role=categorical used for grouping. data_quality_notes: any issues you see. pii_columns: any personally identifiable columns.`,
        UnderstandingSpec, DEFAULT_MODEL
      );
      if (!understanding) understanding = fallbackUnderstanding(ds as never);
      understanding = sanitizeUnderstanding(understanding, ds as never);

      let dashboard = await guarded(
        `You are a senior data visualization expert. Given the dataset context and its analysis, design an executive dashboard.\n\n${dsCtx}\n\nANALYSIS:\n${JSON.stringify(understanding)}\n\nSTRICT CHART SELECTION RULES — follow exactly:\n1. Only reference column names that exist in COLUMNS above (case-sensitive). Never invent a column.\n2. NEVER use a role=identifier column as a measure (y), as a scatter axis, or in a KPI value. Identifiers may only appear via aggregation="count" (counting records) or as a table label.\n3. If a derived metric (e.g. "Revenue (calculated)") exists, make it the headline measure for trend, peak, total and KPI cards, ahead of raw quantity/price columns.\n4. Chart type selection by schema:\n   - line/area: x MUST be the time_column; y MUST be role=metric columns.\n   - bar: x MUST be a categorical column with 7-30 unique values (or 2-6 when a pie is already used elsewhere); y MUST be a metric OR aggregation="count".\n   - pie: x MUST be a categorical column with 2-6 unique values (never more).\n   - scatter: x AND y[0] MUST both be role=metric columns and different. Skip scatter entirely if fewer than 2 metric columns exist.\n   - table: use sparingly, only for reference lists.\n5. NEVER show the same grouping twice: one chart per (x, y) grouping — choose pie when x has ≤6 categories, bar otherwise. Do not emit both.\n6. Diversify: time trend, category comparison, distribution/share, and (only if justified) correlation.\n7. Aggregation MUST match: metric y → sum/avg/min/max; no metric y → count; scatter/table → none.\n8. Return 4-6 charts total. Every chart AND KPI needs a plain-English explanation grounded in real column stats.\n9. KPIs: 3-6 cards prioritising business value — total revenue/sales, top-performing category/customer/product, average order value, record count. Values are strings formatted with units/%/$/commas. Never fabricate numbers.\n\nReturn ONLY valid JSON matching the schema.`,
        DashboardSpec, HEAVY_MODEL
      );
      if (!dashboard) dashboard = fallbackDashboard(ds as never, understanding);
      dashboard = validateAndEnrichCharts(dashboard, ds as never, understanding);


      let insights = await guarded(
        `You are a senior data scientist. Study the dataset and produce insights, anomalies, and recommendations.\n\n${dsCtx}\n\nANALYSIS:\n${JSON.stringify(understanding)}\n\nRules:\n- Prioritise business-relevant findings in this order: (1) total revenue/sales or the headline metric, (2) top-performing category/customer/product, (3) trend over time in the headline metric, (4) significant outliers in real metrics.\n- NEVER report statistics (average, peak, trend, correlation, outliers) on role=identifier columns such as order IDs, invoice numbers or customer IDs. They may only be used for record counts.\n- 3-6 insights: title + specific detail + evidence (which columns / values support it).\n- 0-4 anomalies: outliers, quality issues, or surprising values — in metrics, not identifiers.\n- 3-5 recommendations: concrete next actions with an impact rating.\n- executive_summary: 2-3 tight paragraphs an executive can read in 30 seconds, leading with the headline business metric. Never invent facts.`,
        InsightsSpec, HEAVY_MODEL

      );
      if (!insights) insights = fallbackInsights(ds as never, understanding);

      const prepared = prepareAnalysis(ds as never);
      const forecasts = computeForecasts(prepared.rows, understanding);

      // Anomaly Detection Agent — runs after column classification so only
      // metric columns are scanned; identifiers are never flagged.
      const anomalyReport = detectAnomalies(
        prepared.rows,
        prepared.cols as RoleColumn[],
        ds.row_count || prepared.rows.length,
      );
      anomalyReport.anomalies = await explainAnomalies({
        datasetName: ds.name,
        anomalies: anomalyReport.anomalies,
        columns: prepared.cols as RoleColumn[],
      });


      const { error: insErr } = await context.supabase.from("analyses").insert({
        dataset_id: data.id,
        user_id: context.userId,
        understanding: understanding as unknown as never,
        dashboard: dashboard as unknown as never,
        insights: { insights: insights.insights, anomalies: insights.anomalies } as unknown as never,
        recommendations: insights.recommendations as unknown as never,
        executive_summary: insights.executive_summary,
        forecasts: ({ forecasts } as unknown as never),
        anomalies: anomalyReport as unknown as never,
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
function fallbackUnderstanding(ds: { name: string; row_count: number; columns: unknown; sample_rows: unknown }): Understanding {
  const { cols, derived } = prepareAnalysis(ds);
  const timeCol = cols.find((c) => c.role === "time")?.name ?? null;
  const metrics = orderMetrics(metricColumns(cols), derived?.name ?? null).map((c) => c.name);
  const dims = cols.filter((c) => c.role === "categorical" && c.unique <= 50).map((c) => c.name);
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

/** Put the derived/headline revenue metric first; drop identifiers. */
function orderMetrics(metrics: ColumnMeta[], derivedName: string | null): ColumnMeta[] {
  const score = (c: ColumnMeta) => {
    if (derivedName && c.name === derivedName) return 0;
    if (/(revenue|sales|total|amount|profit)/i.test(c.name)) return 1;
    if (/(price|cost|value|spend)/i.test(c.name)) return 2;
    if (/(qty|quantity|units)/i.test(c.name)) return 3;
    return 4;
  };
  return [...metrics].sort((a, b) => score(a) - score(b));
}

/**
 * Force the AI's understanding to respect column roles: identifiers can never
 * be metrics, and the derived revenue metric is promoted to the front.
 */
function sanitizeUnderstanding(
  u: Understanding,
  ds: { name: string; row_count: number; columns: unknown; sample_rows: unknown },
): Understanding {
  const { cols, derived } = prepareAnalysis(ds);
  const byName = new Map(cols.map((c) => [c.name, c]));
  const validMetrics = orderMetrics(
    (u.metric_columns ?? [])
      .map((n) => byName.get(n))
      .filter((c): c is ColumnMeta => !!c && c.role === "metric"),
    derived?.name ?? null,
  ).map((c) => c.name);
  if (derived && !validMetrics.includes(derived.name)) validMetrics.unshift(derived.name);
  const metrics = validMetrics.length ? validMetrics : orderMetrics(metricColumns(cols), derived?.name ?? null).map((c) => c.name);

  const dims = (u.dimension_columns ?? []).filter((n) => byName.get(n)?.role === "categorical");
  const timeCol = u.time_column && byName.get(u.time_column)?.role === "time"
    ? u.time_column
    : cols.find((c) => c.role === "time")?.name ?? null;

  return {
    ...u,
    time_column: timeCol,
    metric_columns: metrics,
    dimension_columns: dims.length ? dims : cols.filter((c) => c.role === "categorical" && c.unique <= 50).map((c) => c.name),
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

// Post-process AI dashboard: drop invalid charts, coerce mismatched types, dedupe, top-up.
function validateAndEnrichCharts(
  dashboard: Dashboard,
  ds: { name: string; row_count: number; columns: unknown; sample_rows: unknown },
  u: Understanding,
): Dashboard {
  const { cols, rows: sample } = prepareAnalysis(ds);
  const byName = new Map(cols.map((c) => [c.name, c]));
  const uniqueValuesInSample = (name: string) => {
    const s = new Set<string>();
    for (const r of sample) {
      const v = r?.[name];
      if (v === null || v === undefined || v === "") continue;
      s.add(String(v));
      if (s.size > 50) break;
    }
    return s.size;
  };
  const cardinality = (c: ColumnMeta) => c.unique || uniqueValuesInSample(c.name);
  const isMetric = (n: string) => byName.get(n)?.role === "metric";

  const seen = new Set<string>();
  // Track (x + measure) groupings so a bar and a pie never duplicate each other.
  const groupings = new Set<string>();
  const cleaned: Dashboard["charts"] = [];

  for (const c of dashboard.charts ?? []) {
    const xCol = c.x ? byName.get(c.x) : null;
    // Identifier columns are never measures.
    const yCols = (c.y ?? []).filter((n) => byName.has(n) && !isIdentifier(byName.get(n)));
    if (c.x && !xCol) continue; // x refers to missing column
    if (yCols.length === 0 && c.aggregation !== "count" && c.type !== "table") continue;

    let type = c.type;
    let aggregation = c.aggregation;

    if (type === "line" || type === "area") {
      if (!xCol || (!xCol.isDate && !isMetric(xCol.name))) continue;
      if (isIdentifier(xCol)) continue;
      if (!yCols.some(isMetric)) continue;
      if (aggregation === "none" || aggregation === "count") aggregation = "sum";
    } else if (type === "bar" || type === "pie") {
      // x must be a grouping dimension (identifiers are never a chart axis)
      if (!xCol || xCol.isNumeric || xCol.isDate || isIdentifier(xCol)) continue;
      const card = cardinality(xCol);
      if (card < 2 || card > 30) continue;
      if (yCols.length === 0) aggregation = "count";
      else if (aggregation === "none") aggregation = "sum";
      // Rule: pie for <=6 categories, bar for more — never both for one grouping.
      type = card <= 6 ? "pie" : "bar";
    } else if (type === "scatter") {
      // Only between two genuine metrics, and only if a relationship is plausible.
      if (!xCol || !isMetric(xCol.name)) continue;
      const yName = yCols[0];
      if (!yName || !isMetric(yName) || yName === xCol.name) continue;
      const r = correlation(sample, xCol.name, yName);
      if (r === null || Math.abs(r) < 0.15) continue; // no meaningful relationship
      aggregation = "none";
    } else if (type === "table") {
      if (yCols.length === 0) continue;
    }

    const key = `${type}|${c.x ?? ""}|${yCols.join(",")}|${c.groupBy ?? ""}`;
    if (seen.has(key)) continue;
    const grouping = `${c.x ?? ""}|${yCols.join(",") || "count"}`;
    if ((type === "bar" || type === "pie") && groupings.has(grouping)) continue;
    seen.add(key);
    if (type === "bar" || type === "pie") groupings.add(grouping);
    const groupByCol = c.groupBy ? byName.get(c.groupBy) : null;
    cleaned.push({
      ...c, type, aggregation,
      y: yCols.length ? yCols : c.y,
      groupBy: groupByCol && !isIdentifier(groupByCol) && !groupByCol.isNumeric ? c.groupBy : null,
    });
  }

  // Top-up with deterministic charts if we have <4 valid ones
  if (cleaned.length < 4) {
    const filler = fallbackDashboard(ds, u).charts;
    for (const c of filler) {
      const key = `${c.type}|${c.x ?? ""}|${c.y.join(",")}|${c.groupBy ?? ""}`;
      const grouping = `${c.x ?? ""}|${c.y.join(",") || "count"}`;
      if (seen.has(key)) continue;
      if ((c.type === "bar" || c.type === "pie") && groupings.has(grouping)) continue;
      seen.add(key);
      if (c.type === "bar" || c.type === "pie") groupings.add(grouping);
      cleaned.push(c);
      if (cleaned.length >= 5) break;
    }
  }

  // KPIs must never be built on identifier columns.
  const kpis = (dashboard.kpis ?? []).filter((k) => {
    const idHit = cols.find((c) => isIdentifier(c) && new RegExp(`\\b${escapeRe(c.name)}\\b`, "i").test(k.label));
    return !idHit || /count|records|rows|number of/i.test(k.label);
  });

  return { ...dashboard, kpis: kpis.length ? kpis : fallbackDashboard(ds, u).kpis, charts: cleaned.slice(0, 6) };
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Pearson correlation between two numeric columns of the sample. */
function correlation(rows: Array<Record<string, unknown>>, a: string, b: string): number | null {
  const pts: Array<[number, number]> = [];
  for (const r of rows) {
    const x = Number(r[a]); const y = Number(r[b]);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
  }
  if (pts.length < 5) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); dx += (x - mx) ** 2; dy += (y - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

/** Business-level aggregates computed from the sample (identifier-free). */
function businessStats(
  ds: { row_count: number; columns: unknown; sample_rows: unknown },
) {
  const { cols, rows, derived } = prepareAnalysis(ds);
  const metrics = orderMetrics(metricColumns(cols), derived?.name ?? null);
  const headline = metrics[0] ?? null;
  const dims = cols
    .filter((c) => c.role === "categorical" && c.unique >= 2 && c.unique <= 30)
    .sort((a, b) => a.unique - b.unique);
  const timeCol = cols.find((c) => c.role === "time")?.name ?? null;

  let total = 0;
  const perDim = new Map<string, Map<string, number>>();
  if (headline) {
    for (const r of rows) {
      const v = Number(r[headline.name]);
      if (!Number.isFinite(v)) continue;
      total += v;
      for (const d of dims.slice(0, 2)) {
        const key = String(r[d.name] ?? "—");
        if (!perDim.has(d.name)) perDim.set(d.name, new Map());
        const m = perDim.get(d.name)!;
        m.set(key, (m.get(key) ?? 0) + v);
      }
    }
  }
  const topBy = [...perDim.entries()].map(([dim, m]) => {
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const sum = sorted.reduce((s, e) => s + e[1], 0) || 1;
    return { dim, label: sorted[0]?.[0] ?? "—", value: sorted[0]?.[1] ?? 0, share: ((sorted[0]?.[1] ?? 0) / sum) * 100 };
  });

  return { cols, rows, derived, metrics, headline, dims, timeCol, total, topBy };
}

function fallbackDashboard(ds: { name: string; row_count: number; columns: unknown; sample_rows?: unknown }, u: Understanding): Dashboard {
  const s = businessStats({ row_count: ds.row_count, columns: ds.columns, sample_rows: ds.sample_rows ?? [] });
  const { cols, metrics, headline, dims, timeCol, total, topBy } = s;

  const kpis: Dashboard["kpis"] = [];
  if (headline) {
    kpis.push({
      label: `Total ${headline.name}`,
      value: fmtNum(total),
      subvalue: `across ${ds.row_count.toLocaleString()} records`,
      trend: "none" as const,
      explanation: `Sum of ${headline.name} over the analysed rows — the headline business volume.`,
    });
    kpis.push({
      label: `Avg ${headline.name}`,
      value: fmtNum(headline.mean ?? 0),
      subvalue: `min ${fmtNum(Number(headline.min))} · max ${fmtNum(Number(headline.max))}`,
      trend: "none" as const,
      explanation: `Average ${headline.name} per record.`,
    });
  }
  if (topBy[0]) {
    kpis.push({
      label: `Top ${topBy[0].dim}`,
      value: topBy[0].label,
      subvalue: `${fmtNum(topBy[0].value)} · ${topBy[0].share.toFixed(1)}% share`,
      trend: "none" as const,
      explanation: `Best performing ${topBy[0].dim} by ${headline?.name ?? "volume"}.`,
    });
  }
  kpis.push({
    label: "Records",
    value: ds.row_count.toLocaleString(),
    subvalue: `${cols.length} columns`,
    trend: "none" as const,
    explanation: "Total records in the dataset.",
  });

  const charts: Dashboard["charts"] = [];
  const groupings = new Set<string>();
  const metric = headline?.name ?? null;

  if (timeCol && metric) {
    charts.push({
      id: "ts", type: "line", title: `${metric} over time`,
      description: `Trend of ${metric} across ${timeCol}.`,
      x: timeCol, y: [metric], groupBy: null, aggregation: "sum",
      explanation: `Shows how total ${metric} evolves over ${timeCol}.`,
    });
  }

  // One chart per dimension — pie when <=6 categories, bar otherwise.
  for (const d of dims.slice(0, 3)) {
    const grouping = `${d.name}|${metric ?? "count"}`;
    if (groupings.has(grouping)) continue;
    groupings.add(grouping);
    const pie = d.unique <= 6;
    charts.push({
      id: `dim-${charts.length}`,
      type: pie ? "pie" : "bar",
      title: metric ? `${metric} by ${d.name}` : `Records by ${d.name}`,
      description: metric ? `Comparison of ${metric} across ${d.name}.` : `Record distribution across ${d.name}.`,
      x: d.name,
      y: metric ? [metric] : ["count"],
      groupBy: null,
      aggregation: metric ? "sum" : "count",
      explanation: pie
        ? `Share of ${metric ?? "records"} held by each ${d.name} (few enough categories for a share view).`
        : `Aggregates ${metric ?? "records"} for each ${d.name}, ranked for comparison.`,
    });
    if (charts.length >= 4) break;
  }

  // Scatter only between two real metrics with a plausible relationship.
  if (metrics.length >= 2) {
    const a = metrics[0].name;
    const b = metrics.find((m) => m.name !== a)!.name;
    const r = correlation(s.rows, a, b);
    if (r !== null && Math.abs(r) >= 0.15) {
      charts.push({
        id: "sc", type: "scatter", title: `${a} vs ${b}`,
        description: `Relationship between two key metrics (r=${r.toFixed(2)}).`,
        x: a, y: [b], groupBy: null, aggregation: "none",
        explanation: `Explores how ${a} moves with ${b}; correlation is ${r.toFixed(2)}.`,
      });
    }
  }

  return {
    title: `${ds.name} — Overview`,
    kpis: kpis.slice(0, 4),
    charts: charts.length ? charts : [{
      id: "tbl", type: "table", title: "Sample rows",
      description: "First rows of the dataset.",
      x: null, y: cols.slice(0, 6).map((c) => c.name), groupBy: null, aggregation: "none",
      explanation: "Raw sample for reference.",
    }],
  };
}

function fallbackInsights(ds: { row_count: number; columns: unknown; sample_rows?: unknown }, u: Understanding): Insights {
  const s = businessStats({ row_count: ds.row_count, columns: ds.columns, sample_rows: ds.sample_rows ?? [] });
  const { cols, headline, total, topBy, timeCol, derived } = s;
  const missing = cols.filter((c) => c.missing > 0);
  const ids = cols.filter(isIdentifier);

  const insights: Insights["insights"] = [];
  if (headline) {
    insights.push({
      title: `Total ${headline.name}`,
      detail: `${headline.name} totals ${fmtNum(total)} across ${ds.row_count.toLocaleString()} records, averaging ${fmtNum(headline.mean ?? 0)} per record.`,
      evidence: `sum and mean of ${headline.name}${derived ? ` (derived as ${derived.quantity} × ${derived.price})` : ""}`,
    });
  }
  if (topBy[0]) {
    insights.push({
      title: `Top performing ${topBy[0].dim}`,
      detail: `"${topBy[0].label}" leads on ${headline?.name ?? "volume"} with ${fmtNum(topBy[0].value)} (${topBy[0].share.toFixed(1)}% of the total).`,
      evidence: `${headline?.name ?? "records"} grouped by ${topBy[0].dim}`,
    });
  }
  if (timeCol && headline) {
    insights.push({
      title: "Trend over time",
      detail: `${headline.name} is tracked against ${timeCol}; use the trend chart and forecast tab to monitor direction.`,
      evidence: `${headline.name} by ${timeCol}`,
    });
  }
  if (headline && headline.stddev) {
    const spread = (headline.stddev / Math.max(Math.abs(headline.mean ?? 1), 1e-9)) * 100;
    insights.push({
      title: `${headline.name} variability`,
      detail: `${headline.name} ranges ${fmtNum(Number(headline.min))}–${fmtNum(Number(headline.max))} with a ${spread.toFixed(0)}% coefficient of variation, indicating ${spread > 60 ? "a long tail of outsized records" : "fairly consistent record sizes"}.`,
      evidence: `min/max/stddev of ${headline.name}`,
    });
  }
  if (!insights.length) {
    insights.push({ title: "Dataset size", detail: `${ds.row_count.toLocaleString()} rows across ${cols.length} columns.`, evidence: "row_count, column_count" });
  }

  const anomalies: Insights["anomalies"] = missing.slice(0, 3).map((c) => ({
    title: `Missing values in ${c.name}`, detail: `${c.name} has ${c.missing} missing entries — verify data quality upstream.`,
  }));
  if (headline && headline.stddev && headline.max !== null && Number(headline.max) > (headline.mean ?? 0) + 3 * headline.stddev) {
    anomalies.push({
      title: `Outlier in ${headline.name}`,
      detail: `The maximum ${headline.name} (${fmtNum(Number(headline.max))}) sits more than 3 standard deviations above the mean — worth verifying.`,
    });
  }

  return {
    insights: insights.slice(0, 6),
    anomalies,
    recommendations: [
      topBy[0]
        ? { title: `Double down on ${topBy[0].label}`, detail: `"${topBy[0].label}" drives ${topBy[0].share.toFixed(1)}% of ${headline?.name ?? "volume"} in ${topBy[0].dim}. Protect this segment and study what makes it work before scaling elsewhere.`, impact: "high" as const }
        : { title: "Add a segmentation column", detail: "No usable grouping dimension was found, which limits comparative analysis.", impact: "medium" as const },
      { title: "Validate data quality", detail: missing.length ? `Investigate missing values in ${missing.slice(0, 3).map((c) => c.name).join(", ")}.` : "No missing values detected; keep ingestion checks in place.", impact: missing.length ? "high" as const : "low" as const },
      { title: timeCol ? "Track the trend" : "Add a time dimension", detail: timeCol ? `Monitor ${headline?.name ?? "the headline metric"} against ${timeCol} to catch shifts early.` : "Add a date column to unlock trend and forecast analysis.", impact: "medium" as const },
      ...(ids.length ? [{ title: "Keep identifiers out of metrics", detail: `${ids.map((c) => c.name).join(", ")} are record keys and are excluded from averages and trends by design — use them only for record counts and lookups.`, impact: "low" as const }] : []),
    ].slice(0, 5),
    executive_summary: `${headline ? `${headline.name} totals ${fmtNum(total)} across ${ds.row_count.toLocaleString()} records (avg ${fmtNum(headline.mean ?? 0)}).` : `This dataset covers ${ds.row_count.toLocaleString()} records across ${cols.length} columns.`}${topBy[0] ? ` "${topBy[0].label}" is the strongest ${topBy[0].dim}, contributing ${topBy[0].share.toFixed(1)}% of the total.` : ""}${timeCol ? ` Performance is tracked over ${timeCol}, enabling trend and forecast views.` : ""}${ids.length ? ` Identifier columns (${ids.map((c) => c.name).join(", ")}) are used only for record counts and are excluded from metric analysis.` : ""}`,
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

