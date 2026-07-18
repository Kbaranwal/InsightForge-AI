import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState } from "react";
import { Send, Loader2, Bot, User as UserIcon, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  "What are the top 3 trends?",
  "Summarize this dataset in 3 bullet points",
  "Which column has the most missing values?",
  "Are there any outliers I should investigate?",
];

export function ChatPanel({ datasetId, datasetName }: { datasetId: string; datasetName: string }) {
  const [token, setToken] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setToken(data.session?.access_token ?? null));
  }, []);

  const { messages, input, handleInputChange, handleSubmit, isLoading, error, append } = useChat({
    api: "/api/chat",
    body: { datasetId },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => { inputRef.current?.focus(); }, [datasetId, isLoading]);

  return (
    <div className="rounded-xl border border-border bg-card flex flex-col h-[70vh]">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <div className="size-8 rounded-lg flex items-center justify-center" style={{ background: "var(--gradient-primary)" }}>
          <Bot className="size-4 text-white" />
        </div>
        <div>
          <div className="font-semibold text-sm">Chat with your data</div>
          <div className="text-xs text-muted-foreground">Grounded in "{datasetName}"</div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-4">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <Sparkles className="size-8 text-primary mx-auto mb-3" />
            <div className="text-sm text-muted-foreground">Ask anything about your dataset.</div>
            <div className="mt-4 flex flex-wrap gap-2 justify-center">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => append({ role: "user", content: s })}
                  className="text-xs px-3 py-1.5 rounded-full border border-border hover:border-primary/40 hover:bg-primary/5 transition">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cn("flex gap-3", m.role === "user" && "flex-row-reverse")}>
            <div className={cn("size-7 rounded-full shrink-0 flex items-center justify-center",
              m.role === "user" ? "bg-muted" : "bg-primary/15")}>
              {m.role === "user" ? <UserIcon className="size-3.5" /> : <Bot className="size-3.5 text-primary" />}
            </div>
            <div className={cn("max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
              m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted")}>
              {m.content}
            </div>
          </div>
        ))}
        {isLoading && messages[messages.length - 1]?.role === "user" && (
          <div className="flex gap-3">
            <div className="size-7 rounded-full bg-primary/15 flex items-center justify-center">
              <Bot className="size-3.5 text-primary" />
            </div>
            <div className="bg-muted rounded-2xl px-4 py-3 text-sm inline-flex items-center gap-2">
              <Loader2 className="size-3.5 animate-spin" /> Thinking…
            </div>
          </div>
        )}
        {error && <div className="text-xs text-destructive">{error.message}</div>}
      </div>

      <form onSubmit={handleSubmit} className="p-3 border-t border-border flex gap-2">
        <Textarea
          ref={inputRef}
          value={input}
          onChange={handleInputChange}
          placeholder="Ask about trends, outliers, comparisons…"
          rows={1}
          className="min-h-0 resize-none py-2.5"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
          }}
        />
        <Button type="submit" size="icon" disabled={isLoading || !input.trim()}>
          {isLoading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </form>
    </div>
  );
}
