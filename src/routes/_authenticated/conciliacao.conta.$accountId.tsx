import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Plus, CalendarDays, ArrowLeft, CalendarRange, X } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { DateRange } from "react-day-picker";
import { setNoMovement } from "@/lib/reconciliation.functions";
import {
  type CellColor, type Acct, type Rec, type Daily, type EntryRef, type MatchRef,
  CELL_CLASS, CELL_LABEL, CELL_ORDER, CAL_BACK,
  todayISO, isoShift, isWeekend, acctLabel, fmtBRL,
  buildCalendar, calendarDays, lastDays,
} from "@/lib/reconciliation-calendar";

export const Route = createFileRoute("/_authenticated/conciliacao/conta/$accountId")({
  component: AccountDetail,
});

const HIST_DAYS = 30;   // janela dos indicadores históricos
const PAGE_SIZE = 25;   // conciliações por página na lista

// Filtros de status da lista. "sem_movimento" NÃO é uma conciliação — é um
// registro de daily_account_status — então essa opção troca a fonte da lista.
type StatusFilter = "todas" | "conciliada" | "com_pendencias" | "aberta" | "sem_movimento";
const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "todas", label: "Todas" },
  { value: "conciliada", label: "Conciliada" },
  { value: "com_pendencias", label: "Com pendências" },
  { value: "aberta", label: "Aberta" },
  { value: "sem_movimento", label: "Sem movimento" },
];

const iso = (d: Date) => format(d, "yyyy-MM-dd");
const fmtDate = (isoDate: string) => format(new Date(isoDate + "T00:00"), "dd/MM/yyyy", { locale: ptBR });

type RecRow = Rec & { balance_bank: number | null };
// Uma página da lista é de conciliações OU de dias sem movimento — nunca das duas
// (o filtro de status escolhe a fonte).
type ListPage =
  | { kind: "daily"; rows: Daily[] }
  | { kind: "rec"; rows: RecRow[]; entries: EntryRef[]; matches: MatchRef[] };

