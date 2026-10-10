// Parses the decoded text with papaparse in slices that yield to the main thread (design 3.2). Rows stay plain arrays
// (header: false): header names never become object keys, so a "__proto__" header cannot pollute anything.
import type { ParseError, ParseResult, Parser } from "papaparse";
import { DELIMITERS, ImportFileError, LIMITS, PARSE_CHUNK_CHARS, type Delimiter } from "./rules";
import { cleanText, codePointLength, fold } from "./text";

export type ParsedRecord = {
  /** The row number Excel shows: header = row 1, a quoted multi-line cell is one row. */
  row_no: number;
  /** Raw cells as written in the file (extra cells beyond the header included). */
  cells: string[];
};

export type ParsedCsv = {
  /** Header names for display: cleaned, duplicates numbered "Email (2)". Empty headers stay "". */
  headers: string[];
  /** The header cells exactly as written (used by the problems file). Same length as `headers`. */
  rawHeaders: string[];
  /** Non-empty data rows in file order. */
  records: ParsedRecord[];
  /** Fully empty rows between the header and the last data row: they keep their number but are never sent. */
  blankRows: number;
  /** Non-empty data rows (import_batches.row_count). */
  rowCount: number;
  /** Spreadsheet row number of the last non-empty data row (import_batches.last_row_no). */
  lastRowNo: number;
  delimiter: Delimiter;
};

export type ParseProgress = { done: number; total: number; rows: number };

export type ParseOptions = {
  /** Separator from an Excel "sep=" line (decodeBytes). Otherwise it is guessed. */
  sepHint?: Delimiter | null;
  /** Characters per slice (default 256 K). */
  chunkSize?: number;
  /** Runs `resume` when the main thread is free again (default setTimeout 0). */
  schedule?: (resume: () => void) => void;
  onProgress?: (progress: ParseProgress) => void;
  signal?: AbortSignal;
};

type PapaModule = typeof import("papaparse");

// Loaded on first use, so the bundle only fetches papaparse when a file is picked.
async function loadPapa(): Promise<PapaModule> {
  const mod = (await import("papaparse")) as PapaModule & { default?: PapaModule };
  return mod.default ?? mod;
}

export function isBlankRecord(cells: readonly string[]): boolean {
  return cells.every((c) => c === "" || cleanText(c) === "");
}

/** Numbers repeated header names (" (2)", " (3)"), compared without case or accents. Empty names stay empty. */
export function dedupeHeaders(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    if (name === "") return name;
    let candidate = name;
    for (let n = 2; used.has(fold(candidate)); n++) candidate = `${name} (${n})`;
    used.add(fold(candidate));
    return candidate;
  });
}

// papaparse's own guesser on the first rows, ignoring empty lines (a trailing newline in a short file would otherwise
// make a semicolon file look undetectable and fall back to ",").
function guessDelimiter(Papa: PapaModule, text: string): Delimiter {
  const sample = Papa.parse<string[]>(text.slice(0, PARSE_CHUNK_CHARS), {
    header: false,
    preview: 10,
    skipEmptyLines: "greedy",
    delimitersToGuess: [...DELIMITERS],
  });
  const failed = sample.errors.some((e) => e.code === "UndetectableDelimiter");
  const found = sample.meta.delimiter as Delimiter;
  return !failed && DELIMITERS.includes(found) ? found : ",";
}

type Newline = "\r\n" | "\n" | "\r";

// papaparse guesses the line ending from the first slice only, which a small slice can get wrong (no line break in it
// yet, or one inside a quoted cell). The whole file uses the first line break outside quotes, read field by field
// (a quote only opens a field at its start, a doubled quote inside is a literal one); papaparse's own guess over the
// first 256 K characters when there is none.
function detectNewline(Papa: PapaModule, text: string, delimiter: Delimiter): Newline {
  const end = Math.min(text.length, PARSE_CHUNK_CHARS);
  let i = 0;
  while (i < end) {
    if (text[i] === '"') {
      for (i++; i < end; i++) {
        if (text[i] !== '"') continue;
        if (text[i + 1] !== '"') break;
        i++;
      }
      i++;
    }
    while (i < end && text[i] !== delimiter && text[i] !== "\n" && text[i] !== "\r") i++;
    if (i >= end) break;
    if (text[i] === "\n") return "\n";
    if (text[i] === "\r") return text[i + 1] === "\n" ? "\r\n" : "\r";
    i++; // the delimiter: the next field starts
  }
  const sample = Papa.parse<string[]>(text.slice(0, PARSE_CHUNK_CHARS), { header: false, preview: 1, delimiter });
  return sample.meta.linebreak as Newline;
}

