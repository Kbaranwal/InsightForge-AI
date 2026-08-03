/**
 * Anomaly Detection Agent — deterministic statistics layer.
 *
 * Runs AFTER column classification (see `column-roles.ts`) so that only
 * columns with role="metric" are ever examined. Identifier columns
 * (OrderID, InvoiceNumber, CustomerID …) are skipped entirely — a unique key
 * is never an outlier.
 *
 * Three detectors:
 *  1. z-score      → |value - mean| / stddev > 2.5
 *  2. IQR fence    → value < Q1 - 1.5*IQR  or  value > Q3 + 1.5*IQR
 *  3. time-series  → rolling 7-period moving average ± 2 std dev (only when a
 *                    Time column exists) to catch sudden spikes/drops that
 *                    static, whole-column detection smooths away.
 *
 * The module is pure and isomorphic: the server uses it during analysis, the
 * client can re-run it on the sample rows without another round trip.
 */

import { classifyColumns, type RoleColumn } from "./column-roles";

export type AnomalySeverity = "low" | "medium" | "high";
export type AnomalyMethod = "zscore" | "iqr" | "rolling";

export interface Anomaly {
  /** Stable key so UI lists and AI explanations can be joined. */
  id: string;
  column: string;
  /** Zero-based index into the analysed sample rows. */
  rowIndex: number;
  /** Human row reference — the time value, a key column value, or "Row N". */
  rowLabel: string;
  value: number;
  /** Inclusive expected band the value fell outside of. */
  expectedMin: number;
  expectedMax: number;
  /** Signed deviation in standard deviations (rolling: vs local window). */
  deviation: number;
  direction: "spike" | "drop";
  method: AnomalyMethod;
  severity: AnomalySeverity;
  /** Other column values on the same row, for AI context and the UI table. */
  context: Record<string, string>;
  /** Filled in by the AI explanation pass; deterministic text until then. */
  explanation: string;
}

export interface AnomalyReport {
  anomalies: Anomaly[];
  /** Metric columns that were scanned. */
  scanned: string[];
  /** Identifier columns deliberately skipped. */
  skipped: string[];
  timeColumn: string | null;
  rowsAnalyzed: number;
}

const Z_THRESHOLD = 2.5;
const IQR_FACTOR = 1.5;
const ROLLING_WINDOW = 7;
const ROLLING_SIGMA = 2;
/** Cap so a noisy column cannot flood the report. */
const MAX_PER_COLUMN = 12;
const MAX_TOTAL = 60;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[, $]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base];
}

function severityFor(deviation: number): AnomalySeverity {
  const d = Math.abs(deviation);
  if (d >= 4) return "high";
  if (d >= 3) return "medium";
  return "low";
}

function round(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.abs(n) >= 100 ? Math.round(n * 100) / 100 : Math.round(n * 10000) / 10000;
}

/** Compact same-row context (max 6 short fields) used by the UI and the AI. */
function rowContext(
  row: Record<string, unknown>,
  exclude: string,
  preferred: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of preferred) {
    if (key === exclude) continue;
    const v = row[key];
    if (v === null || v === undefined || v === "") continue;
    out[key] = String(v).slice(0, 60);
    if (Object.keys(out).length >= 6) break;
  }
  return out;
}

/**
 * Detect anomalies across all metric columns of a dataset sample.
 *
 * @param rows    Sample rows (already enriched with derived metrics).
 * @param columns Column metadata carrying `role` (or classifiable on the fly).
 * @param rowCount Total dataset row count, used for role classification.
 */
