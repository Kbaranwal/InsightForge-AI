/**
 * Natural Language Query — structured intent + deterministic execution.
 *
 * The AI never returns numbers. It returns ONLY a structured intent
 * (groupBy / metric / aggregation / filter / chartType). This module executes
 * that intent against the real rows in the browser, so every number shown to
 * the user is computed from their data — no hallucinated statistics.
 *
 * Chart selection reuses the dashboard rules: time dimension → line,
 * ≤6 categories → pie, otherwise bar.
 */

import type { ChartSpec } from "@/components/chart-renderer";
import { classifyColumns, type ColumnRole, type RoleColumn } from "./column-roles";

export type Aggregation = "sum" | "avg" | "count" | "min" | "max";
export type FilterOp = "eq" | "neq" | "gt" | "lt" | "contains";

export interface QueryFilter {
  column: string;
  op: FilterOp;
  value: string;
}

export interface QueryIntent {
  groupBy: string | null;
  metric: string | null;
  aggregation: Aggregation;
  filter: QueryFilter | null;
  chartType: "bar" | "pie" | "line" | "table";
  /** Set when the question is ambiguous or no column matches — no chart is shown. */
  clarification: string | null;
  /** Short label for the measure, e.g. "Total Revenue (calculated)". */
  title: string;
}

export interface QueryResultRow {
  label: string;
  value: number;
}

export interface QueryResult {
  intent: QueryIntent;
  rows: QueryResultRow[];
  chartType: "bar" | "pie" | "line" | "table";
  /** One-line plain-English answer computed from the real data. */
  answer: string;
  spec: ChartSpec;
  total: number;
}

