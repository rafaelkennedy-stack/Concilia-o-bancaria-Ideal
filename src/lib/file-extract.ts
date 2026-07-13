// Helpers de extração de texto/saldo dos extratos (lado do cliente). As libs
// pesadas (xlsx, unpdf) são carregadas sob demanda via import dinâmico para não
// entrarem no bundle inicial das rotas que só precisam delas ocasionalmente.

export async function parseExcel(file: File): Promise<string> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS: " | " });
    parts.push(`=== Sheet: ${name} ===\n${csv}`);
  }
  return parts.join("\n\n");
}

export async function parsePdf(file: File): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const buf = await file.arrayBuffer();
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const result = await extractText(pdf, { mergePages: true });
  const t: unknown = result.text;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.join("\n");
  return String(t ?? "");
}

// Lançamento estruturado extraído deterministicamente (mesmo formato do AiEntry
// no servidor). tipo (entry_type) e valor (amount) vêm da leitura direta das
// colunas — NÃO são inferidos por IA.
export type ParsedEntry = {
  entry_date: string | null;
  description: string;
  beneficiary: string | null;
  amount: number;
  entry_type: "C" | "D";
  document_ref: string | null;
};

const MONEY_RE = /^-?[\d.]+,\d{2}$/;
const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;

// "DD/MM/YYYY" -> "YYYY-MM-DD"
function brDateToISO(raw: string): string | null {
  const m = String(raw).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Nome do beneficiário a partir do histórico do Agrotis:
// "Pgto. dupl. 30014-1, de Leonardo Santos Reis" -> "Leonardo Santos Reis".
// Remove sufixos de recepção ("- RECEPÇÃO MILHO"). Sem "de ..." (ex.:
// "TRANSFERENCIA ENTRE CONTAS") retorna vazio.
function agrotisBeneficiary(hist: string): string {
  const m = hist.match(/,\s*de\s+(.+)$/i);
  if (!m) return "";
  return m[1].replace(/\s*-\s*(recep[çc][aã]o|recepc[aã]o).*$/i, "").trim();
}

// Nome do beneficiário a partir do "Detalhamento Hist." do BB:
// "01/07 18:42 LEONARDO SANTOS REIS" -> "LEONARDO SANTOS REIS".
// Remove o prefixo "DD/MM HH:MM " e um eventual número de documento à frente.
function bbBeneficiary(det: string): string {
  return String(det)
    .replace(/^\s*\d{2}\/\d{2}\s+\d{2}:\d{2}\s*/, "")
    .replace(/^\d{6,}\s*/, "")
    .trim();
}

// Extração ESTRUTURADA do Excel do BB. A coluna "Inf." define C/D e "Valor R$"
// o valor — lidos diretamente, sem IA. Localiza a linha de cabeçalho por nome de
// coluna, então adapta-se à ordem/posição das colunas.
export async function parseBbEntries(file: File): Promise<ParsedEntry[]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const out: ParsedEntry[] = [];
  const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[sheetName], { header: 1, raw: false, defval: "" });
    // Cabeçalho: linha com "Data", "Valor…", "Inf." e "Historico".
    let headerIdx = -1;
    const col: Record<string, number> = {};
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].map(norm);
      if (cells.includes("data") && cells.some((c) => c.startsWith("valor")) && cells.includes("inf.")) {
        headerIdx = i;
        rows[i].forEach((c, j) => { col[norm(c)] = j; });
        break;
      }
    }
    if (headerIdx < 0) continue;
    const cData = col["data"];
    const cInf = col["inf."];
    const cHist = col["historico"] ?? col["histórico"];
    const cValKey = Object.keys(col).find((k) => k.startsWith("valor"));
    const cVal = cValKey != null ? col[cValKey] : -1;
    const cDetKey = Object.keys(col).find((k) => k.startsWith("detalhamento"));
    const cDet = cDetKey != null ? col[cDetKey] : -1;
    const cDoc = col["numero documento"] ?? col["número documento"] ?? -1;

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const entry_date = brDateToISO(String(r[cData] ?? ""));
      if (!entry_date) continue;
      const hist = String(r[cHist] ?? "").trim();
      if (/saldo anterior/i.test(hist)) continue;
      const amount = parseBRNumber(String(r[cVal] ?? ""));
      if (amount == null) continue;
      const inf = norm(r[cInf]).toUpperCase();
      const entry_type: "C" | "D" = inf.startsWith("D") ? "D" : "C";
      const det = cDet >= 0 ? String(r[cDet] ?? "") : "";
      const beneficiary = bbBeneficiary(det) || null;
      out.push({
        entry_date,
        description: hist,
        beneficiary,
        amount: Math.abs(amount),
        entry_type,
        document_ref: cDoc >= 0 ? String(r[cDoc] ?? "").trim() || null : null,
      });
    }
  }
  return out;
}

