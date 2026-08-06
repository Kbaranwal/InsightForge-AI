import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Activity, AlertCircle, Sparkles, Upload, FileText, Trash2, BookOpen } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { listAuditLogs } from "@/lib/datasets.functions";

export const Route = createFileRoute("/_authenticated/activity")({
  component: ActivityPage,
  head: () => ({ meta: [{ title: "Activity — InsightForge AI" }, { name: "robots", content: "noindex" }] }),
});

const ACTION_META: Record<string, { label: string; icon: typeof Sparkles; tone: string }> = {
  "dataset.create": { label: "Dataset uploaded", icon: Upload, tone: "text-accent" },
  "dataset.delete": { label: "Dataset deleted", icon: Trash2, tone: "text-destructive" },
  "analysis.run": { label: "Analysis run", icon: Sparkles, tone: "text-primary" },
  "report.generate": { label: "Report generated", icon: BookOpen, tone: "text-success" },
  "chat.message": { label: "Chat message", icon: FileText, tone: "text-muted-foreground" },
};

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function ActivityPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["audit-logs"],
    queryFn: () => listAuditLogs(),
  });

  return (
    <div className="container-page py-6 md:py-8">
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="size-6 text-accent" /> Activity
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every action taken on your workspace, including AI runs and dataset changes. Last 200 events.
        </p>
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6">
          <AlertCircle className="size-5 text-destructive mb-2" />
          <div className="font-medium">Couldn't load activity</div>
          <div className="text-sm text-muted-foreground mt-1">{(error as Error).message}</div>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => refetch()}>Retry</Button>
        </div>
      )}

      {data && data.length === 0 && (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <Activity className="size-8 text-muted-foreground mx-auto mb-3" />
          <div className="font-medium">No activity yet</div>
          <p className="text-sm text-muted-foreground mt-1">Upload your first dataset to see activity here.</p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="rounded-xl border border-border bg-card divide-y divide-border">
          {data.map((row, i) => {
            const meta = ACTION_META[row.action] ?? { label: row.action, icon: FileText, tone: "text-muted-foreground" };
            const Icon = meta.icon;
            const m = row.metadata as Record<string, unknown> | null;
            return (
              <motion.div key={row.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.015, 0.4) }}
                className="flex items-center gap-4 px-4 py-3">
                <div className={`size-9 rounded-lg border border-border bg-background flex items-center justify-center ${meta.tone}`}>
                  <Icon className="size-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{meta.label}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {row.resource_type ?? "—"}
                    {m && Object.keys(m).length > 0 && (
                      <> · <span className="font-mono">{Object.entries(m).slice(0, 3).map(([k, v]) => `${k}=${String(v)}`).join(" ")}</span></>
                    )}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground shrink-0">{timeAgo(row.created_at)}</div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
