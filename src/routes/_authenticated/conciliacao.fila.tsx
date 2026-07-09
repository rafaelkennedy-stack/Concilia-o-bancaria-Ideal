import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { ArrowLeft, Sparkles, CalendarOff, Clock, Check, Play, RotateCcw, ChevronDown } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { setNoMovement, deferAccount, resetDailyStatus } from "@/lib/reconciliation.functions";

export const Route = createFileRoute("/_authenticated/conciliacao/fila")({
  component: Fila,
});

// "Hoje" no mesmo formato usado ao criar conciliações (nova.tsx), para que os
// joins por data com reconciliations e daily_account_status batam.
const todayISO = () => new Date().toISOString().slice(0, 10);

const REASONS = ["Fim de semana", "Feriado", "Sem movimentação"] as const;
type Reason = (typeof REASONS)[number];

type Account = { id: string; bank: string; entity_name: string; account_number: string | null };
type QueueStatus = "pendente" | "em_andamento" | "conciliada" | "sem_movimento" | "adiada";
type Row = { account: Account; label: string; status: QueueStatus; recId: string | null; reason: string | null };

// Ordem da fila: em andamento primeiro (retomar), depois pendentes, depois as
// adiadas (fim da fila do dia), e por último as concluídas.
const RANK: Record<QueueStatus, number> = {
  em_andamento: 0, pendente: 1, adiada: 2, sem_movimento: 3, conciliada: 4,
};

const STATUS_META: Record<QueueStatus, { label: string; variant: "default" | "secondary" | "outline"; className?: string }> = {
  pendente: { label: "Pendente", variant: "outline" },
  em_andamento: { label: "Em andamento", variant: "secondary" },
  conciliada: { label: "Conciliada", variant: "default" },
  sem_movimento: { label: "Sem movimento", variant: "outline", className: "text-muted-foreground" },
  adiada: { label: "Deixada para depois", variant: "outline", className: "border-amber-400 text-amber-700 dark:text-amber-400" },
};

