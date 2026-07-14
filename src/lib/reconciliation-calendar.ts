// Lógica compartilhada do calendário de conciliação.
//
// Vive aqui — e não dentro de uma tela — porque MAIS DE UMA tela precisa chegar
// exatamente na mesma cor para o mesmo dia: o calendário e os indicadores da tela
// principal (/conciliacao) e os da página da conta (/conciliacao/conta/$id). Se
// cada tela reimplementasse a regra, elas divergiriam com o tempo (já aconteceu:
// os cards contavam conciliações enquanto o calendário contava dias).
//
// Regra de cor de um dia, em ordem de precedência:
//   1. conciliação fechada    -> verde (sem pendências) | amarelo (com pendências)
//   2. conciliação aberta/reaberta/massa -> aberta
//   3. daily_account_status = sem_movimento -> cinza
//   4. fim de semana          -> cinza
//   5. data futura            -> futuro
//   6. dia útil sem nada      -> semRegistro
//
// A divergência de saldo NÃO entra na cor (é informativa).

export type CellColor = "verde" | "amarelo" | "aberta" | "semRegistro" | "cinza" | "futuro";

export const CELL_CLASS: Record<CellColor, string> = {
  verde: "bg-emerald-500",
  amarelo: "bg-amber-400",
  aberta: "bg-red-800",
  semRegistro: "bg-rose-400",
  cinza: "bg-zinc-300 dark:bg-zinc-600",
  futuro: "border border-dashed border-border bg-transparent",
};

export const CELL_LABEL: Record<CellColor, string> = {
  verde: "Conciliada",
  amarelo: "Com pendências",
  aberta: "Aberta",
  semRegistro: "Sem registro (dia útil)",
  cinza: "Sem movimento / fim de semana",
  futuro: "Futuro",
};

export const CELL_ORDER: CellColor[] = ["verde", "amarelo", "aberta", "semRegistro", "cinza", "futuro"];

export const CAL_BACK = 30;   // dias para trás no calendário
export const CAL_FWD = 7;     // dias de planejamento à frente

// ---- Datas em UTC, consistentes com toISOString().slice(0,10) do restante do app ----
export const todayISO = () => new Date().toISOString().slice(0, 10);

export function isoShift(baseISO: string, n: number): string {
  const d = new Date(baseISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(laterISO: string, earlierISO: string): number {
  const a = new Date(laterISO + "T00:00:00Z").getTime();
  const b = new Date(earlierISO + "T00:00:00Z").getTime();
  return Math.round((a - b) / 86400000);
}

export function isWeekend(iso: string): boolean {
  const day = new Date(iso + "T00:00:00Z").getUTCDay();
  return day === 0 || day === 6;
}

export type Acct = { id: string; bank: string; entity_name: string; account_number: string | null };

export type Rec = {
  id: string;
  reconciliation_date: string;
  account: string;
  bank_account_id: string | null;
  status: "aberta" | "fechada" | "reaberta" | "massa";
  closed_with_pending: boolean | null;
};

export type Daily = { account_id: string; date: string; status: string; no_movement_reason: string | null };
export type EntryRef = { id: string; reconciliation_id: string };
export type MatchRef = {
  reconciliation_id: string; status: string;
  bb_entry_id: string | null; agrotis_entry_id: string | null;
};

export const acctLabel = (a: Acct) =>
  `${a.bank} — ${a.entity_name}${a.account_number ? ` (${a.account_number})` : ""}`;

export const fmtBRL = (n: number | null | undefined) =>
  n == null ? "—" : `R$ ${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Constrói os índices e devolve recInfo/cellFor sobre eles. Chamado uma vez por
// render, com os dados já carregados.
export function buildCalendar(
  data: { recs: Rec[]; entries: EntryRef[]; matches: MatchRef[]; daily: Daily[] },
  today: string,
) {
  const entriesByRec = new Map<string, string[]>();
  for (const e of data.entries) {
    const arr = entriesByRec.get(e.reconciliation_id);
    if (arr) arr.push(e.id);
    else entriesByRec.set(e.reconciliation_id, [e.id]);
  }

  const matchesByRec = new Map<string, MatchRef[]>();
  for (const m of data.matches) {
    const arr = matchesByRec.get(m.reconciliation_id);
    if (arr) arr.push(m);
    else matchesByRec.set(m.reconciliation_id, [m]);
  }

  const recByAcctDate = new Map<string, Rec[]>();
  for (const r of data.recs) {
    const k = `${r.bank_account_id}|${r.reconciliation_date}`;
    const arr = recByAcctDate.get(k);
    if (arr) arr.push(r);
    else recByAcctDate.set(k, [r]);
  }

  const dailyByKey = new Map<string, Daily>();
  for (const d of data.daily) dailyByKey.set(`${d.account_id}|${d.date}`, d);

  // pendentes  = lançamentos sem match confirmed/manual/no_pair (não resolvidos)
  // conciliados = lançamentos em match confirmed/manual
  function recInfo(rec: Rec) {
    const entryIds = entriesByRec.get(rec.id) ?? [];
    const ms = matchesByRec.get(rec.id) ?? [];
    const resolved = new Set<string>();
    const confirmedManual = new Set<string>();
    for (const m of ms) {
      const isResolved = m.status === "confirmed" || m.status === "manual" || m.status === "no_pair";
      const isConfirmed = m.status === "confirmed" || m.status === "manual";
      if (isResolved) {
        if (m.bb_entry_id) resolved.add(m.bb_entry_id);
        if (m.agrotis_entry_id) resolved.add(m.agrotis_entry_id);
      }
      if (isConfirmed) {
        if (m.bb_entry_id) confirmedManual.add(m.bb_entry_id);
        if (m.agrotis_entry_id) confirmedManual.add(m.agrotis_entry_id);
      }
    }
    const pending = entryIds.filter((id) => !resolved.has(id)).length;
    const confirmed = confirmedManual.size;
    const color: CellColor = rec.status === "fechada"
      ? (rec.closed_with_pending ? "amarelo" : "verde")
      : "aberta"; // aberta / reaberta / massa
    return { pending, confirmed, color };
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

  return { recInfo, cellFor };
}

// Janela padrão do calendário: CAL_BACK dias atrás .. CAL_FWD dias à frente.
export function calendarDays(today: string): string[] {
  const days: string[] = [];
  for (let i = CAL_BACK; i >= 0; i--) days.push(isoShift(today, -i));
  for (let i = 1; i <= CAL_FWD; i++) days.push(isoShift(today, i));
  return days;
}

// Últimos `n` dias corridos até hoje (inclusive).
export function lastDays(today: string, n: number): string[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) days.push(isoShift(today, -i));
  return days;
}
