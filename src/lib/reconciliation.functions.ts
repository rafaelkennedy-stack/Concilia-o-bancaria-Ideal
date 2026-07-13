import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Lançamento já estruturado (tipo C/D e valor extraídos deterministicamente no
// cliente, em file-extract.ts). A IA NÃO extrai mais lançamentos — só faz o
// matching por nome/contexto.
const AiEntry = z.object({
  entry_date: z.string().nullable(),
  description: z.string(),
  beneficiary: z.string().nullable(),
  amount: z.number(),
  entry_type: z.enum(["C", "D"]),
  document_ref: z.string().nullable(),
});
type Entry = z.infer<typeof AiEntry>;

const ProcessInput = z.object({
  reconciliationDate: z.string(),
  bankAccountId: z.string().uuid(),
  bbFileName: z.string(),
  bbEntries: z.array(AiEntry),
  agrotisFileName: z.string(),
  agrotisEntries: z.array(AiEntry),
  balanceBank: z.number().nullable().optional(),
  balanceAgrotisPrevious: z.number().nullable().optional(),
});

// A IA agora devolve APENAS casamentos (índices), não lançamentos.
const AiMatch = z.object({
  bb_index: z.number(),
  agrotis_index: z.number(),
  confidence: z.enum(["strong", "medium"]),
  reason: z.string(),
});
const AiMatchResult = z.object({ matches: z.array(AiMatch) });
type Match = z.infer<typeof AiMatch>;



// Extrai lançamentos e sugestões de casamento dos dois extratos via IA. Aplica
// o rebaixamento de "strong" -> "medium" quando a similaridade de nomes é baixa.
// Compartilhado entre a conciliação de um dia (processReconciliation) e a
// conciliação em massa de vários dias (processMassReconciliation).
async function extractReconciliation(bbEntries: Entry[], agrotisEntries: Entry[]) {
  const bb_entries = bbEntries;
  const agrotis_entries = agrotisEntries;

  const descEntry = (e: Entry | undefined) =>
    e ? `[${e.entry_type} ${e.amount} ${e.entry_date} "${e.beneficiary ?? e.description ?? ""}"]` : "<inválido>";

  // Similaridade de nome (coeficiente de Dice sobre bigramas).
  const norm = (s: string | null | undefined) =>
    (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const dice = (a: string, b: string) => {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    A.forEach((g) => { if (B.has(g)) inter++; });
    return (2 * inter) / (A.size + B.size);
  };
  const nameOf = (e: Entry) => norm(e.beneficiary) || norm(e.description);
  // signed() embute a equivalência de tipo (confirmada pelo BalanceCard e agora
  // pela extração determinística): BB "C" (entrada) ↔ Agrotis "C" (entrada) e
  // BB "D" (saída) ↔ Agrotis "D" (saída). MESMO tipo => diferença ≈ 0; tipos
  // opostos => |diferença| ≈ 2× valor, acima da tolerância.
  const signed = (e: Entry) => (e.entry_type === "C" ? 1 : -1) * e.amount;
  const dateDiffDays = (a: string | null, b: string | null): number | null => {
    if (!a || !b) return null;
    const da = Date.parse(a + "T00:00:00Z");
    const db = Date.parse(b + "T00:00:00Z");
    if (Number.isNaN(da) || Number.isNaN(db)) return null;
    return Math.round(Math.abs(da - db) / 86_400_000);
  };

  console.log(`[extractReconciliation] entradas estruturadas: BB=${bb_entries.length} Agrotis=${agrotis_entries.length}`);

  // === PRÉ-MATCHING DETERMINÍSTICO ===
  // Casa pares com valor idêntico (≤ R$ 1,00), MESMO tipo (via signed) e data
  // ±1 dia. Atribuição 1:1 gulosa: menor diferença de valor, depois de data,
  // depois maior similaridade de nome (desempate). Cada par vira sugestão FORTE.
  const usedBb = new Set<number>();
  const usedAg = new Set<number>();
  const candidates: Array<{ i: number; j: number; valueDiff: number; dayDiff: number; sim: number }> = [];
  bb_entries.forEach((bb, i) => {
    agrotis_entries.forEach((ag, j) => {
      const valueDiff = Math.abs(signed(bb) - signed(ag));
      if (valueDiff > MATCH_TOLERANCE) return;       // valor + tipo precisam bater
      const dayDiff = dateDiffDays(bb.entry_date, ag.entry_date);
      if (dayDiff == null || dayDiff > 1) return;    // data ±1 dia
      candidates.push({ i, j, valueDiff, dayDiff, sim: dice(nameOf(bb), nameOf(ag)) });
    });
  });
  candidates.sort((x, y) => x.valueDiff - y.valueDiff || x.dayDiff - y.dayDiff || y.sim - x.sim);
  const preMatches: Match[] = [];
  for (const c of candidates) {
    if (usedBb.has(c.i) || usedAg.has(c.j)) continue;
    usedBb.add(c.i); usedAg.add(c.j);
    preMatches.push({
      bb_index: c.i,
      agrotis_index: c.j,
      confidence: "strong",
      reason: `Pré-casamento automático (valor idêntico, data ±1 dia, mesmo tipo${c.sim > 0 ? `, nome ${(c.sim * 100).toFixed(0)}%` : ""})`,
    });
    console.log(`[extractReconciliation] PRÉ-MATCH forte: BB=${descEntry(bb_entries[c.i])} AG=${descEntry(agrotis_entries[c.j])} ` +
      `| valorDiff=R$${c.valueDiff.toFixed(2)} dataDiff=${c.dayDiff}d nomeSim=${(c.sim * 100).toFixed(0)}%`);
  }
  console.log(`[extractReconciliation] pré-matches determinísticos: ${preMatches.length}`);

  // === MATCHING POR IA (apenas pares não exatos; a IA NÃO extrai lançamentos) ===
  let aiMatches: Match[] = [];
  try {
    aiMatches = await aiMatchOnly(bb_entries, agrotis_entries, usedBb, usedAg);
  } catch (e) {
    console.log("[extractReconciliation] matching por IA falhou (seguindo só com pré-matches):", (e as Error).message);
  }
  // Valida os matches da IA: índice válido, não pré-casado, mesmo valor/tipo.
  // Marca como usados para a IA não repetir um índice em dois matches.
  aiMatches = aiMatches.filter((m) => {
    if (usedBb.has(m.bb_index) || usedAg.has(m.agrotis_index)) return false;
    const bb = bb_entries[m.bb_index];
    const ag = agrotis_entries[m.agrotis_index];
    if (!bb || !ag) {
      console.log(`[extractReconciliation] match da IA DESCARTADO (índice inválido): bb=${m.bb_index} ag=${m.agrotis_index}`);
      return false;
    }
    const valueDiff = Math.abs(signed(bb) - signed(ag));
    if (valueDiff > MATCH_TOLERANCE) {
      console.log(`[extractReconciliation] match da IA DESCARTADO (valor/tipo divergem R$ ${valueDiff.toFixed(2)}): BB=${descEntry(bb)} AG=${descEntry(ag)}`);
      return false;
    }
    usedBb.add(m.bb_index); usedAg.add(m.agrotis_index);
    return true;
  });
  // Classificação determinística: FORTE se mesma data + nome > 70%; senão MÉDIA.
  aiMatches = aiMatches.map((m) => {
    const bb = bb_entries[m.bb_index];
    const ag = agrotis_entries[m.agrotis_index];
    const sameDate = !!bb.entry_date && bb.entry_date === ag.entry_date;
    const a = nameOf(bb), b = nameOf(ag);
    const namesPresent = !!a && !!b;
    const sim = namesPresent ? dice(a, b) : 0;
    let next = m;
    if (sameDate && namesPresent && sim > 0.7) {
      next = m.confidence === "strong" ? m : { ...m, confidence: "strong" as const };
    } else if (m.confidence === "strong" && namesPresent) {
      const motivo = !sameDate ? "data diferente" : `similaridade de nome ${(sim * 100).toFixed(0)}%`;
      next = { ...m, confidence: "medium" as const, reason: `${m.reason} (rebaixado: ${motivo})` };
    }
    console.log(`[extractReconciliation] match IA: BB=${descEntry(bb)} AG=${descEntry(ag)} | mesmaData=${sameDate} nomeSim=${(sim * 100).toFixed(0)}% => ${next.confidence}`);
    return next;
  });

  console.log(`[extractReconciliation] total de casamentos: ${preMatches.length + aiMatches.length} (pré ${preMatches.length} + IA ${aiMatches.length})`);
  return { bb_entries, agrotis_entries, matches: [...preMatches, ...aiMatches] };
}

// Pede à IA APENAS os casamentos entre lançamentos JÁ estruturados (com tipo e
// valor definidos deterministicamente). Ignora os índices já pré-casados.
async function aiMatchOnly(
  bb_entries: Entry[], agrotis_entries: Entry[], usedBb: Set<number>, usedAg: Set<number>,
): Promise<Match[]> {
  const { createAnthropicClient, RECONCILIATION_MODEL } = await import("@/lib/ai-gateway.server");
  const line = (e: Entry, i: number) =>
    `  ${i}: ${e.entry_type} R$ ${e.amount.toFixed(2)} ${e.entry_date ?? "?"} "${(e.beneficiary ?? e.description ?? "").slice(0, 60)}"`;
  const bbList = bb_entries.map((e, i) => (usedBb.has(i) ? null : line(e, i))).filter(Boolean).join("\n");
  const agList = agrotis_entries.map((e, i) => (usedAg.has(i) ? null : line(e, i))).filter(Boolean).join("\n");
  if (!bbList || !agList) return [];  // nada restante para casar

  const prompt = `Você faz conciliação bancária. Recebe lançamentos JÁ estruturados (tipo C/D e
valor definidos) de dois extratos: Banco do Brasil (BB) e Agrotis. Case os que
representam a MESMA transação.

Regras ESTRITAS:
- Só case lançamentos de MESMO tipo (C com C, D com D) e valor idêntico (diferença ≤ R$ 1,00).
- A data pode diferir em até 2 dias.
- Use o nome/beneficiário como contexto para decidir o par correto.
- confidence "strong" quando o nome bate bem; "medium" quando batem só valor+tipo+data.
- Use APENAS os índices listados abaixo; cada índice no máximo uma vez.

BB (índice: tipo valor data "nome"):
${bbList}

AGROTIS (índice: tipo valor data "nome"):
${agList}

Retorne APENAS JSON: {"matches":[{"bb_index":0,"agrotis_index":0,"confidence":"strong"|"medium","reason":"..."}]}`;

  const anthropic = createAnthropicClient();
  const message = await anthropic.messages.create({
    model: RECONCILIATION_MODEL,
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
  });
  if (message.stop_reason === "refusal") throw new Error("IA recusou a solicitação");
  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("IA não retornou JSON");
  return AiMatchResult.parse(JSON.parse(jsonMatch[0])).matches;
}

export const processReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ProcessInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Lançamentos já vêm estruturados do cliente (tipo/valor determinísticos);
    // extractReconciliation só faz o casamento (pré-match + IA por nome).
    const parsed = await extractReconciliation(data.bbEntries, data.agrotisEntries);

    // Fetch bank account to derive account label
    const { data: acct, error: acctErr } = await supabase
      .from("bank_accounts").select("bank, entity_name, account_number, active")
      .eq("id", data.bankAccountId).single();
    if (acctErr || !acct) throw new Error("Conta bancária inválida.");
    if (!acct.active) throw new Error("Conta bancária inativa.");
    const accountLabel = `${acct.bank} — ${acct.entity_name}${acct.account_number ? ` (${acct.account_number})` : ""}`;

    // Create reconciliation record
    const { data: rec, error: recErr } = await supabase
      .from("reconciliations")
      .insert({
        reconciliation_date: data.reconciliationDate,
        created_by: userId,
        bank_account_id: data.bankAccountId,
        account: accountLabel,
        bb_file_name: data.bbFileName,
        agrotis_file_name: data.agrotisFileName,
        status: "aberta",
        balance_bank: data.balanceBank ?? null,
        balance_agrotis_previous: data.balanceAgrotisPrevious ?? null,
      })
      .select()
      .single();
    if (recErr || !rec) throw new Error(recErr?.message || "Falha ao criar conciliação");


    // Insert entries
    const bbInserts = parsed.bb_entries.map((e) => ({
      reconciliation_id: rec.id,
      source: "bb" as const,
      ...e,
    }));
    const agInserts = parsed.agrotis_entries.map((e) => ({
      reconciliation_id: rec.id,
      source: "agrotis" as const,
      ...e,
    }));
    const { data: bbRows, error: bbErr } = await supabase
      .from("reconciliation_entries").insert(bbInserts).select();
    if (bbErr) throw new Error(bbErr.message);
    const { data: agRows, error: agErr } = await supabase
      .from("reconciliation_entries").insert(agInserts).select();
    if (agErr) throw new Error(agErr.message);

    // Insert matches
    const matchInserts = parsed.matches
      .filter((m) => bbRows?.[m.bb_index] && agRows?.[m.agrotis_index])
      .map((m) => ({
        reconciliation_id: rec.id,
        bb_entry_id: bbRows![m.bb_index].id,
        agrotis_entry_id: agRows![m.agrotis_index].id,
        confidence: m.confidence,
        status: "suggested" as const,
        reason: m.reason,
      }));
    if (matchInserts.length) {
      const { error: mErr } = await supabase.from("reconciliation_matches").insert(matchInserts);
      if (mErr) throw new Error(mErr.message);
    }

    // Audit log
    await supabase.from("reconciliation_audit_log").insert({
      reconciliation_id: rec.id, user_id: userId, action: "processed",
      details: { bb: bbRows?.length, agrotis: agRows?.length, matches: matchInserts.length },
    });

    return { reconciliationId: rec.id };
  });

