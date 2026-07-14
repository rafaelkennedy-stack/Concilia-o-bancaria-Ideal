// Helpers de extração de texto/saldo dos extratos (lado do cliente). As libs
// pesadas (xlsx, unpdf) são carregadas sob demanda via import dinâmico para não
// entrarem no bundle inicial das rotas que só precisam delas ocasionalmente.

// ---- Leitura do extrato bancário: .xlsx, .xls e .csv --------------------------
//
// O formato é detectado pelos MAGIC BYTES, não pela extensão (arquivo renomeado é
// comum): ZIP => .xlsx, OLE/BIFF => .xls, qualquer outra coisa => texto (CSV).
const MAGIC_XLSX = [0x50, 0x4b];              // "PK"  — zip
const MAGIC_XLS = [0xd0, 0xcf, 0x11, 0xe0];   // OLE2 compound file

function isBinaryWorkbook(bytes: Uint8Array): boolean {
  const comeca = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  return comeca(MAGIC_XLSX) || comeca(MAGIC_XLS);
}

// CSV precisa ser decodificado por NÓS antes de entregar ao SheetJS.
//
// Motivo: XLSX.read(bytes, {type:"array"}) trata os bytes como latin1. Num CSV em
// UTF-8 isso transforma "Histórico" em "HistÃ³rico" e a coluna deixa de ser
// encontrada — e o parse NÃO falha: ele só devolve descrição vazia e, pior, para de
// reconhecer a linha "Saldo Anterior", que passa a entrar como se fosse lançamento.
// Decodificando aqui e passando type:"string", o SheetJS detecta o separador
// (vírgula ou ponto-e-vírgula) sozinho.
function decodeText(bytes: Uint8Array): string {
  // BOM de UTF-8.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  // Extratos de banco brasileiro saem muito em windows-1252. Acentos em 1252 são
  // sequências INVÁLIDAS em UTF-8, então um decode estrito distingue os dois casos.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

// ---- OFX ----------------------------------------------------------------------
//
// OFX é o formato mais confiável dos três: o tipo do lançamento vem do SINAL de
// <TRNAMT> (não depende de existir uma coluna "Inf."), a data é ISO (AAAAMMDD) e
// não há ambiguidade de separador nem de casa decimal — as armadilhas que o CSV tem.
//
// ATENÇÃO ao roteamento: OFX é TEXTO, e readBankWorkbook trata todo arquivo não
// binário como CSV. Por isso a detecção de OFX precisa vir ANTES — senão o arquivo
// entra no parser de CSV e vira lixo silencioso.
function isOfx(text: string): boolean {
  const inicio = text.slice(0, 2048).toUpperCase();
  return inicio.includes("OFXHEADER") || inicio.includes("<OFX>");
}

// Valor de um elemento folha do OFX. No OFX clássico (SGML) as folhas NÃO são
// fechadas — "<TRNAMT>-100.00\n<MEMO>..." — então o valor vai até o próximo "<" ou
// quebra de linha. Isso também funciona no OFX 2.x (XML), onde a tag é fechada.
function ofxTag(bloco: string, nome: string): string | null {
  const m = bloco.match(new RegExp(`<${nome}>([^<\r\n]*)`, "i"));
  return m ? (m[1].trim() || null) : null;
}

// OFX especifica ponto como separador decimal, mas alguns bancos brasileiros emitem
// vírgula. Cobrimos os dois — sem passar por parseBRNumber, que trataria o ponto de
// "1234.56" como separador de milhar.
function ofxAmount(raw: string | null): number | null {
  if (!raw) return null;
  const s = raw.replace(/\s/g, "");
  if (!s) return null;
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  return Number.isFinite(n) ? n : null;
}

// <DTPOSTED>20260701120000[-3:BRT] -> "2026-07-01" (os 8 primeiros dígitos).
function ofxDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function parseOfxEntries(text: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  for (const m of text.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)) {
    const bloco = m[1];
    const entry_date = ofxDate(ofxTag(bloco, "DTPOSTED"));
    const valor = ofxAmount(ofxTag(bloco, "TRNAMT"));
    if (!entry_date || valor == null) continue;
    out.push({
      entry_date,
      description: ofxTag(bloco, "MEMO") ?? "",
      beneficiary: null,
      amount: Math.abs(valor),
      entry_type: valor < 0 ? "D" : "C",   // sinal do TRNAMT define o tipo
      document_ref: ofxTag(bloco, "CHECKNUM"),
    });
  }
  return out;
}

// Saldo final do extrato: <LEDGERBAL> ... <BALAMT>. É preciso limitar a busca ao
// bloco LEDGERBAL — o OFX também tem <AVAILBAL><BALAMT> (saldo disponível), que é
// outro número e não deve ser confundido com o saldo do razão.
function parseOfxBalance(text: string): number | null {
  const bloco = text.match(/<LEDGERBAL>([\s\S]*?)<\/LEDGERBAL>/i);
  if (!bloco) return null;
  return ofxAmount(ofxTag(bloco[1], "BALAMT"));
}

