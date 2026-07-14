import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Upload, Sparkles, Layers } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { processMassReconciliation } from "@/lib/reconciliation.functions";
import { parseBbEntries, parseAgrotisEntries } from "@/lib/file-extract";

export const Route = createFileRoute("/_authenticated/conciliacao/massa")({
  component: Mass,
});

type Account = { id: string; bank: string; entity_name: string; account_number: string | null; active: boolean };

const fmtDate = (iso: string) => format(new Date(iso + "T00:00"), "dd/MM/yyyy", { locale: ptBR });

function Mass() {
  const navigate = useNavigate();
  const process = useServerFn(processMassReconciliation);
  const [accountId, setAccountId] = useState<string>("");
  const [bb, setBB] = useState<File | null>(null);
  const [ag, setAg] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const accounts = useQuery({
    queryKey: ["bank_accounts", "active"],
    queryFn: async () => {
      const { data, error } = await supabase.from("bank_accounts")
        .select("id, bank, entity_name, account_number, active")
        .eq("active", true).order("bank");
      if (error) throw error;
      return (data ?? []) as Account[];
    },
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId) { toast.error("Selecione uma conta bancária."); return; }
    if (!bb || !ag) { toast.error("Envie os dois arquivos."); return; }
    setBusy(true);
    try {
      toast.info("Lendo arquivos…");
      const [bbEntries, agrotisEntries] = await Promise.all([parseBbEntries(bb), parseAgrotisEntries(ag)]);
      if (!bbEntries.length) throw new Error("Nenhum lançamento lido do Excel do BB.");
      if (!agrotisEntries.length) throw new Error("Nenhum lançamento lido do PDF do Agrotis.");
      toast.info("Casando com IA…", { description: "Isso pode levar alguns segundos." });
      const { reconciliationId, minDate, maxDate, dayCount } = await process({ data: {
        bankAccountId: accountId,
        bbFileName: bb.name, bbEntries,
        agrotisFileName: ag.name, agrotisEntries,
      }});
      toast.success(
        `Encontrei lançamentos de ${dayCount} dia${dayCount === 1 ? "" : "s"}: ${fmtDate(minDate)} a ${fmtDate(maxDate)}`,
        { description: "Revise os casamentos e feche para dividir por dia." },
      );
      navigate({ to: "/conciliacao/$id", params: { id: reconciliationId } });
    } catch (err) {
      toast.error("Falha ao processar", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8">
      <Button asChild variant="ghost" size="sm" className="mb-4">
        <Link to="/conciliacao"><ArrowLeft className="mr-1 h-4 w-4" /> Voltar</Link>
      </Button>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" /> Processamento em massa
          </CardTitle>
          <CardDescription>
            Envie extratos que cobrem vários dias. A IA identifica a data de cada lançamento;
            ao fechar, a conciliação é dividida automaticamente em conciliações diárias.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={submit}>
            <div>
              <Label>Conta bancária</Label>
              {accounts.isLoading ? (
                <p className="mt-1 text-sm text-muted-foreground">Carregando…</p>
              ) : !accounts.data?.length ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  Nenhuma conta ativa. Peça ao Diretor para cadastrar em Configurações › Contas.
                </p>
              ) : (
                <Select value={accountId} onValueChange={setAccountId}>
                  <SelectTrigger><SelectValue placeholder="Selecionar conta…" /></SelectTrigger>
                  <SelectContent>
                    {accounts.data.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.bank} — {a.entity_name}{a.account_number ? ` (${a.account_number})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <FileField
              label="Extrato BB (.xlsx ou .xls)" accept=".xlsx,.xls"
              file={bb} onChange={setBB}
            />
            <FileField
              label="Extrato Agrotis (.pdf)" accept=".pdf,application/pdf"
              file={ag} onChange={setAg}
            />
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Processando…" : <><Sparkles className="mr-1 h-4 w-4" /> Processar em massa</>}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function FileField({ label, accept, file, onChange }: { label: string; accept: string; file: File | null; onChange: (f: File | null) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <label className="mt-1 flex cursor-pointer items-center justify-between rounded-md border border-dashed px-3 py-3 text-sm hover:bg-accent/40">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Upload className="h-4 w-4" />
          {file ? file.name : "Selecionar arquivo"}
        </span>
        <input type="file" accept={accept} className="sr-only"
          onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
      </label>
    </div>
  );
}
