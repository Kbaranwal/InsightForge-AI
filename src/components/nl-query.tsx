import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Loader2, Sparkles, Pin, PinOff, HelpCircle, History, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartRenderer } from "@/components/chart-renderer";
import { interpretQuery, listPinnedWidgets, pinWidget, unpinWidget } from "@/lib/insights.functions";
import { executeIntent, type QueryIntent, type QueryResult } from "@/lib/analysis/nl-query";
import type { RoleColumn } from "@/lib/analysis/column-roles";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const RECENT_LIMIT = 5;
const recentKey = (id: string) => `insightiq:recent-queries:${id}`;

function loadRecent(id: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(recentKey(id));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as string[]).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveRecent(id: string, list: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(recentKey(id), JSON.stringify(list.slice(0, RECENT_LIMIT)));
  } catch { /* storage unavailable — recents are non-critical */ }
}

/** Renders one computed result: chart + one-line answer. */
function ResultCard({
  result, onPin, pinned, onUnpin, busy,
}: {
  result: QueryResult;
  onPin?: () => void;
  onUnpin?: () => void;
  pinned?: boolean;
  busy?: boolean;
}) {
  const rows = useMemo(
    () => result.rows.map((r) => ({ label: r.label, value: r.value })),
    [result.rows],
  );
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="font-semibold truncate">{result.spec.title}</div>
          <div className="text-xs text-muted-foreground mt-1">{result.spec.description}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground border border-border rounded-full px-2 py-0.5">
            {result.chartType}
          </span>
          {onPin && (
            <Button size="sm" variant="outline" className="gap-1.5 h-7" onClick={onPin} disabled={busy}>
              <Pin className="size-3.5" /> Pin
            </Button>
          )}
          {onUnpin && (
            <Button size="sm" variant="ghost" className="gap-1.5 h-7" onClick={onUnpin} disabled={busy}>
              <PinOff className="size-3.5" /> Unpin
            </Button>
          )}
          {pinned && !onUnpin && <span className="text-[10px] text-primary">pinned</span>}
        </div>
      </div>
      {result.chartType === "table" ? (
        <div className="py-6 text-center">
          <div className="text-4xl font-bold tabular-nums">{result.rows[0].value.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground mt-2">{result.spec.description}</div>
        </div>
      ) : (
        <ChartRenderer spec={result.spec} rows={rows} />
      )}
      <div className="text-sm mt-3 pt-3 border-t border-border">
        <span className="text-primary font-medium inline-flex items-center gap-1.5">
          <Sparkles className="size-3.5" /> Answer:{" "}
        </span>
        {result.answer}
      </div>
    </div>
  );
}

export function NaturalLanguageQuery({
  datasetId, rows, columns, rowCount,
}: {
  datasetId: string;
  rows: Array<Record<string, unknown>>;
  columns: RoleColumn[];
  rowCount: number;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [question, setQuestion] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [clarification, setClarification] = useState<string | null>(null);

  useEffect(() => {
    setRecent(loadRecent(datasetId));
    setResult(null);
    setClarification(null);
  }, [datasetId]);

  const pinnedQuery = useQuery({
    queryKey: ["pinned", datasetId],
    queryFn: () => listPinnedWidgets({ data: { id: datasetId } }),
  });

  const ask = useMutation({
    mutationFn: (q: string) => interpretQuery({ data: { id: datasetId, question: q } }),
    onSuccess: (intent, q) => {
      const next = [q, ...recent.filter((r) => r !== q)].slice(0, RECENT_LIMIT);
      setRecent(next);
      saveRecent(datasetId, next);
      if (intent.clarification) {
        setResult(null);
        setClarification(intent.clarification);
        return;
      }
      const computed = executeIntent(rows, intent, columns, rowCount);
      if (!computed) {
        setResult(null);
        setClarification("That query returned no matching rows. Try widening the filter or asking about another column.");
        return;
      }
      setClarification(null);
      setResult(computed);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Query failed"),
  });

  const pin = useMutation({
    mutationFn: (r: QueryResult) =>
      pinWidget({ data: { id: datasetId, question: question || r.spec.title, intent: r.intent as unknown as Record<string, unknown> } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pinned", datasetId] });
      toast.success("Pinned to dashboard");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not pin"),
  });

  const unpin = useMutation({
    mutationFn: (widgetId: string) => unpinWidget({ data: { widgetId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pinned", datasetId] });
      toast.success("Widget removed");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not remove"),
  });

  function submit(q: string) {
    const trimmed = q.trim();
    if (!trimmed || ask.isPending) return;
    setQuestion(trimmed);
    ask.mutate(trimmed);
  }

  const pinnedResults = useMemo(() => {
    const list = pinnedQuery.data ?? [];
    return list
      .map((w) => {
        const computed = executeIntent(rows, w.intent as unknown as QueryIntent, columns, rowCount);
        return computed ? { widgetId: w.id, question: w.question, result: computed } : null;
      })
      .filter((v): v is { widgetId: string; question: string; result: QueryResult } => v !== null);
  }, [pinnedQuery.data, rows, columns, rowCount]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border glass p-4">
        <form
          onSubmit={(e) => { e.preventDefault(); submit(question); }}
          className="flex flex-col sm:flex-row gap-2"
        >
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask your data anything…  e.g. total revenue by region"
              className="pl-9"
              aria-label="Ask your data anything"
            />
            {question && (
              <button
                type="button"
                onClick={() => { setQuestion(""); inputRef.current?.focus(); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear question"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <Button type="submit" className="gap-2 btn-shine" disabled={ask.isPending || !question.trim()}>
            {ask.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {ask.isPending ? "Thinking…" : "Ask"}
          </Button>
        </form>

        {recent.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
              <History className="size-3" /> Recent
            </span>
            {recent.map((r) => (
              <button
                key={r}
                onClick={() => submit(r)}
                className={cn(
                  "text-xs px-3 py-1 rounded-full border border-border text-muted-foreground",
                  "hover:border-primary/40 hover:text-foreground hover:bg-primary/5 transition max-w-[18rem] truncate",
                )}
              >
                {r}
              </button>
            ))}
          </div>
        )}
      </div>

      <AnimatePresence mode="wait">
        {ask.isPending && (
          <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Skeleton className="h-72 rounded-xl" />
          </motion.div>
        )}

        {!ask.isPending && clarification && (
          <motion.div
            key="clarify"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="rounded-xl border border-warning/40 bg-warning/5 p-5 flex items-start gap-3"
          >
            <HelpCircle className="size-5 text-warning mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Need a bit more detail</div>
              <p className="text-sm text-muted-foreground mt-1">{clarification}</p>
            </div>
          </motion.div>
        )}

        {!ask.isPending && result && (
          <motion.div key="result" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <ResultCard result={result} onPin={() => pin.mutate(result)} busy={pin.isPending} />
          </motion.div>
        )}
      </AnimatePresence>

      {pinnedResults.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-medium text-muted-foreground inline-flex items-center gap-1.5">
            <Pin className="size-3" /> Pinned widgets
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {pinnedResults.map((p) => (
              <ResultCard
                key={p.widgetId}
                result={p.result}
                pinned
                onUnpin={() => unpin.mutate(p.widgetId)}
                busy={unpin.isPending}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