function AccountDetail() {
  const { accountId } = Route.useParams();
  const { isDiretor } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const noMoveFn = useServerFn(setNoMovement);
  const today = todayISO();

  const [dayModal, setDayModal] = useState<{ date: string } | null>(null);
  const [reason, setReason] = useState("");

  // Filtros da lista
  const [range, setRange] = useState<DateRange | undefined>();
  const [exactDate, setExactDate] = useState("");           // busca por data específica
  const [status, setStatus] = useState<StatusFilter>("todas");

  // ---- Dados do calendário + indicadores (janela fixa, igual à tela principal) ----
  const cal = useQuery({
    queryKey: ["conta-calendario", accountId, today],
    queryFn: async () => {
      const from = isoShift(today, -CAL_BACK);
      const [{ data: acct }, { data: recs }, { data: daily }] = await Promise.all([
        supabase.from("bank_accounts").select("id, bank, entity_name, account_number").eq("id", accountId).single(),
        supabase.from("reconciliations")
          .select("id, reconciliation_date, period_end_date, account, bank_account_id, status, closed_with_pending, closed_at")
          .eq("bank_account_id", accountId).gte("reconciliation_date", from),
        supabase.from("daily_account_status")
          .select("account_id, date, status, no_movement_reason")
          .eq("account_id", accountId).gte("date", from),
      ]);
      const recIds = (recs ?? []).map((r) => r.id);
      const [{ data: entries }, { data: matches }] = await Promise.all([
        recIds.length
          ? supabase.from("reconciliation_entries").select("id, reconciliation_id").in("reconciliation_id", recIds)
          : Promise.resolve({ data: [] as EntryRef[] }),
        recIds.length
          ? supabase.from("reconciliation_matches").select("reconciliation_id, status, bb_entry_id, agrotis_entry_id").in("reconciliation_id", recIds)
          : Promise.resolve({ data: [] as MatchRef[] }),
      ]);
      return {
        acct: acct as Acct,
        recs: (recs ?? []) as Array<Rec & { period_end_date: string | null; closed_at: string | null }>,
        entries: (entries ?? []) as EntryRef[],
        matches: (matches ?? []) as MatchRef[],
        daily: (daily ?? []) as Daily[],
      };
    },
  });

  // ---- Lista paginada ----
  // Filtros aplicados no SQL (não no cliente) para que a paginação seja correta
  // mesmo com muitas conciliações.
  const listFilters = { accountId, exactDate, from: range?.from ? iso(range.from) : "", to: range?.to ? iso(range.to) : "", status };
  const list = useInfiniteQuery({
    queryKey: ["conta-lista", listFilters],
    initialPageParam: 0,
    getNextPageParam: (last: ListPage, all) =>
      last.rows.length < PAGE_SIZE ? undefined : all.length,
    queryFn: async ({ pageParam }): Promise<ListPage> => {
      const start = (pageParam as number) * PAGE_SIZE;
      const end = start + PAGE_SIZE - 1;

      // A busca por data específica tem precedência sobre o intervalo.
      const dFrom = exactDate || (range?.from ? iso(range.from) : "");
      const dTo = exactDate || (range?.to ? iso(range.to) : "");

      if (status === "sem_movimento") {
        let q = supabase.from("daily_account_status")
          .select("account_id, date, status, no_movement_reason")
          .eq("account_id", accountId).eq("status", "sem_movimento");
        if (dFrom) q = q.gte("date", dFrom);
        if (dTo) q = q.lte("date", dTo);
        const { data, error } = await q.order("date", { ascending: false }).range(start, end);
        if (error) throw new Error(error.message);
        return { kind: "daily" as const, rows: data ?? [] };
      }

      let q = supabase.from("reconciliations")
        .select("id, reconciliation_date, status, closed_with_pending, balance_bank")
        .eq("bank_account_id", accountId);
      if (dFrom) q = q.gte("reconciliation_date", dFrom);
      if (dTo) q = q.lte("reconciliation_date", dTo);
      // closed_with_pending é nullable (default false). O calendário trata NULL como
      // "sem pendências" (null é falsy), então "conciliada" precisa incluir NULL —
      // senão a lista e o calendário discordariam sobre a mesma conciliação.
      if (status === "conciliada") {
        q = q.eq("status", "fechada").or("closed_with_pending.is.null,closed_with_pending.eq.false");
      } else if (status === "com_pendencias") {
        q = q.eq("status", "fechada").eq("closed_with_pending", true);
      } else if (status === "aberta") {
        q = q.in("status", ["aberta", "reaberta", "massa"]);
      }

      const { data, error } = await q
        .order("reconciliation_date", { ascending: false })
        .range(start, end);
      if (error) throw new Error(error.message);

      // Pendentes: só dos lançamentos das conciliações desta página.
      const ids = (data ?? []).map((r) => r.id);
      const [{ data: entries }, { data: matches }] = await Promise.all([
        ids.length
          ? supabase.from("reconciliation_entries").select("id, reconciliation_id").in("reconciliation_id", ids)
          : Promise.resolve({ data: [] as EntryRef[] }),
        ids.length
          ? supabase.from("reconciliation_matches").select("reconciliation_id, status, bb_entry_id, agrotis_entry_id").in("reconciliation_id", ids)
          : Promise.resolve({ data: [] as MatchRef[] }),
      ]);
      return {
        kind: "rec",
        rows: (data ?? []) as RecRow[],
        entries: (entries ?? []) as EntryRef[],
        matches: (matches ?? []) as MatchRef[],
      };
    },
  });

  const { recInfo, cellFor } = buildCalendar(
    cal.data ?? { recs: [], entries: [], matches: [], daily: [] },
    today,
  );

  async function markNoMovement() {
    if (!dayModal || !reason) return;
    try {
      await noMoveFn({ data: {
        accountId, date: dayModal.date,
        reason: reason as "Fim de semana" | "Feriado" | "Sem movimentação",
      } });
      toast.success("Dia marcado como sem movimento.");
      setDayModal(null); setReason("");
      qc.invalidateQueries({ queryKey: ["conta-calendario", accountId] });
      qc.invalidateQueries({ queryKey: ["conta-lista"] });
      qc.invalidateQueries({ queryKey: ["conciliacao-overview"] });
    } catch (e) { toast.error((e as Error).message); }
  }

  function onCell(date: string) {
    const { recId } = cellFor(accountId, date);
    if (recId) { navigate({ to: "/conciliacao/$id", params: { id: recId } }); return; }
    setReason(isWeekend(date) ? "Fim de semana" : "");
    setDayModal({ date });
  }

  if (cal.isLoading || !cal.data?.acct) {
    return <div className="container mx-auto p-8 text-sm text-muted-foreground">Carregando…</div>;
  }
  const { acct, recs } = cal.data;
  const days = calendarDays(today);

  // ---- Indicadores históricos (últimos 30 dias) ----
  // Todos derivam de cellFor(), então batem célula a célula com o calendário.
  const histDays = lastDays(today, HIST_DAYS);
  const colorOf = (d: string) => cellFor(accountId, d).color;

  const uteis = histDays.filter((d) => !isWeekend(d));
  const semMovimento = histDays.filter((d) => colorOf(d) === "cinza" && !isWeekend(d)).length;
  const semRegistro = histDays.filter((d) => colorOf(d) === "semRegistro").length;
  const fechadasDias = histDays.filter((d) => ["verde", "amarelo"].includes(colorOf(d))).length;
  // Denominador: dias úteis que exigiam trabalho (exclui os marcados sem movimento).
  const exigiam = uteis.length - semMovimento;
  const pctConciliado = exigiam > 0 ? Math.round((fechadasDias / exigiam) * 100) : null;

  // Prazo médio: dias entre o fim do período conciliado e o fechamento.
  const prazos = recs
    .filter((r) => r.status === "fechada" && r.closed_at)
    .map((r) => {
      const base = r.period_end_date ?? r.reconciliation_date;
      const fim = new Date(base + "T00:00:00Z").getTime();
      const fechado = new Date(r.closed_at as string).getTime();
      return (fechado - fim) / 86_400_000;
    })
    .filter((n) => Number.isFinite(n) && n >= 0);
  const prazoMedio = prazos.length
    ? prazos.reduce((a, b) => a + b, 0) / prazos.length
    : null;

  const totalFechadas = recs.filter((r) => r.status === "fechada").length;

  const pages = list.data?.pages ?? [];
  const isDailyList = status === "sem_movimento";
  const totalCarregado = pages.reduce((n, p) => n + p.rows.length, 0);

  const limparFiltros = () => { setRange(undefined); setExactDate(""); setStatus("todas"); };
  const temFiltro = !!range?.from || !!exactDate || status !== "todas";

  return (
    <div className="container mx-auto max-w-6xl px-4 py-6">
      <Breadcrumb className="mb-3">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild><Link to="/conciliacao">Conciliação</Link></BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>{acct.entity_name}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* HEADER */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{acct.entity_name}</h1>
          <div className="text-sm text-muted-foreground">
            {acct.bank}{acct.account_number ? ` · ${acct.account_number}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost">
            <Link to="/conciliacao"><ArrowLeft className="mr-1 h-4 w-4" /> Voltar</Link>
          </Button>
          <Button asChild>
            <Link to="/conciliacao/nova" search={{ account: accountId, date: undefined }}>
              <Plus className="mr-1 h-4 w-4" /> Nova conciliação
            </Link>
          </Button>
        </div>
      </div>

      {/* INDICADORES HISTÓRICOS */}
      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Dias úteis conciliados"
          value={pctConciliado == null ? "—" : `${pctConciliado}%`}
          hint={pctConciliado == null
            ? "Nenhum dia útil exigiu conciliação"
            : `${fechadasDias} de ${exigiam} dias úteis (fora ${semMovimento} sem movimento)`}
        />
        <Stat
          label="Prazo médio de conciliação"
          value={prazoMedio == null ? "—" : `${prazoMedio.toFixed(1)} d`}
          hint={prazoMedio == null ? "Nenhuma conciliação fechada" : `Do fim do período até o fechamento · ${prazos.length} fechada(s)`}
        />
        <Stat label="Conciliações fechadas" value={String(totalFechadas)} hint={`Nos últimos ${HIST_DAYS} dias`} />
        <Stat
          label="Dias sem registro"
          value={String(semRegistro)}
          hint="Dias úteis sem conciliação e sem marcação"
          alert={semRegistro > 0}
        />
      </div>

      {/* CALENDÁRIO */}
      <div className="mb-8">
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <CalendarDays className="h-4 w-4" /> Calendário desta conta
        </h2>
        <Card className="overflow-x-auto p-3">
          <div className="min-w-max space-y-1">
            <div className="flex items-center gap-1">
              {days.map((d, i) => (
                <div key={d} className="w-5 text-center text-[9px] text-muted-foreground">
                  {i % 5 === 0 ? format(new Date(d + "T00:00"), "dd/MM", { locale: ptBR }) : ""}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {days.map((d) => {
                const { color } = cellFor(accountId, d);
                return (
                  <button
                    key={d} type="button"
                    title={`${fmtDate(d)} · ${CELL_LABEL[color]}`}
                    onClick={() => onCell(d)}
                    className={`h-5 w-5 shrink-0 rounded-sm ${CELL_CLASS[color]} cursor-pointer transition-shadow hover:ring-2 hover:ring-ring`}
                  />
                );
              })}
            </div>
          </div>
        </Card>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {CELL_ORDER.map((c) => (
            <span key={c} className="flex items-center gap-1.5">
              <span className={`h-3 w-3 rounded-sm ${CELL_CLASS[c]}`} />{CELL_LABEL[c]}
            </span>
          ))}
        </div>
      </div>

      {/* LISTA */}
      <div>
        <h2 className="mb-2 text-sm font-semibold">Conciliações</h2>

        {/* Filtros */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-9" disabled={!!exactDate}>
                <CalendarRange className="mr-1 h-4 w-4" />
                {range?.from
                  ? range.to
                    ? `${format(range.from, "dd/MM/yy")} – ${format(range.to, "dd/MM/yy")}`
                    : format(range.from, "dd/MM/yy")
                  : "Intervalo de datas"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar mode="range" selected={range} onSelect={setRange} numberOfMonths={2} locale={ptBR} />
            </PopoverContent>
          </Popover>

          <div className="flex items-center gap-1">
            <Input
              type="date" value={exactDate} onChange={(e) => setExactDate(e.target.value)}
              className="h-9 w-[10.5rem]" aria-label="Buscar data específica"
            />
          </div>

          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger className="h-9 w-[11rem]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {temFiltro && (
            <Button variant="ghost" size="sm" className="h-9" onClick={limparFiltros}>
              <X className="mr-1 h-4 w-4" /> Limpar
            </Button>
          )}
          {exactDate && (
            <span className="text-xs text-muted-foreground">
              Buscando {fmtDate(exactDate)} — o intervalo fica desativado.
            </span>
          )}
        </div>

        <Card className="overflow-hidden">
          {/* Cabeçalho */}
          <div className="grid grid-cols-[7rem_1fr_9rem_6rem_5rem] items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            <div>Data</div>
            <div>Status</div>
            <div className="text-right">{isDailyList ? "Motivo" : "Saldo do banco"}</div>
            <div className="text-right">{isDailyList ? "" : "Pendentes"}</div>
            <div className="text-right">Ação</div>
          </div>

          {list.isLoading ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Carregando…</p>
          ) : totalCarregado === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              Nenhum registro para os filtros escolhidos.
            </p>
          ) : (
            <div className="divide-y">
              {pages.map((page, pi) => {
                if (page.kind === "daily") {
                  return page.rows.map((d) => (
                    <div key={`${pi}-${d.date}`} className="grid grid-cols-[7rem_1fr_9rem_6rem_5rem] items-center gap-2 px-4 py-2.5 text-sm">
                      <div className="font-medium">{fmtDate(d.date)}</div>
                      <div><ColorBadge color="cinza" label="Sem movimento" /></div>
                      <div className="text-right text-xs text-muted-foreground">{d.no_movement_reason ?? "—"}</div>
                      <div />
                      <div className="text-right text-xs text-muted-foreground">—</div>
                    </div>
                  ));
                }
                // Cor e pendentes saem da MESMA regra do calendário (buildCalendar),
                // sobre os lançamentos/casamentos desta página. Uma vez por página.
                const pageCal = buildCalendar(
                  { recs: page.rows, entries: page.entries, matches: page.matches, daily: [] },
                  today,
                );
                return page.rows.map((r) => {
                  const info = pageCal.recInfo(r);
                  return (
                    <div key={r.id} className="grid grid-cols-[7rem_1fr_9rem_6rem_5rem] items-center gap-2 px-4 py-2.5 text-sm">
                      <div className="font-medium">{fmtDate(r.reconciliation_date)}</div>
                      <div><ColorBadge color={info.color} label={CELL_LABEL[info.color]} /></div>
                      <div className="text-right tabular-nums">
                        {isDiretor ? fmtBRL(r.balance_bank) : "—"}
                      </div>
                      <div className="text-right tabular-nums">
                        {info.pending > 0
                          ? <span className="font-medium text-amber-600">{info.pending}</span>
                          : <span className="text-muted-foreground">0</span>}
                      </div>
                      <div className="text-right">
                        <Button asChild size="sm" variant="ghost" className="h-7">
                          <Link to="/conciliacao/$id" params={{ id: r.id }}>Ver</Link>
                        </Button>
                      </div>
                    </div>
                  );
                });
              })}
            </div>
          )}

          {list.hasNextPage && (
            <div className="border-t p-3 text-center">
              <Button
                variant="outline" size="sm"
                onClick={() => list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
              </Button>
            </div>
          )}
        </Card>
        {totalCarregado > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {totalCarregado} registro(s) carregado(s){list.hasNextPage ? " — há mais" : ""}.
          </p>
        )}
      </div>

      {/* Modal ao clicar num dia sem registro */}
      <Dialog open={!!dayModal} onOpenChange={(o) => { if (!o) { setDayModal(null); setReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dayModal && `${fmtDate(dayModal.date)} — ${acctLabel(acct)}`}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Nenhum registro neste dia. Escolha uma ação:</p>
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
          <DialogFooter>
            {dayModal && (
              <Button variant="outline" onClick={() => {
                navigate({ to: "/conciliacao/nova", search: { account: accountId, date: dayModal.date } });
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

function Stat({ label, value, hint, alert }: {
  label: string; value: string; hint?: string; alert?: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${alert ? "text-rose-600" : ""}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}

// Badge que reusa exatamente a cor da célula do calendário.
function ColorBadge({ color, label }: { color: CellColor; label: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={`h-2.5 w-2.5 rounded-sm ${CELL_CLASS[color]}`} />
      {label}
    </Badge>
  );
}
