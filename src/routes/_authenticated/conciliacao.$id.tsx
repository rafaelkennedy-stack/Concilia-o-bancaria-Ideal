import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowLeft, Check, Search, Lock, Unlock, X, AlertTriangle, Network, ClipboardList, Printer, Layers } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  confirmMatch, manualMatch, justifyNoPair, closeReconciliation, reopenReconciliation,
  reassignMatch, rejectSuggestion, confirmGroupedMatch, closeMassReconciliation,
} from "@/lib/reconciliation.functions";

export const Route = createFileRoute("/_authenticated/conciliacao/$id")({
  component: Detail,
});

type Entry = {
  id: string; source: "bb" | "agrotis"; entry_date: string | null;
  description: string | null; beneficiary: string | null;
  amount: number; entry_type: "C" | "D"; document_ref: string | null;
};
type Match = {
  id: string; bb_entry_id: string | null; agrotis_entry_id: string | null;
  confidence: "strong" | "medium" | "pending";
  status: "suggested" | "confirmed" | "manual" | "no_pair";
  reason: string | null; justification: string | null;
  confirmed_by: string | null; confirmed_at: string | null;
  group_id: string | null;
};

// Tolerância máxima (R$) entre os lados de qualquer casamento. Espelha
// MATCH_TOLERANCE no servidor (reconciliation.functions.ts).
const TOLERANCE = 1.0;
const signedAmount = (e: Entry) => (e.entry_type === "C" ? 1 : -1) * Number(e.amount);

