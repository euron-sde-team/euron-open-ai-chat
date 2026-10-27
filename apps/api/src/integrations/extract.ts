/**
 * Plain text out of documents, for models that read text: PDF (unpdf, a serverless build
 * of pdf.js), DOCX (mammoth), XLSX (exceljs, every sheet as CSV-like rows), CSV and text
 * files as UTF-8. Nothing here executes document content: no macros, no scripts, no
 * external references are followed.
 */
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import type { FileKind } from "@open-chat/types";

export interface Extracted {
  text: string;
  pageCount: number | null;
}

/** Rows read from one spreadsheet, at most; enough for a model, bounded for memory. */
const MAX_SHEET_ROWS = 5000;

export async function extractTextFrom(kind: FileKind, mimeType: string, data: Buffer): Promise<Extracted> {
  switch (kind) {
    case "PDF": {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const { totalPages, text } = await extractText(pdf, { mergePages: true });
      return { text: Array.isArray(text) ? text.join("\n\n") : text, pageCount: totalPages };
    }
    case "DOCUMENT": {
      const { value } = await mammoth.extractRawText({ buffer: data });
      return { text: value, pageCount: null };
    }
    case "SPREADSHEET": {
      if (mimeType === "text/csv") return { text: data.toString("utf8"), pageCount: null };
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(data as unknown as ArrayBuffer);
      const parts: string[] = [];
      let rows = 0;
      book.eachSheet((sheet) => {
        parts.push(`# Sheet: ${sheet.name}`);
        sheet.eachRow({ includeEmpty: false }, (row) => {
          if (rows++ >= MAX_SHEET_ROWS) return;
          const values = (row.values as unknown[]).slice(1).map(cellText);
          parts.push(values.map(csvField).join(","));
        });
      });
      return { text: parts.join("\n"), pageCount: book.worksheets.length };
    }
    case "TEXT":
      return { text: data.toString("utf8"), pageCount: null };
    default:
      return { text: "", pageCount: null };
  }
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[]; hyperlink?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return cellText(o.result);
    return "";
  }
  return String(v);
}

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
