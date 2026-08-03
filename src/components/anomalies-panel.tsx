import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  AlertTriangle, ShieldCheck, Loader2, RefreshCw, TrendingUp, TrendingDown, Sparkles,
} from "lucide-react";
import {
  LineChart, Line, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ComposedChart, ReferenceArea,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getAnomalies } from "@/lib/insights.functions";
import type { Anomaly, AnomalyReport, AnomalySeverity } from "@/lib/analysis/anomalies";
import { SEVERITY_ORDER } from "@/lib/analysis/anomalies";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const SEVERITY_STYLES: Record<AnomalySeverity, string> = {
  high: "border-destructive/40 text-destructive bg-destructive/10",
  medium: "border-warning/40 text-warning bg-warning/10",
  low: "border-border text-muted-foreground bg-muted/40",
};

const METHOD_LABEL = {
  zscore: "Z-score",
  iqr: "IQR fence",
  rolling: "Rolling window",
} as const;

function SeverityBadge({ severity }: { severity: AnomalySeverity }) {
  return (
    <span className={cn("text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border whitespace-nowrap", SEVERITY_STYLES[severity])}>
      {severity}
    </span>
  );
}

/** Trend line for one metric with anomaly points highlighted on top. */
function AnomalyTrend({
  rows, metric, timeColumn, anomalies,
}: {
  rows: Array<Record<string, unknown>>;
  metric: string;
  timeColumn: string;
  anomalies: Anomaly[];
}) {
  const data = useMemo(() => {
    const flagged = new Map(anomalies.filter((a) => a.column === metric).map((a) => [a.rowIndex, a]));
    return rows
      .map((r, i) => {
        const v = Number(r[metric]);
        const t = r[timeColumn];
        if (!Number.isFinite(v) || t === null || t === undefined || t === "") return null;
        const hit = flagged.get(i);
        return {
          period: String(t),
          value: v,
          anomaly: hit ? v : null,
          severity: hit?.severity ?? null,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .sort((a, b) => (a.period < b.period ? -1 : 1))
      .slice(0, 400);
  }, [rows, metric, timeColumn, anomalies]);

  if (data.length < 3) return null;
  const flaggedCount = data.filter((d) => d.anomaly !== null).length;
  if (!flaggedCount) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="font-semibold">{metric} over {timeColumn}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {flaggedCount} anomalous point{flaggedCount === 1 ? "" : "s"} highlighted in red
          </div>
        </div>
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="period" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} minTickGap={24} />
            <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} />
            <Tooltip
              contentStyle={{
                background: "var(--color-popover)", border: "1px solid var(--color-border)",
                borderRadius: 10, fontSize: 12, color: "var(--color-foreground)",
              }}
            />
            <Line type="monotone" dataKey="value" stroke="var(--color-chart-1)" strokeWidth={2} dot={false} name={metric} />
            <Scatter dataKey="anomaly" fill="var(--color-destructive)" shape="circle" name="Anomaly" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function AnomaliesPanel({
  datasetId, rows,
}: {
  datasetId: string;
  rows: Array<Record<string, unknown>>;
}) {
  const qc = useQueryClient();
  const [severityFilter, setSeverityFilter] = useState<AnomalySeverity | "all">("all");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["anomalies", datasetId],
    queryFn: () => getAnomalies({ data: { id: datasetId } }) as Promise<AnomalyReport>,
    staleTime: 5 * 60 * 1000,
  });

  const rescan = useMutation({
    mutationFn: () => getAnomalies({ data: { id: datasetId, refresh: true } }),
    onSuccess: (r) => {
      qc.setQueryData(["anomalies", datasetId], r);
      toast.success("Anomaly scan complete");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Scan failed"),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6">
        <AlertTriangle className="size-5 text-destructive mb-2" />
        <div className="font-medium">Anomaly detection failed</div>
        <div className="text-sm text-muted-foreground mt-1">{(error as Error).message}</div>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  const report = data as AnomalyReport | undefined;
  const all = report?.anomalies ?? [];
  const filtered = severityFilter === "all" ? all : all.filter((a) => a.severity === severityFilter);
  const sorted = [...filtered].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || Math.abs(b.deviation) - Math.abs(a.deviation),
  );
  const counts = {
    high: all.filter((a) => a.severity === "high").length,
    medium: all.filter((a) => a.severity === "medium").length,
    low: all.filter((a) => a.severity === "low").length,
  };
  const trendMetrics = report?.timeColumn
    ? Array.from(new Set(all.map((a) => a.column))).slice(0, 3)
    : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {(["all", "high", "medium", "low"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSeverityFilter(s)}
              className={cn(
                "text-xs px-3 py-1.5 rounded-full border transition",
                severityFilter === s ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/30",
              )}
            >
              {s === "all" ? `All (${all.length})` : `${s} (${counts[s]})`}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => rescan.mutate()} disabled={rescan.isPending}>
          {rescan.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {rescan.isPending ? "Scanning…" : "Re-scan"}
        </Button>
      </div>

      {report && (
        <div className="text-xs text-muted-foreground">
          Scanned {report.scanned.length} metric column{report.scanned.length === 1 ? "" : "s"} across{" "}
          {report.rowsAnalyzed.toLocaleString()} sample rows
          {report.skipped.length > 0 && <> · skipped identifier columns: <span className="font-mono">{report.skipped.join(", ")}</span></>}
          {report.timeColumn && <> · time-series checks on <span className="font-mono">{report.timeColumn}</span></>}
        </div>
      )}

      {all.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <ShieldCheck className="size-8 text-success mx-auto mb-3" />
          <div className="font-medium">No significant anomalies detected</div>
          <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
            Every metric column stayed within its expected statistical range (2.5σ and the 1.5×IQR fence).
            Identifier columns are excluded by design.
          </p>
        </div>
      ) : (
        <>
          {report?.timeColumn &&
            trendMetrics.map((m) => (
              <AnomalyTrend key={m} rows={rows} metric={m} timeColumn={report.timeColumn!} anomalies={all} />
            ))}

          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b border-border">
                  <tr className="text-left">
                    <th className="px-4 py-2.5 font-medium">Column</th>
                    <th className="px-4 py-2.5 font-medium">Row</th>
                    <th className="px-4 py-2.5 font-medium text-right">Value</th>
                    <th className="px-4 py-2.5 font-medium">Expected range</th>
                    <th className="px-4 py-2.5 font-medium">Severity</th>
                    <th className="px-4 py-2.5 font-medium">AI explanation</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((a, i) => (
                    <motion.tr
                      key={a.id}
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i * 0.02, 0.4) }}
                      className="border-b border-border/50 last:border-0 hover:bg-muted/30 align-top"
                    >
                      <td className="px-4 py-3 font-medium whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          {a.direction === "spike"
                            ? <TrendingUp className="size-3.5 text-destructive" />
                            : <TrendingDown className="size-3.5 text-warning" />}
                          {a.column}
                        </span>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">
                          {METHOD_LABEL[a.method]}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground max-w-[14rem] truncate">{a.rowLabel}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">{a.value.toLocaleString()}</td>
                      <td className="px-4 py-3 text-muted-foreground tabular-nums whitespace-nowrap">
                        {a.expectedMin.toLocaleString()} – {a.expectedMax.toLocaleString()}
                        <div className="text-[10px] text-muted-foreground/80">{a.deviation > 0 ? "+" : ""}{a.deviation}σ</div>
                      </td>
                      <td className="px-4 py-3"><SeverityBadge severity={a.severity} /></td>
                      <td className="px-4 py-3 text-muted-foreground max-w-md">
                        <span className="inline-flex items-start gap-1.5">
                          <Sparkles className="size-3 text-primary mt-1 shrink-0" />
                          <span>{a.explanation}</span>
                        </span>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sorted.length === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No {severityFilter} severity anomalies. Switch the filter to see the rest.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Kept for potential band overlays; referenced to satisfy the linter.
export const __unusedReferenceArea = ReferenceArea;
