import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Plus, FileText, Settings, ListChecks, LayoutDashboard, Users } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

export const Route = createFileRoute("/_authenticated/conciliacao/")({
  component: List,
});

type Row = {
  id: string; reconciliation_date: string; account: string;
  status: "aberta" | "fechada" | "reaberta";
  confirmed: number; pending: number;
};

function statusColor(s: Row["status"]) {
  return s === "fechada" ? "default" : s === "reaberta" ? "secondary" : "outline";
}

function List() {
  const { isDiretor } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["reconciliations"],
    queryFn: async (): Promise<Row[]> => {
      const { data: recs, error } = await supabase
        .from("reconciliations").select("id, reconciliation_date, account, status")
        .order("reconciliation_date", { ascending: false });
      if (error) throw error;
      const rows: Row[] = [];
      for (const r of recs ?? []) {
        const { data: m } = await supabase
          .from("reconciliation_matches").select("status").eq("reconciliation_id", r.id);
        const confirmed = (m ?? []).filter((x) => x.status === "confirmed" || x.status === "manual" || x.status === "no_pair").length;
        const pending = (m ?? []).filter((x) => x.status === "suggested").length;
        rows.push({ ...(r as any), confirmed, pending });
      }
      return rows;
    },
  });

  const balances = useQuery({
    enabled: isDiretor,
    queryKey: ["account-balances"],
    queryFn: async () => {
      const { data: accts } = await supabase.from("bank_accounts")
        .select("id, bank, entity_name, account_number").eq("active", true)
        .order("entity_name");
      const rows: Array<{
        id: string; label: string; date: string | null;
        bank: number | null; calculated: number | null; diff: number | null;
      }> = [];
      for (const a of accts ?? []) {
        const { data: last } = await supabase.from("reconciliations")
          .select("reconciliation_date, balance_bank, balance_agrotis_calculated, balance_agrotis_previous, status")
          .eq("bank_account_id", a.id).in("status", ["fechada", "reaberta"])
          .order("reconciliation_date", { ascending: false }).limit(1);
        const l = last?.[0];
        const bank = l?.balance_bank != null ? Number(l.balance_bank) : null;
        const calc = l?.balance_agrotis_calculated != null
          ? Number(l.balance_agrotis_calculated)
          : (l?.balance_agrotis_previous != null ? Number(l.balance_agrotis_previous) : null);
        const diff = bank != null && calc != null ? Number((bank - calc).toFixed(2)) : null;
        rows.push({
          id: a.id,
          label: `${a.bank} — ${a.entity_name}${a.account_number ? ` (${a.account_number})` : ""}`,
          date: l?.reconciliation_date ?? null,
          bank, calculated: calc, diff,
        });
      }
      return rows;
    },
  });


  return (
    <div className="container mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Conciliação Bancária</h1>
          <p className="text-sm text-muted-foreground">Histórico de conciliações</p>
        </div>
        <div className="flex items-center gap-2">
          {isDiretor && (
            <Button asChild variant="outline">
              <Link to="/dashboard"><LayoutDashboard className="mr-1 h-4 w-4" /> Painel</Link>
            </Button>
          )}
          {isDiretor && (
            <Button asChild variant="outline">
              <Link to="/configuracoes/contas"><Settings className="mr-1 h-4 w-4" /> Contas</Link>
            </Button>
          )}
          {isDiretor && (
            <Button asChild variant="outline">
              <Link to="/configuracoes/usuarios"><Users className="mr-1 h-4 w-4" /> Usuários</Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link to="/conciliacao/fila"><ListChecks className="mr-1 h-4 w-4" /> Fila do dia</Link>
          </Button>
          <Button asChild>
            <Link to="/conciliacao/nova"><Plus className="mr-1 h-4 w-4" /> Nova Conciliação</Link>
          </Button>
        </div>
      </div>

      {isDiretor && (balances.data?.length ?? 0) > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">Saldos por conta (último fechamento)</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {balances.data!.map((b) => {
              const ok = b.diff != null && Math.abs(b.diff) < 0.01;
              return (
                <Card key={b.id} className="p-3">
                  <div className="truncate text-xs text-muted-foreground">{b.label}</div>
                  <div className="mt-1 flex items-baseline justify-between gap-2">
                    <span className="text-lg font-semibold">
                      {b.calculated != null
                        ? `R$ ${b.calculated.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                    </span>
                    {b.diff != null && (
                      <span className={`text-xs font-medium ${ok ? "text-emerald-600" : "text-rose-600"}`}>
                        {ok ? "conferido" : `Δ R$ ${b.diff.toFixed(2)}`}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {b.date
                      ? `em ${format(new Date(b.date + "T00:00"), "dd/MM/yyyy", { locale: ptBR })}`
                      : "sem fechamento ainda"}
                    {b.bank != null && (
                      <> · banco R$ {b.bank.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}



      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !data?.length ? (
        <Card className="p-12 text-center">
          <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">Nenhuma conciliação ainda.</p>
          <Button asChild className="mt-4"><Link to="/conciliacao/nova">Criar a primeira</Link></Button>
        </Card>
      ) : (
        <div className="space-y-2">
          {data.map((r) => (
            <Link key={r.id} to="/conciliacao/$id" params={{ id: r.id }} className="block">
              <Card className="p-4 hover:bg-accent/40 transition-colors">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">
                      {format(new Date(r.reconciliation_date + "T00:00"), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
                    </div>
                    <div className="text-xs text-muted-foreground">{r.account}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-xs text-right">
                      <div><span className="text-emerald-600 font-medium">{r.confirmed}</span> conciliados</div>
                      <div><span className="text-amber-600 font-medium">{r.pending}</span> pendentes</div>
                    </div>
                    <Badge variant={statusColor(r.status)} className="capitalize">{r.status}</Badge>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