// Tolerância máxima (R$) entre a soma dos lados de qualquer casamento.
export const MATCH_TOLERANCE = 1.0;

const signedAmount = (e: { entry_type: string; amount: number | string }) =>
  (e.entry_type === "C" ? 1 : -1) * Number(e.amount);

// Lança erro se a diferença absoluta entre os valores assinados dos dois lados
// exceder a tolerância. Bloqueia a confirmação de casamentos 1:1 / manuais que
// não fecham dentro de R$ 1,00. Ignora quando algum lado está ausente.
async function assertMatchWithinTolerance(
  supabase: any, bbEntryId: string | null, agrotisEntryId: string | null,
) {
  if (!bbEntryId || !agrotisEntryId) return;
  const { data: rows, error } = await supabase.from("reconciliation_entries")
    .select("id, amount, entry_type").in("id", [bbEntryId, agrotisEntryId]);
  if (error) throw new Error(error.message);
  const bb = (rows ?? []).find((r: any) => r.id === bbEntryId);
  const ag = (rows ?? []).find((r: any) => r.id === agrotisEntryId);
  if (!bb || !ag) return;
  const diff = signedAmount(bb) - signedAmount(ag);
  if (Math.abs(diff) > MATCH_TOLERANCE) {
    throw new Error(
      `Diferença de R$ ${Math.abs(diff).toFixed(2)} excede a tolerância de R$ ${MATCH_TOLERANCE.toFixed(2)}. Ajuste o casamento antes de confirmar.`,
    );
  }
}