function Fila() {
  const today = todayISO();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const noMovementFn = useServerFn(setNoMovement);
  const deferFn = useServerFn(deferAccount);
  const resetFn = useServerFn(resetDailyStatus);

  const q = useQuery({
    queryKey: ["fila", today],
    queryFn: async (): Promise<Row[]> => {
      const [{ data: accts, error: aErr }, { data: recs }, { data: daily }] = await Promise.all([
        supabase.from("bank_accounts").select("id, bank, entity_name, account_number").eq("active", true).order("bank"),
        supabase.from("reconciliations").select("id, bank_account_id, status").eq("reconciliation_date", today),
        supabase.from("daily_account_status").select("account_id, status, no_movement_reason").eq("date", today),
      ]);
      if (aErr) throw aErr;

      const recByAcct = new Map<string, { id: string; status: string }[]>();
      for (const r of recs ?? []) {
        if (!r.bank_account_id) continue;
        const arr = recByAcct.get(r.bank_account_id) ?? [];
        arr.push({ id: r.id, status: r.status });
        recByAcct.set(r.bank_account_id, arr);
      }
      const dailyByAcct = new Map<string, { status: QueueStatus; reason: string | null }>();
      for (const d of daily ?? []) dailyByAcct.set(d.account_id, { status: d.status as QueueStatus, reason: d.no_movement_reason });

      const rows: Row[] = (accts ?? []).map((a) => {
        const label = `${a.bank} — ${a.entity_name}${a.account_number ? ` (${a.account_number})` : ""}`;
        const rs = recByAcct.get(a.id) ?? [];
        // Estado da conciliação é a fonte de verdade para conciliada/em andamento;
        // daily_account_status guarda as decisões da fila (sem movimento / adiada).
        const closed = rs.find((r) => r.status === "fechada");
        const open = rs.find((r) => r.status !== "fechada");
        const d = dailyByAcct.get(a.id);
        let status: QueueStatus = "pendente";
        let recId: string | null = null;
        let reason: string | null = null;
        if (closed) { status = "conciliada"; recId = closed.id; }
        else if (open) { status = "em_andamento"; recId = open.id; }
        else if (d?.status === "sem_movimento") { status = "sem_movimento"; reason = d.reason; }
        else if (d?.status === "adiada") { status = "adiada"; }
        return { account: a, label, status, recId, reason };
      });
      rows.sort((x, y) => RANK[x.status] - RANK[y.status] || x.label.localeCompare(y.label));
      return rows;
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["fila", today] });

  async function doNoMovement(accountId: string, reason: Reason) {
    try { await noMovementFn({ data: { accountId, date: today, reason } }); toast.success("Marcado sem movimento"); invalidate(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function doDefer(accountId: string) {
    try { await deferFn({ data: { accountId, date: today } }); toast.success("Deixado para depois"); invalidate(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function doReset(accountId: string) {
    try { await resetFn({ data: { accountId, date: today } }); toast.success("Revertido para pendente"); invalidate(); }
    catch (e) { toast.error((e as Error).message); }
  }
  function processAccount(row: Row) {
    if (row.recId) navigate({ to: "/conciliacao/$id", params: { id: row.recId } });
    else navigate({ to: "/conciliacao/nova", search: { account: row.account.id, date: today } });
  }

  const rows = q.data ?? [];
  const todo = rows.filter((r) => r.status === "pendente" || r.status === "adiada" || r.status === "em_andamento").length;
  const done = rows.length - todo;

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      <Button asChild variant="ghost" size="sm" className="mb-2">
        <Link to="/conciliacao"><ArrowLeft className="mr-1 h-4 w-4" /> Histórico</Link>
      </Button>
      <div className="mb-5">
        <h1 className="text-2xl font-bold">Fila do dia</h1>
        <p className="text-sm text-muted-foreground">
          {format(new Date(today + "T00:00"), "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
          {" · "}<span className="font-medium">{todo}</span> a fazer · <span className="font-medium">{done}</span> concluídas
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : q.error ? (
        <Card className="border-rose-300 bg-rose-50 p-4 text-sm text-rose-800 dark:bg-rose-950/20 dark:text-rose-300">
          Não foi possível carregar a fila. Confirme que a migração <code>daily_account_status</code> foi aplicada no Supabase.
        </Card>
      ) : rows.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          Nenhuma conta bancária ativa. Peça ao Diretor para cadastrar em Configurações › Contas.
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <QueueRow key={row.account.id} row={row}
              onProcess={() => processAccount(row)}
              onNoMovement={(reason) => doNoMovement(row.account.id, reason)}
              onDefer={() => doDefer(row.account.id)}
              onReset={() => doReset(row.account.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QueueRow({ row, onProcess, onNoMovement, onDefer, onReset }: {
  row: Row;
  onProcess: () => void;
  onNoMovement: (reason: Reason) => void;
  onDefer: () => void;
  onReset: () => void;
}) {
  const meta = STATUS_META[row.status];
  const actionable = row.status === "pendente" || row.status === "adiada";
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <div className="truncate font-medium">{row.label}</div>
        <div className="mt-1 flex items-center gap-2">
          <Badge variant={meta.variant} className={meta.className}>{meta.label}</Badge>
          {row.status === "sem_movimento" && row.reason && (
            <span className="text-xs text-muted-foreground">{row.reason}</span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {row.status === "conciliada" && (
          <Button size="sm" variant="outline" onClick={onProcess}><Check className="mr-1 h-4 w-4" />Ver</Button>
        )}
        {row.status === "em_andamento" && (
          <Button size="sm" onClick={onProcess}><Play className="mr-1 h-4 w-4" />Continuar</Button>
        )}
        {actionable && (
          <>
            <Button size="sm" onClick={onProcess}><Sparkles className="mr-1 h-4 w-4" />Processar</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  <CalendarOff className="mr-1 h-4 w-4" />Sem movimento<ChevronDown className="ml-1 h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Motivo</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {REASONS.map((r) => (
                  <DropdownMenuItem key={r} onClick={() => onNoMovement(r)}>{r}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {row.status === "pendente" ? (
              <Button size="sm" variant="ghost" onClick={onDefer}><Clock className="mr-1 h-4 w-4" />Deixar para depois</Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={onReset}><RotateCcw className="mr-1 h-4 w-4" />Reverter</Button>
            )}
          </>
        )}
        {row.status === "sem_movimento" && (
          <Button size="sm" variant="ghost" onClick={onReset}><RotateCcw className="mr-1 h-4 w-4" />Reverter</Button>
        )}
      </div>
    </Card>
  );
}
