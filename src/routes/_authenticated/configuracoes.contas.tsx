import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { ArrowLeft, Plus, Pencil, Power, PowerOff } from "lucide-react";
import {
  createBankAccount, updateBankAccount, setBankAccountActive,
} from "@/lib/bank-accounts.functions";

export const Route = createFileRoute("/_authenticated/configuracoes/contas")({
  component: Page,
});

type Account = {
  id: string; bank: string; agency: string | null; account_number: string | null;
  entity_name: string; notes: string | null; active: boolean;
};

function Page() {
  const { isDiretor, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !isDiretor) {
      toast.error("Acesso restrito ao Diretor.");
      navigate({ to: "/conciliacao" });
    }
  }, [loading, isDiretor, navigate]);

  const qc = useQueryClient();
  const createFn = useServerFn(createBankAccount);
  const updateFn = useServerFn(updateBankAccount);
  const toggleFn = useServerFn(setBankAccountActive);

  const q = useQuery({
    queryKey: ["bank_accounts"],
    queryFn: async () => {
      const { data, error } = await supabase.from("bank_accounts")
        .select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Account[];
    },
  });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);

  async function save(values: Omit<Account, "id" | "active">) {
    try {
      if (editing) {
        await updateFn({ data: { id: editing.id, ...values } });
        toast.success("Conta atualizada");
      } else {
        await createFn({ data: values });
        toast.success("Conta criada");
      }
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      setOpen(false); setEditing(null);
    } catch (e) { toast.error((e as Error).message); }
  }

  async function toggle(a: Account) {
    try {
      await toggleFn({ data: { id: a.id, active: !a.active } });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
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
          <h1 className="text-2xl font-bold">Contas Bancárias</h1>
          <p className="text-sm text-muted-foreground">Cadastro usado nas conciliações.</p>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button onClick={() => setEditing(null)}>
              <Plus className="mr-1 h-4 w-4" /> Nova conta
            </Button>
          </DialogTrigger>
          <AccountDialog account={editing} onSave={save} />
        </Dialog>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !q.data?.length ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Nenhuma conta cadastrada.
        </Card>
      ) : (
        <div className="space-y-2">
          {q.data.map((a) => (
            <Card key={a.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{a.bank}</span>
                    <Badge variant={a.active ? "default" : "secondary"}>
                      {a.active ? "Ativa" : "Inativa"}
                    </Badge>
                  </div>
                  <div className="text-sm">{a.entity_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {a.agency ? `Ag. ${a.agency}` : ""}{a.agency && a.account_number ? " · " : ""}
                    {a.account_number ? `Conta ${a.account_number}` : ""}
                  </div>
                  {a.notes && <div className="mt-1 text-xs text-muted-foreground">{a.notes}</div>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setEditing(a); setOpen(true); }}>
                    <Pencil className="mr-1 h-3.5 w-3.5" /> Editar
                  </Button>
                  <Button size="sm" variant={a.active ? "ghost" : "outline"} onClick={() => toggle(a)}>
                    {a.active ? <><PowerOff className="mr-1 h-3.5 w-3.5" /> Desativar</>
                      : <><Power className="mr-1 h-3.5 w-3.5" /> Reativar</>}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountDialog({
  account, onSave,
}: {
  account: Account | null;
  onSave: (v: { bank: string; agency: string | null; account_number: string | null; entity_name: string; notes: string | null }) => void;
}) {
  const [bank, setBank] = useState(account?.bank ?? "");
  const [agency, setAgency] = useState(account?.agency ?? "");
  const [num, setNum] = useState(account?.account_number ?? "");
  const [entity, setEntity] = useState(account?.entity_name ?? "");
  const [notes, setNotes] = useState(account?.notes ?? "");

  useEffect(() => {
    setBank(account?.bank ?? "");
    setAgency(account?.agency ?? "");
    setNum(account?.account_number ?? "");
    setEntity(account?.entity_name ?? "");
    setNotes(account?.notes ?? "");
  }, [account]);

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>{account ? "Editar conta" : "Nova conta"}</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <div><Label>Banco</Label><Input value={bank} onChange={(e) => setBank(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Agência</Label><Input value={agency} onChange={(e) => setAgency(e.target.value)} /></div>
          <div><Label>Número da conta</Label><Input value={num} onChange={(e) => setNum(e.target.value)} /></div>
        </div>
        <div><Label>Nome da entidade</Label><Input value={entity} onChange={(e) => setEntity(e.target.value)} /></div>
        <div><Label>Observações</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button
          disabled={!bank.trim() || !entity.trim()}
          onClick={() => onSave({
            bank: bank.trim(), entity_name: entity.trim(),
            agency: agency.trim() || null, account_number: num.trim() || null,
            notes: notes.trim() || null,
          })}
        >Salvar</Button>
      </DialogFooter>
    </DialogContent>
  );
}