export const confirmMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ matchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: m } = await supabase.from("reconciliation_matches")
      .select("reconciliation_id, bb_entry_id, agrotis_entry_id").eq("id", data.matchId).single();
    if (!m) throw new Error("Casamento não encontrado");
    await assertMatchWithinTolerance(supabase, m.bb_entry_id, m.agrotis_entry_id);
    const { error } = await supabase.from("reconciliation_matches")
      .update({ status: "confirmed", confirmed_by: userId, confirmed_at: new Date().toISOString() })
      .eq("id", data.matchId);
    if (error) throw new Error(error.message);
    await supabase.from("reconciliation_audit_log").insert({
      reconciliation_id: m.reconciliation_id, user_id: userId, action: "match_confirmed",
      details: { match_id: data.matchId },
    });
    return { ok: true };
  });

export const manualMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    reconciliationId: z.string().uuid(),
    bbEntryId: z.string().uuid().nullable(),
    agrotisEntryId: z.string().uuid().nullable(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertMatchWithinTolerance(supabase, data.bbEntryId, data.agrotisEntryId);
    const { error } = await supabase.from("reconciliation_matches").insert({
      reconciliation_id: data.reconciliationId,
      bb_entry_id: data.bbEntryId,
      agrotis_entry_id: data.agrotisEntryId,
      confidence: "pending",
      status: "manual",
      confirmed_by: userId,
      confirmed_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    await supabase.from("reconciliation_audit_log").insert({
      reconciliation_id: data.reconciliationId, user_id: userId, action: "manual_match",
      details: { bb: data.bbEntryId, agrotis: data.agrotisEntryId },
    });
    return { ok: true };
  });

export const reassignMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    matchId: z.string().uuid(),
    side: z.enum(["bb", "agrotis"]),
    newEntryId: z.string().uuid(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: cur } = await supabase.from("reconciliation_matches")
      .select("bb_entry_id, agrotis_entry_id").eq("id", data.matchId).single();
    if (!cur) throw new Error("Casamento não encontrado");
    const resultingBb = data.side === "bb" ? data.newEntryId : cur.bb_entry_id;
    const resultingAg = data.side === "agrotis" ? data.newEntryId : cur.agrotis_entry_id;
    await assertMatchWithinTolerance(supabase, resultingBb, resultingAg);
    const update: Record<string, unknown> = {
      status: "manual",
      confidence: "pending",
      reason: null,
      confirmed_by: userId,
      confirmed_at: new Date().toISOString(),
    };
    update[data.side === "bb" ? "bb_entry_id" : "agrotis_entry_id"] = data.newEntryId;
    const { data: m, error } = await supabase.from("reconciliation_matches")
      .update(update as never).eq("id", data.matchId).select("reconciliation_id").single();
    if (error) throw new Error(error.message);
    await supabase.from("reconciliation_audit_log").insert({
      reconciliation_id: m!.reconciliation_id, user_id: userId, action: "match_reassigned",
      details: { match_id: data.matchId, side: data.side, new_entry_id: data.newEntryId },
    });
    return { ok: true };
  });