// Descobre o separador do CSV. Não dá para confiar no palpite do SheetJS: extratos
// começam com uma linha de título SEM separador, e ele chuta a partir da primeira
// linha. Usamos a MEDIANA de separadores por linha (o título, sozinho, não
// desequilibra) e só contamos fora das aspas, para não confundir a vírgula decimal
// de "1.234,56" com separador de campo.
function detectDelimiter(text: string): string {
  const linhas = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (!linhas.length) return ",";

  const contarFora = (linha: string, sep: string) => {
    let n = 0;
    let aspas = false;
    for (const c of linha) {
      if (c === '"') aspas = !aspas;
      else if (c === sep && !aspas) n++;
    }
    return n;
  };

  let melhor = ",";
  let melhorMediana = 0;
  for (const sep of [";", ",", "\t", "|"]) {
    const cont = linhas.map((l) => contarFora(l, sep)).sort((a, b) => a - b);
    const mediana = cont[Math.floor(cont.length / 2)] ?? 0;
    if (mediana > melhorMediana) { melhorMediana = mediana; melhor = sep; }
  }
  return melhor;
}

async function readBankWorkbook(file: File, opts: { cellDates?: boolean } = {}) {
  const XLSX = await import("xlsx");
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (isBinaryWorkbook(bytes)) {
    return { XLSX, wb: XLSX.read(bytes, { type: "array", ...opts }) };
  }

  // CSV: lido com raw:true, ou seja, TODA célula fica como texto.
  //
  // Sem isso o SheetJS infere tipos com convenção americana e corrompe o extrato em
  // silêncio: "01/07/2026" (1º de julho) vira 7 de janeiro, e "1.234,56" vira
  // 1.23456 — mil vezes menor. Como texto, quem interpreta é brDateToISO/coerceISO
  // e parseBRNumber, que já entendem o formato brasileiro (é o mesmo caminho que os
  // valores do .xls/.xlsx percorrem).
  const text = decodeText(bytes);
  const wb = XLSX.read(text, { type: "string", raw: true, FS: detectDelimiter(text), ...opts });
  return { XLSX, wb };
}

