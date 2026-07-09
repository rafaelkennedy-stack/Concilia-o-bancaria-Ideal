import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ArrowLeft, HelpCircle, ExternalLink } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

export const Route = createFileRoute("/_authenticated/conciliacao/$id_/vinculos")({
  component: Vinculos,
});

type Entry = {
  id: string; source: "bb" | "agrotis"; entry_date: string | null;
  description: string | null; beneficiary: string | null;
  amount: number; entry_type: "C" | "D"; document_ref: string | null;
};
type Match = {
  id: string; bb_entry_id: string | null; agrotis_entry_id: string | null;
  status: "suggested" | "confirmed" | "manual" | "no_pair";
  reason: string | null; justification: string | null; group_id: string | null;
};

const TOLERANCE = 1.0;
const signed = (e: Entry) => (e.entry_type === "C" ? 1 : -1) * Number(e.amount);
const fmtBRL = (n: number) => `R$ ${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Vinculo = {
  key: string; bb: Entry[]; ag: Entry[];
  kind: string; status: Match["status"]; note: string | null;
};

function Vinculos() {
  const { id } = Route.useParams();
  const navigate = useNavigate();

  // Mesma query/chave da tela de detalhe → cache compartilhado, navegação instantânea.
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
  const { rec, entries, matches } = q.data;
  const byId = new Map(entries.map((e) => [e.id, e]));

  const done = matches.filter((m) => m.status === "confirmed" || m.status === "manual" || m.status === "no_pair");

  // Agrupa casamentos em vínculos: mesmo group_id = um vínculo N:1/1:N; sem
  // group_id = vínculo 1:1 ou "sem par".
  const byGroup = new Map<string, Match[]>();
  const solo: Match[] = [];
  for (const m of done) {
    if (m.group_id) (byGroup.get(m.group_id) ?? byGroup.set(m.group_id, []).get(m.group_id)!).push(m);
    else solo.push(m);
  }

  const collect = (ms: Match[], key: string): Vinculo => {
    const bbIds = new Set<string>(), agIds = new Set<string>();
    for (const m of ms) { if (m.bb_entry_id) bbIds.add(m.bb_entry_id); if (m.agrotis_entry_id) agIds.add(m.agrotis_entry_id); }
    const bb = [...bbIds].map((i) => byId.get(i)).filter(Boolean) as Entry[];
    const ag = [...agIds].map((i) => byId.get(i)).filter(Boolean) as Entry[];
    const status = ms[0].status;
    const note = ms.map((m) => m.reason || m.justification).find(Boolean) ?? null;
    let kind: string;
    if (bb.length === 0 || ag.length === 0) kind = "Sem par";
    else if (bb.length === 1 && ag.length === 1) kind = "1:1";
    else if (ag.length === 1) kind = `${bb.length}:1`;
    else if (bb.length === 1) kind = `1:${ag.length}`;
    else kind = `${bb.length}:${ag.length}`;
    return { key, bb, ag, kind, status, note };
  };

  const vinculos: Vinculo[] = [
    ...[...byGroup.entries()].map(([gid, ms]) => collect(ms, `g:${gid}`)),
    ...solo.map((m) => collect([m], `m:${m.id}`)),
  ];

  return (
    <div className="container mx-auto max-w-5xl px-4 py-6">
      <Button asChild variant="ghost" size="sm" className="mb-3">
        <Link to="/conciliacao/$id" params={{ id }}><ArrowLeft className="mr-1 h-4 w-4" /> Voltar ao detalhe</Link>
      </Button>

      <div className="mb-5">
        <h1 className="text-2xl font-bold">Mapa de vínculos</h1>
        <div className="text-sm text-muted-foreground">
          {format(new Date(rec.reconciliation_date + "T00:00"), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })} · {rec.account}
          {" · "}{vinculos.length} vínculo(s)
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-blue-300 bg-blue-100 dark:bg-blue-950/40" /> Banco do Brasil</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-emerald-300 bg-emerald-100 dark:bg-emerald-950/40" /> Agrotis</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded bg-emerald-500" /> valores batem</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded bg-rose-500" /> divergência</span>
      </div>

      {vinculos.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Nenhum vínculo confirmado ainda. Confirme casamentos na tela de detalhe.
        </Card>
      ) : (
        <div className="space-y-3">
          {vinculos.map((v) => (
            <VinculoCard key={v.key} v={v} onDetails={() => navigate({ to: "/conciliacao/$id", params: { id } })} />
          ))}
        </div>
      )}
    </div>
  );
}

function VinculoCard({ v, onDetails }: { v: Vinculo; onDetails: () => void }) {
  const sumBb = v.bb.reduce((s, e) => s + signed(e), 0);
  const sumAg = v.ag.reduce((s, e) => s + signed(e), 0);
  const isNoPair = v.bb.length === 0 || v.ag.length === 0;
  const diff = Number((sumBb - sumAg).toFixed(2));
  const match = !isNoPair && Math.abs(diff) <= TOLERANCE;

  const lineClass = isNoPair
    ? "border-t-2 border-dashed border-muted-foreground/50"
    : match ? "h-0.5 bg-emerald-500" : "h-0.5 bg-rose-500";
  const statusLabel = v.status === "no_pair" ? "Sem par" : v.status === "manual" ? "Manual" : "Confirmado";

  return (
    <Card className="p-4">
      <div className="flex items-stretch gap-2">
        {/* Lado BB (esquerda) */}
        <div className="flex flex-1 flex-col justify-center gap-2">
          {v.bb.length ? v.bb.map((e) => <EntryBlock key={e.id} e={e} side="bb" />) : <QuestionBlock />}
        </div>
        {/* Conector */}
        <div className="relative flex w-20 shrink-0 items-center justify-center">
          <div className={`absolute left-0 right-0 top-1/2 -translate-y-1/2 ${lineClass}`} />
          <span className="relative z-10 rounded-full border bg-background px-2 py-0.5 text-[10px] font-medium">{v.kind}</span>
        </div>
        {/* Lado Agrotis (direita) */}
        <div className="flex flex-1 flex-col justify-center gap-2">
          {v.ag.length ? v.ag.map((e) => <EntryBlock key={e.id} e={e} side="agrotis" />) : <QuestionBlock />}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <Badge variant="secondary">{statusLabel}</Badge>
          {!isNoPair ? (
            <span>
              BB {fmtBRL(sumBb)} · Agrotis {fmtBRL(sumAg)} ·{" "}
              <span className={match ? "text-emerald-600" : "font-medium text-rose-600"}>
                {match ? "confere" : `Δ ${fmtBRL(Math.abs(diff))}`}
              </span>
            </span>
          ) : (
            <span>{fmtBRL(Math.abs(sumBb || sumAg))} sem contrapartida</span>
          )}
          {v.note && <span className="italic">· {v.note}</span>}
        </div>
        <Button size="sm" variant="outline" onClick={onDetails}>
          <ExternalLink className="mr-1 h-3.5 w-3.5" /> Ver detalhes
        </Button>
      </div>
    </Card>
  );
}

function EntryBlock({ e, side }: { e: Entry; side: "bb" | "agrotis" }) {
  const color = side === "bb"
    ? "border-blue-300 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30"
    : "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30";
  return (
    <div className={`rounded-md border p-2 text-sm ${color}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium">{e.description || "(sem descrição)"}</span>
        <span className={e.entry_type === "C" ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}>
          {e.entry_type === "C" ? "+" : "−"} {fmtBRL(Number(e.amount))}
        </span>
      </div>
      <div className="mt-0.5 flex justify-between text-xs text-muted-foreground">
        <span>{e.entry_date ?? "sem data"}{e.beneficiary ? ` · ${e.beneficiary}` : ""}</span>
        <span>Tipo {e.entry_type}</span>
      </div>
    </div>
  );
}

function QuestionBlock() {
  return (
    <div className="flex items-center justify-center rounded-md border border-dashed p-3 text-sm text-muted-foreground">
      <HelpCircle className="mr-1.5 h-4 w-4" /> sem par
    </div>
  );
}