// Aplica um novo par (BB + Agrotis) proposto na tela e confirma o casamento numa
// única operação. Usado pelo botão "Confirmar" quando o usuário alterou o vínculo
// no modal (que não persiste nada por si só). Valida a tolerância no par FINAL.
export const reassignAndConfirmMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    matchId: z.string().uuid(),
    bbEntryId: z.string().uuid(),
    agrotisEntryId: z.string().uuid(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: cur } = await supabase.from("reconciliation_matches")
      .select("reconciliation_id").eq("id", data.matchId).single();
    if (!cur) throw new Error("Casamento não encontrado");
    await assertMatchWithinTolerance(supabase, data.bbEntryId, data.agrotisEntryId);
    const { error } = await supabase.from("reconciliation_matches").update({
      bb_entry_id: data.bbEntryId,
      agrotis_entry_id: data.agrotisEntryId,
      status: "manual",
      confidence: "pending",
      reason: null,
      confirmed_by: userId,
      confirmed_at: new Date().toISOString(),
    }).eq("id", data.matchId);
    if (error) throw new Error(error.message);
    await supabase.from("reconciliation_audit_log").insert({
      reconciliation_id: cur.reconciliation_id, user_id: userId, action: "match_reassigned_confirmed",
      details: { match_id: data.matchId, bb_entry_id: data.bbEntryId, agrotis_entry_id: data.agrotisEntryId },
    });
    return { ok: true };
  });

export const rejectSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    matchId: z.string().uuid(),
    justification: z.string().min(1),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: m, error: fErr } = await supabase.from("reconciliation_matches")
      .select("reconciliation_id, bb_entry_id, agrotis_entry_id").eq("id", data.matchId).single();
    if (fErr || !m) throw new Error(fErr?.message || "Sugestão não encontrada");
    const { error: dErr } = await supabase.from("reconciliation_matches").delete().eq("id", data.matchId);
    if (dErr) throw new Error(dErr.message);
    const nowIso = new Date().toISOString();
    const rows: Array<Record<string, unknown>> = [];
    if (m.bb_entry_id) rows.push({
      reconciliation_id: m.reconciliation_id, bb_entry_id: m.bb_entry_id,
      confidence: "pending", status: "no_pair", justification: data.justification,
      confirmed_by: userId, confirmed_at: nowIso,
    });
    if (m.agrotis_entry_id) rows.push({
      reconciliation_id: m.reconciliation_id, agrotis_entry_id: m.agrotis_entry_id,
      confidence: "pending", status: "no_pair", justification: data.justification,
      confirmed_by: userId, confirmed_at: nowIso,
    });
    if (rows.length) {
      const { error: iErr } = await supabase.from("reconciliation_matches").insert(rows as never);
      if (iErr) throw new Error(iErr.message);
    }
    await supabase.from("reconciliation_audit_log").insert({
      reconciliation_id: m.reconciliation_id, user_id: userId, action: "suggestion_rejected",
      details: { match_id: data.matchId, justification: data.justification },
    });
    return { ok: true };
  });

export const justifyNoPair = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    reconciliationId: z.string().uuid(),
    entryId: z.string().uuid(),
    source: z.enum(["bb", "agrotis"]),
    justification: z.string().min(1),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const insert: Record<string, unknown> = {
      reconciliation_id: data.reconciliationId,
      confidence: "pending",
      status: "no_pair",
      justification: data.justification,
      confirmed_by: userId,
      confirmed_at: new Date().toISOString(),
    };
    insert[data.source === "bb" ? "bb_entry_id" : "agrotis_entry_id"] = data.entryId;
    const { error } = await supabase.from("reconciliation_matches").insert(insert as never);
    if (error) throw new Error(error.message);
    await supabase.from("reconciliation_audit_log").insert({
      reconciliation_id: data.reconciliationId, user_id: userId, action: "no_pair_justified",
      details: { entry_id: data.entryId, source: data.source, justification: data.justification },
    });
    return { ok: true };
  });

async function computeAgrotisCalculated(supabase: any, reconciliationId: string, previous: number | null) {
  if (previous == null) return null;
  const { data: entries } = await supabase.from("reconciliation_entries")
    .select("amount, entry_type, source").eq("reconciliation_id", reconciliationId).eq("source", "agrotis");
  const sum = (entries ?? []).reduce((acc: number, e: any) => {
    const amt = Number(e.amount) || 0;
    return acc + (e.entry_type === "C" ? amt : -amt);
  }, 0);
  return Number((previous + sum).toFixed(2));
}

