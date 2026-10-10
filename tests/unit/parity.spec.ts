import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FIX_CODES, OUTCOMES, PROBLEM_CODES, REASON_CODES, STEP_UP_SECONDS, leadStatuses } from "@/lib/import";

// The browser rules and the database must use the same code lists and the same step-up window: a code the database
// does not know would make a whole chunk fail, and a missing label would show a raw code. Reads the migration text.
const sql = readFileSync(join(__dirname, "../../supabase/migrations/20261010150000_lead_import.sql"), "utf8");

// The quoted words of the first SQL "array[...]" or "in (...)" list that follows `anchor`.
function listAfter(anchor: string): string[] {
  const start = sql.indexOf(anchor);
  expect(start, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const rest = sql.slice(start + anchor.length);
  const open = rest.search(/array\[|\(/);
  const close = rest.indexOf(rest[open] === "a" ? "]" : ")", open);
  return [...rest.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

test("problem codes match the working table's check", () => {
  expect(listAfter("problems text[] not null default '{}' check (cardinality(problems) <= 16 and problems <@")).toEqual([...PROBLEM_CODES]);
});

test("fix codes match the working table's check", () => {
  expect(listAfter("fixes text[] not null default '{}' check (cardinality(fixes) <= 16 and fixes <@")).toEqual([...FIX_CODES]);
});

test("reason and outcome codes match the working table's checks", () => {
  expect(listAfter("reason text check (reason in")).toEqual([...REASON_CODES]);
  expect(listAfter("check (outcome in")).toEqual([...OUTCOMES]);
});

test("the add-rows pre-check accepts exactly the same codes", () => {
  expect(listAfter("where jsonb_typeof(p) <> 'string' or not (p #>> '{}') = any (")).toEqual([...PROBLEM_CODES]);
  expect(listAfter("where jsonb_typeof(f) <> 'string' or not (f #>> '{}') = any (")).toEqual([...FIX_CODES]);
});

test("lead statuses match the database rule check", () => {
  expect(listAfter("or lead_status not in")).toEqual([...leadStatuses]);
});

test("the step-up window is the same 10 minutes everywhere", () => {
  expect(STEP_UP_SECONDS).toBe(600);
  expect(sql).toContain("has_recent_aal2(600)");
  expect(sql).not.toMatch(/has_recent_aal2\((?!600\))/);
  const auth = readFileSync(join(__dirname, "../../src/lib/auth.ts"), "utf8");
  expect(auth).toContain(`STEP_UP_SECONDS = ${STEP_UP_SECONDS}`);
});
