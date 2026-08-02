/**
 * Column role classification + derived metric detection.
 *
 * Shared by the server-side analysis pipeline and the client-side chart
 * renderer so both agree on what counts as a real business metric.
 *
 * Roles:
 *  - "identifier"  → sequential/unique keys (OrderID, InvoiceNumber). Usable for
 *                    counting/labelling only. Never averaged, trended or correlated.
 *  - "metric"      → meaningful numeric quantities (Quantity, UnitPrice, Revenue).
 *  - "categorical" → text/low-cardinality fields used for grouping only.
 *  - "time"        → date/datetime columns used as the trend axis.
 */

export type ColumnRole = "identifier" | "metric" | "categorical" | "time";

export interface RoleColumn {
  name: string;
  unique: number;
  missing?: number;
  isNumeric?: boolean;
  isDate?: boolean;
  min?: number | string | null;
  max?: number | string | null;
  mean?: number | null;
  stddev?: number | null;
  top?: Array<{ value: string; count: number }>;
  role?: string;
}

/** Names that are almost always keys, not measures. */
const IDENTIFIER_NAME_RE =
  /(^|[^a-z])(id|ids|uuid|guid|key|code|no|num|number|sku|ref|reference)$|^(id|uuid|guid)$/i;

const IDENTIFIER_HINT_RE = /(_id|id|_no|no|number|code|key|ref|sku)$/i;

/** Metric-sounding names that should win even if cardinality is high. */
const METRIC_NAME_RE =
  /(amount|amt|revenue|sales|price|cost|total|profit|margin|qty|quantity|units|discount|tax|value|score|rate|spend|balance|weight|age|duration|count)/i;

export function classifyColumn(col: RoleColumn, rowCount: number): ColumnRole {
  if (col.isDate) return "time";
  if (!col.isNumeric) return "categorical";

  const name = col.name.trim();
  const nameLooksLikeId =
    IDENTIFIER_NAME_RE.test(name.replace(/[\s_-]+/g, "")) || IDENTIFIER_HINT_RE.test(name.replace(/[\s_-]+/g, ""));
  const nameLooksLikeMetric = METRIC_NAME_RE.test(name);

  // Near-unique numeric column relative to row count → key, not measure.
  const rows = Math.max(rowCount || 0, 1);
  const uniqueRatio = col.unique / rows;
  const nearUnique = rows >= 10 && uniqueRatio >= 0.9;

  if (nameLooksLikeId && !nameLooksLikeMetric) return "identifier";
  if (nearUnique && !nameLooksLikeMetric) return "identifier";
  return "metric";
}

export interface RoleMap {
  roles: Record<string, ColumnRole>;
  identifiers: string[];
  metrics: string[];
  dimensions: string[];
  timeColumns: string[];
}

export function classifyColumns(cols: RoleColumn[], rowCount: number): RoleMap {
  const roles: Record<string, ColumnRole> = {};
  const identifiers: string[] = [];
  const metrics: string[] = [];
  const dimensions: string[] = [];
  const timeColumns: string[] = [];
  for (const c of cols) {
    const role = classifyColumn(c, rowCount);
    roles[c.name] = role;
    if (role === "identifier") identifiers.push(c.name);
    else if (role === "metric") metrics.push(c.name);
    else if (role === "time") timeColumns.push(c.name);
    else dimensions.push(c.name);
  }
  return { roles, identifiers, metrics, dimensions, timeColumns };
}

/** Dimensions usable for grouping (low enough cardinality to chart). */
export function groupableDimensions(cols: RoleColumn[], rowCount: number, max = 30): string[] {
  const { roles } = classifyColumns(cols, rowCount);
  return cols
    .filter((c) => roles[c.name] === "categorical" && c.unique >= 2 && c.unique <= max)
    .sort((a, b) => a.unique - b.unique)
    .map((c) => c.name);
}

// ---------- Derived revenue ----------

export const DERIVED_REVENUE = "Revenue (calculated)";

const QTY_RE = /^(qty|quantity|units?|unitssold|itemcount|pieces)$/i;
const PRICE_RE = /^(unitprice|price|rate|unitcost|costperunit|priceperunit|amountperunit)$/i;

export interface RevenuePair {
  quantity: string;
  price: string;
  name: string;
}

/**
 * Detect a quantity × price pair so we can synthesise a Revenue metric.
 * Returns null when the dataset already has an explicit revenue/total column.
 */
export function detectRevenuePair(cols: RoleColumn[], rowCount: number): RevenuePair | null {
  const { roles } = classifyColumns(cols, rowCount);
  const numeric = cols.filter((c) => roles[c.name] === "metric");
  const norm = (s: string) => s.replace(/[\s_\-()]/g, "").toLowerCase();

  const hasExplicitTotal = numeric.some((c) =>
    /^(revenue|totalamount|totalsales|totalprice|totalvalue|sales|grandtotal|linetotal|amount)$/i.test(norm(c.name)),
  );
  if (hasExplicitTotal) return null;

  const qty = numeric.find((c) => QTY_RE.test(norm(c.name)));
  const price = numeric.find((c) => PRICE_RE.test(norm(c.name)));
  if (!qty || !price || qty.name === price.name) return null;
  return { quantity: qty.name, price: price.name, name: DERIVED_REVENUE };
}

/** Append the derived revenue field to each row (non-mutating). */
export function withDerivedFields(
  rows: Array<Record<string, unknown>>,
  pair: RevenuePair | null,
): Array<Record<string, unknown>> {
  if (!pair) return rows;
  return rows.map((r) => {
    const q = Number(r[pair.quantity]);
    const p = Number(r[pair.price]);
    if (!Number.isFinite(q) || !Number.isFinite(p)) return r;
    return { ...r, [pair.name]: Math.round(q * p * 100) / 100 };
  });
}

/** Column metadata entry for the derived revenue field. */
export function derivedRevenueColumn(
  rows: Array<Record<string, unknown>>,
  pair: RevenuePair,
): RoleColumn & { type: string; isNumeric: true } {
  const vals = rows
    .map((r) => Number(r[pair.name]))
    .filter((n) => Number.isFinite(n));
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  return {
    name: pair.name,
    type: "number",
    unique: new Set(vals).size,
    missing: rows.length - vals.length,
    isNumeric: true,
    isDate: false,
    min: vals.length ? Math.min(...vals) : null,
    max: vals.length ? Math.max(...vals) : null,
    mean,
    stddev: vals.length
      ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length)
      : 0,
    role: "metric",
  };
}