export const confirmGroupedMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    reconciliationId: z.string().uuid(),
    bbEntryIds: z.array(z.string().uuid()).min(1),
    agrotisEntryIds: z.array(z.string().uuid()).min(1),
    note: z.string().optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const bbSet = new Set(data.bbEntryIds);
    const agSet = new Set(data.agrotisEntryIds);
    if (bbSet.size !== data.bbEntryIds.length || agSet.size !== data.agrotisEntryIds.length) {
      throw new Error("Lançamentos duplicados na seleção.");
    }
    const { data: rows, error: fErr } = await supabase.from("reconciliation_entries")
      .select("id, source, amount, entry_type")
      .in("id", [...data.bbEntryIds, ...data.agrotisEntryIds])
      .eq("reconciliation_id", data.reconciliationId);
    if (fErr) throw new Error(fErr.message);
    const signed = (r: any) => (r.entry_type === "C" ? 1 : -1) * Number(r.amount);
    const bb = (rows ?? []).filter((r: any) => r.source === "bb");
    const ag = (rows ?? []).filter((r: any) => r.source === "agrotis");
    if (bb.length !== data.bbEntryIds.length || ag.length !== data.agrotisEntryIds.length) {
      throw new Error("Lançamentos não pertencem a esta conciliação.");
    }
    const sumBb = bb.reduce((s: number, r: any) => s + signed(r), 0);
    const sumAg = ag.reduce((s: number, r: any) => s + signed(r), 0);
    if (Math.abs(sumBb - sumAg) > MATCH_TOLERANCE) {
      throw new Error(`Soma não bate: BB ${sumBb.toFixed(2)} × Agrotis ${sumAg.toFixed(2)} (diferença R$ ${Math.abs(sumBb - sumAg).toFixed(2)}, tolerância R$ ${MATCH_TOLERANCE.toFixed(2)}).`);
    }
    // remove any existing suggested/manual matches involving these entries
    const { data: existing } = await supabase.from("reconciliation_matches")
      .select("id, bb_entry_id, agrotis_entry_id").eq("reconciliation_id", data.reconciliationId);
    const toDelete = (existing ?? []).filter((m: any) =>
      (m.bb_entry_id && bbSet.has(m.bb_entry_id)) || (m.agrotis_entry_id && agSet.has(m.agrotis_entry_id))
    ).map((m: any) => m.id);
    if (toDelete.length) await supabase.from("reconciliation_matches").delete().in("id", toDelete);

    const groupId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const many = bb.length >= ag.length ? "bb" : "agrotis";
    const manySide = many === "bb" ? bb : ag;
    const oneSide = many === "bb" ? ag : bb;
    const inserts: Array<Record<string, unknown>> = [];
    manySide.forEach((mR: any, i: number) => {
      const oneR = oneSide[Math.min(i, oneSide.length - 1)];
      inserts.push({
        reconciliation_id: data.reconciliationId,
        bb_entry_id: many === "bb" ? mR.id : oneR.id,
        agrotis_entry_id: many === "bb" ? oneR.id : mR.id,
        confidence: "pending",
        status: "manual",
        group_id: groupId,
        reason: data.note ?? `Agrupado (${bb.length}:${ag.length})`,
        confirmed_by: userId,
        confirmed_at: nowIso,
      });
    });
    const { error: iErr } = await supabase.from("reconciliation_matches").insert(inserts as never);
    if (iErr) throw new Error(iErr.message);
    await supabase.from("reconciliation_audit_log").insert({
      reconciliation_id: data.reconciliationId, user_id: userId, action: "grouped_match_confirmed",
      details: { group_id: groupId, bb: data.bbEntryIds, agrotis: data.agrotisEntryIds, sum_bb: sumBb, sum_ag: sumAg },
    });
    return { ok: true, groupId };
  });

export const closeReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    reconciliationId: z.string().uuid(),
    force: z.boolean().optional(),
    // Fecha o dia mesmo com sugestões/pendentes ainda em aberto, marcando o
    // registro com closed_with_pending = true. Os lançamentos suggested/pending
    // permanecem salvos no banco para tratamento posterior.
    closedWithPending: z.boolean().optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: rec, error: rErr } = await supabase.from("reconciliations")
      .select("*").eq("id", data.reconciliationId).single();
    if (rErr || !rec) throw new Error(rErr?.message || "Conciliação não encontrada");

    // Compute Agrotis calculated balance
    const calculated = await computeAgrotisCalculated(supabase, rec.id, rec.balance_agrotis_previous);

    // A validação de cadeia de saldo (bloqueio quando o saldo anterior não batia
    // com o fechamento do dia anterior) foi removida: o fechamento é sempre
    // permitido, com ou sem pendências.

    const closedWithPending = data.closedWithPending ?? false;
    const { error } = await supabase.from("reconciliations")
      .update({
        status: "fechada",
        closed_at: new Date().toISOString(),
        closed_by: userId,
        closed_with_pending: closedWithPending,
        balance_agrotis_calculated: calculated,
      })
      .eq("id", data.reconciliationId);
    if (error) throw new Error(error.message);
    await supabase.from("reconciliation_audit_log").insert({
      reconciliation_id: data.reconciliationId, user_id: userId,
      action: closedWithPending ? "closed_with_pending" : "closed",
      details: { balance_bank: rec.balance_bank, balance_agrotis_calculated: calculated, closed_with_pending: closedWithPending },
    });
    return { ok: true };
  });

