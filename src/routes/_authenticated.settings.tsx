import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: "Settings — InsightForge AI" }, { name: "robots", content: "noindex" }] }),
});

function SettingsPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? "");
      supabase.from("profiles").select("full_name").eq("id", data.user!.id).single().then(({ data: p }) => {
        setFullName(p?.full_name ?? "");
      });
    });
  }, []);

  async function save() {
    setLoading(true);
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.from("profiles").update({ full_name: fullName }).eq("id", userData.user!.id);
    setLoading(false);
    if (error) toast.error(error.message); else toast.success("Profile updated");
  }

  return (
    <div className="container-page py-8 max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
      <p className="text-muted-foreground mt-1">Manage your account.</p>

      <div className="mt-8 rounded-xl border border-border bg-card p-6 space-y-4">
        <h2 className="font-semibold">Profile</h2>
        <div>
          <Label>Email</Label>
          <Input value={email} disabled />
        </div>
        <div>
          <Label>Full name</Label>
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={80} />
        </div>
        <Button onClick={save} disabled={loading}>{loading ? "Saving…" : "Save changes"}</Button>
      </div>
    </div>
  );
}
