// The "rows not imported" file, built in the browser from the file in memory (design 3.10). Safe to open in Excel:
// formula-like cells get a leading apostrophe, which the importer removes again (stripFormulaGuard), so it re-imports
// as is.
import type { ParsedRecord } from "./parse";
import type { Delimiter } from "./rules";

// A cell that Excel or LibreOffice could run as a formula: after leading spaces it starts with = + - @, a tab or a
// carriage return, or a full-width equals, plus, minus or at sign (U+FF1D, U+FF0B, U+FF0D, U+FF20). The importer uses
// the same pattern to remove the guard again (text.ts stripFormulaGuard), so the two always agree.
export const FORMULA_START = /^[ \u00A0]*[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;

/**
 * One CSV cell: NUL bytes dropped (the importer removes them anyway, and one in the file's first 64 KB makes it look
 * like a binary file), formula guard, then always quoted with inner quotes doubled.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value).replace(/\u0000/g, "");
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export type ProblemsCsvIssue = {
  row_no: number;
  /** Messages already in the UI language ("Email address doesn't look right", "Same phone as row 12"). */
  messages: readonly string[];
};

export type ProblemsCsvInput = {
  delimiter: Delimiter;
  /** The header cells exactly as in the source file. */
  headers: readonly string[];
  /** The parsed rows (at least every row named in `issues`). */
  records: readonly ParsedRecord[];
  issues: readonly ProblemsCsvIssue[];
  /** Localised names of the two leading columns, and the separator between messages (default " · "). */
  labels: { row: string; problem: string; separator?: string };
};

/** "<basename>-problems-YYYY-MM-DD.csv"; the source name loses its extension, folders and unsafe characters. */
export function problemsFileName(sourceName: string, isoDate: string): string {
  const base = (sourceName.split(/[\\/]/).pop() ?? "")
    .replace(/\.[^.]*$/, "")
    .replace(/[\u0000-\u001F\u007F"*:<>?|]+/g, "")
    .trim()
    .slice(0, 80);
  return `${base || "leads"}-problems-${isoDate.slice(0, 10)}.csv`;
}

/** UTF-8 BOM, CRLF, every cell quoted; columns: Row, Problem, then every original column in source order. */
export function buildProblemsCsv({ delimiter, headers, records, issues, labels }: ProblemsCsvInput): string {
  const byRow = new Map<number, ParsedRecord>();
  for (const record of records) byRow.set(record.row_no, record);
  const separator = labels.separator ?? " \u00B7 ";
  const line = (cells: readonly (string | number)[]) => cells.map(csvCell).join(delimiter);
  const lines = [line([labels.row, labels.problem, ...headers])];
  const sorted = [...issues].sort((a, b) => a.row_no - b.row_no);
  for (const issue of sorted) {
    const cells = byRow.get(issue.row_no)?.cells ?? [];
    const padded = cells.length >= headers.length ? cells : [...cells, ...Array(headers.length - cells.length).fill("")];
    lines.push(line([issue.row_no, issue.messages.join(separator), ...padded]));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
