import { useMemo } from "react";
import {
  Line, LineChart, Bar, BarChart, Area, AreaChart, Pie, PieChart, Cell,
  Scatter, ScatterChart, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  ReferenceLine, LabelList,
} from "recharts";
import { TrendingUp, TrendingDown, Minus, Trophy, Target, Activity, Sigma } from "lucide-react";

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

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(2) + "K";
  if (abs >= 10) return n.toFixed(0);
  return n.toFixed(2);
}

function aggregate(rows: Array<Record<string, unknown>>, spec: ChartSpec): { rows: Array<Record<string, unknown>>; series: string[] } {
  const { x, y, aggregation, groupBy } = spec;
  if (!x || y.length === 0) return { rows: [], series: [] };

  if (groupBy) {
    const map = new Map<string, Record<string, unknown>>();
    const groups = new Set<string>();
    for (const r of rows) {
      const xv = r[x]; const gv = r[groupBy];
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
    borderRadius: "10px",
    fontSize: "12px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
    color: "var(--color-foreground)",
  },
  labelStyle: { color: "var(--color-foreground)", fontWeight: 600 },
  itemStyle: { color: "var(--color-foreground)" },
};

const CHART_H = 300;

type Stats = {
  total: number; avg: number; min: number; max: number;
  minLabel: string; maxLabel: string;
  count: number;
  firstVal: number; lastVal: number;
  trendPct: number | null;
  topShare: number | null; // for pie: top slice share of total
  topShareLabel: string | null;
};

function computeStats(data: Array<Record<string, unknown>>, xKey: string | null, series: string[]): Stats | null {
  if (!data.length || series.length === 0 || !xKey) return null;
  // Use primary series (sum across series per row for multi-series totals)
  const values: Array<{ label: string; v: number }> = [];
  for (const row of data) {
    let sum = 0; let has = false;
    for (const s of series) {
      const n = coerceNum(row[s]);
      if (n !== null) { sum += n; has = true; }
    }
    if (has) values.push({ label: String(row[xKey] ?? ""), v: sum });
  }
  if (!values.length) return null;
  const nums = values.map((v) => v.v);
  const total = nums.reduce((a, b) => a + b, 0);
  const avg = total / nums.length;
  let minI = 0, maxI = 0;
  values.forEach((v, i) => { if (v.v < values[minI].v) minI = i; if (v.v > values[maxI].v) maxI = i; });
  const firstVal = values[0].v;
  const lastVal = values[values.length - 1].v;
  const trendPct = firstVal !== 0 ? ((lastVal - firstVal) / Math.abs(firstVal)) * 100 : null;
  const topShare = total !== 0 ? (values[maxI].v / total) * 100 : null;
  return {
    total, avg, min: values[minI].v, max: values[maxI].v,
    minLabel: values[minI].label, maxLabel: values[maxI].label,
    count: values.length, firstVal, lastVal, trendPct,
    topShare, topShareLabel: values[maxI].label,
  };
}

function StatChip({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: "up" | "down" | "flat" | "accent" }) {
  const toneClass =
    tone === "up" ? "text-success" :
    tone === "down" ? "text-destructive" :
    tone === "accent" ? "text-primary" : "text-foreground";
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 min-w-0">
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground leading-tight">{label}</div>
        <div className={`text-xs font-semibold tabular-nums truncate ${toneClass}`}>{value}</div>
      </div>
    </div>
  );
}

function InsightBand({ stats, isPie }: { stats: Stats; isPie: boolean }) {
  const bits: string[] = [];
  if (isPie && stats.topShare !== null) {
    bits.push(`“${stats.topShareLabel}” leads with ${stats.topShare.toFixed(1)}% of the total.`);
  } else {
    bits.push(`Peak at “${stats.maxLabel}” (${fmtNum(stats.max)}); low at “${stats.minLabel}” (${fmtNum(stats.min)}).`);
    if (stats.trendPct !== null && Math.abs(stats.trendPct) >= 1) {
      const dir = stats.trendPct > 0 ? "up" : "down";
      bits.push(`Overall trend ${dir} ${Math.abs(stats.trendPct).toFixed(1)}% from start to end.`);
    }
    const aboveAvg = stats.max > stats.avg * 1.5;
    if (aboveAvg) bits.push(`“${stats.maxLabel}” is ${(stats.max / (stats.avg || 1)).toFixed(1)}× the average.`);
  }
  return (
    <div className="mt-3 text-xs text-foreground/80 leading-relaxed rounded-lg bg-primary/5 border border-primary/15 px-3 py-2">
      <span className="text-primary font-semibold">Auto-insight: </span>{bits.join(" ")}
    </div>
  );
}

