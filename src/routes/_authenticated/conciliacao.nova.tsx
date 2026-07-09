import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Upload, Sparkles } from "lucide-react";
import { processReconciliation } from "@/lib/reconciliation.functions";

export const Route = createFileRoute("/_authenticated/conciliacao/nova")({
  // Permite abrir o fluxo já com a conta e a data pré-selecionadas a partir da
  // fila diária (/conciliacao/fila).
  validateSearch: (s: Record<string, unknown>): { account?: string; date?: string } => ({
    account: typeof s.account === "string" ? s.account : undefined,
    date: typeof s.date === "string" ? s.date : undefined,
  }),
  component: New,
});

import * as XLSX from "xlsx";
import { extractText, getDocumentProxy } from "unpdf";

async function parseExcel(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS: " | " });
    parts.push(`=== Sheet: ${name} ===\n${csv}`);
  }
  return parts.join("\n\n");
}

async function parsePdf(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const result = await extractText(pdf, { mergePages: true });
  const t: unknown = result.text;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.join("\n");
  return String(t ?? "");
}

// Parse "R$ 1.234,56" or "1.234,56" or "-1.234,56" or "1,234.56" formats
function parseBRNumber(raw: string): number | null {
  const s = raw.replace(/R\$/gi, "").replace(/\s/g, "").trim();
  if (!s) return null;
  // Detect Brazilian format (comma decimal)
  const hasComma = s.includes(",");
  const cleaned = hasComma ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Extract "SALDO" line from BB Excel text (letters may be spaced: S A L D O)
function extractBankBalance(text: string): number | null {
  // Try spaced pattern first
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const norm = line.replace(/\s+/g, " ");
    if (/\bS\s*A\s*L\s*D\s*O\b/i.test(line) || /\bSALDO\b/i.test(norm)) {
      // Grab last number-looking token
      const matches = norm.match(/-?[\d.]+,\d{2}|-?[\d,]+\.\d{2}/g);
      if (matches && matches.length) {
        const n = parseBRNumber(matches[matches.length - 1]);
        if (n != null) return n;
      }
    }
  }
  return null;
}

// Extract "saldo anterior" from Agrotis PDF text (first line typically)
function extractAgrotisPrevious(text: string): number | null {
  const lines = text.split(/\r?\n/).slice(0, 40);
  for (const line of lines) {
    if (/saldo\s*anterior/i.test(line)) {
      const matches = line.match(/-?[\d.]+,\d{2}|-?[\d,]+\.\d{2}/g);
      if (matches && matches.length) {
        const n = parseBRNumber(matches[matches.length - 1]);
        if (n != null) return n;
      }
    }
  }
  return null;
}

type Account = { id: string; bank: string; entity_name: string; account_number: string | null; active: boolean };

function New() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const process = useServerFn(processReconciliation);
  const [date, setDate] = useState(() => search.date ?? new Date().toISOString().slice(0, 10));
  const [accountId, setAccountId] = useState<string>(search.account ?? "");
  const fromQueue = !!search.account;
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
      const [bbText, agrotisText] = await Promise.all([parseExcel(bb), parsePdf(ag)]);
      if (!bbText?.trim()) throw new Error("Não foi possível extrair texto do Excel BB.");
      if (!agrotisText?.trim()) throw new Error("Não foi possível extrair texto do PDF Agrotis.");
      const balanceBank = extractBankBalance(bbText);
      const balanceAgrotisPrevious = extractAgrotisPrevious(agrotisText);
      if (balanceBank == null) toast.warning("Saldo do banco não encontrado — o fechamento poderá pedir revisão.");
      if (balanceAgrotisPrevious == null) toast.warning("Saldo anterior Agrotis não encontrado — validação da cadeia ficará indisponível.");
      toast.info("Processando com IA…", { description: "Isso pode levar alguns segundos." });
      const { reconciliationId } = await process({ data: {
        reconciliationDate: date,
        bankAccountId: accountId,
        bbFileName: bb.name, bbText,
        agrotisFileName: ag.name, agrotisText,
        balanceBank, balanceAgrotisPrevious,
      }});
      toast.success("Concluído!");
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
        {fromQueue
          ? <Link to="/conciliacao/fila"><ArrowLeft className="mr-1 h-4 w-4" /> Voltar para a fila</Link>
          : <Link to="/conciliacao"><ArrowLeft className="mr-1 h-4 w-4" /> Voltar</Link>}
      </Button>
      <Card>
        <CardHeader>
          <CardTitle>Nova Conciliação</CardTitle>
          <CardDescription>Envie os extratos do dia. A IA identifica e sugere os casamentos.</CardDescription>
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
                <Select value={accountId} onValueChange={setAccountId} disabled={fromQueue}>
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
            <div>
              <Label>Data</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </div>
            <FileField
              label="Extrato BB (.xlsx)" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              file={bb} onChange={setBB}
            />
            <FileField
              label="Extrato Agrotis (.pdf)" accept=".pdf,application/pdf"
              file={ag} onChange={setAg}
            />
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Processando…" : <><Sparkles className="mr-1 h-4 w-4" /> Processar</>}
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
