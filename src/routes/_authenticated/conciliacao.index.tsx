import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Settings, ListChecks, LayoutDashboard, Users, Layers, CalendarDays, CircleAlert } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { setNoMovement } from "@/lib/reconciliation.functions";

export const Route = createFileRoute("/_authenticated/conciliacao/")({
  component: List,
});

// ---- Datas em UTC, consistentes com toISOString().slice(0,10) do restante do app ----
const todayISO = () => new Date().toISOString().slice(0, 10);
function isoShift(baseISO: string, n: number): string {
  const d = new Date(baseISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diffDays(laterISO: string, earlierISO: string): number {
  const a = new Date(laterISO + "T00:00:00Z").getTime();
  const b = new Date(earlierISO + "T00:00:00Z").getTime();
  return Math.round((a - b) / 86400000);
}
function isWeekend(iso: string): boolean {
  const day = new Date(iso + "T00:00:00Z").getUTCDay();
  return day === 0 || day === 6;
}

const CAL_BACK = 30;
const CAL_FWD = 7;
const TOLERANCE = 1.0;

type Acct = { id: string; bank: string; entity_name: string; account_number: string | null };
type Rec = {
  id: string; reconciliation_date: string; account: string; bank_account_id: string | null;
  status: "aberta" | "fechada" | "reaberta" | "massa";
  balance_bank: number | null; balance_agrotis_calculated: number | null; closed_with_pending: boolean | null;
};
type Daily = { account_id: string; date: string; status: string; no_movement_reason: string | null };
type LastClosed = { reconciliation_date: string; balance_bank: number | null; balance_agrotis_calculated: number | null; balance_agrotis_previous: number | null } | null;

type CellColor = "verde" | "amarelo" | "aberta" | "semRegistro" | "cinza" | "futuro";

const CELL_CLASS: Record<CellColor, string> = {
  verde: "bg-emerald-500",
  amarelo: "bg-amber-400",
  aberta: "bg-red-800",
  semRegistro: "bg-rose-400",
  cinza: "bg-zinc-300 dark:bg-zinc-600",
  futuro: "border border-dashed border-border bg-transparent",
};
const CELL_LABEL: Record<CellColor, string> = {
  verde: "Conciliada",
  amarelo: "Pendência ou divergência",
  aberta: "Aberta",
  semRegistro: "Sem registro (dia útil)",
  cinza: "Sem movimento / fim de semana",
  futuro: "Futuro",
};

const acctLabel = (a: Acct) => `${a.bank} — ${a.entity_name}${a.account_number ? ` (${a.account_number})` : ""}`;
const fmtBRL = (n: number | null | undefined) =>
  n == null ? "—" : `R$ ${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function List() {
  const { isDiretor } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const noMoveFn = useServerFn(setNoMovement);
  const today = todayISO();

  const [selectedAccts, setSelectedAccts] = useState<Set<string> | null>(null); // null = todas
  const [dayModal, setDayModal] = useState<{ accountId: string; label: string; date: string } | null>(null);
  const [reason, setReason] = useState<string>("");

  const q = useQuery({
    queryKey: ["conciliacao-overview", today],
    queryFn: async () => {
      const from = isoShift(today, -CAL_BACK);
      const [{ data: accts }, { data: recs }, { data: daily }] = await Promise.all([
        supabase.from("bank_accounts").select("id, bank, entity_name, account_number").eq("active", true).order("entity_name"),
        supabase.from("reconciliations")
          .select("id, reconciliation_date, account, bank_account_id, status, balance_bank, balance_agrotis_calculated, closed_with_pending")
          .gte("reconciliation_date", from).order("reconciliation_date", { ascending: false }),
        supabase.from("daily_account_status").select("account_id, date, status, no_movement_reason").gte("date", from),
      ]);
      const recIds = (recs ?? []).map((r) => r.id);
      const [{ data: entries }, { data: matches }] = await Promise.all([
        recIds.length
          ? supabase.from("reconciliation_entries").select("id, reconciliation_id").in("reconciliation_id", recIds)
          : Promise.resolve({ data: [] as { id: string; reconciliation_id: string }[] }),
        recIds.length
          ? supabase.from("reconciliation_matches").select("reconciliation_id, status, bb_entry_id, agrotis_entry_id").in("reconciliation_id", recIds)
          : Promise.resolve({ data: [] as { reconciliation_id: string; status: string; bb_entry_id: string | null; agrotis_entry_id: string | null }[] }),
      ]);
      // Última conciliação fechada por conta (pode ser mais antiga que a janela do calendário).
      const lastClosed: Record<string, LastClosed> = {};
      await Promise.all((accts ?? []).map(async (a) => {
        const { data } = await supabase.from("reconciliations")
          .select("reconciliation_date, balance_bank, balance_agrotis_calculated, balance_agrotis_previous")
          .eq("bank_account_id", a.id).in("status", ["fechada", "reaberta"])
          .order("reconciliation_date", { ascending: false }).limit(1);
        lastClosed[a.id] = (data?.[0] as LastClosed) ?? null;
      }));
      return {
        accts: (accts ?? []) as Acct[],
        recs: (recs ?? []) as Rec[],
        entries: (entries ?? []) as { id: string; reconciliation_id: string }[],
        matches: (matches ?? []) as { reconciliation_id: string; status: string; bb_entry_id: string | null; agrotis_entry_id: string | null }[],
        daily: (daily ?? []) as Daily[],
        lastClosed,
      };
    },
  });

  const data = q.data;

  // Índices e cálculos derivados (fora do render condicional para manter hooks estáveis).
  const entriesByRec = new Map<string, string[]>();
  const matchesByRec = new Map<string, { status: string; bb_entry_id: string | null; agrotis_entry_id: string | null }[]>();
  const recByAcctDate = new Map<string, Rec[]>();
  const dailyByKey = new Map<string, Daily>();
  if (data) {
    for (const e of data.entries) (entriesByRec.get(e.reconciliation_id) ?? entriesByRec.set(e.reconciliation_id, []).get(e.reconciliation_id)!).push(e.id);
    for (const m of data.matches) (matchesByRec.get(m.reconciliation_id) ?? matchesByRec.set(m.reconciliation_id, []).get(m.reconciliation_id)!).push(m);
    for (const r of data.recs) {
      if (!r.bank_account_id) continue;
      const k = `${r.bank_account_id}|${r.reconciliation_date}`;
      (recByAcctDate.get(k) ?? recByAcctDate.set(k, []).get(k)!).push(r);
    }
    for (const d of data.daily) dailyByKey.set(`${d.account_id}|${d.date}`, d);
  }

  // pendentes = lançamentos sem match confirmed/manual/no_pair (não resolvidos); (bug 5b)
  // conciliados = lançamentos em match confirmed/manual.
  function recInfo(rec: Rec) {
    const entryIds = entriesByRec.get(rec.id) ?? [];
    const ms = matchesByRec.get(rec.id) ?? [];
    const resolved = new Set<string>();
    const confirmedManual = new Set<string>();
    for (const m of ms) {
      const isResolved = m.status === "confirmed" || m.status === "manual" || m.status === "no_pair";
      const isConfirmed = m.status === "confirmed" || m.status === "manual";
      if (isResolved) { if (m.bb_entry_id) resolved.add(m.bb_entry_id); if (m.agrotis_entry_id) resolved.add(m.agrotis_entry_id); }
      if (isConfirmed) { if (m.bb_entry_id) confirmedManual.add(m.bb_entry_id); if (m.agrotis_entry_id) confirmedManual.add(m.agrotis_entry_id); }
    }
    const pending = entryIds.filter((id) => !resolved.has(id)).length;
    const confirmed = confirmedManual.size;
    const b = rec.balance_bank, c = rec.balance_agrotis_calculated;
    // A divergência de saldo é informativa (cards de conta) e NÃO classifica a
    // conciliação: a cor depende só do status e das pendências.
    const diverge = b != null && c != null && Math.abs(Number(b) - Number(c)) > TOLERANCE;
    let color: CellColor;
    if (rec.status === "fechada") color = rec.closed_with_pending ? "amarelo" : "verde";
    else color = "aberta"; // aberta / reaberta / massa
    return { pending, confirmed, diverge, color };
  }

  function cellFor(accountId: string, date: string): { color: CellColor; recId: string | null } {
    const recs = recByAcctDate.get(`${accountId}|${date}`) ?? [];
    const closed = recs.find((r) => r.status === "fechada");
    if (closed) return { color: recInfo(closed).color, recId: closed.id };
    const open = recs.find((r) => r.status === "aberta" || r.status === "reaberta" || r.status === "massa");
    if (open) return { color: "aberta", recId: open.id };
    const ds = dailyByKey.get(`${accountId}|${date}`);
    if (ds?.status === "sem_movimento") return { color: "cinza", recId: null };
    if (isWeekend(date)) return { color: "cinza", recId: null };
    if (date > today) return { color: "futuro", recId: null };
    return { color: "semRegistro", recId: null };
  }

  if (q.isLoading || !data) {
    return <div className="container mx-auto p-8 text-sm text-muted-foreground">Carregando…</div>;
  }

  const { accts, recs } = data;
  const since7 = isoShift(today, -6);
  const days: string[] = [];
  for (let i = CAL_BACK; i >= 0; i--) days.push(isoShift(today, -i));
  for (let i = 1; i <= CAL_FWD; i++) days.push(isoShift(today, i));

  const visibleAccts = selectedAccts ? accts.filter((a) => selectedAccts.has(a.id)) : accts;

  // Lista do meio: só conciliações que precisam de atenção (tudo que não é verde).
  const attention = recs
    .map((r) => ({ r, info: recInfo(r) }))
    .filter((x) => x.info.color !== "verde")
    .sort((a, b) => (a.r.reconciliation_date < b.r.reconciliation_date ? 1 : -1));

  async function markNoMovement() {
    if (!dayModal || !reason) return;
    try {
      await noMoveFn({ data: { accountId: dayModal.accountId, date: dayModal.date, reason: reason as "Fim de semana" | "Feriado" | "Sem movimentação" } });
      toast.success("Dia marcado como sem movimento.");
      setDayModal(null); setReason("");
      qc.invalidateQueries({ queryKey: ["conciliacao-overview"] });
    } catch (e) { toast.error((e as Error).message); }
  }

  function onCell(accountId: string, label: string, date: string) {
    const { recId } = cellFor(accountId, date);
    if (recId) { navigate({ to: "/conciliacao/$id", params: { id: recId } }); return; }
    setReason(isWeekend(date) ? "Fim de semana" : "");
    setDayModal({ accountId, label, date });
  }

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Conciliação Bancária</h1>
          <p className="text-sm text-muted-foreground">Visão geral por conta, pendências e calendário</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isDiretor && <Button asChild variant="outline"><Link to="/dashboard"><LayoutDashboard className="mr-1 h-4 w-4" /> Painel</Link></Button>}
          {isDiretor && <Button asChild variant="outline"><Link to="/configuracoes/contas"><Settings className="mr-1 h-4 w-4" /> Contas</Link></Button>}
          {isDiretor && <Button asChild variant="outline"><Link to="/configuracoes/usuarios"><Users className="mr-1 h-4 w-4" /> Usuários</Link></Button>}
          <Button asChild variant="outline"><Link to="/conciliacao/fila"><ListChecks className="mr-1 h-4 w-4" /> Fila do dia</Link></Button>
          <Button asChild variant="outline"><Link to="/conciliacao/massa"><Layers className="mr-1 h-4 w-4" /> Processar em massa</Link></Button>
          <Button asChild><Link to="/conciliacao/nova"><Plus className="mr-1 h-4 w-4" /> Nova Conciliação</Link></Button>
        </div>
      </div>

      {/* 1) Cards de conta */}
      {accts.length > 0 && (
        <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {accts.map((a) => {
            const lc = data.lastClosed[a.id];
            const saldo = lc ? (lc.balance_agrotis_calculated ?? lc.balance_agrotis_previous ?? lc.balance_bank) : null;
            const dias = lc ? diffDays(today, lc.reconciliation_date) : null;
            const recs7 = recs.filter((r) => r.bank_account_id === a.id && r.reconciliation_date >= since7);
            const fechadas = recs7.filter((r) => r.status === "fechada").length;
            const pendencias = recs7.filter((r) => r.status === "fechada" && r.closed_with_pending).length;
            const divergencias = recs7.filter((r) => recInfo(r).diverge && r.status === "fechada").length;
            return (
              <Card key={a.id} className="p-4">
                <div className="text-sm font-medium">{a.bank}</div>
                <div className="truncate text-xs text-muted-foreground">{a.entity_name}{a.account_number ? ` · ${a.account_number}` : ""}</div>
                {isDiretor && (
                  <div className="mt-2 text-xl font-semibold">{fmtBRL(saldo)}</div>
                )}
                <div className="mt-1 text-xs text-muted-foreground">
                  {dias == null ? "Nunca conciliado" : dias === 0 ? "Conciliado hoje" : `Conciliado há ${dias} dia${dias === 1 ? "" : "s"}`}
                </div>
                <div className="mt-3 flex items-center gap-3 text-xs">
                  <span className="text-emerald-600"><strong>{fechadas}</strong> fechadas</span>
                  <span className="text-amber-600"><strong>{pendencias}</strong> pendências</span>
                  <span className="text-rose-600"><strong>{divergencias}</strong> diverg.</span>
                  <span className="ml-auto text-muted-foreground">7 dias</span>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* 3) Lista do meio — só conciliações que precisam de atenção */}
      <div className="mb-8">
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <CircleAlert className="h-4 w-4 text-amber-500" /> Precisam de atenção ({attention.length})
        </h2>
        {attention.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Tudo em dia — nenhuma conciliação aberta ou com pendências. Veja o histórico completo no calendário abaixo.
          </Card>
        ) : (
          <div className="space-y-2">
            {attention.map(({ r, info }) => (
              <Link key={r.id} to="/conciliacao/$id" params={{ id: r.id }} className="block">
                <Card className="p-4 transition-colors hover:bg-accent/40">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">
                        {format(new Date(r.reconciliation_date + "T00:00"), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{r.account}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right text-xs">
                        <div><span className="font-medium text-emerald-600">{info.confirmed}</span> conciliados</div>
                        <div><span className="font-medium text-amber-600">{info.pending}</span> pendentes</div>
                      </div>
                      <AttnBadge color={info.color} status={r.status} />
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* 4) Calendário */}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <CalendarDays className="h-4 w-4" /> Calendário ({CAL_BACK} dias + {CAL_FWD} de planejamento)
          </h2>
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant={selectedAccts === null ? "default" : "outline"} className="h-7 text-xs" onClick={() => setSelectedAccts(null)}>Todas</Button>
            {accts.map((a) => {
              const on = selectedAccts?.has(a.id) ?? false;
              return (
                <Button key={a.id} size="sm" variant={on ? "default" : "outline"} className="h-7 text-xs"
                  onClick={() => setSelectedAccts((prev) => {
                    const next = new Set(prev ?? []);
                    if (next.has(a.id)) next.delete(a.id); else next.add(a.id);
                    return next.size === 0 ? null : next;
                  })}>
                  {a.entity_name}
                </Button>
              );
            })}
          </div>
        </div>

        <Card className="overflow-x-auto p-3">
          <div className="min-w-max space-y-1">
            {/* eixo com marcações a cada 5 dias */}
            <div className="flex items-center gap-1 pl-40">
              {days.map((d, i) => (
                <div key={d} className="w-5 text-center text-[9px] text-muted-foreground">
                  {i % 5 === 0 ? format(new Date(d + "T00:00"), "dd/MM", { locale: ptBR }) : ""}
                </div>
              ))}
            </div>
            {visibleAccts.map((a) => (
              <div key={a.id} className="flex items-center gap-1">
                <div className="w-40 shrink-0 truncate pr-2 text-xs" title={acctLabel(a)}>{a.entity_name}</div>
                {days.map((d) => {
                  const { color, recId } = cellFor(a.id, d);
                  const title = `${format(new Date(d + "T00:00"), "dd/MM/yyyy", { locale: ptBR })} · ${CELL_LABEL[color]}`;
                  return (
                    <button key={d} type="button" title={title}
                      onClick={() => onCell(a.id, acctLabel(a), d)}
                      className={`h-5 w-5 shrink-0 rounded-sm ${CELL_CLASS[color]} cursor-pointer transition-shadow hover:ring-2 hover:ring-ring`} />
                  );
                })}
              </div>
            ))}
            {visibleAccts.length === 0 && <p className="py-4 text-sm text-muted-foreground">Selecione ao menos uma conta.</p>}
          </div>
        </Card>

        {/* Legenda */}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {(["verde", "amarelo", "aberta", "semRegistro", "cinza", "futuro"] as CellColor[]).map((c) => (
            <span key={c} className="flex items-center gap-1.5">
              <span className={`h-3 w-3 rounded-sm ${CELL_CLASS[c]}`} />{CELL_LABEL[c]}
            </span>
          ))}
        </div>
      </div>

      {/* Modal ao clicar num dia sem registro */}
      <Dialog open={!!dayModal} onOpenChange={(o) => { if (!o) { setDayModal(null); setReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dayModal && `${format(new Date(dayModal.date + "T00:00"), "dd/MM/yyyy", { locale: ptBR })} — ${dayModal.label}`}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Nenhum registro neste dia. Escolha uma ação:</p>
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-xs font-medium">Marcar como sem movimento</div>
              <div className="flex gap-2">
                <Select value={reason} onValueChange={setReason}>
                  <SelectTrigger className="flex-1"><SelectValue placeholder="Motivo…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Fim de semana">Fim de semana</SelectItem>
                    <SelectItem value="Feriado">Feriado</SelectItem>
                    <SelectItem value="Sem movimentação">Sem movimentação</SelectItem>
                  </SelectContent>
                </Select>
                <Button disabled={!reason} onClick={markNoMovement}>Marcar</Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            {dayModal && (
              <Button variant="outline" onClick={() => {
                navigate({ to: "/conciliacao/nova", search: { account: dayModal.accountId, date: dayModal.date } });
              }}>
                <Plus className="mr-1 h-4 w-4" /> Nova conciliação neste dia
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AttnBadge({ color, status }: { color: CellColor; status: string }) {
  const cls = color === "amarelo"
    ? "border-amber-300 bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
    : "border-red-300 bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300";
  const label = color === "amarelo"
    ? "Com pendências"
    : status === "massa" ? "Em massa" : status;
  return <Badge variant="outline" className={`${cls} capitalize`}>{label}</Badge>;
}
