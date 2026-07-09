import * as XLSX from "xlsx";
import { extractText, getDocumentProxy } from "unpdf";

export type ParsedEntry = {
  entry_date: string | null;
  description: string;
  beneficiary: string | null;
  amount: number;
  entry_type: "C" | "D";
  document_ref: string | null;
};

export async function extractExcelText(buffer: ArrayBuffer): Promise<string> {
  const wb = XLSX.read(buffer, { type: "array" });
  const rows: string[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: " | " });
    rows.push(`=== Sheet: ${name} ===\n${csv}`);
  }
  return rows.join("\n\n");
}

export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const result = await extractText(pdf, { mergePages: true });
  const text: unknown = result.text;
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return text.join("\n");
  return String(text ?? "");
}