export function ChartRenderer({ spec, rows }: { spec: ChartSpec; rows: Array<Record<string, unknown>> }) {
  const computed = useMemo(() => aggregate(rows, spec), [rows, spec]);
  const stats = useMemo(() => computeStats(computed.rows, spec.x, computed.series), [computed, spec.x]);

  if (spec.type === "table") {
    const cols = [spec.x, ...spec.y].filter(Boolean) as string[];
    return (
      <div className="overflow-auto max-h-80 rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/60 sticky top-0"><tr>{cols.map((c) => <th key={c} className="text-left px-2 py-2 font-semibold text-foreground">{c}</th>)}</tr></thead>
          <tbody>
            {rows.slice(0, 50).map((r, i) => (
              <tr key={i} className="border-t border-border/50 hover:bg-muted/30">
                {cols.map((c) => <td key={c} className="px-2 py-1.5 text-foreground/90">{String(r[c] ?? "")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!computed.rows.length) {
    return <div className="h-64 flex items-center justify-center text-xs text-muted-foreground">Not enough data to render this chart.</div>;
  }
  const { rows: data, series } = computed;

  const StatsStrip = stats ? (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
      <StatChip icon={<Sigma className="size-3.5" />} label="Total" value={fmtNum(stats.total)} tone="accent" />
      <StatChip icon={<Activity className="size-3.5" />} label="Average" value={fmtNum(stats.avg)} />
      <StatChip icon={<Trophy className="size-3.5" />} label={`Peak · ${stats.maxLabel}`.slice(0, 24)} value={fmtNum(stats.max)} tone="up" />
      <StatChip
        icon={stats.trendPct !== null && stats.trendPct >= 0 ? <TrendingUp className="size-3.5" /> : stats.trendPct !== null ? <TrendingDown className="size-3.5" /> : <Minus className="size-3.5" />}
        label="Trend"
        value={stats.trendPct !== null ? `${stats.trendPct >= 0 ? "+" : ""}${stats.trendPct.toFixed(1)}%` : "—"}
        tone={stats.trendPct === null ? "flat" : stats.trendPct >= 0 ? "up" : "down"}
      />
    </div>
  ) : null;

  if (spec.type === "pie") {
    const y0 = spec.y[0];
    const rawPie = data.map((d) => ({ name: String(d[spec.x!]), value: coerceNum(d[y0]) ?? 0 }))
      .sort((a, b) => b.value - a.value);
    const top = rawPie.slice(0, 5);
    const restVal = rawPie.slice(5).reduce((a, b) => a + b.value, 0);
    const pieData = restVal > 0 ? [...top, { name: "Other", value: restVal }] : top;
    const total = pieData.reduce((a, b) => a + b.value, 0) || 1;
    return (
      <div>
        {StatsStrip}
        <ResponsiveContainer width="100%" height={CHART_H}>
          <PieChart>
            <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={110} paddingAngle={2}
                 stroke="var(--color-background)" strokeWidth={2}
                 label={(e: { name?: string; value?: number }) => `${e.name} · ${(((e.value ?? 0) / total) * 100).toFixed(0)}%`}
                 labelLine={false}>
              {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip {...tooltipStyle} formatter={(v: number, n: string) => [`${fmtNum(v)} (${((v / total) * 100).toFixed(1)}%)`, n]} />
            <Legend wrapperStyle={{ fontSize: 12, color: "var(--color-foreground)" }} />
          </PieChart>
        </ResponsiveContainer>
        {stats && <InsightBand stats={stats} isPie />}
      </div>
    );
  }

  if (spec.type === "scatter") {
    const [xk, yk] = spec.y.length >= 2 ? spec.y : [spec.x!, spec.y[0]];
    const scatter = rows.map((r) => ({ x: coerceNum(r[xk]), y: coerceNum(r[yk]) })).filter((p) => p.x !== null && p.y !== null) as Array<{ x: number; y: number }>;
    // correlation
    let corr: number | null = null;
    if (scatter.length > 2) {
      const n = scatter.length;
      const mx = scatter.reduce((a, b) => a + b.x, 0) / n;
      const my = scatter.reduce((a, b) => a + b.y, 0) / n;
      let num = 0, dx = 0, dy = 0;
      for (const p of scatter) { num += (p.x - mx) * (p.y - my); dx += (p.x - mx) ** 2; dy += (p.y - my) ** 2; }
      corr = dx && dy ? num / Math.sqrt(dx * dy) : null;
    }
    return (
      <div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
          <StatChip icon={<Target className="size-3.5" />} label="Points" value={String(scatter.length)} />
          <StatChip icon={<Activity className="size-3.5" />} label="Correlation" value={corr !== null ? corr.toFixed(2) : "—"} tone={corr !== null ? (corr > 0 ? "up" : "down") : "flat"} />
          <StatChip icon={<Sigma className="size-3.5" />} label={`Avg ${xk}`} value={fmtNum(scatter.reduce((a, b) => a + b.x, 0) / (scatter.length || 1))} />
          <StatChip icon={<Sigma className="size-3.5" />} label={`Avg ${yk}`} value={fmtNum(scatter.reduce((a, b) => a + b.y, 0) / (scatter.length || 1))} />
        </div>
        <ResponsiveContainer width="100%" height={CHART_H}>
          <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="var(--color-border)" strokeOpacity={0.6} strokeDasharray="3 3" />
            <XAxis dataKey="x" name={xk} tick={{ fontSize: 12, fill: "var(--color-foreground)" }} stroke="var(--color-muted-foreground)" />
            <YAxis dataKey="y" name={yk} tick={{ fontSize: 12, fill: "var(--color-foreground)" }} stroke="var(--color-muted-foreground)" />
            <Tooltip {...tooltipStyle} cursor={{ strokeDasharray: "3 3" }} />
            <Scatter data={scatter} fill="var(--color-chart-1)" />
          </ScatterChart>
        </ResponsiveContainer>
        {corr !== null && (
          <div className="mt-3 text-xs text-foreground/80 leading-relaxed rounded-lg bg-primary/5 border border-primary/15 px-3 py-2">
            <span className="text-primary font-semibold">Auto-insight: </span>
            {Math.abs(corr) < 0.2 ? `No meaningful correlation between ${xk} and ${yk} (r=${corr.toFixed(2)}).`
              : Math.abs(corr) < 0.5 ? `Weak ${corr > 0 ? "positive" : "negative"} relationship (r=${corr.toFixed(2)}).`
              : Math.abs(corr) < 0.8 ? `Moderate ${corr > 0 ? "positive" : "negative"} correlation (r=${corr.toFixed(2)}).`
              : `Strong ${corr > 0 ? "positive" : "negative"} correlation (r=${corr.toFixed(2)}) — ${xk} and ${yk} move together.`}
          </div>
        )}
      </div>
    );
  }

  const commonProps = { data, margin: { top: 20, right: 16, bottom: 4, left: 0 } } as const;
  const axes = (
    <>
      <CartesianGrid stroke="var(--color-border)" strokeOpacity={0.7} strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey={spec.x!} tick={{ fontSize: 12, fill: "var(--color-foreground)" }} tickLine={false} axisLine={{ stroke: "var(--color-border)" }} />
      <YAxis tick={{ fontSize: 12, fill: "var(--color-foreground)" }} tickLine={false} axisLine={false} width={48} tickFormatter={fmtNum} />
      <Tooltip {...tooltipStyle} cursor={{ fill: "var(--color-muted)", fillOpacity: 0.3 }} formatter={(v: number) => fmtNum(v)} />
      {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: "var(--color-foreground)" }} />}
      {stats && series.length === 1 && (
        <ReferenceLine y={stats.avg} stroke="var(--color-muted-foreground)" strokeDasharray="4 4" strokeOpacity={0.7}
          label={{ value: `Avg ${fmtNum(stats.avg)}`, position: "insideTopRight", fill: "var(--color-muted-foreground)", fontSize: 11 }} />
      )}
    </>
  );

  if (spec.type === "bar") {
    const maxRowIdx = stats ? data.findIndex((r) => String(r[spec.x!]) === stats.maxLabel) : -1;
    return (
      <div>
        {StatsStrip}
        <ResponsiveContainer width="100%" height={CHART_H}>
          <BarChart {...commonProps}>
            {axes}
            {series.map((s, i) => (
              <Bar key={s} dataKey={s} radius={[6, 6, 0, 0]} maxBarSize={48}>
                {data.map((_, idx) => (
                  <Cell key={idx} fill={series.length === 1 && idx === maxRowIdx ? "var(--color-primary)" : COLORS[i % COLORS.length]} />
                ))}
                {series.length === 1 && data.length <= 12 && (
                  <LabelList dataKey={s} position="top" formatter={(v: number) => fmtNum(v)}
                    style={{ fill: "var(--color-foreground)", fontSize: 11, fontWeight: 600 }} />
                )}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
        {stats && <InsightBand stats={stats} isPie={false} />}
      </div>
    );
  }
  if (spec.type === "area") {
    return (
      <div>
        {StatsStrip}
        <ResponsiveContainer width="100%" height={CHART_H}>
          <AreaChart {...commonProps}>
            <defs>
              {series.map((s, i) => (
                <linearGradient key={s} id={`grad-${spec.id}-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0.75} />
                  <stop offset="100%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0.05} />
                </linearGradient>
              ))}
            </defs>
            {axes}
            {series.map((s, i) => (
              <Area key={s} type="monotone" dataKey={s} stroke={COLORS[i % COLORS.length]}
                    strokeWidth={2.5} fill={`url(#grad-${spec.id}-${i})`} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
        {stats && <InsightBand stats={stats} isPie={false} />}
      </div>
    );
  }
  // line default
  return (
    <div>
      {StatsStrip}
      <ResponsiveContainer width="100%" height={CHART_H}>
        <LineChart {...commonProps}>
          {axes}
          {series.map((s, i) => (
            <Line key={s} type="monotone" dataKey={s} stroke={COLORS[i % COLORS.length]}
                  strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 6 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {stats && <InsightBand stats={stats} isPie={false} />}
    </div>
  );
}
