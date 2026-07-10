import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const ProcessInput = z.object({
  reconciliationDate: z.string(),
  bankAccountId: z.string().uuid(),
  bbFileName: z.string(),
  bbText: z.string().min(1),
  agrotisFileName: z.string(),
  agrotisText: z.string().min(1),
  balanceBank: z.number().nullable().optional(),
  balanceAgrotisPrevious: z.number().nullable().optional(),
});

const AiEntry = z.object({
  entry_date: z.string().nullable(),
  description: z.string(),
  beneficiary: z.string().nullable(),
  amount: z.number(),
  entry_type: z.enum(["C", "D"]),
  document_ref: z.string().nullable(),
});

const AiResult = z.object({
  bb_entries: z.array(AiEntry),
  agrotis_entries: z.array(AiEntry),
  matches: z.array(
    z.object({
      bb_index: z.number(),
      agrotis_index: z.number(),
      confidence: z.enum(["strong", "medium"]),
      reason: z.string(),
    }),
  ),
});


export const processReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ProcessInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { createAnthropicClient, RECONCILIATION_MODEL } = await import("@/lib/ai-gateway.server");

    const anthropic = createAnthropicClient();

    const bbText = data.bbText;
    const agrotisText = data.agrotisText;

    const prompt = `Você é um assistente contábil especializado em conciliação bancária.

Extrai os lançamentos de dois extratos e sugere casamentos.

EXTRATO BB (Excel convertido para CSV):
${bbText.slice(0, 40000)}

EXTRATO AGROTIS (texto do PDF):
${agrotisText.slice(0, 40000)}

Regras para casamentos:
- STRONG: valor idêntico (tolerância R$ 1,00) + mesma data (tolerância 0 dias) + tipo igual (C/D) + nome do beneficiário similar quando disponível
- MEDIUM: valor + tipo batem mas data difere em até 2 dias
- Se não achar par, não inclua nos matches

Retorne APENAS JSON válido no formato:
{
  "bb_entries": [{"entry_date":"YYYY-MM-DD","description":"...","beneficiary":"...","amount":123.45,"entry_type":"C"|"D","document_ref":"..."}],
  "agrotis_entries": [...mesmo formato...],
  "matches": [{"bb_index": 0, "agrotis_index": 0, "confidence": "strong"|"medium", "reason": "..."}]
}

Onde bb_index e agrotis_index são os índices (0-based) nos respectivos arrays. entry_type = "C" para crédito, "D" para débito. amount sempre positivo.`;

    const message = await anthropic.messages.create({
      model: RECONCILIATION_MODEL,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    });
    if (message.stop_reason === "refusal") throw new Error("IA recusou a solicitação");
    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    // extract JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("IA não retornou JSON");
    let parsed;
    try {
      parsed = AiResult.parse(JSON.parse(jsonMatch[0]));
    } catch (e) {
      throw new Error("Formato inesperado da IA: " + (e as Error).message);
    }

    // Bug fix: downgrade "strong" suggestions when name similarity < 70%.
    // Value/date alone cannot justify a strong match — names must also align.
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
    const nameOf = (e: z.infer<typeof AiEntry>) =>
      norm(e.beneficiary) || norm(e.description);
    parsed.matches = parsed.matches.map((m) => {
      if (m.confidence !== "strong") return m;
      const bb = parsed.bb_entries[m.bb_index];
      const ag = parsed.agrotis_entries[m.agrotis_index];
      if (!bb || !ag) return m;
      const a = nameOf(bb), b = nameOf(ag);
      if (!a || !b) return m;
      const sim = dice(a, b);
      if (sim < 0.7) {
        return { ...m, confidence: "medium" as const,
          reason: `${m.reason} (rebaixado: similaridade de nome ${(sim * 100).toFixed(0)}%)` };
      }
      return m;
    });



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

    // Validate chain: previous closed reconciliation for this bank account
    if (rec.bank_account_id && rec.balance_agrotis_previous != null) {
      const { data: prev } = await supabase.from("reconciliations")
        .select("id, reconciliation_date, balance_bank, balance_agrotis_calculated, status")
        .eq("bank_account_id", rec.bank_account_id)
        .in("status", ["fechada", "reaberta"])
        .lt("reconciliation_date", rec.reconciliation_date)
        .order("reconciliation_date", { ascending: false })
        .limit(1);
      const previous = prev?.[0];
      if (previous) {
        const prevClose = previous.balance_agrotis_calculated ?? previous.balance_bank;
        if (prevClose != null && Math.abs(Number(prevClose) - Number(rec.balance_agrotis_previous)) > 0.01) {
          throw new Error(
            `Saldo anterior Agrotis (R$ ${Number(rec.balance_agrotis_previous).toFixed(2)}) ` +
            `não bate com fechamento do dia anterior (R$ ${Number(prevClose).toFixed(2)}). ` +
            `Reabra a conciliação de ${previous.reconciliation_date} para corrigir.` +
            `|PREV:${previous.id}`
          );
        }
      }
    }

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
