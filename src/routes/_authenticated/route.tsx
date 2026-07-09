import { createFileRoute, Outlet, redirect, Link, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Landmark, LogOut } from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { user, roles, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto flex h-14 items-center justify-between px-4">
          <Link to="/conciliacao" className="flex items-center gap-2 font-semibold">
            <Landmark className="h-5 w-5" /> Financeiro
          </Link>
          <nav className="flex items-center gap-4">
            <Link to="/conciliacao" className="text-sm hover:underline" activeProps={{ className: "text-sm font-medium" }}>
              Conciliação Bancária
            </Link>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{user?.email}</span>
              <span className="rounded bg-accent px-2 py-0.5 text-accent-foreground">
                {roles.includes("diretor") ? "Diretor" : "Dani"}
              </span>
            </div>
            <Button variant="ghost" size="sm" onClick={async () => { await signOut(); navigate({ to: "/auth", replace: true }); }}>
              <LogOut className="h-4 w-4" />
            </Button>
          </nav>
        </div>
      </header>
      <main><Outlet /></main>
    </div>
  );
}
