import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const AccountInput = z.object({
  bank: z.string().trim().min(1).max(100),
  agency: z.string().trim().max(50).optional().nullable(),
  account_number: z.string().trim().max(50).optional().nullable(),
  entity_name: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(1000).optional().nullable(),
});

async function assertDiretor(ctx: { supabase: any; userId: string }) {
  const { data: ok, error } = await ctx.supabase.rpc("has_role", { _user_id: ctx.userId, _role: "diretor" });
  if (error) throw new Error(`Falha ao checar perfil: ${error.message}`);
  if (!ok) throw new Error(`Apenas o Diretor pode gerenciar contas bancárias. (user=${ctx.userId})`);
}

export const createBankAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => AccountInput.parse(d))
  .handler(async ({ data, context }) => {
    await assertDiretor(context);
    const { data: row, error } = await context.supabase.from("bank_accounts").insert({
      ...data, created_by: context.userId,
    }).select().single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateBankAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    AccountInput.extend({ id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertDiretor(context);
    const { id, ...patch } = data;
    const { error } = await context.supabase.from("bank_accounts").update(patch as never).eq("id", id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setBankAccountActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), active: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertDiretor(context);
    const { error } = await context.supabase.from("bank_accounts")
      .update({ active: data.active } as never).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
