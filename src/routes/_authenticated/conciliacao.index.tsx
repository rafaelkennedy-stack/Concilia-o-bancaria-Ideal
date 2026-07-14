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
import { Plus, Settings, ListChecks, LayoutDashboard, Users, Layers, CalendarDays, CircleAlert, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { setNoMovement } from "@/lib/reconciliation.functions";
import {
  type CellColor, type Acct, type Rec, type Daily, type EntryRef, type MatchRef,
  CELL_CLASS, CELL_LABEL, CELL_ORDER, CAL_BACK, CAL_FWD,
  todayISO, isoShift, diffDays, isWeekend, acctLabel, fmtBRL,
  buildCalendar, calendarDays, lastDays,
} from "@/lib/reconciliation-calendar";

export const Route = createFileRoute("/_authenticated/conciliacao/")({
  component: List,
});

// Janela dos indicadores do card: 7 dias corridos (inclui o fim de semana, que
// conta como "sem movimento" — igual ao calendário).
const CARD_DAYS = 7;

type LastClosed = { reconciliation_date: string; balance_bank: number | null; balance_agrotis_calculated: number | null; balance_agrotis_previous: number | null } | null;

// Indicadores do card, na ordem de exibição. As chaves são as MESMAS cores que o
// calendário usa (CellColor), e a contagem vem de cellFor() — a mesma função que
// pinta as células. Card e calendário não têm como divergir.
const CARD_KINDS: Array<{ color: CellColor; one: string; many: string }> = [
  { color: "verde", one: "conciliada", many: "conciliadas" },
  { color: "amarelo", one: "com pendências", many: "com pendências" },
  { color: "aberta", one: "aberta", many: "abertas" },
  { color: "cinza", one: "sem movimento", many: "sem movimento" },
  { color: "semRegistro", one: "sem registro", many: "sem registro" },
];

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
        entries: (entries ?? []) as EntryRef[],
        matches: (matches ?? []) as MatchRef[],
        daily: (daily ?? []) as Daily[],
        lastClosed,
      };
    },
  });

  const data = q.data;

  // Cores/pendências vêm do módulo compartilhado — a MESMA regra que a página da
  // conta usa. (Fora do return condicional para manter os hooks estáveis.)
  const { recInfo, cellFor } = buildCalendar(
    data ?? { recs: [], entries: [], matches: [], daily: [] },
    today,
  );

  if (q.isLoading || !data) {
    return <div className="container mx-auto p-8 text-sm text-muted-foreground">Carregando…</div>;
  }

  const { accts, recs } = data;
  const days = calendarDays(today);

  // Últimos 7 dias corridos (até hoje) — subconjunto exato de `days`, então as
  // contagens do card são as mesmas células que o calendário desenha.
  const cardDays = lastDays(today, CARD_DAYS);

  // Conta, por conta bancária, quantos dos últimos 7 dias caem em cada cor —
  // usando cellFor(), a MESMA função que pinta o calendário.
  function cardTally(accountId: string): Map<CellColor, number> {
    const tally = new Map<CellColor, number>();
    for (const d of cardDays) {
      const { color } = cellFor(accountId, d);
      tally.set(color, (tally.get(color) ?? 0) + 1);
    }
    return tally;
  }

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
            const tally = cardTally(a.id);
            return (
              <Link key={a.id} to="/conciliacao/conta/$accountId" params={{ accountId: a.id }} className="block">
                <Card className="h-full p-4 transition-colors hover:bg-accent/40">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{a.bank}</div>
                    <div className="truncate text-xs text-muted-foreground">{a.entity_name}{a.account_number ? ` · ${a.account_number}` : ""}</div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </div>
                {isDiretor && (
                  <div className="mt-2 text-xl font-semibold">{fmtBRL(saldo)}</div>
                )}
                <div className="mt-1 text-xs text-muted-foreground">
                  {dias == null ? "Nunca conciliado" : dias === 0 ? "Conciliado hoje" : `Conciliado há ${dias} dia${dias === 1 ? "" : "s"}`}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {CARD_KINDS.map(({ color, one, many }) => {
                    const n = tally.get(color) ?? 0;
                    if (n === 0) return null;
                    return (
                      <span key={color} className="flex items-center gap-1 whitespace-nowrap">
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${CELL_CLASS[color]}`} />
                        <strong>{n}</strong> {n === 1 ? one : many}
                      </span>
                    );
                  })}
                  <span className="ml-auto text-muted-foreground">7 dias</span>
                </div>
                </Card>
              </Link>
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
          {CELL_ORDER.map((c) => (
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
