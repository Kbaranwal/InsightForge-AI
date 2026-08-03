import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { detectAnomalies, type AnomalyReport } from "@/lib/analysis/anomalies";
import {
  detectRevenuePair, withDerivedFields, derivedRevenueColumn, classifyColumns,
  type RoleColumn,
} from "@/lib/analysis/column-roles";
import { validateIntent, type QueryIntent } from "@/lib/analysis/nl-query";
import { explainAnomalies, inferQueryIntent } from "@/lib/analysis/insight-agents.server";

/**
 * Anomaly Detection Agent.
 * Deterministic z-score / IQR / rolling-window detection on metric columns,
 * then AI explanations per anomaly. Result is cached on the latest analysis
 * row so repeat visits are instant. RLS scopes every read/write to the owner.
 */
export const getAnomalies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z.object({ id: z.string().uuid(), refresh: z.boolean().optional() }).parse(v),
  )
  .handler(async ({ data, context }): Promise<AnomalyReport> => {
    const { data: ds, error } = await context.supabase
      .from("datasets").select("id, name, columns, sample_rows, row_count").eq("id", data.id).single();
    if (error || !ds) throw new Error(error?.message ?? "Dataset not found");

    const { data: analysis } = await context.supabase
      .from("analyses").select("id, anomalies").eq("dataset_id", data.id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();

    if (!data.refresh && analysis?.anomalies) {
      return analysis.anomalies as unknown as AnomalyReport;
    }

    const baseCols = ((ds.columns as unknown as RoleColumn[]) ?? []).map((c) => ({ ...c }));
    const rawRows = (ds.sample_rows as unknown as Array<Record<string, unknown>>) ?? [];
    const pair = detectRevenuePair(baseCols, ds.row_count || rawRows.length);
    const rows = withDerivedFields(rawRows, pair);
    const cols = pair && !baseCols.some((c) => c.name === pair.name)
      ? [...baseCols, derivedRevenueColumn(rows, pair) as RoleColumn]
      : baseCols;
    const { roles } = classifyColumns(cols, ds.row_count || rows.length || 1);
    for (const c of cols) c.role = c.role ?? roles[c.name];

    const report = detectAnomalies(rows, cols, ds.row_count || rows.length);
    report.anomalies = await explainAnomalies({
      datasetName: ds.name, anomalies: report.anomalies, columns: cols,
    });

    if (analysis?.id) {
      await context.supabase.from("analyses")
        .update({ anomalies: report as unknown as never }).eq("id", analysis.id);
    }
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "anomalies.detect", resource_type: "dataset", resource_id: data.id,
      metadata: { found: report.anomalies.length, scanned: report.scanned.length } as unknown as never,
    });
    return report;
  });

/**
 * Natural Language Query agent.
 * Returns a STRUCTURED INTENT only — the client computes real numbers from the
 * dataset so no statistic is ever hallucinated by the model.
 */
export const interpretQuery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z.object({ id: z.string().uuid(), question: z.string().min(2).max(500) }).parse(v),
  )
  .handler(async ({ data, context }): Promise<QueryIntent> => {
    const { data: ds, error } = await context.supabase
      .from("datasets").select("id, name, columns, sample_rows, row_count").eq("id", data.id).single();
    if (error || !ds) throw new Error(error?.message ?? "Dataset not found");

    const baseCols = ((ds.columns as unknown as RoleColumn[]) ?? []).map((c) => ({ ...c }));
    const rawRows = (ds.sample_rows as unknown as Array<Record<string, unknown>>) ?? [];
    const pair = detectRevenuePair(baseCols, ds.row_count || rawRows.length);
    const rows = withDerivedFields(rawRows, pair);
    const cols = pair && !baseCols.some((c) => c.name === pair.name)
      ? [...baseCols, derivedRevenueColumn(rows, pair) as RoleColumn]
      : baseCols;
    const { roles } = classifyColumns(cols, ds.row_count || rows.length || 1);
    for (const c of cols) c.role = c.role ?? roles[c.name];

    try {
      const intent = await inferQueryIntent({
        question: data.question, datasetName: ds.name, columns: cols, sampleRows: rows,
      });
      return validateIntent(intent, cols, ds.row_count || rows.length);
    } catch (e) {
      console.error("[nlq] intent failed:", e instanceof Error ? e.message : e);
      return {
        groupBy: null, metric: null, aggregation: "count", filter: null, chartType: "table",
        clarification: "I couldn't interpret that question. Try naming a metric and a grouping, e.g. \"total revenue by region\".",
        title: data.question,
      };
    }
  });

// ---------- Pinned dashboard widgets ----------

export const listPinnedWidgets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("pinned_widgets").select("id, question, intent, created_at")
      .eq("dataset_id", data.id).order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return rows;
  });

export const pinWidget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z.object({
      id: z.string().uuid(),
      question: z.string().min(1).max(500),
      intent: z.record(z.string(), z.unknown()),
    }).parse(v),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("pinned_widgets").insert({
      user_id: context.userId,
      dataset_id: data.id,
      question: data.question,
      intent: data.intent as unknown as never,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const unpinWidget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ widgetId: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("pinned_widgets").delete().eq("id", data.widgetId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
