import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CheckCircle2, Clock, AlertTriangle, Timer } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

// ---- Datas (UTC, consistente com toISOString().slice(0,10) usado no restante do app) ----
const todayISO = () => new Date().toISOString().slice(0, 10);
function isoMinusDays(baseISO: string, n: number): string {
  const d = new Date(baseISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function isWeekend(iso: string): boolean {
  const day = new Date(iso + "T00:00:00Z").getUTCDay();
  return day === 0 || day === 6;
}
function diffDays(laterISO: string, earlierISO: string): number {
  const a = new Date(laterISO + "T00:00:00Z").getTime();
  const b = new Date(earlierISO + "T00:00:00Z").getTime();
  return Math.round((a - b) / 86400000);
}

const WINDOW = 30; // dias do calendário / prazo médio

type Color = "verde" | "vermelho" | "amarelo" | "cinza" | "azul";
type DayCell = { date: string; color: Color; recId: string | null; diverge: boolean };

type Rec = {
  id: string; reconciliation_date: string; period_end_date: string | null; bank_account_id: string | null;
  status: "aberta" | "fechada" | "reaberta" | "massa";
  balance_bank: number | null; balance_agrotis_calculated: number | null;
  closed_at: string | null;
};
type Daily = { account_id: string; date: string; status: string };
type Account = { id: string; bank: string; entity_name: string; account_number: string | null };

const COLOR_CLASS: Record<Color, string> = {
  verde: "bg-emerald-500",
  vermelho: "bg-rose-500",
  amarelo: "bg-amber-400",
  cinza: "bg-muted-foreground/30",
  azul: "bg-blue-500",
};
const TODAY_LABEL: Record<Color, string> = {
  verde: "Conciliada", amarelo: "Conciliada", azul: "Em andamento", cinza: "Sem movimento", vermelho: "Pendente",
};
const TODAY_BADGE: Record<Color, "default" | "secondary" | "outline"> = {
  verde: "default", amarelo: "default", azul: "secondary", cinza: "outline", vermelho: "outline",
};

function Dashboard() {
  const { isDiretor, loading } = useAuth();
  const navigate = useNavigate();
  const today = todayISO();
  const from = isoMinusDays(today, WINDOW - 1);

  const q = useQuery({
    enabled: isDiretor,
    queryKey: ["dashboard", today],
    queryFn: async () => {
      const [{ data: accts, error: aErr }, { data: recs }, { data: daily }] = await Promise.all([
        supabase.from("bank_accounts").select("id, bank, entity_name, account_number").eq("active", true).order("bank"),
        supabase.from("reconciliations")
          .select("id, reconciliation_date, period_end_date, bank_account_id, status, balance_bank, balance_agrotis_calculated, closed_at")
          .gte("reconciliation_date", from),
        supabase.from("daily_account_status").select("account_id, date, status").gte("date", from),
      ]);
      if (aErr) throw aErr;
      return { accts: (accts ?? []) as Account[], recs: (recs ?? []) as Rec[], daily: (daily ?? []) as Daily[] };
    },
  });

  if (loading) return <div className="container mx-auto p-8 text-sm text-muted-foreground">Carregando…</div>;
  if (!isDiretor) {
    return (
      <div className="container mx-auto max-w-lg px-4 py-16 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-muted-foreground" />
        <h1 className="mt-3 text-lg font-semibold">Acesso restrito</h1>
        <p className="mt-1 text-sm text-muted-foreground">O painel do diretor está disponível apenas para o perfil Diretor.</p>
        <Button asChild variant="outline" className="mt-4"><Link to="/conciliacao">Voltar</Link></Button>
      </div>
    );
  }

  const days = Array.from({ length: WINDOW }, (_, i) => isoMinusDays(today, WINDOW - 1 - i));

  // Índices por (conta|dia)
  const recsByKey = new Map<string, Rec[]>();
  const dailyByKey = new Map<string, string>();
  for (const r of q.data?.recs ?? []) {
    if (!r.bank_account_id) continue;
    const k = `${r.bank_account_id}|${r.reconciliation_date}`;
    (recsByKey.get(k) ?? recsByKey.set(k, []).get(k)!).push(r);
  }
  for (const d of q.data?.daily ?? []) dailyByKey.set(`${d.account_id}|${d.date}`, d.status);

  function dayStatus(accountId: string, date: string): DayCell {
    const recs = recsByKey.get(`${accountId}|${date}`) ?? [];
    const closed = recs.find((r) => r.status === "fechada");
    if (closed) {
      const bank = closed.balance_bank, calc = closed.balance_agrotis_calculated;
      const diverge = bank != null && calc != null && Math.abs(Number(bank) - Number(calc)) >= 0.01;
      return { date, color: diverge ? "amarelo" : "verde", recId: closed.id, diverge };
    }
    const open = recs.find((r) => r.status === "aberta" || r.status === "reaberta");
    if (open) return { date, color: "azul", recId: open.id, diverge: false };
    const ds = dailyByKey.get(`${accountId}|${date}`);
    if (ds === "sem_movimento") return { date, color: "cinza", recId: null, diverge: false };
    if (isWeekend(date)) return { date, color: "cinza", recId: null, diverge: false };
    return { date, color: "vermelho", recId: null, diverge: false }; // pendente / adiada / não feita
  }

  // Prazo médio: dias entre o movimento e o fechamento (closed_at). Usa
  // period_end_date (data do movimento mais recente) quando disponível — caso das
  // conciliações geradas por processamento em massa — senão reconciliation_date.
  function avgLead(accountId: string | null): number | null {
    const source = (q.data?.recs ?? []).filter((r) =>
      r.status === "fechada" && r.closed_at && (accountId == null || r.bank_account_id === accountId));
    if (!source.length) return null;
    const total = source.reduce((s, r) =>
      s + Math.max(0, diffDays(r.closed_at!.slice(0, 10), r.period_end_date ?? r.reconciliation_date)), 0);
    return total / source.length;
  }

  // Streak: dias conciliados consecutivos (a partir do mais recente). Conciliada (mesmo
  // com divergência) conta; sem movimento / fim de semana são neutros (não quebram);
  // hoje ainda pendente não quebra; um dia útil pendente/não feito no passado quebra.
  function streak(accountId: string): number {
    let count = 0;
    for (let i = 0; i < 60; i++) {
      const d = isoMinusDays(today, i);
      const c = dayStatus(accountId, d).color;
      if (i === 0 && (c === "vermelho" || c === "azul")) continue;
      if (c === "verde" || c === "amarelo") { count++; continue; }
      if (c === "cinza") continue;
      break;
    }
    return count;
  }

  const accounts = q.data?.accts ?? [];
  const todayColors = new Map(accounts.map((a) => [a.id, dayStatus(a.id, today).color]));
  const reconciledToday = accounts.filter((a) => { const c = todayColors.get(a.id); return c === "verde" || c === "amarelo"; }).length;
  const pendingToday = accounts.filter((a) => todayColors.get(a.id) === "vermelho").length;
  const since7 = isoMinusDays(today, 6);
  const divergences7d = (q.data?.recs ?? []).filter((r) =>
    r.status === "fechada" && r.reconciliation_date >= since7 &&
    r.balance_bank != null && r.balance_agrotis_calculated != null &&
    Math.abs(Number(r.balance_bank) - Number(r.balance_agrotis_calculated)) >= 0.01).length;
  const globalLead = avgLead(null);

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      <Button asChild variant="ghost" size="sm" className="mb-2">
        <Link to="/conciliacao"><ArrowLeft className="mr-1 h-4 w-4" /> Conciliação</Link>
      </Button>
      <h1 className="mb-1 text-2xl font-bold">Painel do Diretor</h1>
      <p className="mb-5 text-sm text-muted-foreground">
        {format(new Date(today + "T00:00"), "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })} · últimos {WINDOW} dias
      </p>

      {/* Indicadores globais */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Indicator icon={<CheckCircle2 className="h-5 w-5 text-emerald-600" />} label="Conciliadas hoje" value={`${reconciledToday}/${accounts.length}`} />
        <Indicator icon={<Clock className="h-5 w-5 text-rose-600" />} label="Pendentes hoje" value={String(pendingToday)} />
        <Indicator icon={<AlertTriangle className="h-5 w-5 text-amber-500" />} label="Divergências (7 dias)" value={String(divergences7d)} />
        <Indicator icon={<Timer className="h-5 w-5 text-blue-600" />} label="Prazo médio geral" value={globalLead == null ? "—" : `${globalLead.toFixed(1)} d`} />
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando dados…</p>
      ) : q.error ? (
        <Card className="border-rose-300 bg-rose-50 p-4 text-sm text-rose-800 dark:bg-rose-950/20 dark:text-rose-300">
          Não foi possível carregar os dados do painel.
        </Card>
      ) : accounts.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Nenhuma conta bancária ativa cadastrada.</Card>
      ) : (
        <>
          <Legend />
          <div className="grid gap-3">
            {accounts.map((a) => {
              const color = todayColors.get(a.id)!;
              const diverge = dayStatus(a.id, today).diverge;
              const lead = avgLead(a.id);
              const cells = days.map((d) => dayStatus(a.id, d));
              return (
                <Card key={a.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{a.bank} — {a.entity_name}{a.account_number ? ` (${a.account_number})` : ""}</div>
                      <div className="mt-1 flex items-center gap-2">
                        <Badge variant={TODAY_BADGE[color]}>{TODAY_LABEL[color]}{diverge ? " (divergência)" : ""}</Badge>
                      </div>
                    </div>
                    <div className="flex gap-6 text-right">
                      <Metric label="Prazo médio (30d)" value={lead == null ? "—" : `${lead.toFixed(1)} d`} />
                      <Metric label="Streak conciliado" value={`${streak(a.id)} d`} />
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1">
                    {cells.map((c) => {
                      const label = `${format(new Date(c.date + "T00:00"), "dd/MM", { locale: ptBR })} · ${TODAY_LABEL[c.color]}${c.diverge ? " (divergência)" : ""}`;
                      const cls = `h-6 w-6 rounded ${COLOR_CLASS[c.color]} ${c.recId ? "cursor-pointer hover:ring-2 hover:ring-ring" : "cursor-default"}`;
                      return c.recId ? (
                        <button key={c.date} type="button" title={label} className={cls}
                          onClick={() => navigate({ to: "/conciliacao/$id", params: { id: c.recId! } })} />
                      ) : (
                        <div key={c.date} title={label} className={cls} />
                      );
                    })}
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Indicator({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent">{icon}</div>
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold">{value}</div>
      </div>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function Legend() {
  const items: Array<[Color, string]> = [
    ["verde", "Conciliada"], ["amarelo", "Divergência"], ["azul", "Em andamento"],
    ["cinza", "Sem movimento / fim de semana"], ["vermelho", "Pendente / não feita"],
  ];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {items.map(([c, label]) => (
        <span key={c} className="flex items-center gap-1.5">
          <span className={`h-3 w-3 rounded ${COLOR_CLASS[c]}`} />{label}
        </span>
      ))}
    </div>
  );
}