export const reopenReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ reconciliationId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isDir } = await supabase.rpc("has_role", { _user_id: userId, _role: "diretor" });
    if (!isDir) throw new Error("Apenas o Diretor pode reabrir conciliações.");
    const { error } = await supabase.from("reconciliations")
      .update({ status: "reaberta", reopened_at: new Date().toISOString(), reopened_by: userId })
      .eq("id", data.reconciliationId);
    if (error) throw new Error(error.message);
    await supabase.from("reconciliation_audit_log").insert({
      reconciliation_id: data.reconciliationId, user_id: userId, action: "reopened", details: {},
    });
    return { ok: true };
  });

// Reabre uma conciliação SUBSTITUINDO seus lançamentos/casamentos pelos extraídos
// de novos extratos. Apenas o Diretor pode executar. Ação destrutiva: apaga todos
// os reconciliation_entries e reconciliation_matches antes de reprocessar.
export const reopenWithNewFiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    reconciliationId: z.string().uuid(),
    bbFileName: z.string(),
    bbEntries: z.array(AiEntry),
    agrotisFileName: z.string(),
    agrotisEntries: z.array(AiEntry),
    balanceBank: z.number().nullable().optional(),
    balanceAgrotisPrevious: z.number().nullable().optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isDir } = await supabase.rpc("has_role", { _user_id: userId, _role: "diretor" });
    if (!isDir) throw new Error("Apenas o Diretor pode reabrir conciliações.");

    const { data: rec, error: rErr } = await supabase.from("reconciliations")
      .select("id").eq("id", data.reconciliationId).single();
    if (rErr || !rec) throw new Error(rErr?.message || "Conciliação não encontrada");

    // Casa os novos lançamentos ANTES de apagar os antigos: se o casamento falhar,
    // a conciliação permanece intacta.
    const parsed = await extractReconciliation(data.bbEntries, data.agrotisEntries);

    // Apaga casamentos e lançamentos atuais. (Apagar os lançamentos já removeria
    // os casamentos por cascade, mas removemos os matches explicitamente primeiro
    // para cobrir também os de lado único, no_pair.)
    const { error: delMErr } = await supabase.from("reconciliation_matches")
      .delete().eq("reconciliation_id", rec.id);
    if (delMErr) throw new Error(delMErr.message);
    const { error: delEErr } = await supabase.from("reconciliation_entries")
      .delete().eq("reconciliation_id", rec.id);
    if (delEErr) throw new Error(delEErr.message);

    // Reinsere lançamentos e sugestões (mesma lógica de processReconciliation).
    const bbInserts = parsed.bb_entries.map((e) => ({ reconciliation_id: rec.id, source: "bb" as const, ...e }));
    const agInserts = parsed.agrotis_entries.map((e) => ({ reconciliation_id: rec.id, source: "agrotis" as const, ...e }));
    const { data: bbRows, error: bbErr } = await supabase.from("reconciliation_entries").insert(bbInserts).select();
    if (bbErr) throw new Error(bbErr.message);
    const { data: agRows, error: agErr } = await supabase.from("reconciliation_entries").insert(agInserts).select();
    if (agErr) throw new Error(agErr.message);

    const matchInserts = parsed.matches
      .filter((m) => bbRows?.[m.bb_index] && agRows?.[m.agrotis_index])
      .map((m) => ({
        reconciliation_id: rec.id,
        bb_entry_id: bbRows![m.bb_index].id,
        agrotis_entry_id: agRows![m.agrotis_index].id,
        confidence: m.confidence,
        status: "suggested" as const,
        reason: m.reason,
      }));
    if (matchInserts.length) {
      const { error: mErr } = await supabase.from("reconciliation_matches").insert(matchInserts);
      if (mErr) throw new Error(mErr.message);
    }

    // Reabre e atualiza arquivos/saldos. O saldo calculado do Agrotis é zerado
    // para ser recomputado no próximo fechamento com os novos lançamentos.
    const { error: updErr } = await supabase.from("reconciliations").update({
      status: "reaberta",
      reopened_at: new Date().toISOString(),
      reopened_by: userId,
      bb_file_name: data.bbFileName,
      agrotis_file_name: data.agrotisFileName,
      balance_bank: data.balanceBank ?? null,
      balance_agrotis_previous: data.balanceAgrotisPrevious ?? null,
      balance_agrotis_calculated: null,
    }).eq("id", data.reconciliationId);
    if (updErr) throw new Error(updErr.message);

    await supabase.from("reconciliation_audit_log").insert({
      reconciliation_id: data.reconciliationId, user_id: userId, action: "reopened_with_new_files",
      details: {
        bb_file: data.bbFileName, agrotis_file: data.agrotisFileName,
        bb: bbRows?.length, agrotis: agRows?.length, matches: matchInserts.length,
      },
    });

    return { reconciliationId: rec.id };
  });

// ---- Fila diária de conciliação (daily_account_status) ----