function firstQuoteError(errors: readonly ParseError[], rowsInSlice: number): ParseError | undefined {
  // An error on the unfinished last row of a slice (row === rowsInSlice) is reported again, correctly, by the next
  // slice once the row is complete; only errors on rows this slice returned are real.
  return errors
    .filter((e) => e.type === "Quotes" && typeof e.row === "number" && e.row < rowsInSlice)
    .sort((a, b) => (a.row ?? 0) - (b.row ?? 0))[0];
}

export async function parseCsvText(text: string, options: ParseOptions = {}): Promise<ParsedCsv> {
  const Papa = await loadPapa();
  if (options.signal?.aborted) throw new ImportFileError("aborted");
  const delimiter = options.sepHint ?? guessDelimiter(Papa, text);
  const newline = detectNewline(Papa, text, delimiter);
  const schedule = options.schedule ?? ((resume: () => void) => void setTimeout(resume, 0));

  return new Promise<ParsedCsv>((resolve, reject) => {
    let settled = false;
    let recordIndex = 0; // index of the next record in the whole file; record 0 is the header (row 1)
    let headerCells: string[] | null = null; // the header row as written, trailing empty cells included
    let named = 0; // header columns up to the last one with a name
    let used = 0; // header columns up to the last one with a name or a value in some data row
    const records: ParsedRecord[] = [];
    let blankRows = 0;
    let pendingBlank = 0;
    let lastRowNo = 0;

    const fail = (error: unknown, parser?: Parser) => {
      if (settled) return;
      settled = true;
      parser?.abort();
      reject(error);
    };

    // Excel pads rows with trailing separators, so empty header cells at the end of the header row are dropped, but
    // only once the whole file is read: a column without a name whose data rows hold values stays, as an empty header
    // ("Column N (no name)", not imported), rather than making every row columns_extra.
    const takeHeader = (cells: string[]) => {
      if (isBlankRecord(cells)) throw new ImportFileError("no_header");
      let n = cells.length;
      while (n > 0 && cleanText(cells[n - 1]) === "") n--;
      if (n > LIMITS.maxColumns) throw new ImportFileError("too_many_columns");
      if (cells.some((h) => codePointLength(cleanText(h)) > LIMITS.maxHeaderChars)) {
        throw new ImportFileError("header_too_long");
      }
      headerCells = cells;
      named = n;
      used = n;
    };

    // Widens `used` to the last unnamed header column that holds a value in this row (one past the column limit is
    // enough to refuse the file).
    const noteUsedColumns = (cells: readonly string[], header: readonly string[]) => {
      for (let i = Math.min(cells.length, header.length, LIMITS.maxColumns + 1) - 1; i >= used; i--) {
        if (cleanText(cells[i]) !== "") {
          used = i + 1;
          return;
        }
      }
    };

    const takeRecord = (cells: string[]) => {
      const rowNo = recordIndex + 1;
      recordIndex++;
      if (headerCells === null) return takeHeader(cells);
      if (isBlankRecord(cells)) {
        pendingBlank++;
        return;
      }
      if (rowNo > LIMITS.maxRowNo) throw new ImportFileError("too_many_rows", rowNo);
      blankRows += pendingBlank;
      pendingBlank = 0;
      noteUsedColumns(cells, headerCells);
      records.push({ row_no: rowNo, cells });
      lastRowNo = rowNo;
    };

    Papa.parse<string[]>(text, {
      header: false,
      dynamicTyping: false,
      skipEmptyLines: false,
      delimiter,
      newline,
      delimitersToGuess: [...DELIMITERS],
      chunkSize: options.chunkSize ?? PARSE_CHUNK_CHARS,
      chunk(results: ParseResult<string[]>, parser: Parser) {
        if (settled) return;
        try {
          if (options.signal?.aborted) throw new ImportFileError("aborted");
          const quoteError = firstQuoteError(results.errors, results.data.length);
          if (quoteError) throw new ImportFileError("quote_error", recordIndex + (quoteError.row ?? 0) + 1);
          for (const cells of results.data) takeRecord(cells);
          options.onProgress?.({ done: results.meta.cursor, total: text.length, rows: records.length });
          parser.pause();
          schedule(() => {
            if (!settled) parser.resume();
          });
        } catch (error) {
          fail(error, parser);
        }
      },
      complete() {
        if (settled) return;
        if (headerCells === null) return fail(new ImportFileError("no_header"));
        if (records.length === 0) return fail(new ImportFileError("no_rows"));
        const width = Math.max(named, used);
        if (width > LIMITS.maxColumns) return fail(new ImportFileError("too_many_columns"));
        const rawHeaders = headerCells.slice(0, width);
        settled = true;
        resolve({
          headers: dedupeHeaders(rawHeaders.map((h) => cleanText(h))),
          rawHeaders,
          records,
          blankRows,
          rowCount: records.length,
          lastRowNo,
          delimiter,
        });
      },
    });
  });
}