export function detectAnomalies(
  rows: Array<Record<string, unknown>>,
  columns: RoleColumn[],
  rowCount: number,
): AnomalyReport {
  const empty: AnomalyReport = {
    anomalies: [], scanned: [], skipped: [], timeColumn: null, rowsAnalyzed: rows.length,
  };
  if (!rows.length || !columns.length) return empty;

  const { roles } = classifyColumns(columns, rowCount || rows.length);
  const roleOf = (name: string) => (columns.find((c) => c.name === name)?.role as string) ?? roles[name];

  const metrics = columns.filter((c) => roleOf(c.name) === "metric").map((c) => c.name);
  const skipped = columns.filter((c) => roleOf(c.name) === "identifier").map((c) => c.name);
  const timeColumn = columns.find((c) => roleOf(c.name) === "time")?.name ?? null;
  if (!metrics.length) return { ...empty, skipped, timeColumn };

  // Label/context columns: time first, then identifiers (labels only), then dimensions.
  const dimensions = columns.filter((c) => roleOf(c.name) === "categorical").map((c) => c.name);
  const labelPriority = [
    ...(timeColumn ? [timeColumn] : []),
    ...skipped.slice(0, 2),
    ...dimensions.slice(0, 4),
    ...metrics.slice(0, 3),
  ];

  const labelFor = (row: Record<string, unknown>, index: number): string => {
    for (const key of labelPriority) {
      const v = row[key];
      if (v !== null && v !== undefined && v !== "") return `${key}: ${String(v).slice(0, 40)}`;
    }
    return `Row ${index + 1}`;
  };

  // Rows ordered by time, when a time column exists — required for the rolling detector.
  const timeOrder = timeColumn
    ? rows
        .map((r, i) => ({ i, t: String(r[timeColumn] ?? "") }))
        .filter((e) => e.t !== "")
        .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    : [];

  const anomalies: Anomaly[] = [];

  for (const column of metrics) {
    const found = new Map<number, Anomaly>(); // rowIndex → best anomaly for this column

    const values: Array<{ i: number; v: number }> = [];
    for (let i = 0; i < rows.length; i++) {
      const v = num(rows[i][column]);
      if (v !== null) values.push({ i, v });
    }
    if (values.length < 8) continue; // too few points for meaningful statistics

    const nums = values.map((e) => e.v);
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const stddev = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length);
    const sorted = [...nums].sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    const lowFence = q1 - IQR_FACTOR * iqr;
    const highFence = q3 + IQR_FACTOR * iqr;

    const push = (a: Anomaly) => {
      const prev = found.get(a.rowIndex);
      if (!prev || Math.abs(a.deviation) > Math.abs(prev.deviation)) found.set(a.rowIndex, a);
    };

    // --- 1 & 2: static detectors (z-score + IQR) -------------------------
    for (const { i, v } of values) {
      const z = stddev > 0 ? (v - mean) / stddev : 0;
      const outsideZ = stddev > 0 && Math.abs(z) > Z_THRESHOLD;
      const outsideIqr = iqr > 0 && (v < lowFence || v > highFence);
      if (!outsideZ && !outsideIqr) continue;

      const method: AnomalyMethod = outsideZ ? "zscore" : "iqr";
      const expectedMin = outsideZ ? mean - Z_THRESHOLD * stddev : lowFence;
      const expectedMax = outsideZ ? mean + Z_THRESHOLD * stddev : highFence;
      // For pure-IQR hits express deviation in IQR multiples so severity is comparable.
      const deviation = outsideZ
        ? z
        : iqr > 0
        ? (v > highFence ? (v - q3) / iqr : (v - q1) / iqr) * 1.5
        : 0;

      push({
        id: `${column}::${i}::${method}`,
        column,
        rowIndex: i,
        rowLabel: labelFor(rows[i], i),
        value: round(v),
        expectedMin: round(expectedMin),
        expectedMax: round(expectedMax),
        deviation: round(deviation),
        direction: v >= expectedMax ? "spike" : "drop",
        method,
        severity: severityFor(deviation),
        context: rowContext(rows[i], column, labelPriority),
        explanation: `${column} = ${round(v)} sits outside the expected range ${round(expectedMin)} – ${round(expectedMax)} (${method === "zscore" ? `${round(Math.abs(z))}σ from the mean` : "beyond the 1.5×IQR fence"}).`,
      });
    }

    // --- 3: rolling-window detector (time series only) -------------------
    if (timeColumn && timeOrder.length >= ROLLING_WINDOW + 1) {
      const series: Array<{ i: number; v: number }> = [];
      for (const { i } of timeOrder) {
        const v = num(rows[i][column]);
        if (v !== null) series.push({ i, v });
      }
      for (let k = ROLLING_WINDOW; k < series.length; k++) {
        const window = series.slice(k - ROLLING_WINDOW, k).map((e) => e.v);
        const wMean = window.reduce((a, b) => a + b, 0) / window.length;
        const wStd = Math.sqrt(window.reduce((a, b) => a + (b - wMean) ** 2, 0) / window.length);
        if (wStd <= 0) continue;
        const { i, v } = series[k];
        const z = (v - wMean) / wStd;
        if (Math.abs(z) <= ROLLING_SIGMA) continue;
        push({
          id: `${column}::${i}::rolling`,
          column,
          rowIndex: i,
          rowLabel: labelFor(rows[i], i),
          value: round(v),
          expectedMin: round(wMean - ROLLING_SIGMA * wStd),
          expectedMax: round(wMean + ROLLING_SIGMA * wStd),
          deviation: round(z),
          direction: z > 0 ? "spike" : "drop",
          method: "rolling",
          severity: severityFor(z),
          context: rowContext(rows[i], column, labelPriority),
          explanation: `${column} ${z > 0 ? "spiked to" : "dropped to"} ${round(v)} against a ${ROLLING_WINDOW}-period moving average of ${round(wMean)} (${round(Math.abs(z))}σ of local volatility).`,
        });
      }
    }

    const perColumn = [...found.values()]
      .sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation))
      .slice(0, MAX_PER_COLUMN);
    anomalies.push(...perColumn);
  }

  const ranked = anomalies
    .sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation))
    .slice(0, MAX_TOTAL);

  return { anomalies: ranked, scanned: metrics, skipped, timeColumn, rowsAnalyzed: rows.length };
}

export const SEVERITY_ORDER: Record<AnomalySeverity, number> = { high: 0, medium: 1, low: 2 };
