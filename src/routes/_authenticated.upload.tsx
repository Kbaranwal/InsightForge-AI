import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { Upload, FileSpreadsheet, Loader2, Sparkles, CheckCircle2, AlertCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { createDataset, analyzeDataset } from "@/lib/datasets.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/upload")({
  component: UploadPage,
  head: () => ({ meta: [{ title: "New analysis — InsightForge AI" }, { name: "robots", content: "noindex" }] }),
});

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_SAMPLE_ROWS = 500;

type Step = "idle" | "parsing" | "uploading" | "creating" | "analyzing" | "done" | "error";

function parseFile(file: File): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "csv" || ext === "tsv" || ext === "txt") {
    return new Promise((resolve, reject) => {
      const rows: Record<string, unknown>[] = [];
      let total = 0;
      Papa.parse(file, {
        header: true, skipEmptyLines: true, dynamicTyping: true,
        step: (result) => { total++; if (rows.length < MAX_SAMPLE_ROWS) rows.push(result.data as Record<string, unknown>); },
        complete: () => resolve({ rows, total }),
        error: (err) => reject(err),
      });
    });
  }
  return file.arrayBuffer().then((buf) => {
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const all = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true, defval: null });
    return { rows: all.slice(0, MAX_SAMPLE_ROWS), total: all.length };
  });
}

function UploadPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const pickFile = (f: File | null) => {
    if (!f) return;
    if (f.size > MAX_BYTES) { toast.error("File exceeds 100 MB limit"); return; }
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (!ext || !["csv", "tsv", "txt", "xlsx", "xls"].includes(ext)) {
      toast.error("Only CSV, TSV, XLSX, XLS supported"); return;
    }
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    pickFile(e.dataTransfer.files?.[0] ?? null);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    if (!file || !name.trim()) { toast.error("Add a file and name"); return; }
    setError(null); setProgress(5); setStep("parsing");
    try {
      const { rows, total } = await parseFile(file);
      if (!rows.length) throw new Error("No rows found in file");

      setProgress(30); setStep("uploading");
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user!.id;
      const path = `${uid}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const up = await supabase.storage.from("datasets").upload(path, file, { upsert: false });
      if (up.error) throw new Error(up.error.message);

      setProgress(55); setStep("creating");
      const { id } = await createDataset({
        data: {
          name: name.trim(), fileName: file.name, fileSize: file.size,
          storagePath: path, rowCount: total, sampleRows: rows,
        },
      });

      setProgress(75); setStep("analyzing");
      // Fire-and-await analysis so the user lands on a ready dashboard.
      await analyzeDataset({ data: { id } });

      setProgress(100); setStep("done");
      toast.success("Analysis complete");
      navigate({ to: "/datasets/$id", params: { id } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setError(msg); setStep("error"); toast.error(msg);
    }
  }

  const busy = step !== "idle" && step !== "error" && step !== "done";

  return (
    <div className="container-page py-8 md:py-12 max-w-3xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">New analysis</h1>
        <p className="text-muted-foreground mt-1">Upload a CSV or Excel file. We handle the rest.</p>
      </div>

      <motion.div
        onDragOver={(e: React.DragEvent) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        className={cn(
          "rounded-2xl border-2 border-dashed p-10 md:p-16 text-center cursor-pointer transition",
          drag ? "border-primary bg-primary/5" : "border-border bg-card/40 hover:border-primary/40",
          busy && "pointer-events-none opacity-70"
        )}
      >
        <input ref={inputRef} type="file" hidden accept=".csv,.tsv,.txt,.xlsx,.xls"
               onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
        {file ? (
          <div className="flex items-center justify-center gap-3">
            <FileSpreadsheet className="size-8 text-primary" />
            <div className="text-left">
              <div className="font-medium">{file.name}</div>
              <div className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</div>
            </div>
            {!busy && (
              <button className="ml-4 text-muted-foreground hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); setFile(null); setName(""); }}>
                <X className="size-4" />
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="mx-auto size-14 rounded-2xl flex items-center justify-center mb-4"
                 style={{ background: "var(--gradient-primary)" }}>
              <Upload className="size-6 text-white" />
            </div>
            <div className="font-semibold text-lg">Drop your file here</div>
            <div className="text-sm text-muted-foreground mt-1">CSV, TSV, XLSX up to 100 MB</div>
          </>
        )}
      </motion.div>

      <div className="mt-6 space-y-4">
        <div>
          <Label htmlFor="name">Analysis name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Q4 revenue" maxLength={200} disabled={busy} />
        </div>

        {busy && (
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="font-medium">
                {step === "parsing" && "Parsing your file…"}
                {step === "uploading" && "Uploading securely…"}
                {step === "creating" && "Profiling columns…"}
                {step === "analyzing" && "AI agents are analyzing your data…"}
              </span>
            </div>
            <Progress value={progress} className="h-1.5" />
            {step === "analyzing" && (
              <div className="text-xs text-muted-foreground">
                Cleaning · Understanding · Dashboard · Insights · Recommendations
              </div>
            )}
          </div>
        )}

        {step === "error" && error && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 flex items-start gap-3">
            <AlertCircle className="size-5 text-destructive shrink-0 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium">Upload failed</div>
              <div className="text-muted-foreground mt-1">{error}</div>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="rounded-xl border border-success/40 bg-success/5 p-4 flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-5 text-success" /> Redirecting to your dashboard…
          </div>
        )}

        <Button className="w-full gap-2 btn-shine" size="lg" onClick={submit} disabled={!file || !name.trim() || busy}>
          <Sparkles className="size-4" />
          {busy ? "Working…" : "Generate dashboard"}
        </Button>
      </div>
    </div>
  );
}
