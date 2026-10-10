import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { chunkRows } from "../../src/lib/import/chunk";
import { checkFileMeta, decodeBytes } from "../../src/lib/import/decode";
import { assignTarget, autoMap, columnFor, type ColumnMapping } from "../../src/lib/import/headers";
import { normaliseRecords, type NormalisedRecord } from "../../src/lib/import/normalise";
import { parseCsvText, type ParsedCsv } from "../../src/lib/import/parse";
import { FIELD_PROBLEM_FIX, ImportFileError, ROW_PROBLEMS, type BadFieldPolicy, type FieldProblem, type LeadStatus } from "../../src/lib/import/rules";
import { importChunkSchema, importRowSchema, type StagedRow } from "../../src/lib/import/schema";
import {
  countryKey,
  detectDateOrder,
  distinctValues,
  matchCountry,
  matchOwner,
  ownerKey,
  suggestStatus,
} from "../../src/lib/import/values";
import { dedupe, emailKey, nameKey, phoneKey, type DedupeResult, type ExistingLead } from "./helpers/dedupe-ref";

const ROOT = path.join(__dirname, "..", "..");
const DIR = path.join(ROOT, "tests", "fixtures", "import");
const GENERATOR = path.join(ROOT, "scripts", "make-fake-leads.mjs");

type ExpectedRow = {
  row_no: number;
  expect: "ready" | "duplicate_file" | "duplicate_existing" | "rejected";
  problems?: string[];
  fixes?: string[];
  match_key?: "email" | "phone" | "name";
  match_row_no?: number;
  match_existing_row_no?: number;
  tags?: string[];
};
type Expected = {
  header: string[];
  row_count: number;
  last_row_no: number;
  blank_row_nos: number[];
  totals: Record<string, unknown> & { ready: number; duplicate_file: number; duplicate_existing: number; rejected: number };
  blank_field_totals: { ready: number; duplicate_file: number; duplicate_existing: number; rejected: number };
  rows: ExpectedRow[];
};
const expected = JSON.parse(readFileSync(path.join(DIR, "expected.json"), "utf8")) as Expected;

// The e2e users, with fixed ids.
const TEAM = [
  { id: "0a6f5c2e-1d3b-4c8a-9e7f-2b4d6a8c0e11", first_name: "Haider", last_name: "Test" },
  { id: "1b7a6d3f-2e4c-4d9b-8f80-3c5e7b9d1f22", first_name: "Henri", last_name: "Test" },
  { id: "2c8b7e40-3f5d-4ea0-9091-4d6f8cae2033", first_name: "Kais", last_name: "Test" },
];
// The two explicit choices the e2e test makes on the mapping screen.
const STATUS_CHOICES = new Map<string, LeadStatus>([
  ["hot lead", "warm"],
  ["prospect", "cold"],
]);
const NOW = new Date("2026-10-10T12:00:00Z");

async function load(name: string) {
  const bytes = new Uint8Array(readFileSync(path.join(DIR, name)));
  const decoded = decodeBytes(bytes);
  const parsed = await parseCsvText(decoded.text, { sepHint: decoded.sepHint });
  return { decoded, parsed };
}

function normalise(parsed: ParsedCsv, policy: BadFieldPolicy = "reject_row", mapping: ColumnMapping = autoMap(parsed.headers).targets) {
  return normaliseRecords(parsed.records, {
    mapping,
    team: TEAM,
    dateOrder: "dmy",
    timeZone: "Europe/Paris",
    statusChoices: STATUS_CHOICES,
    badFieldPolicy: policy,
    now: NOW,
  });
}

function existingLeads(rows: readonly NormalisedRecord[]): ExistingLead[] {
  return rows.map((r) => {
    const p = r.payload as StagedRow;
    return { ref: r.row_no, email: p.email, phone: p.phone, name: p.name, city: p.city, country: p.country };
  });
}

function count(results: readonly DedupeResult[]) {
  const totals = { ready: 0, duplicate_file: 0, duplicate_existing: 0, rejected: 0 };
  for (const r of results) totals[r.outcome]++;
  return totals;
}