function Detail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { isDiretor } = useAuth();
  const confirmFn = useServerFn(confirmMatch);
  const closeFn = useServerFn(closeReconciliation);
  const closeMassFn = useServerFn(closeMassReconciliation);
  const reopenFn = useServerFn(reopenReconciliation);
  const noPairFn = useServerFn(justifyNoPair);
  const manualFn = useServerFn(manualMatch);
  const reassignFn = useServerFn(reassignMatch);
  const rejectFn = useServerFn(rejectSuggestion);
  const groupFn = useServerFn(confirmGroupedMatch);





  const [prevIdToReopen, setPrevIdToReopen] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["reconciliation", id],
    queryFn: async () => {
      const [{ data: rec }, { data: entries }, { data: matches }, { data: log }] = await Promise.all([
        supabase.from("reconciliations").select("*").eq("id", id).single(),
        supabase.from("reconciliation_entries").select("*").eq("reconciliation_id", id),
        supabase.from("reconciliation_matches").select("*").eq("reconciliation_id", id),
        supabase.from("reconciliation_audit_log").select("*").eq("reconciliation_id", id).order("created_at"),
      ]);
      return { rec, entries: (entries ?? []) as Entry[], matches: (matches ?? []) as Match[], log: log ?? [] };
    },
  });

  if (q.isLoading || !q.data?.rec) {
    return <div className="container mx-auto p-8 text-sm text-muted-foreground">Carregando…</div>;
  }
  const { rec, entries, matches, log } = q.data;
  const byId = new Map(entries.map((e) => [e.id, e]));

  const strong = matches.filter((m) => m.status === "suggested" && m.confidence === "strong");
  const medium = matches.filter((m) => m.status === "suggested" && m.confidence === "medium");
  const done = matches.filter((m) => m.status !== "suggested");
  const matchedEntryIds = new Set<string>();
  matches.forEach((m) => {
    if (m.bb_entry_id) matchedEntryIds.add(m.bb_entry_id);
    if (m.agrotis_entry_id) matchedEntryIds.add(m.agrotis_entry_id);
  });
  // Entries locked by a definitive (non-suggested) match — used to hide from
  // the "Alterar vínculo" modal. Suggested matches remain selectable so the
  // user can reassign to any not-yet-confirmed entry.
  const confirmedEntryIds = new Set<string>();
  matches.forEach((m) => {
    if (m.status === "suggested") return;
    if (m.bb_entry_id) confirmedEntryIds.add(m.bb_entry_id);
    if (m.agrotis_entry_id) confirmedEntryIds.add(m.agrotis_entry_id);
  });
  const unmatched = entries.filter((e) => !matchedEntryIds.has(e.id));
  // Elegíveis para casamento agrupado: TODOS os lançamentos ainda não confirmados
  // definitivamente (status ≠ confirmed/manual/no_pair) — inclui os que estão só
  // em sugestões, para o usuário escolher livremente. Selecionar um lançamento
  // sugerido remove a sugestão ao confirmar o grupo (ver confirmGroupedMatch).
  const groupEligible = entries.filter((e) => !confirmedEntryIds.has(e.id));
  const suggestedEntryIds = new Set<string>();
  matches.forEach((m) => {
    if (m.status !== "suggested") return;
    if (m.bb_entry_id) suggestedEntryIds.add(m.bb_entry_id);
    if (m.agrotis_entry_id) suggestedEntryIds.add(m.agrotis_entry_id);
  });

  const allReviewed = strong.length === 0 && medium.length === 0 && unmatched.length === 0;
  const isClosed = rec.status === "fechada";
  // Conciliação em massa (vários dias). Ao fechar, é dividida em conciliações
  // diárias; por isso o card de saldo do dia e o fechamento normal não se aplicam.
  const isMassa = rec.status === "massa";
  const distinctDays = new Set(entries.map((e) => e.entry_date ?? rec.reconciliation_date));

  // Lançamentos sem par confirmado: os que não participam de nenhum casamento
  // definitivo (confirmed/manual) nem foram justificados como sem par (no_pair)
  // — ou seja, exatamente o que resta na aba "Revisão". confirmedEntryIds já
  // reúne todos os lançamentos presos a um match não-sugerido.
  const pendingEntries = entries.filter((e) => !confirmedEntryIds.has(e.id));
  const pendingBB = pendingEntries.filter((e) => e.source === "bb");
  const pendingAg = pendingEntries.filter((e) => e.source === "agrotis");

  async function doConfirm(matchId: string) {
    try { await confirmFn({ data: { matchId } }); toast.success("Confirmado"); qc.invalidateQueries({ queryKey: ["reconciliation", id] }); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function doClose(closedWithPending = false) {
    setCloseError(null); setPrevIdToReopen(null);
    try {
      await closeFn({ data: { reconciliationId: id, closedWithPending } });
      toast.success(closedWithPending ? "Conciliação fechada com pendências." : "Conciliação fechada.");
      qc.invalidateQueries({ queryKey: ["reconciliation", id] });
      // Fluxo da fila diária: ao fechar a conciliação do dia, volta para a fila.
      if (rec.reconciliation_date === new Date().toISOString().slice(0, 10)) {
        navigate({ to: "/conciliacao/fila" });
      }
    } catch (e) {
      const msg = (e as Error).message;
      const prevMatch = msg.match(/\|PREV:([0-9a-f-]{36})/);
      if (prevMatch) {
        setPrevIdToReopen(prevMatch[1]);
        setCloseError(msg.split("|PREV:")[0].trim());
      } else {
        setCloseError(msg);
      }
      toast.error("Não foi possível fechar", { description: msg.split("|PREV:")[0] });
    }
  }
  async function doCloseMass() {
    try {
      const res = await closeMassFn({ data: { reconciliationId: id } });
      toast.success(`Dividido em ${res.count} conciliação(ões) diária(s).`);
      // A conciliação massa foi apagada; volta para a lista.
      navigate({ to: "/conciliacao" });
    } catch (e) {
      toast.error("Não foi possível fechar", { description: (e as Error).message });
    }
  }
  async function doReopen() {
    try { await reopenFn({ data: { reconciliationId: id } }); toast.success("Conciliação reaberta."); qc.invalidateQueries({ queryKey: ["reconciliation", id] }); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function doReopenPrevious() {
    if (!prevIdToReopen) return;
    try {
      await reopenFn({ data: { reconciliationId: prevIdToReopen } });
      toast.success("Dia anterior reaberto. Corrija os saldos e feche novamente.");
      setPrevIdToReopen(null); setCloseError(null);
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="container mx-auto max-w-6xl px-4 py-6">
      <Button asChild variant="ghost" size="sm" className="mb-3">
        <Link to="/conciliacao"><ArrowLeft className="mr-1 h-4 w-4" /> Voltar</Link>
      </Button>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            {isMassa
              ? "Processamento em massa"
              : format(new Date(rec.reconciliation_date + "T00:00"), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
          </h1>
          <div className="text-sm text-muted-foreground">
            {rec.account}
            {isMassa && (
              <> · {format(new Date(rec.reconciliation_date + "T00:00"), "dd/MM/yyyy", { locale: ptBR })}
                {rec.period_end_date
                  ? ` a ${format(new Date(rec.period_end_date + "T00:00"), "dd/MM/yyyy", { locale: ptBR })}`
                  : ""} · {distinctDays.size} dia(s)</>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link to="/conciliacao/$id/vinculos" params={{ id }}><Network className="mr-1 h-4 w-4" /> Ver vínculos</Link>
          </Button>
          <PendingReportDialog rec={rec} pendingBB={pendingBB} pendingAg={pendingAg} />
          <Badge className="capitalize" variant={isClosed ? "default" : rec.status === "reaberta" || isMassa ? "secondary" : "outline"}>
            {rec.status}
          </Badge>
          {isClosed && rec.closed_with_pending && (
            <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400">
              com pendências
            </Badge>
          )}
          {isMassa && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button><Layers className="mr-1 h-4 w-4" /> Fechar e dividir por dia</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Fechar e dividir por dia?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Serão criadas {distinctDays.size} conciliação(ões) diária(s), uma para cada dia distinto.
                    Os casamentos confirmados vão para o dia do lançamento do BB e os lançamentos sem par
                    confirmado ficam pendentes na conciliação do respectivo dia. Esta conciliação em massa
                    será removida.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction onClick={doCloseMass}>Fechar e dividir</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {!isClosed && !isMassa && (
            <>
              <Button disabled={!allReviewed} onClick={() => doClose()}>
                <Lock className="mr-1 h-4 w-4" /> Fechar conciliação do dia
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline">
                    <AlertTriangle className="mr-1 h-4 w-4" /> Fechar com pendências
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Fechar com pendências?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {pendingEntries.length === 0
                        ? "Não há lançamentos pendentes — a conciliação será fechada normalmente."
                        : `${pendingEntries.length} lançamento(s) ficarão pendentes ` +
                          `(${pendingBB.length} do Banco do Brasil e ${pendingAg.length} do Agrotis). ` +
                          "Eles permanecem salvos e poderão ser tratados depois. " +
                          "A conciliação será fechada e marcada como fechada com pendências."}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction onClick={() => doClose(true)}>Fechar com pendências</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
          {isClosed && isDiretor && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline"><Unlock className="mr-1 h-4 w-4" /> Reabrir</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reabrir conciliação?</AlertDialogTitle>
                  <AlertDialogDescription>Isso registrará no log de auditoria com seu usuário.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction onClick={doReopen}>Confirmar</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {isMassa ? (
        <Card className="mb-4 border-blue-300 bg-blue-50 p-4 dark:bg-blue-950/20">
          <div className="flex items-start gap-2">
            <Layers className="mt-0.5 h-5 w-5 text-blue-600" />
            <div className="text-sm text-blue-900 dark:text-blue-200">
              <div className="font-medium">Conciliação em massa</div>
              <p className="mt-1 text-blue-800 dark:text-blue-300">
                Revise e confirme os casamentos normalmente. Ao clicar em “Fechar e dividir por dia”,
                o sistema cria uma conciliação fechada para cada dia distinto, distribuindo os casamentos
                pela data do lançamento do BB. A conferência de saldo é feita em cada conciliação diária.
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <BalanceCard rec={rec} entries={entries} />
      )}

      {closeError && (
        <Card className="mb-4 border-rose-300 bg-rose-50 p-4 dark:bg-rose-950/20">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-rose-600" />
            <div className="flex-1">
              <div className="text-sm font-medium text-rose-900 dark:text-rose-200">Fechamento bloqueado</div>
              <p className="mt-1 text-sm text-rose-800 dark:text-rose-300">{closeError}</p>
              {prevIdToReopen && isDiretor && (
                <Button size="sm" variant="outline" className="mt-2" onClick={doReopenPrevious}>
                  <Unlock className="mr-1 h-4 w-4" /> Reabrir dia anterior
                </Button>
              )}
              {prevIdToReopen && !isDiretor && (
                <p className="mt-2 text-xs text-rose-700">Peça ao Diretor para reabrir o dia anterior.</p>
              )}
            </div>
          </div>
        </Card>
      )}


      <Tabs defaultValue="revisar">
        <TabsList>
          <TabsTrigger value="revisar">Revisão ({strong.length + medium.length + unmatched.length})</TabsTrigger>
          <TabsTrigger value="concluidos">Concluídos ({done.length})</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
        </TabsList>

        <TabsContent value="revisar" className="space-y-6 pt-4">
          <Section title="Sugestões fortes" tone="strong" count={strong.length}>
            {strong.map((m) => (
              <SuggestedRow key={m.id} m={m} entries={entries} matchedEntryIds={confirmedEntryIds}
                disabled={isClosed} onConfirm={() => doConfirm(m.id)}
                onReassign={async (side, newEntryId) => {
                  try { await reassignFn({ data: { matchId: m.id, side, newEntryId } });
                    toast.success("Vínculo alterado"); qc.invalidateQueries({ queryKey: ["reconciliation", id] }); }
                  catch (err) { toast.error((err as Error).message); }
                }}
                onReject={async (justification) => {
                  try { await rejectFn({ data: { matchId: m.id, justification } });
                    toast.success("Marcado sem par"); qc.invalidateQueries({ queryKey: ["reconciliation", id] }); }
                  catch (err) { toast.error((err as Error).message); }
                }}
              />
            ))}
          </Section>
          <Section title="Sugestões médias" tone="medium" count={medium.length}>
            {medium.map((m) => (
              <SuggestedRow key={m.id} m={m} entries={entries} matchedEntryIds={confirmedEntryIds}
                disabled={isClosed} onConfirm={() => doConfirm(m.id)}
                onReassign={async (side, newEntryId) => {
                  try { await reassignFn({ data: { matchId: m.id, side, newEntryId } });
                    toast.success("Vínculo alterado"); qc.invalidateQueries({ queryKey: ["reconciliation", id] }); }
                  catch (err) { toast.error((err as Error).message); }
                }}
                onReject={async (justification) => {
                  try { await rejectFn({ data: { matchId: m.id, justification } });
                    toast.success("Marcado sem par"); qc.invalidateQueries({ queryKey: ["reconciliation", id] }); }
                  catch (err) { toast.error((err as Error).message); }
                }}
              />
            ))}
          </Section>
          {!isClosed && groupEligible.length > 1 && (
            <GroupedMatchPanel
              eligible={groupEligible}
              suggestedEntryIds={suggestedEntryIds}
              onConfirm={async (bbIds, agIds, note) => {
                try {
                  await groupFn({ data: { reconciliationId: id, bbEntryIds: bbIds, agrotisEntryIds: agIds, note } });
                  toast.success("Casamento agrupado confirmado");
                  qc.invalidateQueries({ queryKey: ["reconciliation", id] });
                } catch (err) { toast.error((err as Error).message); }
              }}
            />
          )}
          <Section title="Pendentes (sem par)" tone="pending" count={unmatched.length}>
            {unmatched.map((e) => (
              <PendingRow key={e.id} entry={e} allEntries={entries}
                onManual={async (otherId) => {
                  const bb = e.source === "bb" ? e.id : otherId;
                  const ag = e.source === "agrotis" ? e.id : otherId;
                  try { await manualFn({ data: { reconciliationId: id, bbEntryId: bb, agrotisEntryId: ag } });
                    toast.success("Casado manualmente"); qc.invalidateQueries({ queryKey: ["reconciliation", id] }); }
                  catch (err) { toast.error((err as Error).message); }
                }}
                onNoPair={async (justification) => {
                  try { await noPairFn({ data: { reconciliationId: id, entryId: e.id, source: e.source, justification } });
                    toast.success("Marcado sem par"); qc.invalidateQueries({ queryKey: ["reconciliation", id] }); }
                  catch (err) { toast.error((err as Error).message); }
                }}
                disabled={isClosed}
              />
            ))}
          </Section>
        </TabsContent>

        <TabsContent value="concluidos" className="space-y-2 pt-4">
          {done.length === 0 && <p className="text-sm text-muted-foreground">Nada concluído ainda.</p>}
          {done.map((m) => (
            <MatchRow key={m.id} m={m} bb={m.bb_entry_id ? byId.get(m.bb_entry_id) : undefined}
              ag={m.agrotis_entry_id ? byId.get(m.agrotis_entry_id) : undefined} tone="done" />
          ))}
        </TabsContent>

        <TabsContent value="historico" className="pt-4">
          <Card className="p-4">
            <ul className="space-y-2 text-sm">
              {log.map((l: any) => (
                <li key={l.id} className="flex items-start justify-between border-b pb-2 last:border-b-0">
                  <div>
                    <div className="font-medium">{l.action}</div>
                    {l.details && <pre className="mt-1 text-xs text-muted-foreground">{JSON.stringify(l.details)}</pre>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {format(new Date(l.created_at), "dd/MM HH:mm", { locale: ptBR })}
                    <div>por {l.user_id?.slice(0, 8) ?? "—"}</div>
                  </div>
                </li>
              ))}
              {log.length === 0 && <p className="text-muted-foreground">Sem entradas.</p>}
            </ul>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Section({ title, tone, count, children }: { title: string; tone: "strong" | "medium" | "pending"; count: number; children: React.ReactNode }) {
  const bg = tone === "strong" ? "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-900"
    : tone === "medium" ? "bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-900"
    : "bg-rose-50 border-rose-200 dark:bg-rose-950/20 dark:border-rose-900";
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">{title} · {count}</h2>
      <div className={`space-y-2 rounded-md border p-2 ${bg}`}>
        {count === 0 ? <p className="p-3 text-sm text-muted-foreground">Nada aqui.</p> : children}
      </div>
    </div>
  );
}

function EntryCard({ e, label }: { e?: Entry; label: string }) {
  if (!e) return <div className="rounded border bg-muted/40 p-3 text-xs text-muted-foreground">{label}: —</div>;
  return (
    <div className="rounded border bg-card p-3 text-sm">
      <div className="mb-1 text-xs uppercase text-muted-foreground">{label}</div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{e.description || "(sem descrição)"}</span>
        <span className={e.entry_type === "C" ? "text-emerald-600" : "text-rose-600"}>
          {e.entry_type === "C" ? "+" : "−"} R$ {Number(e.amount).toFixed(2)}
        </span>
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{e.entry_date ?? "sem data"} {e.beneficiary ? `· ${e.beneficiary}` : ""}</span>
        <span>{e.document_ref ?? ""}</span>
      </div>
    </div>
  );
}

function MatchRow({ m, bb, ag, actions, tone }: { m: Match; bb?: Entry; ag?: Entry; actions?: React.ReactNode; tone?: "done" }) {
  return (
    <Card className="p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <EntryCard e={bb} label="Banco do Brasil" />
        <EntryCard e={ag} label="Agrotis" />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {m.reason || m.justification || (m.status === "manual" ? "Casado manualmente" : "")}
        </span>
        <div className="flex items-center gap-2">
          {tone === "done" && <Badge variant="secondary" className="capitalize">{m.status.replace("_", " ")}</Badge>}
          {actions}
        </div>
      </div>
    </Card>
  );
}

function PendingRow({ entry, allEntries, onManual, onNoPair, disabled }: {
  entry: Entry; allEntries: Entry[];
  onManual: (otherId: string) => void; onNoPair: (j: string) => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [noOpen, setNoOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [justification, setJustification] = useState("");
  const opposite = allEntries.filter((e) => e.source !== entry.source);
  const filtered = opposite.filter((e) => {
    const s = search.toLowerCase();
    return !s || (e.description ?? "").toLowerCase().includes(s) || String(e.amount).includes(s) || (e.beneficiary ?? "").toLowerCase().includes(s);
  });
  // Diferença 1:1 entre o lançamento pendente e um candidato (sinais C/D).
  const pairDiff = (candidate: Entry) => {
    const bb = entry.source === "bb" ? entry : candidate;
    const ag = entry.source === "agrotis" ? entry : candidate;
    return Number((signedAmount(bb) - signedAmount(ag)).toFixed(2));
  };

  return (
    <Card className="p-3">
      <EntryCard e={entry} label={entry.source === "bb" ? "Banco do Brasil (sem par)" : "Agrotis (sem par)"} />
      {!disabled && (
        <div className="mt-2 flex justify-end gap-2">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button size="sm" variant="outline"><Search className="mr-1 h-4 w-4" />Casar manualmente</Button></DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader><DialogTitle>Escolher lançamento para casar</DialogTitle></DialogHeader>
              <Input placeholder="Buscar por descrição, valor ou beneficiário…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <div className="max-h-80 space-y-1 overflow-auto">
                {filtered.map((e) => {
                  const d = pairDiff(e);
                  const over = Math.abs(d) > TOLERANCE;
                  return (
                    <button key={e.id} type="button" disabled={over}
                      className="w-full text-left disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => { onManual(e.id); setOpen(false); }}>
                      <EntryCard e={e} label={e.source === "bb" ? "BB" : "Agrotis"} />
                      <div className={`px-1 pb-1 text-xs ${over ? "font-medium text-rose-600" : "text-emerald-600"}`}>
                        Diferença R$ {Math.abs(d).toFixed(2)}{over ? ` — acima da tolerância de R$ ${TOLERANCE.toFixed(2)}` : ""}
                      </div>
                    </button>
                  );
                })}
                {filtered.length === 0 && <p className="p-3 text-sm text-muted-foreground">Nenhum resultado.</p>}
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={noOpen} onOpenChange={setNoOpen}>
            <DialogTrigger asChild><Button size="sm" variant="ghost"><X className="mr-1 h-4 w-4" />Sem par justificado</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Justificar ausência de par</DialogTitle></DialogHeader>
              <Textarea value={justification} onChange={(e) => setJustification(e.target.value)} placeholder="Explique por que este lançamento não tem par…" />
              <DialogFooter>
                <Button variant="ghost" onClick={() => setNoOpen(false)}>Cancelar</Button>
                <Button disabled={!justification.trim()} onClick={() => { onNoPair(justification.trim()); setJustification(""); setNoOpen(false); }}>Registrar</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </Card>
  );
}

function GroupedMatchPanel({ eligible, suggestedEntryIds, onConfirm }: {
  eligible: Entry[];
  suggestedEntryIds: Set<string>;
  onConfirm: (bbIds: string[], agIds: string[], note: string) => void | Promise<void>;
}) {
  const [bbSel, setBbSel] = useState<Set<string>>(new Set());
  const [agSel, setAgSel] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const bbList = eligible.filter((e) => e.source === "bb");
  const agList = eligible.filter((e) => e.source === "agrotis");
  const sumBb = bbList.filter((e) => bbSel.has(e.id)).reduce((s, e) => s + signedAmount(e), 0);
  const sumAg = agList.filter((e) => agSel.has(e.id)).reduce((s, e) => s + signedAmount(e), 0);
  const diff = Number((sumBb - sumAg).toFixed(2));
  const withinTolerance = Math.abs(diff) <= TOLERANCE;
  const canSubmit = bbSel.size >= 1 && agSel.size >= 1
    && (bbSel.size > 1 || agSel.size > 1) && withinTolerance;

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };
  const reset = () => { setBbSel(new Set()); setAgSel(new Set()); setNote(""); };

  const renderItem = (e: Entry, sel: Set<string>, setter: (s: Set<string>) => void) => (
    <label key={e.id} className="flex items-start gap-2 rounded border bg-card p-2 text-sm">
      <Checkbox checked={sel.has(e.id)} onCheckedChange={() => toggle(sel, setter, e.id)} className="mt-1" />
      <div className="flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex items-center gap-1.5 font-medium">
            {e.description || "(sem descrição)"}
            {suggestedEntryIds.has(e.id) && (
              <Badge variant="outline" className="border-amber-400 text-[10px] text-amber-700 dark:text-amber-400">sugerido</Badge>
            )}
          </span>
          <span className={e.entry_type === "C" ? "text-emerald-600" : "text-rose-600"}>
            {e.entry_type === "C" ? "+" : "−"} R$ {Number(e.amount).toFixed(2)}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {e.entry_date ?? "sem data"} {e.beneficiary ? `· ${e.beneficiary}` : ""}
        </div>
      </div>
    </label>
  );

  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">
        Casamento agrupado (N:1 / 1:N) · selecione 2+ de um lado e 1+ do outro
      </h2>
      <Card className="p-3">
        <p className="mb-2 text-xs text-muted-foreground">
          Mostrando todos os lançamentos ainda não confirmados. Itens marcados como
          <span className="mx-1 font-medium text-amber-700 dark:text-amber-400">sugerido</span>
          estão em uma sugestão que será substituída ao confirmar o grupo.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Banco do Brasil</div>
            <div className="max-h-72 space-y-1 overflow-auto pr-1">
              {bbList.length === 0 && <p className="text-xs text-muted-foreground">Nada elegível.</p>}
              {bbList.map((e) => renderItem(e, bbSel, setBbSel))}
            </div>
            <div className="mt-2 text-xs">
              Selecionados: <strong>{bbSel.size}</strong> · Soma: <strong>R$ {sumBb.toFixed(2)}</strong>
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Agrotis</div>
            <div className="max-h-72 space-y-1 overflow-auto pr-1">
              {agList.length === 0 && <p className="text-xs text-muted-foreground">Nada elegível.</p>}
              {agList.map((e) => renderItem(e, agSel, setAgSel))}
            </div>
            <div className="mt-2 text-xs">
              Selecionados: <strong>{agSel.size}</strong> · Soma: <strong>R$ {sumAg.toFixed(2)}</strong>
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <div className="text-sm">
            Diferença:{" "}
            <strong className={withinTolerance ? "text-emerald-600" : "text-rose-600"}>
              R$ {diff.toFixed(2)}
            </strong>
            <span className="ml-2 text-xs text-muted-foreground">(tolerância R$ {TOLERANCE.toFixed(2)})</span>
            {!withinTolerance && (bbSel.size > 0 || agSel.size > 0) && (
              <span className="ml-2 text-xs font-medium text-rose-600">Acima da tolerância — confirmação bloqueada</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observação (opcional)" className="h-9 w-56" />
            <Button size="sm" variant="ghost" onClick={reset}>Limpar</Button>
            <Button size="sm" disabled={!canSubmit}
              onClick={async () => {
                await onConfirm([...bbSel], [...agSel], note.trim());
                reset();
              }}>
              <Check className="mr-1 h-4 w-4" />Confirmar casamento agrupado
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function SuggestedRow({
  m, entries, matchedEntryIds, disabled, onConfirm, onReassign, onReject,
}: {
  m: Match; entries: Entry[]; matchedEntryIds: Set<string>; disabled: boolean;
  onConfirm: () => void;
  onReassign: (side: "bb" | "agrotis", newEntryId: string) => void;
  onReject: (justification: string) => void;
}) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const bb = m.bb_entry_id ? byId.get(m.bb_entry_id) : undefined;
  const ag = m.agrotis_entry_id ? byId.get(m.agrotis_entry_id) : undefined;
  const diff = bb && ag ? Number((signedAmount(bb) - signedAmount(ag)).toFixed(2)) : null;
  const overTolerance = diff != null && Math.abs(diff) > TOLERANCE;

  const [editOpen, setEditOpen] = useState(false);
  const [side, setSide] = useState<"bb" | "agrotis">("agrotis");
  const [search, setSearch] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [justification, setJustification] = useState("");

  // available = entries on that side not currently linked in any match,
  // plus the currently-linked entry on that side (so user can keep it as-is)
  const currentOnSide = side === "bb" ? m.bb_entry_id : m.agrotis_entry_id;
  const candidates = entries.filter((e) =>
    e.source === side && (!matchedEntryIds.has(e.id) || e.id === currentOnSide) && e.id !== currentOnSide,
  );
  const filtered = candidates.filter((e) => {
    const s = search.toLowerCase();
    return !s || (e.description ?? "").toLowerCase().includes(s)
      || String(e.amount).includes(s)
      || (e.beneficiary ?? "").toLowerCase().includes(s);
  });

  return (
    <Card className="p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <EntryCard e={bb} label="Banco do Brasil" />
        <EntryCard e={ag} label="Agrotis" />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          {m.reason ?? ""}
          {overTolerance && (
            <span className="ml-2 font-medium text-rose-600">
              Diferença R$ {Math.abs(diff!).toFixed(2)} — acima da tolerância de R$ {TOLERANCE.toFixed(2)}
            </span>
          )}
        </span>
        {!disabled && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={overTolerance} onClick={onConfirm}><Check className="mr-1 h-4 w-4" />Confirmar</Button>

            <Dialog open={editOpen} onOpenChange={setEditOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline"><Search className="mr-1 h-4 w-4" />Alterar vínculo</Button>
              </DialogTrigger>
              <DialogContent className="max-w-xl">
                <DialogHeader><DialogTitle>Alterar vínculo</DialogTitle></DialogHeader>
                <div className="flex gap-2">
                  <Button size="sm" variant={side === "bb" ? "default" : "outline"} onClick={() => setSide("bb")}>Trocar BB</Button>
                  <Button size="sm" variant={side === "agrotis" ? "default" : "outline"} onClick={() => setSide("agrotis")}>Trocar Agrotis</Button>
                </div>
                <Input placeholder="Buscar…" value={search} onChange={(e) => setSearch(e.target.value)} />
                <div className="max-h-80 space-y-1 overflow-auto">
                  {filtered.map((e) => (
                    <button key={e.id} type="button" className="w-full text-left"
                      onClick={() => { onReassign(side, e.id); setEditOpen(false); setSearch(""); }}>
                      <EntryCard e={e} label={side === "bb" ? "BB" : "Agrotis"} />
                    </button>
                  ))}
                  {filtered.length === 0 && (
                    <p className="p-3 text-sm text-muted-foreground">Nenhum lançamento disponível deste lado.</p>
                  )}
                </div>
              </DialogContent>
            </Dialog>

            <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="ghost"><X className="mr-1 h-4 w-4" />Marcar sem par</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Marcar como sem par</DialogTitle></DialogHeader>
                <p className="text-sm text-muted-foreground">
                  Ambos os lançamentos serão registrados como sem par com a mesma justificativa.
                </p>
                <Textarea value={justification} onChange={(e) => setJustification(e.target.value)}
                  placeholder="Justificativa obrigatória…" />
                <DialogFooter>
                  <Button variant="ghost" onClick={() => setRejectOpen(false)}>Cancelar</Button>
                  <Button disabled={!justification.trim()}
                    onClick={() => { onReject(justification.trim()); setJustification(""); setRejectOpen(false); }}>
                    Registrar
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>
    </Card>
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function fmtEntryAmount(e: Entry) {
  return `${e.entry_type === "C" ? "+" : "−"} R$ ${Number(e.amount).toFixed(2)}`;
}

// Abre uma janela com um documento HTML autocontido e dispara a impressão.
// Evita conflitos de @media print com o app e mantém o relatório previsível.
function printPendingReport(title: string, bb: Entry[], ag: Entry[]) {
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) {
    toast.error("Não foi possível abrir a janela de impressão. Permita pop-ups para este site.");
    return;
  }
  const rows = (list: Entry[]) =>
    list.length === 0
      ? `<tr><td colspan="5" class="empty">Nenhuma pendência.</td></tr>`
      : list
          .map(
            (e) => `<tr>
      <td>${escapeHtml(e.entry_date ?? "—")}</td>
      <td>${escapeHtml(e.description || "(sem descrição)")}</td>
      <td>${escapeHtml(e.beneficiary ?? "")}</td>
      <td>${escapeHtml(e.document_ref ?? "")}</td>
      <td class="amt ${e.entry_type === "C" ? "c" : "d"}">${fmtEntryAmount(e)}</td>
    </tr>`,
          )
          .join("");
  const section = (label: string, list: Entry[]) => `
    <h2>${escapeHtml(label)} · ${list.length}</h2>
    <table>
      <thead>
        <tr><th>Data</th><th>Descrição</th><th>Beneficiário</th><th>Documento</th><th class="amt">Valor</th></tr>
      </thead>
      <tbody>${rows(list)}</tbody>
    </table>`;
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111; margin: 24px; }
      h1 { font-size: 18px; margin: 0 0 16px; }
      h2 { font-size: 14px; margin: 24px 0 6px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
      th { background: #f4f4f5; }
      td.amt, th.amt { text-align: right; white-space: nowrap; }
      td.amt.c { color: #047857; }
      td.amt.d { color: #be123c; }
      td.empty { color: #777; font-style: italic; }
      @media print { body { margin: 0; } }
    </style></head><body>
    <h1>${escapeHtml(title)}</h1>
    ${section("Banco do Brasil — sem par confirmado", bb)}
    ${section("Agrotis — sem par confirmado", ag)}
  </body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

function PendingEntryRow({ e }: { e: Entry }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b py-1.5 text-sm last:border-b-0">
      <div className="min-w-0">
        <div className="truncate font-medium">{e.description || "(sem descrição)"}</div>
        <div className="truncate text-xs text-muted-foreground">
          {e.entry_date ?? "sem data"}
          {e.beneficiary ? ` · ${e.beneficiary}` : ""}
          {e.document_ref ? ` · ${e.document_ref}` : ""}
        </div>
      </div>
      <span className={`whitespace-nowrap ${e.entry_type === "C" ? "text-emerald-600" : "text-rose-600"}`}>
        {fmtEntryAmount(e)}
      </span>
    </div>
  );
}

function PendingReportDialog({ rec, pendingBB, pendingAg }: {
  rec: any; pendingBB: Entry[]; pendingAg: Entry[];
}) {
  const dateLabel = format(new Date(rec.reconciliation_date + "T00:00"), "dd/MM/yyyy", { locale: ptBR });
  const title = `Pendências a conciliar — ${dateLabel} — ${rec.account}`;
  const total = pendingBB.length + pendingAg.length;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <ClipboardList className="mr-1 h-4 w-4" /> Pendências
          {total > 0 && (
            <Badge variant="secondary" className="ml-1.5">{total}</Badge>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {total === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Nenhuma pendência — tudo com par confirmado ou justificado.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Banco do Brasil · {pendingBB.length}
              </div>
              <div className="max-h-80 overflow-auto rounded-md border p-2">
                {pendingBB.length === 0
                  ? <p className="p-2 text-sm text-muted-foreground">Nenhuma pendência.</p>
                  : pendingBB.map((e) => <PendingEntryRow key={e.id} e={e} />)}
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Agrotis · {pendingAg.length}
              </div>
              <div className="max-h-80 overflow-auto rounded-md border p-2">
                {pendingAg.length === 0
                  ? <p className="p-2 text-sm text-muted-foreground">Nenhuma pendência.</p>
                  : pendingAg.map((e) => <PendingEntryRow key={e.id} e={e} />)}
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => printPendingReport(title, pendingBB, pendingAg)}>
            <Printer className="mr-1 h-4 w-4" /> Imprimir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function fmtBRL(n: number | null | undefined) {
  if (n == null) return "—";
  return `R$ ${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function BalanceCard({ rec, entries }: { rec: any; entries: Entry[] }) {
  const totalBy = (source: "bb" | "agrotis", type: "C" | "D") =>
    entries.filter((e) => e.source === source && e.entry_type === type)
      .reduce((s, e) => s + Number(e.amount), 0);
  const bankCredits = totalBy("bb", "C");
  const bankDebits = totalBy("bb", "D");
  const agCredits = totalBy("agrotis", "C");
  const agDebits = totalBy("agrotis", "D");

  const previous = rec.balance_agrotis_previous != null ? Number(rec.balance_agrotis_previous) : null;
  // Saldo final Agrotis = anterior + entradas − saídas. Ao fechar, também fica
  // persistido em balance_agrotis_calculated (fallback quando não há saldo anterior).
  const agrotisFinal = previous != null
    ? Number((previous + agCredits - agDebits).toFixed(2))
    : (rec.balance_agrotis_calculated != null ? Number(rec.balance_agrotis_calculated) : null);
  const bank = rec.balance_bank != null ? Number(rec.balance_bank) : null;
  const diff = bank != null && agrotisFinal != null ? Number((bank - agrotisFinal).toFixed(2)) : null;
  const ok = diff != null && Math.abs(diff) < 0.01;

  if (bank == null && agrotisFinal == null && entries.length === 0) return null;
  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 text-sm font-semibold">Conferência de saldo do dia</div>
      <div className="grid gap-4 sm:grid-cols-2">
        <BalanceColumn
          title="Banco do Brasil" final={bank}
          finalLabel="Saldo final (linha S A L D O)"
          credits={bankCredits} debits={bankDebits}
        />
        <BalanceColumn
          title="Agrotis" final={agrotisFinal}
          finalLabel="Saldo final (anterior + entradas − saídas)"
          credits={agCredits} debits={agDebits}
          extra={previous != null ? `Saldo anterior ${fmtBRL(previous)}` : undefined}
        />
      </div>
      <div className="mt-3 flex items-center justify-between border-t pt-3">
        <span className="text-sm text-muted-foreground">Diferença de saldo (Banco − Agrotis)</span>
        <span className={`text-lg font-semibold ${diff == null ? "" : ok ? "text-emerald-600" : "text-rose-600"}`}>
          {diff == null ? "—" : fmtBRL(diff)}
        </span>
      </div>
    </Card>
  );
}

function BalanceColumn({ title, final, finalLabel, credits, debits, extra }: {
  title: string; final: number | null; finalLabel: string;
  credits: number; debits: number; extra?: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{title}</div>
      <div className="text-xs text-muted-foreground">{finalLabel}</div>
      <div className="text-lg font-medium">{fmtBRL(final)}</div>
      {extra && <div className="mt-0.5 text-xs text-muted-foreground">{extra}</div>}
      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">Créditos (entradas)</div>
          <div className="font-medium text-emerald-600">+ {fmtBRL(credits)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Débitos (saídas)</div>
          <div className="font-medium text-rose-600">− {fmtBRL(debits)}</div>
        </div>
      </div>
    </div>
  );
}

