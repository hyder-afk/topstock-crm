import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildProblemsCsv } from "../../src/lib/import/csv-out";
import { decodeBytes } from "../../src/lib/import/decode";
import { autoMap, type ColumnMapping } from "../../src/lib/import/headers";
import { normaliseRecords, type NormalisedRecord } from "../../src/lib/import/normalise";
import { parseCsvText, type ParsedRecord } from "../../src/lib/import/parse";
import { LIMITS, type Delimiter, type LeadStatus } from "../../src/lib/import/rules";
import { statusKey, suggestStatus } from "../../src/lib/import/values";

// The "rows not imported" file must re-import to exactly what its rows gave the first time: every row goes through
// buildProblemsCsv (formula guard, quoting) -> decodeBytes -> parseCsvText -> normaliseRecords and is compared with
// normalising the original row. Only the row number may differ.

const DIR = path.join(__dirname, "..", "fixtures", "import");
const TEAM = [
  { id: "0a6f5c2e-1d3b-4c8a-9e7f-2b4d6a8c0e11", first_name: "Haider", last_name: "Test" },
  { id: "1b7a6d3f-2e4c-4d9b-8f80-3c5e7b9d1f22", first_name: "Henri", last_name: "Test" },
  { id: "2c8b7e40-3f5d-4ea0-9091-4d6f8cae2033", first_name: "Kais", last_name: "Test" },
];
const NOW = new Date("2026-10-10T12:00:00Z");
const HEADER = ["Company name", "Company owner", "Phone Number", "Email", "Lead Status", "Last Activity Date", "City", "Country/Region"];
const BASE_ROW = ["Maison Verdane", "Haider Test", "+33 6 39 98 00 01", "contact@example.com", "Warm", "15/03/2025", "Lyon", "France"];

type Source = { rawHeaders: readonly string[]; records: readonly ParsedRecord[]; delimiter: Delimiter };

async function loadFixture(name: string): Promise<Source> {
  const decoded = decodeBytes(new Uint8Array(readFileSync(path.join(DIR, name))));
  return parseCsvText(decoded.text, { sepHint: decoded.sepHint });
}

function synthetic(rows: readonly string[][]): Source {
  return { rawHeaders: HEADER, records: rows.map((cells, i) => ({ row_no: i + 2, cells })), delimiter: "," };
}

// Everything except the row number, in a form that compares as text.
function comparable(row: NormalisedRecord): string {
  const payload: Record<string, unknown> = { ...row.payload };
  delete payload.row_no;
  return JSON.stringify({ rejected: row.rejected, payload, problems: row.problems, fixes: row.fixes, display: row.display });
}

/** Mismatches between normalising each original row and normalising it again after the problems file round trip. */
async function roundTrip(source: Source): Promise<string[]> {
  const mapping: ColumnMapping = autoMap(source.rawHeaders).targets;
  // A status word the rules do not know gets an explicit choice (as on the mapping screen), from the original cells
  // only: a cell that comes back spelled differently then stops the normaliser and fails the test.
  const statusColumn = mapping.indexOf("status");
  const statusChoices = new Map<string, LeadStatus>();
  for (const record of source.records) {
    const raw = record.cells[statusColumn] ?? "";
    if (statusKey(raw) && !suggestStatus(raw)) statusChoices.set(statusKey(raw), "warm");
  }
  const options = { team: TEAM, dateOrder: "dmy" as const, timeZone: "Europe/Paris", statusChoices, now: NOW };
  const want = new Map(normaliseRecords(source.records, { ...options, mapping }).map((row) => [row.row_no, row]));

  const csv = buildProblemsCsv({
    delimiter: source.delimiter,
    headers: source.rawHeaders,
    records: source.records,
    issues: source.records.map((record) => ({ row_no: record.row_no, messages: ["Problem"] })),
    labels: { row: "Row", problem: "Problem" },
  });
  const decoded = decodeBytes(new TextEncoder().encode(csv));
  const parsed = await parseCsvText(decoded.text, { sepHint: decoded.sepHint });
  const fixedMapping = autoMap(parsed.headers).targets;
  expect(fixedMapping).toEqual(["ignore", "ignore", ...mapping]);
  expect(parsed.records).toHaveLength(source.records.length);

  const mismatches: string[] = [];
  for (const row of normaliseRecords(parsed.records, { ...options, mapping: fixedMapping })) {
    const record = parsed.records.find((r) => r.row_no === row.row_no)!;
    const original = want.get(Number(record.cells[0]));
    if (!original) {
      mismatches.push(`row ${record.cells[0]} is not in the original file`);
    } else if (comparable(row) !== comparable(original)) {
      const cells = source.records.find((r) => r.row_no === original.row_no)!.cells;
      mismatches.push(`row ${original.row_no} ${JSON.stringify(cells)}: ${comparable(original)} became ${comparable(row)}`);
    }
  }
  return mismatches;
}

// Small deterministic random numbers (mulberry32), so a failure always reproduces.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRICKY_CELLS = [
  "\t",
  "\r",
  "\r\n",
  "\n",
  "   ",
  "\t=1",
  "\r '=",
  "\r\n'-",
  "'=already",
  "' text",
  "'",
  "''",
  "'\t",
  "''=1",
  "'  =1",
  "=",
  "-",
  "@x",
  " =1",
  "\uFF1D1+1",
  "'\uFF1D1",
  "\u00A0=1",
  "'\u00A0=1",
  "+33 6 39 98 00 01",
  "'+33 6 39 98 00 01",
  "=\"x\",\"y\"",
  "\"",
  "n/a",
  "'n/a",
  // At the cell limit: the apostrophe added by the problems file must not make it too long.
  `=${"x".repeat(LIMITS.maxCellChars - 1)}`,
];

test.describe("the problems file re-imports to the same rows", () => {
  test("every row of leads-500-fake.csv", async () => {
    expect(await roundTrip(await loadFixture("leads-500-fake.csv"))).toEqual([]);
  });

  test("every row of existing-20.csv", async () => {
    expect(await roundTrip(await loadFixture("existing-20.csv"))).toEqual([]);
  });

  test("tricky cells in every column, and as an extra cell", async () => {
    const rows: string[][] = [];
    for (const cell of TRICKY_CELLS) {
      for (let column = 0; column < HEADER.length; column++) {
        const row = [...BASE_ROW];
        row[column] = cell;
        rows.push(row);
      }
      rows.push([...BASE_ROW, cell]);
    }
    expect(await roundTrip(synthetic(rows))).toEqual([]);
  });

  test("a few thousand random short cells (fixed seed)", async () => {
    const alphabet = ["'", "=", "+", "-", "@", " ", "\t", "\r", "\n", "a", "\u00A0", "\uFF1D", "\"", ","];
    const next = random(20261010);
    const cell = () => Array.from({ length: Math.floor(next() * 7) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
    const rows: string[][] = [];
    for (let i = 0; i < 3000; i++) {
      const row = [...BASE_ROW];
      // Two random columns get a random cell; column 8 is an extra cell beyond the header.
      for (let k = 0; k < 2; k++) row[Math.floor(next() * (HEADER.length + 1))] = cell();
      rows.push(Array.from(row, (c) => c ?? ""));
    }
    expect(await roundTrip(synthetic(rows))).toEqual([]);
  });
});