// Extração ESTRUTURADA do PDF do Agrotis usando POSIÇÃO (coordenada x) dos
// tokens. O relatório tem colunas "Entrada" e "Saída": se o valor cai sob
// Entrada => C; sob Saída => D. As posições das colunas são lidas do cabeçalho de
// cada página (labels "Entrada"/"Saída"/"Saldo"), tornando a leitura robusta a
// escala. IMPORTANTE: o texto achatado (mergePages) NÃO serve aqui porque cada
// linha termina com um "C" constante que confunde a inferência de tipo — por isso
// usamos as coordenadas.
export async function parseAgrotisEntries(file: File): Promise<ParsedEntry[]> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
  const out: ParsedEntry[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    type Tok = { s: string; x: number; y: number };
    const items: Tok[] = content.items
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((it: any) => ({ s: String(it.str ?? ""), x: Math.round(it.transform[4]), y: Math.round(it.transform[5]) }))
      .filter((it: Tok) => it.s.trim() !== "");

    const byY = new Map<number, Tok[]>();
    for (const it of items) (byY.get(it.y) ?? byY.set(it.y, []).get(it.y)!).push(it);
    const ys = [...byY.keys()].sort((a, b) => b - a);

    // Posições das colunas a partir do cabeçalho.
    let xEntrada = 0, xSaida = 0, xSaldo = 0;
    for (const y of ys) {
      for (const it of byY.get(y)!) {
        if (it.s === "Entrada") xEntrada = it.x;
        else if (it.s === "Saída" || it.s === "Saida") xSaida = it.x;
        else if (it.s === "Saldo") xSaldo = it.x;
      }
      if (xEntrada && xSaida && xSaldo) break;
    }
    if (!xEntrada || !xSaida || !xSaldo) continue;
    const mid = (xEntrada + xSaida) / 2;

    for (const y of ys) {
      const row = byY.get(y)!.slice().sort((a, b) => a.x - b.x);
      const text = row.map((i) => i.s).join(" ");
      if (/Saldo Anterior/i.test(text)) continue;
      const dateTok = row.find((i) => DATE_RE.test(i.s.trim()));
      if (!dateTok) continue;
      const nums = row.filter((i) => MONEY_RE.test(i.s.trim()));
      if (nums.length < 2) continue;
      // Saldo = token mais próximo da coluna Saldo; valor = o outro (mais próximo
      // do centro entre Entrada e Saída).
      const saldo = nums.reduce((a, b) => (Math.abs(b.x - xSaldo) < Math.abs(a.x - xSaldo) ? b : a));
      const valorCands = nums.filter((n) => n !== saldo);
      if (!valorCands.length) continue;
      const valor = valorCands.reduce((a, b) => (Math.abs(b.x - mid) < Math.abs(a.x - mid) ? b : a));
      const amount = parseBRNumber(valor.s.trim());
      if (amount == null) continue;
      // Entrada (C) se o valor está mais perto da coluna Entrada; Saída (D) caso contrário.
      const entry_type: "C" | "D" = Math.abs(valor.x - xEntrada) <= Math.abs(valor.x - xSaida) ? "C" : "D";
      const histTok = row.find((i) => /dupl\.|transfer|aplica|resgate|parcial/i.test(i.s));
      const hist = (histTok?.s ?? "").trim();
      const docTok = row.find((i) => /^\d[\d-]*-\d+$/.test(i.s.trim()));
      out.push({
        entry_date: brDateToISO(dateTok.s.trim()),
        description: hist,
        beneficiary: agrotisBeneficiary(hist) || null,
        amount: Math.abs(amount),
        entry_type,
        document_ref: docTok ? docTok.s.trim() : null,
      });
    }
  }
  return out;
}

// Parse "R$ 1.234,56" or "1.234,56" or "-1.234,56" or "1,234.56" formats
export function parseBRNumber(raw: string): number | null {
  const s = raw.replace(/R\$/gi, "").replace(/\s/g, "").trim();
  if (!s) return null;
  const hasComma = s.includes(",");
  const cleaned = hasComma ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Extract "SALDO" line from BB Excel text (letters may be spaced: S A L D O)
export function extractBankBalance(text: string): number | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const norm = line.replace(/\s+/g, " ");
    if (/\bS\s*A\s*L\s*D\s*O\b/i.test(line) || /\bSALDO\b/i.test(norm)) {
      const matches = norm.match(/-?[\d.]+,\d{2}|-?[\d,]+\.\d{2}/g);
      if (matches && matches.length) {
        const n = parseBRNumber(matches[matches.length - 1]);
        if (n != null) return n;
      }
    }
  }
  return null;
}

// Extract "saldo anterior" from Agrotis PDF text (first lines typically)
export function extractAgrotisPrevious(text: string): number | null {
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