test.describe("the 500-row fake sample", () => {
  test("decodes and parses: BOM, comma, 500 rows, 3 blank rows, last row 504", async () => {
    const { decoded, parsed } = await load("leads-500-fake.csv");
    expect(decoded.encoding).toBe("utf-8");
    expect(decoded.sepHint).toBeNull();
    expect(decoded.text.charCodeAt(0)).not.toBe(0xfeff);
    expect(parsed.delimiter).toBe(",");
    expect(parsed.headers).toEqual(expected.header);
    expect(parsed.rowCount).toBe(500);
    expect(parsed.blankRows).toBe(3);
    expect(parsed.lastRowNo).toBe(504);
    expect(expected.last_row_no).toBe(504);
    expect(parsed.records.map((r) => r.row_no)).toEqual(expected.rows.map((r) => r.row_no));
    const all = new Set([...parsed.records.map((r) => r.row_no), ...expected.blank_row_nos]);
    expect(all.size).toBe(503);
  });

  test("every field is auto-matched; DD/MM detected; only the planned values need a choice", async () => {
    const { parsed } = await load("leads-500-fake.csv");
    const { targets, matched } = autoMap(parsed.headers);
    expect(targets).toEqual(["name", "owner", "phone", "email", "status", "last_activity", "city", "country"]);
    expect(matched.every(Boolean)).toBe(true);

    const guess = detectDateOrder(parsed.records.map((r) => r.cells[5]));
    expect(guess.order).toBe("dmy");
    // 10 ambiguous dates in importable rows, plus the too-old 01/01/1970.
    expect(guess.ambiguous).toBe(11);

    const statuses = distinctValues(parsed.records, columnFor(targets, "status"));
    expect(statuses.filter((s) => suggestStatus(s.label) === null).map((s) => [s.label, s.count])).toEqual([
      ["Hot lead", 3],
      ["Prospect", 2],
    ]);
    const owners = distinctValues(parsed.records, columnFor(targets, "owner"), ownerKey);
    expect(owners.filter((o) => matchOwner(o.label, TEAM) === null).map((o) => [o.label, o.count])).toEqual([["Former Rep", 6]]);
    const countries = distinctValues(parsed.records, columnFor(targets, "country"), countryKey);
    expect(countries.filter((c) => matchCountry(c.label) === null).map((c) => [c.label, c.count])).toEqual([["Atlantis", 2]]);
  });

  test("every row normalises to its expected problems and fixes", async () => {
    const { parsed } = await load("leads-500-fake.csv");
    const rows = normalise(parsed);
    expect(rows).toHaveLength(expected.rows.length);
    rows.forEach((row, i) => {
      const want = expected.rows[i];
      expect(row.row_no).toBe(want.row_no);
      if (want.expect === "rejected") {
        expect(row.rejected, `row ${row.row_no}`).toBe(true);
        expect(row.problems, `row ${row.row_no}`).toEqual(want.problems);
        expect(Object.keys(row.payload), `row ${row.row_no} sends no values`).toEqual(["row_no", "problems"]);
      } else {
        expect(row.rejected, `row ${row.row_no} ${JSON.stringify(row.problems)}`).toBe(false);
        expect(row.fixes, `row ${row.row_no}`).toEqual(want.fixes ?? []);
      }
    });
  });

  test("every row passes the Zod row and chunk schemas", async () => {
    const { parsed } = await load("leads-500-fake.csv");
    for (const policy of ["reject_row", "blank_field"] as const) {
      const payloads = normalise(parsed, policy).map((r) => r.payload);
      for (const p of payloads) expect(importRowSchema.safeParse(p).success, JSON.stringify(p).slice(0, 120)).toBe(true);
      expect(importChunkSchema.safeParse(payloads.slice(0, 500)).success).toBe(true);
      const chunks = chunkRows(payloads, { maxRows: 120 });
      expect(chunks.flat()).toHaveLength(500);
      for (const chunk of chunks) expect(importChunkSchema.safeParse(chunk).success).toBe(true);
    }
  });

  test("the duplicate labels agree with the SQL key rules (against existing-20.csv)", async () => {
    const existing = normalise((await load("existing-20.csv")).parsed);
    const { parsed } = await load("leads-500-fake.csv");
    const results = dedupe(normalise(parsed), existingLeads(existing));
    results.forEach((r, i) => {
      const want = expected.rows[i];
      const label = `row ${r.row_no}`;
      expect(r.outcome, label).toBe(want.expect);
      if (r.outcome === "duplicate_file") {
        expect([r.match_key, r.match_row_no], label).toEqual([want.match_key, want.match_row_no]);
      } else if (r.outcome === "duplicate_existing") {
        expect([r.match_key, r.match_ref], label).toEqual([want.match_key, want.match_existing_row_no]);
      }
    });
    expect(count(results)).toEqual({ ready: 400, duplicate_file: 30, duplicate_existing: 20, rejected: 50 });
    expect(count(results)).toEqual({
      ready: expected.totals.ready,
      duplicate_file: expected.totals.duplicate_file,
      duplicate_existing: expected.totals.duplicate_existing,
      rejected: expected.totals.rejected,
    });
  });

  test("blank_field mode: added 434, can't import 16; bad fields become fixes", async () => {
    const existing = normalise((await load("existing-20.csv")).parsed);
    const { parsed } = await load("leads-500-fake.csv");
    const rows = normalise(parsed, "blank_field");
    expect(count(dedupe(rows, existingLeads(existing)))).toEqual({
      ready: 434,
      duplicate_file: 30,
      duplicate_existing: 20,
      rejected: 16,
    });
    expect(expected.blank_field_totals).toEqual({ ready: 434, duplicate_file: 30, duplicate_existing: 20, rejected: 16 });
    const rowProblems = new Set<string>(ROW_PROBLEMS);
    rows.forEach((row, i) => {
      const want = expected.rows[i];
      if (want.expect !== "rejected") return;
      if (want.problems!.some((p) => rowProblems.has(p))) {
        expect(row.rejected, `row ${row.row_no}`).toBe(true);
      } else {
        expect(row.rejected, `row ${row.row_no}`).toBe(false);
        expect(row.fixes).toEqual(want.problems!.map((p) => FIELD_PROBLEM_FIX[p as FieldProblem]));
      }
    });
  });

  test("hostile and tricky names arrive as plain text", async () => {
    const { parsed } = await load("leads-500-fake.csv");
    const rows = normalise(parsed);
    const names = rows.filter((r) => !r.rejected).map((r) => (r.payload as StagedRow).name);
    expect(names).toContain("'); drop table companies; --");
    expect(names).toContain("),id.eq.");
    expect(names).toContain("<img src=x onerror=alert(1)>");
    expect(names).toContain("<script>alert(\"x\")</script>");
    expect(names).toContain("=1+1 Négoce");
    expect(names).toContain("@Home Déco");
    expect(names).toContain("Dupont, Fils & Cie");
    expect(names).toContain("Le \"Petit\" Marché Gourmand");
    expect(names.some((n) => /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(n))).toBe(false);
    const byTag = (tag: string) => expected.rows.filter((r) => r.tags?.includes(tag)).map((r) => rows.find((x) => x.row_no === r.row_no)!);
    expect((byTag("newline_city")[0].payload as StagedRow).city).toBe("Saint-Denis La Plaine");
    expect([...(byTag("name_200_chars")[0].payload as StagedRow).name].length).toBe(200);
    expect(byTag("dst_gap").map((r) => (r.payload as StagedRow).last_activity).sort()).toEqual(["2025-03-30T02:30:00", "2026-03-29T02:15:00"]);
    expect(byTag("iso_offset").map((r) => (r.payload as StagedRow).last_activity).sort()).toEqual(["2024-11-20T09:05:00", "2025-03-15T14:32:00"]);
    expect((byTag("apostrophe_phone")[0].payload as StagedRow).phone?.startsWith("+33 6 39 98")).toBe(true);
  });
});

