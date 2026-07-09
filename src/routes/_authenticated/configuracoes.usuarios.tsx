import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { ArrowLeft, UserPlus, Power, PowerOff } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { listUsers, inviteUser, changeUserRole, setUserActive } from "@/lib/users.functions";

export const Route = createFileRoute("/_authenticated/configuracoes/usuarios")({
  component: Page,
});

type Row = {
  id: string; email: string; full_name: string | null; created_at: string | null;
  role: "operacional" | "diretor"; active: boolean;
};
type Perfil = "operacional" | "diretor";

function Page() {
  const { isDiretor, loading, user } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && !isDiretor) { toast.error("Acesso restrito ao Diretor."); navigate({ to: "/conciliacao" }); }
  }, [loading, isDiretor, navigate]);

  const qc = useQueryClient();
  const listFn = useServerFn(listUsers);
  const inviteFn = useServerFn(inviteUser);
  const roleFn = useServerFn(changeUserRole);
  const activeFn = useServerFn(setUserActive);

  const q = useQuery({
    enabled: isDiretor,
    queryKey: ["users"],
    queryFn: async () => (await listFn()) as Row[],
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["users"] });
  const [open, setOpen] = useState(false);

  async function invite(email: string, role: Perfil) {
    try { await inviteFn({ data: { email, role } }); toast.success("Convite enviado"); invalidate(); setOpen(false); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function changeRole(userId: string, role: Perfil) {
    try { await roleFn({ data: { userId, role } }); toast.success("Perfil atualizado"); invalidate(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function toggleActive(u: Row) {
    try {
      await activeFn({ data: { userId: u.id, active: !u.active } });
      toast.success(u.active ? "Usuário desativado" : "Usuário reativado"); invalidate();
    } catch (e) { toast.error((e as Error).message); }
  }

  if (loading || !isDiretor) return null;

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      <Button asChild variant="ghost" size="sm" className="mb-3">
        <Link to="/conciliacao"><ArrowLeft className="mr-1 h-4 w-4" /> Voltar</Link>
      </Button>

      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Usuários</h1>
          <p className="text-sm text-muted-foreground">Gestão de acesso da equipe.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><UserPlus className="mr-1 h-4 w-4" /> Convidar usuário</Button></DialogTrigger>
          <InviteDialog onInvite={invite} />
        </Dialog>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : q.error ? (
        <Card className="border-rose-300 bg-rose-50 p-4 text-sm text-rose-800 dark:bg-rose-950/20 dark:text-rose-300">
          Não foi possível carregar os usuários. Confirme que <code>SUPABASE_SERVICE_ROLE_KEY</code> está configurada
          no ambiente do servidor (necessária para a Admin API do Supabase).
        </Card>
      ) : (
        <div className="space-y-2">
          {(q.data ?? []).map((u) => (
            <Card key={u.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{u.full_name || u.email}</span>
                  {!u.active && <Badge variant="secondary">Desativado</Badge>}
                  {u.id === user?.id && <Badge variant="outline">você</Badge>}
                </div>
                <div className="text-sm text-muted-foreground">{u.email}</div>
                <div className="text-xs text-muted-foreground">
                  Cadastro: {u.created_at ? format(new Date(u.created_at), "dd/MM/yyyy", { locale: ptBR }) : "—"}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={u.role} onValueChange={(v) => changeRole(u.id, v as Perfil)} disabled={u.id === user?.id}>
                  <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="operacional">Operacional</SelectItem>
                    <SelectItem value="diretor">Diretor</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" variant={u.active ? "ghost" : "outline"} onClick={() => toggleActive(u)} disabled={u.id === user?.id}>
                  {u.active ? <><PowerOff className="mr-1 h-3.5 w-3.5" /> Desativar</> : <><Power className="mr-1 h-3.5 w-3.5" /> Reativar</>}
                </Button>
              </div>
            </Card>
          ))}
          {(q.data?.length ?? 0) === 0 && (
            <Card className="p-8 text-center text-sm text-muted-foreground">Nenhum usuário.</Card>
          )}
        </div>
      )}
    </div>
  );
}

function InviteDialog({ onInvite }: { onInvite: (email: string, role: Perfil) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Perfil>("operacional");
  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Convidar usuário</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <div>
          <Label>Email</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="pessoa@empresa.com" />
        </div>
        <div>
          <Label>Perfil</Label>
          <Select value={role} onValueChange={(v) => setRole(v as Perfil)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="operacional">Operacional</SelectItem>
              <SelectItem value="diretor">Diretor</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <DialogFooter>
        <Button disabled={!email.trim()} onClick={() => onInvite(email.trim(), role)}>Enviar convite</Button>
      </DialogFooter>
    </DialogContent>
  );
}
