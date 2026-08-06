import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { motion, useInView } from "framer-motion";
import { ArrowRight, BarChart3, Bot, Sparkles, Upload, Zap, ShieldCheck, LineChart, Wand2, LayoutDashboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

/** Animates a number from 0 to `value` once the element scrolls into view. */
function CountUp({ value, prefix = "", suffix = "", decimals = 0 }: { value: number; prefix?: string; suffix?: string; decimals?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!inView) return;
    const duration = 1200;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(value * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, value]);

  return (
    <span ref={ref}>
      {prefix}
      {display.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  );
}

export const Route = createFileRoute("/")({
  component: Landing,
  head: () => ({
    meta: [
      { title: "InsightForge AI — Turn any dataset into a live AI dashboard" },
      {
        name: "description",
        content:
          "Drop in a CSV and InsightForge AI auto-generates the dashboard, insights, forecasts, and a chat analyst grounded in your data.",
      },
    ],
  }),
});

const features = [
  { icon: Upload, title: "Drop any dataset", desc: "CSV or Excel up to 100 MB. We infer schema, types, and semantic roles automatically." },
  { icon: Sparkles, title: "AI-generated dashboard", desc: "No chart pickers. Our multi-agent AI selects the best KPIs and visualizations for your data." },
  { icon: Bot, title: "Chat with your data", desc: "Ask questions in plain English. Every answer is grounded in your dataset, with explanations." },
  { icon: LineChart, title: "Insights & forecasts", desc: "Anomalies, trends, and recommendations surfaced automatically — never fake, always explainable." },
  { icon: ShieldCheck, title: "Private by default", desc: "Row-level security, per-user isolation, PII detection. Your data never leaks between accounts." },
  { icon: Zap, title: "Seconds, not sprints", desc: "From upload to executive-ready dashboard in under a minute for typical datasets." },
];

function Landing() {
  return (
    <div className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 -z-10" style={{ background: "var(--gradient-mesh)" }} />
      <div className="absolute inset-0 -z-10 grid-bg opacity-40" />

      <header className="container-page flex items-center justify-between py-6">
        <Link to="/" className="flex items-center gap-2 font-semibold text-lg">
          <div className="size-8 rounded-lg flex items-center justify-center" style={{ background: "var(--gradient-primary)" }}>
            <BarChart3 className="size-4 text-white" />
          </div>
          InsightForge AI
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link to="/auth">
            <Button variant="ghost" size="sm">Sign in</Button>
          </Link>
          <Link to="/auth">
            <Button size="sm" className="btn-shine">Get started</Button>
          </Link>
        </div>
      </header>

      <section className="container-page pt-16 pb-24 md:pt-28 md:pb-32 text-center relative">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-card/50 text-xs text-muted-foreground mb-6"
        >
          <span className="size-1.5 rounded-full bg-success" /> Multi-agent AI · real-time insight engine
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.05 }}
          className="text-5xl md:text-7xl font-bold tracking-tight max-w-4xl mx-auto leading-[1.05]"
        >
          Upload data. <span className="text-gradient">Get answers.</span>
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.15 }}
          className="mt-6 text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto"
        >
          InsightForge AI turns any spreadsheet into a live dashboard, executive summary, and chat analyst — automatically. No SQL, no chart wizards, no fake numbers.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.25 }}
          className="mt-10 flex flex-wrap items-center justify-center gap-3"
        >
          <Link to="/auth">
            <Button size="lg" className="btn-shine gap-2">
              Start analyzing free <ArrowRight className="size-4" />
            </Button>
          </Link>
          <a href="#features">
            <Button size="lg" variant="outline">See how it works</Button>
          </a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.4 }}
          className="mt-20 mx-auto max-w-5xl rounded-2xl border border-border glass p-2 shadow-card"
        >
          <div className="rounded-xl overflow-hidden bg-card">
            <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border">
              <div className="size-2.5 rounded-full bg-destructive/60" />
              <div className="size-2.5 rounded-full bg-warning/60" />
              <div className="size-2.5 rounded-full bg-success/60" />
              <span className="ml-3 text-xs text-muted-foreground font-mono">insightiq.app/datasets/q4-revenue</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 p-6 bg-gradient-to-b from-transparent to-primary/5">
              {[
                { label: "Total revenue", value: "$1.24M", delta: "+18.2%" },
                { label: "Active accounts", value: "3,412", delta: "+124" },
                { label: "Churn (30d)", value: "2.1%", delta: "-0.4%" },
                { label: "Avg deal size", value: "$3.6k", delta: "+11%" },
              ].map((k) => (
                <div key={k.label} className="rounded-lg border border-border bg-card p-4 text-left">
                  <div className="text-xs text-muted-foreground">{k.label}</div>
                  <div className="text-2xl font-semibold mt-1">{k.value}</div>
                  <div className="text-xs text-success mt-1">{k.delta}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 px-6 pb-6">
              <div className="md:col-span-2 h-48 rounded-lg border border-border bg-card p-4 flex items-end gap-1">
                {Array.from({ length: 32 }).map((_, i) => (
                  <div key={i} className="flex-1 rounded-t" style={{ height: `${20 + Math.sin(i / 3) * 30 + i * 1.4}%`, background: "var(--gradient-primary)", opacity: 0.85 }} />
                ))}
              </div>
              <div className="h-48 rounded-lg border border-border bg-card p-4">
                <div className="text-xs text-muted-foreground">AI Summary</div>
                <p className="text-sm mt-2 leading-relaxed">Revenue is trending up 18% QoQ, driven by enterprise deals. Watch the small dip in week 3 — likely a US holiday effect.</p>
              </div>
            </div>
          </div>
        </motion.div>
      </section>

      <section id="features" className="container-page py-24">
        <div className="max-w-2xl">
          <div className="text-sm text-primary font-medium">The platform</div>
          <h2 className="text-3xl md:text-4xl font-bold mt-2 tracking-tight">
            A team of AI analysts, always on call.
          </h2>
          <p className="text-muted-foreground mt-3">
            Eight specialized agents work together: cleaning your data, understanding it, generating the dashboard, extracting insights, and chatting with you about the results.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-12">
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.4, delay: i * 0.05 }}
              className="rounded-xl border border-border bg-card p-6 hover:border-primary/40 transition"
            >
              <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                <f.icon className="size-5 text-primary" />
              </div>
              <h3 className="font-semibold">{f.title}</h3>
              <p className="text-sm text-muted-foreground mt-1.5">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="container-page pb-24">
        <div className="rounded-2xl border border-border glass p-10 md:p-14 text-center relative overflow-hidden">
          <div className="absolute inset-0 -z-10" style={{ background: "var(--gradient-hero)" }} />
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight">Your next dashboard is one drop away.</h2>
          <p className="text-muted-foreground mt-4 max-w-xl mx-auto">Free to try. No credit card. Your data stays yours.</p>
          <Link to="/auth" className="inline-block mt-8">
            <Button size="lg" className="btn-shine gap-2">Start free <ArrowRight className="size-4" /></Button>
          </Link>
        </div>
      </section>

      <footer className="container-page py-10 border-t border-border text-sm text-muted-foreground flex flex-wrap justify-between gap-4">
        <div>© {new Date().getFullYear()} InsightForge AI</div>
        <div className="flex gap-4">
          <Link to="/auth">Sign in</Link>
        </div>
      </footer>
    </div>
  );
}