const AGG_LABEL: Record<Aggregation, string> = {
  sum: "Total", avg: "Average", count: "Count of", min: "Minimum", max: "Maximum",
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[, $]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function fmtValue(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
}

function matches(row: Record<string, unknown>, f: QueryFilter): boolean {
  const raw = row[f.column];
  if (raw === null || raw === undefined) return false;
  const s = String(raw).toLowerCase();
  const t = f.value.toLowerCase();
  switch (f.op) {
    case "eq": return s === t;
    case "neq": return s !== t;
    case "contains": return s.includes(t);
    case "gt": { const a = num(raw), b = num(f.value); return a !== null && b !== null && a > b; }
    case "lt": { const a = num(raw), b = num(f.value); return a !== null && b !== null && a < b; }
    default: return true;
  }
}

/**
 * Validate an AI-produced intent against the real schema and column roles.
 * Returns a clarification instead of a chart when the intent cannot be honoured.
 */
export function validateIntent(
  intent: QueryIntent,
  columns: RoleColumn[],
  rowCount: number,
): QueryIntent {
  if (intent.clarification) return intent;
  const { roles } = classifyColumns(columns, rowCount || 1);
  const roleOf = (n: string): ColumnRole | undefined =>
    (columns.find((c) => c.name === n)?.role as ColumnRole) ?? roles[n];
  const exists = (n: string | null): n is string => !!n && columns.some((c) => c.name === n);

  if (intent.metric && !exists(intent.metric)) {
    return { ...intent, clarification: `I couldn't find a column called "${intent.metric}". Try naming one of your metric columns.` };
  }
  if (intent.metric && roleOf(intent.metric) === "identifier" && intent.aggregation !== "count") {
    return {
      ...intent,
      clarification: `"${intent.metric}" is a record identifier, so it can't be summed or averaged. Ask for a record count, or pick a real metric column.`,
    };
  }
  if (intent.groupBy && !exists(intent.groupBy)) {
    return { ...intent, clarification: `I couldn't find a column called "${intent.groupBy}" to group by.` };
  }
  if (intent.filter && !exists(intent.filter.column)) {
    return { ...intent, filter: null };
  }
  if (!intent.metric && intent.aggregation !== "count") {
    return { ...intent, aggregation: "count" };
  }
  return intent;
}

/** Execute a validated intent against real rows. All numbers come from here. */
export function executeIntent(
  rows: Array<Record<string, unknown>>,
  intent: QueryIntent,
  columns: RoleColumn[],
  rowCount: number,
): QueryResult | null {
  if (intent.clarification) return null;

  const { roles } = classifyColumns(columns, rowCount || rows.length || 1);
  const roleOf = (n: string) => (columns.find((c) => c.name === n)?.role as ColumnRole) ?? roles[n];

  const filtered = intent.filter ? rows.filter((r) => matches(r, intent.filter!)) : rows;
  const metric = intent.metric;
  const agg = intent.aggregation;

  let out: QueryResultRow[] = [];
  if (intent.groupBy) {
    const buckets = new Map<string, { sum: number; count: number; min: number; max: number }>();
    for (const r of filtered) {
      const g = r[intent.groupBy];
      if (g === null || g === undefined || g === "") continue;
      const key = String(g);
      const b = buckets.get(key) ?? { sum: 0, count: 0, min: Infinity, max: -Infinity };
      const v = metric ? num(r[metric]) : null;
      b.count += 1;
      if (v !== null) { b.sum += v; b.min = Math.min(b.min, v); b.max = Math.max(b.max, v); }
      buckets.set(key, b);
    }
    out = [...buckets.entries()].map(([label, b]) => ({
      label,
      value:
        agg === "count" ? b.count :
        agg === "sum" ? b.sum :
        agg === "avg" ? (b.count ? b.sum / b.count : 0) :
        agg === "min" ? (Number.isFinite(b.min) ? b.min : 0) :
        (Number.isFinite(b.max) ? b.max : 0),
    }));
  } else {
    // No grouping → single scalar answer.
    let sum = 0, count = 0, min = Infinity, max = -Infinity;
    for (const r of filtered) {
      count += 1;
      const v = metric ? num(r[metric]) : null;
      if (v !== null) { sum += v; min = Math.min(min, v); max = Math.max(max, v); }
    }
    const value =
      agg === "count" ? count :
      agg === "sum" ? sum :
      agg === "avg" ? (count ? sum / count : 0) :
      agg === "min" ? (Number.isFinite(min) ? min : 0) :
      (Number.isFinite(max) ? max : 0);
    out = [{ label: metric ?? "Records", value }];
  }

  if (!out.length) return null;

  const isTime = intent.groupBy ? roleOf(intent.groupBy) === "time" : false;
  out = isTime
    ? out.sort((a, b) => (a.label < b.label ? -1 : 1))
    : out.sort((a, b) => b.value - a.value);

  // Auto chart selection (matches the dashboard rules).
  let chartType: QueryResult["chartType"] = intent.chartType;
  if (!intent.groupBy) chartType = "table";
  else if (isTime) chartType = "line";
  else if (out.length <= 6) chartType = chartType === "line" ? "bar" : "pie";
  else chartType = "bar";

  const display = chartType === "pie" ? out.slice(0, 6) : out.slice(0, 20);
  const measureName = metric ?? "Records";
  const measureLabel = `${AGG_LABEL[agg]} ${measureName}`;

  const total = out.reduce((a, b) => a + b.value, 0);
  const answer = buildAnswer(intent, out, measureLabel, isTime, filtered.length, rows.length);

  const spec: ChartSpec = {
    id: "nlq",
    type: chartType === "table" ? "bar" : chartType,
    title: intent.title || measureLabel,
    description: intent.groupBy ? `${measureLabel} by ${intent.groupBy}` : measureLabel,
    x: "label",
    y: ["value"],
    groupBy: null,
    aggregation: "sum",
    explanation: answer,
  };

  return {
    intent,
    rows: display.map((r) => ({ label: r.label, value: Math.round(r.value * 100) / 100 })),
    chartType,
    answer,
    spec,
    total,
  };
}

function buildAnswer(
  intent: QueryIntent,
  rows: QueryResultRow[],
  measureLabel: string,
  isTime: boolean,
  matched: number,
  totalRows: number,
): string {
  const scope = intent.filter
    ? ` (filtered to ${matched.toLocaleString()} of ${totalRows.toLocaleString()} sample rows where ${intent.filter.column} ${intent.filter.op} "${intent.filter.value}")`
    : "";
  if (!intent.groupBy) {
    return `${measureLabel} is ${fmtValue(rows[0].value)}${scope}.`;
  }
  if (isTime) {
    const first = rows[0], last = rows[rows.length - 1];
    const delta = first.value !== 0 ? ((last.value - first.value) / Math.abs(first.value)) * 100 : 0;
    return `${measureLabel} moved from ${fmtValue(first.value)} (${first.label}) to ${fmtValue(last.value)} (${last.label}), a ${delta >= 0 ? "rise" : "fall"} of ${Math.abs(delta).toFixed(1)}%${scope}.`;
  }
  const top = rows[0];
  const sum = rows.reduce((a, b) => a + b.value, 0);
  const share = sum !== 0 ? (top.value / sum) * 100 : 0;
  return `${top.label} leads with ${fmtValue(top.value)} ${measureLabel.toLowerCase()}, ${share.toFixed(1)}% of the ${rows.length} ${intent.groupBy} groups${scope}.`;
}
