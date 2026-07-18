import { useMemo } from "react";
import {
  Line, LineChart, Bar, BarChart, Area, AreaChart, Pie, PieChart, Cell,
  Scatter, ScatterChart, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";

export type ChartSpec = {
  id: string;
  type: "line" | "bar" | "area" | "pie" | "scatter" | "table";
  title: string;
  description: string;
  x: string | null;
  y: string[];
  groupBy: string | null;
  aggregation: "sum" | "avg" | "count" | "min" | "max" | "none";
  explanation: string;
};

const COLORS = [
  "var(--color-chart-1)", "var(--color-chart-2)", "var(--color-chart-3)",
  "var(--color-chart-4)", "var(--color-chart-5)", "var(--color-chart-6)",
];

function coerceNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function aggregate(rows: Array<Record<string, unknown>>, spec: ChartSpec): { rows: Array<Record<string, unknown>>; series: string[] } {
  const { x, y, aggregation, groupBy } = spec;
  if (!x || y.length === 0) return { rows: [], series: [] };

  if (groupBy) {
    // Pivot: x on axis, groupBy as series
    const map = new Map<string, Record<string, unknown>>();
    const groups = new Set<string>();
    for (const r of rows) {
      const xv = r[x];
      const gv = r[groupBy];
      if (xv === null || xv === undefined) continue;
      const key = String(xv);
      const g = String(gv ?? "—");
      groups.add(g);
      if (!map.has(key)) map.set(key, { [x]: xv });
      const entry = map.get(key)!;
      const num = coerceNum(r[y[0]]);
      if (num === null && aggregation !== "count") continue;
      const cur = coerceNum(entry[g]);
      if (aggregation === "sum" || aggregation === "avg" || aggregation === "count") {
        entry[g] = (cur ?? 0) + (aggregation === "count" ? 1 : num ?? 0);
      } else if (aggregation === "min") entry[g] = cur === null ? num : Math.min(cur, num!);
      else if (aggregation === "max") entry[g] = cur === null ? num : Math.max(cur, num!);
      else entry[g] = num;
    }
    return { rows: Array.from(map.values()), series: Array.from(groups) };
  }

  if (aggregation === "none") {
    return { rows: rows.slice(0, 100).map((r) => ({ [x]: r[x], ...Object.fromEntries(y.map((k) => [k, r[k]])) })), series: y };
  }

  const buckets = new Map<string, { count: number; sums: Record<string, number>; mins: Record<string, number>; maxs: Record<string, number> }>();
  for (const r of rows) {
    const xv = r[x];
    if (xv === null || xv === undefined) continue;
    const key = String(xv);
    if (!buckets.has(key)) buckets.set(key, { count: 0, sums: {}, mins: {}, maxs: {} });
    const b = buckets.get(key)!;
    b.count++;
    for (const k of y) {
      const n = coerceNum(r[k]);
      if (n === null) continue;
      b.sums[k] = (b.sums[k] ?? 0) + n;
      b.mins[k] = b.mins[k] === undefined ? n : Math.min(b.mins[k], n);
      b.maxs[k] = b.maxs[k] === undefined ? n : Math.max(b.maxs[k], n);
    }
  }
  const out = Array.from(buckets.entries()).map(([xv, b]) => {
    const rec: Record<string, unknown> = { [x]: xv };
    for (const k of y) {
      rec[k] = aggregation === "sum" ? b.sums[k] ?? 0 :
               aggregation === "avg" ? (b.count ? (b.sums[k] ?? 0) / b.count : 0) :
               aggregation === "count" ? b.count :
               aggregation === "min" ? b.mins[k] ?? 0 :
               b.maxs[k] ?? 0;
    }
    return rec;
  });
  return { rows: out, series: y };
}

const tooltipStyle = {
  contentStyle: {
    background: "var(--color-popover)",
    border: "1px solid var(--color-border)",
    borderRadius: "8px",
    fontSize: "12px",
  },
  labelStyle: { color: "var(--color-foreground)", fontWeight: 500 },
};

export function ChartRenderer({ spec, rows }: { spec: ChartSpec; rows: Array<Record<string, unknown>> }) {
  const computed = useMemo(() => aggregate(rows, spec), [rows, spec]);

  if (spec.type === "table") {
    const cols = [spec.x, ...spec.y].filter(Boolean) as string[];
    return (
      <div className="overflow-auto max-h-64 rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 sticky top-0"><tr>{cols.map((c) => <th key={c} className="text-left px-2 py-1.5 font-medium">{c}</th>)}</tr></thead>
          <tbody>
            {rows.slice(0, 50).map((r, i) => (
              <tr key={i} className="border-t border-border/50">
                {cols.map((c) => <td key={c} className="px-2 py-1 text-muted-foreground">{String(r[c] ?? "")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!computed.rows.length) {
    return <div className="h-56 flex items-center justify-center text-xs text-muted-foreground">Not enough data to render this chart.</div>;
  }
  const { rows: data, series } = computed;

  if (spec.type === "pie") {
    const y0 = spec.y[0];
    const pieData = data.map((d) => ({ name: String(d[spec.x!]), value: coerceNum(d[y0]) ?? 0 })).slice(0, 6);
    return (
      <ResponsiveContainer width="100%" height={240}>
        <PieChart>
          <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={85} paddingAngle={2}>
            {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
          </Pie>
          <Tooltip {...tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    );
  }
  if (spec.type === "scatter") {
    const [xk, yk] = spec.y.length >= 2 ? spec.y : [spec.x!, spec.y[0]];
    const scatter = rows.map((r) => ({ x: coerceNum(r[xk]), y: coerceNum(r[yk]) })).filter((p) => p.x !== null && p.y !== null);
    return (
      <ResponsiveContainer width="100%" height={240}>
        <ScatterChart>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
          <XAxis dataKey="x" name={xk} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} />
          <YAxis dataKey="y" name={yk} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} />
          <Tooltip {...tooltipStyle} cursor={{ strokeDasharray: "3 3" }} />
          <Scatter data={scatter} fill="var(--color-chart-1)" />
        </ScatterChart>
      </ResponsiveContainer>
    );
  }

  const commonProps = {
    data,
    margin: { top: 4, right: 8, bottom: 0, left: -8 },
  } as const;
  const axes = (
    <>
      <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey={spec.x!} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
      <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
      <Tooltip {...tooltipStyle} />
      {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
    </>
  );

  if (spec.type === "bar") {
    return (
      <ResponsiveContainer width="100%" height={240}>
        <BarChart {...commonProps}>
          {axes}
          {series.map((s, i) => <Bar key={s} dataKey={s} fill={COLORS[i % COLORS.length]} radius={[6, 6, 0, 0]} />)}
        </BarChart>
      </ResponsiveContainer>
    );
  }
  if (spec.type === "area") {
    return (
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart {...commonProps}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s} id={`grad-${spec.id}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0.6} />
                <stop offset="100%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          {axes}
          {series.map((s, i) => (
            <Area key={s} type="monotone" dataKey={s} stroke={COLORS[i % COLORS.length]}
                  strokeWidth={2} fill={`url(#grad-${spec.id}-${i})`} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }
  // line default
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart {...commonProps}>
        {axes}
        {series.map((s, i) => (
          <Line key={s} type="monotone" dataKey={s} stroke={COLORS[i % COLORS.length]}
                strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
