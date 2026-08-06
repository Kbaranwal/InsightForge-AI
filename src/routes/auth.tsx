import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { z } from "zod";
import { BarChart3, Loader2, Mail, KeyRound } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";

const searchSchema = z.object({
  redirect: z.string().optional(),
  mode: z.enum(["signin", "signup", "forgot"]).optional(),
});

export const Route = createFileRoute("/auth")({
  validateSearch: searchSchema,
  component: AuthPage,
  head: () => ({
    meta: [
      { title: "Sign in — InsightForge AI" },
      { name: "description", content: "Sign in or create your InsightForge AI account to start analyzing your data." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.24 1.4-1.66 4.1-5.5 4.1-3.32 0-6.02-2.74-6.02-6.12S8.68 5.96 12 5.96c1.9 0 3.16.8 3.88 1.49l2.64-2.55C16.9 3.34 14.68 2.4 12 2.4 6.85 2.4 2.7 6.55 2.7 11.7S6.85 21 12 21c6.93 0 9.5-4.86 9.5-9.7 0-.65-.07-1.14-.16-1.63H12z"/>
    </svg>
  );
}

function AuthPage() {
  const search = useSearch({ from: "/auth" });
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">(search.mode ?? "signin");
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: search.redirect ?? "/app", replace: true });
    });
  }, [navigate, search.redirect]);

  async function handleGoogle() {
    setLoading(true);
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin + "/auth",
    });
    if (result.error) {
      toast.error(result.error.message || "Google sign-in failed");
      setLoading(false);
      return;
    }
    if (result.redirected) return;
    navigate({ to: search.redirect ?? "/app", replace: true });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const parsed = z.object({
          email: z.string().email(),
          password: z.string().min(8, "Password must be at least 8 characters"),
          fullName: z.string().min(1, "Please enter your name").max(80),
        }).safeParse({ email, password, fullName });
        if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
        const { error } = await supabase.auth.signUp({
          email, password,
          options: {
            emailRedirectTo: window.location.origin + "/auth",
            data: { full_name: fullName },
          },
        });
        if (error) throw error;
        toast.success("Account created!");
        navigate({ to: search.redirect ?? "/app", replace: true });
      } else if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast.success("Welcome back");
        navigate({ to: search.redirect ?? "/app", replace: true });
      } else {
        const parsed = z.string().email().safeParse(email);
        if (!parsed.success) { toast.error("Enter a valid email"); return; }
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + "/reset-password",
        });
        if (error) throw error;
        toast.success("Check your email for a reset link");
        setMode("signin");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative">
      <div className="absolute inset-0 -z-10" style={{ background: "var(--gradient-mesh)" }} />
      <div className="absolute inset-0 -z-10 grid-bg opacity-30" />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-md"
      >
        <Link to="/" className="flex items-center justify-center gap-2 font-semibold mb-8">
          <div className="size-8 rounded-lg flex items-center justify-center" style={{ background: "var(--gradient-primary)" }}>
            <BarChart3 className="size-4 text-white" />
          </div>
          InsightForge AI
        </Link>

        <div className="rounded-2xl border border-border glass p-6 md:p-8 shadow-card">
          <h1 className="text-2xl font-semibold text-center">
            {mode === "signup" ? "Create your account" : mode === "forgot" ? "Reset your password" : "Welcome back"}
          </h1>
          <p className="text-sm text-muted-foreground text-center mt-1.5">
            {mode === "signup" ? "Start analyzing your data in under a minute." :
             mode === "forgot" ? "We'll email you a secure reset link." :
             "Sign in to your dashboard."}
          </p>

          {mode !== "forgot" && (
            <>
              <Button type="button" variant="outline" className="w-full mt-6 gap-2" onClick={handleGoogle} disabled={loading}>
                <GoogleIcon /> Continue with Google
              </Button>
              <div className="flex items-center gap-3 my-5">
                <div className="h-px bg-border flex-1" />
                <span className="text-xs text-muted-foreground">or</span>
                <div className="h-px bg-border flex-1" />
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "signup" && (
              <div>
                <Label htmlFor="name">Full name</Label>
                <Input id="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required maxLength={80} />
              </div>
            )}
            <div>
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input id="email" type="email" className="pl-9" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={255} />
              </div>
            </div>
            {mode !== "forgot" && (
              <div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  {mode === "signin" && (
                    <button type="button" onClick={() => setMode("forgot")} className="text-xs text-primary hover:underline">
                      Forgot?
                    </button>
                  )}
                </div>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input id="password" type="password" className="pl-9" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
                </div>
              </div>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> :
               mode === "signup" ? "Create account" : mode === "forgot" ? "Send reset link" : "Sign in"}
            </Button>
          </form>

          <div className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "signin" && (
              <>New here? <button className="text-primary hover:underline" onClick={() => setMode("signup")}>Create an account</button></>
            )}
            {mode === "signup" && (
              <>Already have an account? <button className="text-primary hover:underline" onClick={() => setMode("signin")}>Sign in</button></>
            )}
            {mode === "forgot" && (
              <button className="text-primary hover:underline" onClick={() => setMode("signin")}>Back to sign in</button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