test.describe("the other fixtures", () => {
  test("existing-20.csv: 20 clean leads, none repeated", async () => {
    const { parsed } = await load("existing-20.csv");
    expect(parsed.headers).toEqual(expected.header);
    const rows = normalise(parsed);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => !r.rejected && r.fixes.length === 0)).toBe(true);
    expect(count(dedupe(rows, []))).toEqual({ ready: 20, duplicate_file: 0, duplicate_existing: 0, rejected: 0 });
  });

  test("leads-fr-20-cp1252.csv: Windows-1252, ;, French headers, owner column mapped by hand, 20 new leads", async () => {
    const { decoded, parsed } = await load("leads-fr-20-cp1252.csv");
    expect(decoded.encoding).toBe("windows-1252");
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["Ville", "Nom de la société", "Téléphone", "Chargé de compte", "E-mail", "Statut", "Pays", "Notes", "Dernière activité"]);
    const auto = autoMap(parsed.headers);
    expect(auto.targets).toEqual(["city", "name", "phone", "ignore", "email", "status", "country", "ignore", "last_activity"]);
    expect(auto.matched[3]).toBe(false);
    const mapping = assignTarget(auto.targets, 3, "owner");
    const rows = normalise(parsed, "reject_row", mapping);
    expect(rows).toHaveLength(20);
    expect(rows.filter((r) => r.rejected || r.fixes.length)).toEqual([]);
    const staged = rows.map((r) => r.payload as StagedRow);
    expect(staged.map((r) => r.name)).toContain("Pâtisserie Hélène & Fils");
    expect(staged.map((r) => r.name)).toContain("Bazar à 1 €");
    expect(staged.map((r) => r.name)).toContain("Poissonnerie Île d’Yeu");
    expect(staged.every((r) => r.owner_id !== null && r.country !== null)).toBe(true);
    expect(new Set(staged.map((r) => r.lead_status)).size).toBe(7);
    // None of them is already in the CRM after the other fixtures were imported.
    const sample = normalise((await load("leads-500-fake.csv")).parsed).filter((r) => !r.rejected);
    const existing = normalise((await load("existing-20.csv")).parsed);
    expect(count(dedupe(rows, existingLeads([...existing, ...sample])))).toEqual({ ready: 20, duplicate_file: 0, duplicate_existing: 0, rejected: 0 });
  });

  test("not-a-csv.xlsx and empty.csv are refused with their messages", () => {
    const error = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as ImportFileError).code;
      }
      return null;
    };
    expect(error(() => decodeBytes(new Uint8Array(readFileSync(path.join(DIR, "not-a-csv.xlsx")))))).toBe("excel_file");
    expect(error(() => checkFileMeta({ name: "not-a-csv.xlsx", size: 64 }))).toBe("excel_file");
    expect(error(() => decodeBytes(new Uint8Array(readFileSync(path.join(DIR, "empty.csv")))))).toBe("empty");
  });

  test("the committed fixtures are exactly what the generator writes", () => {
    const output = execFileSync(process.execPath, [GENERATOR, "--check"], { encoding: "utf8" });
    expect(output).toContain("fixtures match the generator");
  });

  test("perf files: deterministic, fully importable, no key shared with the fixtures", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-leads-"));
    try {
      execFileSync(process.execPath, [GENERATOR, "--rows", "600", "--out", dir]);
      const first = readFileSync(path.join(dir, "leads-600-perf.csv"));
      execFileSync(process.execPath, [GENERATOR, "--rows", "600", "--out", dir]);
      expect(readFileSync(path.join(dir, "leads-600-perf.csv")).equals(first)).toBe(true);
      const decoded = decodeBytes(new Uint8Array(first));
      const parsed = await parseCsvText(decoded.text);
      const rows = normalise(parsed);
      expect(rows.filter((r) => r.rejected || r.fixes.length)).toEqual([]);
      const sample = normalise((await load("leads-500-fake.csv")).parsed).filter((r) => !r.rejected);
      const existing = normalise((await load("existing-20.csv")).parsed);
      expect(count(dedupe(rows, existingLeads([...existing, ...sample])))).toEqual({ ready: 600, duplicate_file: 0, duplicate_existing: 0, rejected: 0 });
      expect(() => execFileSync(process.execPath, [GENERATOR, "--rows", "5", "--out", DIR], { stdio: "pipe" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe("the TypeScript copy of the SQL keys (design 6A key tables)", () => {
  test("email, phone and name keys", () => {
    expect(emailKey("  Contact@Example.COM ")).toBe("contact@example.com");
    expect(emailKey("")).toBeNull();
    for (const p of ["+33 (0)6 12 34 56 78", "06.12.34.56.78", "0033 6 12 34 56 78"]) expect(phoneKey(p)).toBe("612345678");
    expect(phoneKey("+44 20 7946 0123")).toBe(phoneKey("020 7946 0123"));
    expect(phoneKey("1234567")).toBeNull();
    expect(phoneKey("+33 6 12 34 56 78 / +33 1 99 00 00 01")).toBeNull();
    expect(nameKey("Łódź Trading", "Łódź", "PL")).toBe("lodztrading|lodz|PL");
    expect(nameKey("Négoce Morvan S.A.R.L.", "Saint-Étienne", "FR")).toBe(nameKey("NEGOCE MORVAN", "saint etienne", "FR"));
    expect(nameKey("SARL", "Lyon", "FR")).toBe("sarl|lyon|FR");
    expect(nameKey("!!!", "Lyon", "FR")).toBeNull();
    expect(nameKey("Maison Verdane", null, "FR")).toBeNull();
    expect(nameKey("東京貿易", "Paris", null)).toBe("東京貿易|paris|");
  });
});
