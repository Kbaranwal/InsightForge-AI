import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  ArrowLeft, Sparkles, Loader2, AlertCircle, TrendingUp, TrendingDown, Minus, Lightbulb,
  AlertTriangle, Target, FileText, Download, LineChart as LineChartIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { ChartRenderer } from "@/components/chart-renderer";
import { ChatPanel } from "@/components/chat-panel";
import { getDataset, analyzeDataset } from "@/lib/datasets.functions";
import type { Dashboard, Insights, Understanding, Forecast } from "@/lib/datasets.functions";
import { exportCSV, exportExcel, exportPDF, exportPPTX, exportDOCX, type ExportPayload } from "@/lib/exports";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/datasets/$id")({
  component: DatasetDetail,
  head: () => ({ meta: [{ title: "Analysis — InsightIQ" }, { name: "robots", content: "noindex" }] }),
});

function DatasetDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dataset", id],
    queryFn: () => getDataset({ data: { id } }),
    refetchInterval: (q) => {
      const s = (q.state.data as { dataset?: { status?: string } } | undefined)?.dataset?.status;
      return s === "analyzing" ? 3000 : false;
    },
  });

  const rerun = useMutation({
    mutationFn: () => analyzeDataset({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dataset", id] }); toast.success("Analysis restarted"); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  if (isLoading) {
    return (
      <div className="container-page py-8 space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="container-page py-12">
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6">
          <AlertCircle className="size-5 text-destructive mb-2" />
          <div className="font-medium">Couldn't load this analysis</div>
          <div className="text-sm text-muted-foreground mt-1">{(error as Error)?.message ?? "Unknown error"}</div>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => refetch()}>Retry</Button>
        </div>
      </div>
    );
  }

  const { dataset, analysis } = data;
  const dashboard = analysis?.dashboard as Dashboard | null;
  const insights = analysis?.insights as { insights: Insights["insights"]; anomalies: Insights["anomalies"] } | null;
  const recommendations = analysis?.recommendations as Insights["recommendations"] | null;
  const understanding = analysis?.understanding as Understanding | null;

  return (
    <div className="container-page py-6 md:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="min-w-0">
          <button onClick={() => navigate({ to: "/dashboard" })}
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-2">
            <ArrowLeft className="size-3" /> Back to datasets
          </button>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight truncate">{dashboard?.title ?? dataset.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {dataset.row_count.toLocaleString()} rows · {dataset.column_count} columns
            {understanding?.domain && <> · <span className="text-accent">{understanding.domain}</span></>}
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => rerun.mutate()} disabled={rerun.isPending}>
          <Sparkles className="size-4" /> {rerun.isPending ? "Restarting…" : "Re-run analysis"}
        </Button>
      </div>

      {dataset.status === "analyzing" && (
        <div className="rounded-xl border border-accent/40 bg-accent/5 p-6 flex items-center gap-3 mb-6">
          <Loader2 className="size-5 animate-spin text-accent" />
          <div>
            <div className="font-medium">AI agents are working on your data</div>
            <div className="text-xs text-muted-foreground">Cleaning, understanding, generating dashboard and insights. This usually takes 20–60 seconds.</div>
          </div>
        </div>
      )}

      {dataset.status === "failed" && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 mb-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="size-5 text-destructive mt-0.5" />
            <div className="flex-1">
              <div className="font-medium">Analysis failed</div>
              <div className="text-sm text-muted-foreground mt-1">{dataset.error_message}</div>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => rerun.mutate()}>Retry analysis</Button>
            </div>
          </div>
        </div>
      )}

      {dataset.status === "ready" && dashboard && (
        <Tabs defaultValue="dashboard">
          <TabsList>
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="insights">Insights</TabsTrigger>
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="data">Data</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="mt-6 space-y-6">
            {analysis?.executive_summary && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="rounded-xl border border-border glass p-6">
                <div className="text-xs text-primary font-medium mb-2 inline-flex items-center gap-1.5">
                  <FileText className="size-3.5" /> Executive summary
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-line">{analysis.executive_summary}</p>
              </motion.div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {dashboard.kpis.map((k, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="rounded-xl border border-border bg-card p-4">
                  <div className="text-xs text-muted-foreground">{k.label}</div>
                  <div className="text-2xl font-bold mt-1 tabular-nums">{k.value}</div>
                  <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                    {k.trend === "up" && <TrendingUp className="size-3 text-success" />}
                    {k.trend === "down" && <TrendingDown className="size-3 text-destructive" />}
                    {k.trend === "flat" && <Minus className="size-3" />}
                    {k.subvalue ?? k.explanation}
                  </div>
                </motion.div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {dashboard.charts.map((c, i) => (
                <motion.div key={c.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className={`rounded-xl border border-border bg-card p-5 ${c.type === "table" || i === 0 ? "lg:col-span-2" : ""}`}>
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div>
                      <div className="font-semibold">{c.title}</div>
                      <div className="text-xs text-muted-foreground mt-1">{c.description}</div>
                    </div>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground border border-border rounded-full px-2 py-0.5">{c.type}</span>
                  </div>
                  <ChartRenderer spec={c} rows={dataset.sample_rows as Array<Record<string, unknown>>} />
                  <div className="text-xs text-muted-foreground mt-3 pt-3 border-t border-border">
                    <span className="text-primary font-medium">Why: </span>{c.explanation}
                  </div>
                </motion.div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="insights" className="mt-6 space-y-6">
            {insights?.insights && insights.insights.length > 0 && (
              <div>
                <h3 className="font-semibold flex items-center gap-2 mb-3"><Lightbulb className="size-4 text-warning" /> Key insights</h3>
                <div className="grid gap-3">
                  {insights.insights.map((it, i) => (
                    <div key={i} className="rounded-xl border border-border bg-card p-4">
                      <div className="font-medium">{it.title}</div>
                      <p className="text-sm text-muted-foreground mt-1">{it.detail}</p>
                      <div className="text-xs text-accent mt-2">Evidence: {it.evidence}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {insights?.anomalies && insights.anomalies.length > 0 && (
              <div>
                <h3 className="font-semibold flex items-center gap-2 mb-3"><AlertTriangle className="size-4 text-destructive" /> Anomalies</h3>
                <div className="grid gap-3">
                  {insights.anomalies.map((a, i) => (
                    <div key={i} className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                      <div className="font-medium">{a.title}</div>
                      <p className="text-sm text-muted-foreground mt-1">{a.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {recommendations && recommendations.length > 0 && (
              <div>
                <h3 className="font-semibold flex items-center gap-2 mb-3"><Target className="size-4 text-success" /> Recommendations</h3>
                <div className="grid gap-3">
                  {recommendations.map((r, i) => (
                    <div key={i} className="rounded-xl border border-border bg-card p-4">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">{r.title}</div>
                        <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                          r.impact === "high" ? "border-success/40 text-success bg-success/10" :
                          r.impact === "medium" ? "border-warning/40 text-warning bg-warning/10" :
                          "border-border text-muted-foreground"
                        }`}>{r.impact} impact</span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">{r.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="chat" className="mt-6">
            <ChatPanel datasetId={id} datasetName={dataset.name} />
          </TabsContent>

          <TabsContent value="data" className="mt-6">
            <div className="rounded-xl border border-border bg-card overflow-auto max-h-[70vh]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card border-b border-border">
                  <tr>
                    {(dataset.columns as Array<{ name: string; type: string }>).map((c) => (
                      <th key={c.name} className="text-left px-3 py-2 font-medium">
                        {c.name}
                        <span className="ml-2 text-[10px] text-muted-foreground font-mono uppercase">{c.type}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(dataset.sample_rows as Array<Record<string, unknown>>).slice(0, 100).map((row, i) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
                      {(dataset.columns as Array<{ name: string }>).map((c) => (
                        <td key={c.name} className="px-3 py-2 text-muted-foreground max-w-xs truncate">
                          {row[c.name] === null || row[c.name] === undefined ? <span className="opacity-40">—</span> : String(row[c.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="p-3 text-xs text-muted-foreground text-center border-t border-border">
                Showing sample of {Math.min(100, (dataset.sample_rows as unknown[]).length)} rows · full dataset: {dataset.row_count.toLocaleString()} rows
              </div>
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
