import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Upload, Database, MoreVertical, Trash2, ExternalLink, Loader2, Sparkles, FileSpreadsheet, AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { listDatasets, deleteDataset, analyzeDataset } from "@/lib/datasets.functions";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
  head: () => ({ meta: [{ title: "Dashboard — InsightIQ" }, { name: "robots", content: "noindex" }] }),
});

function statusBadge(status: string) {
  const map: Record<string, string> = {
    ready: "bg-success/15 text-success border-success/30",
    analyzing: "bg-accent/15 text-accent border-accent/30",
    uploaded: "bg-muted text-muted-foreground border-border",
    failed: "bg-destructive/15 text-destructive border-destructive/30",
  };
  return map[status] ?? map.uploaded;
}

function DashboardPage() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["datasets"],
    queryFn: () => listDatasets(),
    refetchInterval: (q) => {
      const rows = (q.state.data as Array<{ status: string }> | undefined) ?? [];
      return rows.some((r) => r.status === "analyzing") ? 3000 : false;
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteDataset({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["datasets"] }); toast.success("Dataset deleted"); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed"),
  });
  const reAnalyze = useMutation({
    mutationFn: (id: string) => analyzeDataset({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["datasets"] }); toast.success("Re-running analysis"); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Analysis failed"),
  });

  return (
    <div className="container-page py-8 md:py-12">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Your datasets</h1>
          <p className="text-muted-foreground mt-1">Upload data, get a dashboard, chat with the results.</p>
        </div>
        <Link to="/upload">
          <Button className="gap-2 btn-shine"><Upload className="size-4" /> New analysis</Button>
        </Link>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 flex items-start gap-3">
          <AlertCircle className="size-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium">Couldn't load datasets</div>
            <div className="text-sm text-muted-foreground mt-1">{(error as Error).message}</div>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>Retry</Button>
          </div>
        </div>
      )}

      {data && data.length === 0 && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border border-dashed border-border p-12 md:p-16 text-center bg-card/40">
          <div className="mx-auto size-14 rounded-2xl flex items-center justify-center mb-4"
               style={{ background: "var(--gradient-primary)" }}>
            <Sparkles className="size-6 text-white" />
          </div>
          <h2 className="text-xl font-semibold">Upload your first dataset</h2>
          <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
            Drop in a CSV or Excel file and InsightIQ will generate the entire dashboard automatically. No chart setup.
          </p>
          <Link to="/upload" className="inline-block mt-6">
            <Button className="gap-2 btn-shine"><Upload className="size-4" /> Upload data</Button>
          </Link>
        </motion.div>
      )}

      {data && data.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.map((d, i) => (
            <motion.div key={d.id}
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}
              className="group rounded-xl border border-border bg-card p-5 hover:border-primary/40 transition relative">
              <div className="flex items-start justify-between">
                <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <FileSpreadsheet className="size-5 text-primary" />
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="size-8 opacity-60 group-hover:opacity-100">
                      <MoreVertical className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => reAnalyze.mutate(d.id)}>
                      <Sparkles className="size-4 mr-2" /> Re-run analysis
                    </DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive" onClick={() => {
                      if (confirm(`Delete "${d.name}"? This cannot be undone.`)) del.mutate(d.id);
                    }}>
                      <Trash2 className="size-4 mr-2" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Link to="/datasets/$id" params={{ id: d.id }} className="block mt-4">
                <div className="font-semibold truncate">{d.name}</div>
                <div className="text-xs text-muted-foreground mt-1 truncate">{d.file_name}</div>
                <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><Database className="size-3" />{d.row_count.toLocaleString()} rows</span>
                  <span>·</span>
                  <span>{d.column_count} cols</span>
                  <span>·</span>
                  <span>{formatDistanceToNow(new Date(d.created_at), { addSuffix: true })}</span>
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${statusBadge(d.status)} inline-flex items-center gap-1.5`}>
                    {d.status === "analyzing" && <Loader2 className="size-3 animate-spin" />}
                    {d.status}
                  </span>
                  <ExternalLink className="size-3.5 text-muted-foreground group-hover:text-foreground transition" />
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
