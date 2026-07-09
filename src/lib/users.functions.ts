import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Gestão de usuários: exige perfil Diretor e usa o cliente admin (service role),
// pois envolve a Admin API do Supabase Auth (convite/ban) e leitura/escrita de
// todos os user_roles — coisas que a chave anônima + RLS não permitem.

async function assertDiretor(ctx: { supabase: any; userId: string }) {
  const { data: ok, error } = await ctx.supabase.rpc("has_role", { _user_id: ctx.userId, _role: "diretor" });
  if (error) throw new Error(`Falha ao checar perfil: ${error.message}`);
  if (!ok) throw new Error("Apenas o Diretor pode gerenciar usuários.");
}

type ManagedUser = {
  id: string; email: string; full_name: string | null; created_at: string | null;
  role: "operacional" | "diretor"; active: boolean;
};

export const listUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ManagedUser[]> => {
    await assertDiretor(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (authErr) throw new Error(authErr.message);

    const { data: profiles } = await supabaseAdmin.from("profiles").select("id, email, full_name, created_at");
    const { data: roles } = await supabaseAdmin.from("user_roles").select("user_id, role");

    const profileById = new Map((profiles ?? []).map((p: any) => [p.id, p]));
    const rolesByUser = new Map<string, string[]>();
    for (const r of roles ?? []) {
      const arr = rolesByUser.get(r.user_id) ?? [];
      arr.push(r.role);
      rolesByUser.set(r.user_id, arr);
    }
    const now = Date.now();

    return authData.users
      .map((u): ManagedUser => {
        const p: any = profileById.get(u.id);
        const rs = rolesByUser.get(u.id) ?? [];
        const bannedUntil = (u as any).banned_until as string | null | undefined;
        return {
          id: u.id,
          email: u.email ?? p?.email ?? "",
          full_name: p?.full_name ?? (u.user_metadata as any)?.full_name ?? null,
          created_at: p?.created_at ?? u.created_at ?? null,
          role: rs.includes("diretor") ? "diretor" : "operacional",
          active: !(bannedUntil && new Date(bannedUntil).getTime() > now),
        };
      })
      .sort((a, b) => (a.email || "").localeCompare(b.email || ""));
  });

export const inviteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    email: z.string().email(),
    role: z.enum(["operacional", "diretor"]),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertDiretor(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: res, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(data.email);
    if (error) throw new Error(error.message);
    // O trigger on_auth_user_created cria profile + role 'dani'. Para Diretor,
    // adicionamos a role 'diretor' por cima.
    if (data.role === "diretor" && res.user) {
      const { error: rErr } = await supabaseAdmin.from("user_roles")
        .upsert({ user_id: res.user.id, role: "diretor" }, { onConflict: "user_id,role" });
      if (rErr) throw new Error(rErr.message);
    }
    return { ok: true };
  });

export const changeUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    userId: z.string().uuid(),
    role: z.enum(["operacional", "diretor"]),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertDiretor(context);
    if (data.userId === context.userId && data.role === "operacional") {
      throw new Error("Você não pode remover seu próprio perfil de Diretor.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Todos mantêm a role base 'dani'; 'diretor' é adicionada/removida por cima.
    const { error: baseErr } = await supabaseAdmin.from("user_roles")
      .upsert({ user_id: data.userId, role: "dani" }, { onConflict: "user_id,role" });
    if (baseErr) throw new Error(baseErr.message);
    if (data.role === "diretor") {
      const { error } = await supabaseAdmin.from("user_roles")
        .upsert({ user_id: data.userId, role: "diretor" }, { onConflict: "user_id,role" });
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabaseAdmin.from("user_roles")
        .delete().eq("user_id", data.userId).eq("role", "diretor");
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const setUserActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    userId: z.string().uuid(),
    active: z.boolean(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertDiretor(context);
    if (data.userId === context.userId && !data.active) {
      throw new Error("Você não pode desativar a si mesmo.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Ban = impede login sem apagar o cadastro. 'none' remove o ban.
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      ban_duration: data.active ? "none" : "876000h",
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
