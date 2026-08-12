import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { motion } from "framer-motion";
import { BarChart3, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";


export const Route = createFileRoute("/.lovable/oauth/consent")({
  // Browser-only: supabase-js reads its session from localStorage.
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s.authorization_id === "string" ? s.authorization_id : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("Missing authorization_id");
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      const next = location.pathname + location.searchStr;
      throw redirect({ to: "/auth", search: { redirect: next } });
    }
  },
  loader: async ({ location }) => {
    const authorizationId = new URLSearchParams(location.search).get("authorization_id")!;
    const { data, error } = await oauth.getAuthorizationDetails(authorizationId);
    if (error) throw new Error(error.message);
    const immediate = data?.redirect_url ?? data?.redirect_to;
    if (immediate && !data?.client) throw redirect({ href: immediate });
    return data;
  },
  component: Consent,
  errorComponent: ({ error }) => (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border border-border glass p-6 text-center">
        <h1 className="text-lg font-semibold">Could not load this authorization request</h1>
        <p className="text-sm text-muted-foreground mt-2">{String((error as Error)?.message ?? error)}</p>
      </div>
    </main>
  ),
});

function Consent() {
  const details = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientName = details?.client?.client_name ?? details?.client?.name ?? "an app";
  const redirectUri = details?.client?.redirect_uri;
  const scopes = (details?.scope ?? details?.client?.scope ?? "openid email profile")
    .split(/\s+/)
    .filter(Boolean);

  async function decide(approve: boolean) {
    setBusy(approve ? "approve" : "deny");
    setError(null);
    const { data, error } = approve
      ? await oauth.approveAuthorization(authorization_id)
      : await oauth.denyAuthorization(authorization_id);
    if (error) { setBusy(null); setError(error.message); return; }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) { setBusy(null); setError("No redirect returned by the authorization server."); return; }
    window.location.href = target;
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative">
      <div className="absolute inset-0 -z-10" style={{ background: "var(--gradient-mesh)" }} />
      <div className="absolute inset-0 -z-10 grid-bg opacity-30" />

      <motion.main
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-md"
      >
        <div className="flex items-center justify-center gap-2 font-semibold mb-8">
          <div className="size-8 rounded-lg flex items-center justify-center" style={{ background: "var(--gradient-primary)" }}>
            <BarChart3 className="size-4 text-white" />
          </div>
          InsightForge AI
        </div>

        <div className="rounded-2xl border border-border glass p-6 md:p-8 shadow-card">
          <div className="flex items-center gap-2 text-primary text-xs font-medium">
            <ShieldCheck className="size-4" /> Authorize access
          </div>
          <h1 className="text-2xl font-semibold mt-2">Connect {clientName} to InsightForge AI</h1>
          <p className="text-sm text-muted-foreground mt-2">
            {clientName} will be able to call InsightForge AI's tools while you are signed in — reading your datasets,
            analyses, and activity as you.
          </p>

          {redirectUri && (
            <div className="mt-4 text-xs text-muted-foreground break-all">
              Redirects to: <span className="font-mono">{redirectUri}</span>
            </div>
          )}

          <div className="mt-5 rounded-lg border border-border/60 p-3 space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">This grants</div>
            <ul className="text-sm space-y-1">
              {scopes.map((s: string) => (
                <li key={s} className="flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-primary" /> {s}
                </li>
              ))}
              <li className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-primary" /> Call enabled InsightForge AI tools as you
              </li>
            </ul>
          </div>

          <p className="text-xs text-muted-foreground mt-4">
            This does not bypass InsightForge AI's permissions — row-level security still scopes data to your account.
          </p>

          {error && (
            <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>
          )}

          <div className="flex gap-3 mt-6">
            <Button variant="outline" className="flex-1" disabled={busy !== null} onClick={() => decide(false)}>
              {busy === "deny" ? <Loader2 className="size-4 animate-spin" /> : "Cancel"}
            </Button>
            <Button className="flex-1" disabled={busy !== null} onClick={() => decide(true)}>
              {busy === "approve" ? <Loader2 className="size-4 animate-spin" /> : "Approve"}
            </Button>
          </div>
        </div>
      </motion.main>
    </div>
  );
}
