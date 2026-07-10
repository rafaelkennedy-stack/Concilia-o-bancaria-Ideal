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