// Marca a conta como "sem movimento" no dia, registrando o motivo.
export const setNoMovement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    accountId: z.string().uuid(),
    date: z.string(),
    reason: z.enum(["Fim de semana", "Feriado", "Sem movimentação"]),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("daily_account_status").upsert({
      account_id: data.accountId,
      date: data.date,
      status: "sem_movimento",
      no_movement_reason: data.reason,
      created_by: userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "account_id,date" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// "Deixar para depois": move a conta para o fim da fila do dia. Mantém a conta
// pendente de conciliação (status 'adiada' é tratado como ainda-a-fazer na fila).
export const deferAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    accountId: z.string().uuid(),
    date: z.string(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("daily_account_status").upsert({
      account_id: data.accountId,
      date: data.date,
      status: "adiada",
      no_movement_reason: null,
      created_by: userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "account_id,date" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Reverte a decisão do dia (sem movimento / adiada) devolvendo a conta a pendente.
export const resetDailyStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    accountId: z.string().uuid(),
    date: z.string(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase.from("daily_account_status")
      .delete().eq("account_id", data.accountId).eq("date", data.date);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ---- Processamento em massa (vários dias em um único fluxo) ----

const MassInput = z.object({
  bankAccountId: z.string().uuid(),
  bbFileName: z.string(),
  bbEntries: z.array(AiEntry),
  agrotisFileName: z.string(),
  agrotisEntries: z.array(AiEntry),
});

// Processa extratos que cobrem múltiplos dias. Cria UMA conciliação com status
// "massa" contendo todos os lançamentos e sugestões; a revisão é idêntica à
// conciliação normal. Ao fechar (closeMassReconciliation) ela é dividida em
// conciliações diárias.
export const processMassReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => MassInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const parsed = await extractReconciliation(data.bbEntries, data.agrotisEntries);

    const { data: acct, error: acctErr } = await supabase
      .from("bank_accounts").select("bank, entity_name, account_number, active")
      .eq("id", data.bankAccountId).single();
    if (acctErr || !acct) throw new Error("Conta bancária inválida.");
    if (!acct.active) throw new Error("Conta bancária inativa.");
    const accountLabel = `${acct.bank} — ${acct.entity_name}${acct.account_number ? ` (${acct.account_number})` : ""}`;

    // Faixa de datas dos lançamentos extraídos.
    const allDates = [...parsed.bb_entries, ...parsed.agrotis_entries]
      .map((e) => e.entry_date)
      .filter((d): d is string => !!d)
      .sort();
    const today = new Date().toISOString().slice(0, 10);
    const minDate = allDates[0] ?? today;
    const maxDate = allDates[allDates.length - 1] ?? minDate;
    const dayCount = new Set(allDates).size || 1;

    // reconciliation_date = primeiro dia do período (referência da massa).
    const { data: rec, error: recErr } = await supabase
      .from("reconciliations")
      .insert({
        reconciliation_date: minDate,
        period_end_date: maxDate,
        created_by: userId,
        bank_account_id: data.bankAccountId,
        account: accountLabel,
        bb_file_name: data.bbFileName,
        agrotis_file_name: data.agrotisFileName,
        status: "massa",
      })
      .select()
      .single();
    if (recErr || !rec) throw new Error(recErr?.message || "Falha ao criar conciliação em massa");

    const bbInserts = parsed.bb_entries.map((e) => ({ reconciliation_id: rec.id, source: "bb" as const, ...e }));
    const agInserts = parsed.agrotis_entries.map((e) => ({ reconciliation_id: rec.id, source: "agrotis" as const, ...e }));
    const { data: bbRows, error: bbErr } = await supabase.from("reconciliation_entries").insert(bbInserts).select();
    if (bbErr) throw new Error(bbErr.message);
    const { data: agRows, error: agErr } = await supabase.from("reconciliation_entries").insert(agInserts).select();
    if (agErr) throw new Error(agErr.message);

    const matchInserts = parsed.matches
      .filter((m) => bbRows?.[m.bb_index] && agRows?.[m.agrotis_index])
      .map((m) => ({
        reconciliation_id: rec.id,
        bb_entry_id: bbRows![m.bb_index].id,
        agrotis_entry_id: agRows![m.agrotis_index].id,
        confidence: m.confidence,
        status: "suggested" as const,
        reason: m.reason,
      }));
    if (matchInserts.length) {
      const { error: mErr } = await supabase.from("reconciliation_matches").insert(matchInserts);
      if (mErr) throw new Error(mErr.message);
    }

    await supabase.from("reconciliation_audit_log").insert({
      reconciliation_id: rec.id, user_id: userId, action: "mass_processed",
      details: { bb: bbRows?.length, agrotis: agRows?.length, matches: matchInserts.length, min_date: minDate, max_date: maxDate, days: dayCount },
    });

    return { reconciliationId: rec.id, minDate, maxDate, dayCount };
  });

// Fecha uma conciliação "massa" dividindo-a em conciliações diárias:
// - agrupa por dia (data do lançamento do BB; agrotis segue seu par);
// - cada dia vira uma conciliação "fechada" com seus casamentos e lançamentos;
// - lançamentos sem par confirmado ficam no dia e a conciliação é marcada
//   closed_with_pending; period_end_date = data BB mais recente daquele dia;
// - a conciliação massa original é apagada ao final.
export const closeMassReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ reconciliationId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: rec, error: rErr } = await supabase.from("reconciliations")
      .select("*").eq("id", data.reconciliationId).single();
    if (rErr || !rec) throw new Error(rErr?.message || "Conciliação não encontrada");
    if (rec.status !== "massa") throw new Error("Esta conciliação não é do tipo massa.");

    const { data: entriesData } = await supabase.from("reconciliation_entries")
      .select("id, source, entry_date").eq("reconciliation_id", rec.id);
    const { data: matchesData } = await supabase.from("reconciliation_matches")
      .select("id, bb_entry_id, agrotis_entry_id, status, group_id").eq("reconciliation_id", rec.id);
    const entries = (entriesData ?? []) as Array<{ id: string; source: string; entry_date: string | null }>;
    const matches = (matchesData ?? []) as Array<{ id: string; bb_entry_id: string | null; agrotis_entry_id: string | null; status: string; group_id: string | null }>;
    if (entries.length === 0) throw new Error("Conciliação em massa sem lançamentos.");

    const entryById = new Map(entries.map((e) => [e.id, e]));
    const fallbackDay = rec.reconciliation_date as string;

    // Dia representativo de cada grupo (menor data do grupo), para manter os
    // casamentos agrupados juntos mesmo quando as datas do BB divergem.
    const groupDay = new Map<string, string>();
    for (const m of matches) {
      if (!m.group_id) continue;
      const bb = m.bb_entry_id ? entryById.get(m.bb_entry_id) : null;
      const ag = m.agrotis_entry_id ? entryById.get(m.agrotis_entry_id) : null;
      const d = bb?.entry_date ?? ag?.entry_date ?? fallbackDay;
      const cur = groupDay.get(m.group_id);
      if (!cur || d < cur) groupDay.set(m.group_id, d);
    }
    const dayForMatch = (m: (typeof matches)[number]) => {
      if (m.group_id && groupDay.has(m.group_id)) return groupDay.get(m.group_id)!;
      const bb = m.bb_entry_id ? entryById.get(m.bb_entry_id) : null;
      const ag = m.agrotis_entry_id ? entryById.get(m.agrotis_entry_id) : null;
      return bb?.entry_date ?? ag?.entry_date ?? fallbackDay;
    };

    // Cada lançamento herda o dia do seu casamento; sem casamento usa a própria data.
    const entryDay = new Map<string, string>();
    for (const m of matches) {
      const d = dayForMatch(m);
      if (m.bb_entry_id) entryDay.set(m.bb_entry_id, d);
      if (m.agrotis_entry_id) entryDay.set(m.agrotis_entry_id, d);
    }
    for (const e of entries) {
      if (!entryDay.has(e.id)) entryDay.set(e.id, e.entry_date ?? fallbackDay);
    }

    // Lançamentos "resolvidos" = em casamento confirmado/manual ou justificado sem par.
    const resolvedEntryIds = new Set<string>();
    for (const m of matches) {
      if (m.status === "suggested") continue;
      if (m.bb_entry_id) resolvedEntryIds.add(m.bb_entry_id);
      if (m.agrotis_entry_id) resolvedEntryIds.add(m.agrotis_entry_id);
    }

    const days = [...new Set(entryDay.values())].sort();
    const nowIso = new Date().toISOString();

    // Evita duplicar: mapeia dias que JÁ possuem uma conciliação para esta conta.
    // (Bug 5a) Um dia já existente é reaproveitado como destino em vez de criar
    // uma segunda conciliação para a mesma conta+data.
    const existingByDay = new Map<string, string>();
    if (rec.bank_account_id) {
      const { data: existing } = await supabase.from("reconciliations")
        .select("id, reconciliation_date")
        .eq("bank_account_id", rec.bank_account_id)
        .in("reconciliation_date", days)
        .neq("id", rec.id);
      for (const e of existing ?? []) existingByDay.set(e.reconciliation_date as string, e.id as string);
    }

    // Cria (ou reaproveita) a conciliação diária de cada dia distinto.
    const recIdByDay = new Map<string, string>();
    for (const day of days) {
      const dayEntries = entries.filter((e) => entryDay.get(e.id) === day);
      const bbDates = dayEntries
        .filter((e) => e.source === "bb" && e.entry_date)
        .map((e) => e.entry_date as string)
        .sort();
      const periodEnd = bbDates.length ? bbDates[bbDates.length - 1] : day;
      const pending = dayEntries.some((e) => !resolvedEntryIds.has(e.id));

      const existingId = existingByDay.get(day);
      if (existingId) {
        // Reaproveita a conciliação existente daquele dia (não cria duplicata).
        await supabase.from("reconciliations").update({
          status: "fechada",
          closed_at: nowIso,
          closed_by: userId,
          closed_with_pending: pending,
        }).eq("id", existingId);
        recIdByDay.set(day, existingId);
        continue;
      }

      const { data: dayRec, error: insErr } = await supabase.from("reconciliations").insert({
        reconciliation_date: day,
        period_end_date: periodEnd,
        account: rec.account,
        bank_account_id: rec.bank_account_id,
        created_by: userId,
        status: "fechada",
        closed_at: nowIso,
        closed_by: userId,
        closed_with_pending: pending,
        bb_file_name: rec.bb_file_name,
        agrotis_file_name: rec.agrotis_file_name,
      }).select("id").single();
      if (insErr || !dayRec) throw new Error(insErr?.message || "Falha ao criar conciliação diária");
      recIdByDay.set(day, dayRec.id);
    }

    // Re-parenteia lançamentos para as conciliações diárias.
    for (const day of days) {
      const ids = entries.filter((e) => entryDay.get(e.id) === day).map((e) => e.id);
      if (!ids.length) continue;
      const { error: upErr } = await supabase.from("reconciliation_entries")
        .update({ reconciliation_id: recIdByDay.get(day)! }).in("id", ids);
      if (upErr) throw new Error(upErr.message);
    }
    // Re-parenteia casamentos (agrupados por dia do casamento).
    const matchIdsByDay = new Map<string, string[]>();
    for (const m of matches) {
      const d = dayForMatch(m);
      (matchIdsByDay.get(d) ?? matchIdsByDay.set(d, []).get(d)!).push(m.id);
    }
    for (const [day, ids] of matchIdsByDay) {
      const target = recIdByDay.get(day);
      if (!target || !ids.length) continue;
      const { error: upErr } = await supabase.from("reconciliation_matches")
        .update({ reconciliation_id: target }).in("id", ids);
      if (upErr) throw new Error(upErr.message);
    }

    for (const [day, id] of recIdByDay) {
      await supabase.from("reconciliation_audit_log").insert({
        reconciliation_id: id, user_id: userId, action: "created_from_mass",
        details: { source_mass_id: rec.id, day },
      });
    }

    // Apaga a conciliação massa original (já sem lançamentos/casamentos).
    const { error: delErr } = await supabase.from("reconciliations").delete().eq("id", rec.id);
    if (delErr) throw new Error(delErr.message);

    return { ok: true, days, count: days.length };
  });