export async function parseExcel(file: File): Promise<string> {
  const { XLSX, wb } = await readBankWorkbook(file);
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

const normHeader = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// Coage uma célula de data (string formatada ou Date de cellDates) para ISO.
function coerceISO(fmtCell: unknown, rawCell: unknown): string | null {
  if (rawCell instanceof Date && !Number.isNaN(rawCell.getTime())) return rawCell.toISOString().slice(0, 10);
  const s = String(fmtCell ?? "").trim();
  let m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/(\d{2})\/(\d{2})\/(\d{2})\b/);         // ano com 2 dígitos
  if (m) return `20${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// Valor com sinal: usa o número cru (Sicredi guarda valor numérico com sinal);
// se vier string, detecta negativo por "-" ou parênteses e usa o valor absoluto.
function coerceSignedValue(fmtCell: unknown, rawCell: unknown): number | null {
  if (typeof rawCell === "number" && Number.isFinite(rawCell)) return rawCell;
  const s = String(fmtCell ?? "");
  const abs = Math.abs(parseBRNumber(s) ?? NaN);
  if (!Number.isFinite(abs)) return null;
  const negative = /-/.test(s) || /^\s*\(/.test(s);
  return negative ? -abs : abs;
}

// Extração ESTRUTURADA de extrato bancário: .xlsx, .xls antigo ou .csv (ver
// readBankWorkbook). A detecção do banco é a MESMA nos três formatos — depende só
// do cabeçalho, não do container do arquivo:
//   - coluna "Inf." (C/D)  => Banco do Brasil (tipo lido da coluna)
//   - "Valor (R$)" sem C/D  => Sicredi (tipo pelo SINAL do valor)
export async function parseBbEntries(file: File): Promise<ParsedEntry[]> {
  // OFX é texto: precisa ser desviado ANTES de readBankWorkbook, que trataria o
  // arquivo como CSV.
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isBinaryWorkbook(bytes)) {
    const text = decodeText(bytes);
    if (isOfx(text)) return parseOfxEntries(text);
  }

  const { XLSX, wb } = await readBankWorkbook(file, { cellDates: true });
  const out: ParsedEntry[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const fmt = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" });
    // Cabeçalho = primeira linha com "Data" e uma coluna "Valor…".
    let headerIdx = -1;
    const col: Record<string, number> = {};
    for (let i = 0; i < fmt.length; i++) {
      const cells = fmt[i].map(normHeader);
      if (cells.includes("data") && cells.some((c) => c.startsWith("valor"))) {
        headerIdx = i;
        fmt[i].forEach((c, j) => { col[normHeader(c)] = j; });
        break;
      }
    }
    if (headerIdx < 0) continue;

    const hasInf = Object.keys(col).some((k) => k.startsWith("inf"));
    if (hasInf) {
      out.push(...parseBbSheet(fmt, headerIdx, col));
    } else {
      const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
      out.push(...parseSicrediSheet(fmt, raw, headerIdx, col));
    }
  }
  return out;
}

// Banco do Brasil: tipo vem da coluna "Inf." (C/D); valor de "Valor R$"; nome do
// "Detalhamento Hist.".
function parseBbSheet(fmt: unknown[][], headerIdx: number, col: Record<string, number>): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const cData = col["data"];
  const cInf = Object.keys(col).find((k) => k.startsWith("inf"));
  const cInfIdx = cInf != null ? col[cInf] : -1;
  const cHist = col["historico"] ?? col["histórico"] ?? -1;
  const cValKey = Object.keys(col).find((k) => k.startsWith("valor"));
  const cVal = cValKey != null ? col[cValKey] : -1;
  const cDetKey = Object.keys(col).find((k) => k.startsWith("detalhamento"));
  const cDet = cDetKey != null ? col[cDetKey] : -1;
  const cDoc = col["numero documento"] ?? col["número documento"] ?? -1;

  for (let i = headerIdx + 1; i < fmt.length; i++) {
    const r = fmt[i];
    const entry_date = brDateToISO(String(r[cData] ?? ""));
    if (!entry_date) continue;
    const hist = cHist >= 0 ? String(r[cHist] ?? "").trim() : "";
    if (/saldo anterior/i.test(hist)) continue;
    const amount = parseBRNumber(String(r[cVal] ?? ""));
    if (amount == null) continue;
    const inf = normHeader(r[cInfIdx]).toUpperCase();
    const entry_type: "C" | "D" = inf.startsWith("D") ? "D" : "C";
    const det = cDet >= 0 ? String(r[cDet] ?? "") : "";
    out.push({
      entry_date,
      description: hist,
      beneficiary: bbBeneficiary(det) || null,
      amount: Math.abs(amount),
      entry_type,
      document_ref: cDoc >= 0 ? String(r[cDoc] ?? "").trim() || null : null,
    });
  }
  return out;
}

// Sicredi (.xls antigo): sem coluna C/D. O tipo é o SINAL do valor — positivo =
// crédito/entrada (C), negativo = débito/saída (D); amount = |valor|. Ignora a
// linha "Saldo Anterior" e linhas sem data.
function parseSicrediSheet(
  fmt: unknown[][], raw: unknown[][], headerIdx: number, col: Record<string, number>,
): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const cData = col["data"];
  const cValKey = Object.keys(col).find((k) => k.startsWith("valor"));
  const cVal = cValKey != null ? col[cValKey] : -1;
  const cDescKey = Object.keys(col).find((k) => k.startsWith("descri"));
  const cDesc = cDescKey != null ? col[cDescKey] : -1;
  const cDoc = Object.keys(col).find((k) => k.startsWith("documento")) != null
    ? col[Object.keys(col).find((k) => k.startsWith("documento"))!] : -1;

  for (let i = headerIdx + 1; i < fmt.length; i++) {
    const rf = fmt[i], rr = raw[i] ?? [];
    const entry_date = coerceISO(rf[cData], rr[cData]);
    if (!entry_date) continue;
    const desc = cDesc >= 0 ? String(rf[cDesc] ?? "").trim() : "";
    if (/saldo\s*anterior/i.test(desc)) continue;
    const signed = cVal >= 0 ? coerceSignedValue(rf[cVal], rr[cVal]) : null;
    if (signed == null) continue;
    out.push({
      entry_date,
      description: desc,
      beneficiary: null,
      amount: Math.abs(signed),
      entry_type: signed < 0 ? "D" : "C",
      document_ref: cDoc >= 0 ? String(rf[cDoc] ?? "").trim() || null : null,
    });
  }
  return out;
}

// Saldo do extrato bancário, seja qual for o formato. As telas chamam SÓ isto e não
// precisam saber com que arquivo estão lidando:
//   - OFX  => <LEDGERBAL><BALAMT> (número explícito, sem heurística)
//   - .xlsx/.xls/.csv => procura a linha "SALDO" no texto achatado
export async function extractBankBalanceFromFile(file: File): Promise<number | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isBinaryWorkbook(bytes)) {
    const text = decodeText(bytes);
    if (isOfx(text)) return parseOfxBalance(text);
  }
  return extractBankBalance(await parseExcel(file));
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
