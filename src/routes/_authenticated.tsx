import { createFileRoute, Link, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BarChart3, LayoutDashboard, Upload, Settings, LogOut, ChevronRight, Sparkles, Menu, X, Activity,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { User } from "@supabase/supabase-js";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }
    return { user: data.user };
  },
  component: AuthenticatedLayout,
});

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/upload", label: "New analysis", icon: Upload },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

function AuthenticatedLayout() {
  const { user } = Route.useRouteContext() as { user: User };
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  const displayName = (user.user_metadata?.full_name as string) || user.email?.split("@")[0] || "You";
  const initials = displayName.split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="min-h-screen flex bg-background">
      {/* Sidebar */}
      <aside className={cn(
        "fixed md:sticky top-0 left-0 z-40 h-screen w-64 border-r border-sidebar-border bg-sidebar flex flex-col transition-transform",
        mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      )}>
        <div className="p-4 flex items-center justify-between">
          <Link to="/dashboard" className="flex items-center gap-2 font-semibold">
            <div className="size-8 rounded-lg flex items-center justify-center" style={{ background: "var(--gradient-primary)" }}>
              <BarChart3 className="size-4 text-white" />
            </div>
            InsightIQ
          </Link>
          <button className="md:hidden text-muted-foreground" onClick={() => setMobileOpen(false)}>
            <X className="size-5" />
          </button>
        </div>
        <div className="px-3 mt-2">
          <Link to="/upload">
            <Button size="sm" className="w-full gap-2 btn-shine">
              <Sparkles className="size-4" /> New analysis
            </Button>
          </Link>
        </div>
        <nav className="flex-1 p-3 space-y-0.5 mt-4">
          {nav.map((n) => {
            const active = pathname === n.to || (n.to !== "/dashboard" && pathname.startsWith(n.to));
            return (
              <Link key={n.to} to={n.to}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                )}
              >
                <n.icon className="size-4" /> {n.label}
                {active && <ChevronRight className="size-3.5 ml-auto opacity-60" />}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="size-8 rounded-full flex items-center justify-center text-xs font-semibold text-primary-foreground" style={{ background: "var(--gradient-primary)" }}>
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{displayName}</div>
              <div className="text-xs text-muted-foreground truncate">{user.email}</div>
            </div>
            <button onClick={signOut} title="Sign out" className="text-muted-foreground hover:text-foreground">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      {mobileOpen && <div className="fixed inset-0 bg-black/50 z-30 md:hidden" onClick={() => setMobileOpen(false)} />}

      <main className="flex-1 min-w-0">
        <div className="md:hidden sticky top-0 z-20 bg-background/80 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
          <button onClick={() => setMobileOpen(true)}><Menu className="size-5" /></button>
          <span className="font-medium">InsightIQ</span>
        </div>
        <AnimatePresence mode="wait">
          <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
