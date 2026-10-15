import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  COMMIT_CHUNK, LOCATION_KINDS, MOVED_POLICIES, STOCK_DB_WARNINGS, STOCK_FIX_CODES, STOCK_KEPT_REASONS, STOCK_LIMITS,
  STOCK_OUTCOMES, STOCK_PROBLEM_CODES, STOCK_REASONS,
} from "@/lib/stock-import";
import { COST_PATTERN, PRICE_PATTERN, WHOLE_PATTERN } from "@/lib/stock-import/schema";

// The browser rules and the stock import migration must agree (code lists, caps, patterns): a code the database does
// not know would make a whole chunk fail, and a missing label would show a raw code. Reads the migration as text, as
// parity.spec.ts does for the lead import.
const sql = readFileSync(join(__dirname, "../../supabase/migrations/20261018090000_stock_import.sql"), "utf8");

function listAfter(anchor: string): string[] {
  const start = sql.indexOf(anchor);
  expect(start, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const rest = sql.slice(start + anchor.length);
  const open = rest.search(/array\[|\(/);
  const close = rest.indexOf(rest[open] === "a" ? "]" : ")", open);
  return [...rest.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

test("problem, warning, reason and outcome codes match the working table's checks", () => {
  expect(listAfter("problems text[] not null default '{}' check (cardinality(problems) <= 16 and problems <@")).toEqual([...STOCK_PROBLEM_CODES]);
  expect(listAfter("fixes text[] not null default '{}' check (cardinality(fixes) <= 16 and fixes <@")).toEqual([...STOCK_FIX_CODES]);
  expect(listAfter("db_warnings text[] not null default '{}' check (cardinality(db_warnings) <= 4 and db_warnings <@")).toEqual([...STOCK_DB_WARNINGS]);
  expect(listAfter("reason text check (reason in")).toEqual([...STOCK_REASONS]);
  expect(listAfter("check (outcome in")).toEqual([...STOCK_OUTCOMES]);
  expect(listAfter("kept_reason text check (kept_reason in")).toEqual([...STOCK_KEPT_REASONS]);
  expect(listAfter("location_kind text check (location_kind in")).toEqual([...LOCATION_KINDS]);
  expect(listAfter("p_moved_policy not in")).toEqual([...MOVED_POLICIES]);
});

test("the add-rows pre-check accepts exactly the same codes and number forms", () => {
  expect(listAfter("where jsonb_typeof(p) <> 'string' or not (p #>> '{}') = any (")).toEqual([...STOCK_PROBLEM_CODES]);
  expect(listAfter("where jsonb_typeof(f) <> 'string' or not (f #>> '{}') = any (")).toEqual([...STOCK_FIX_CODES]);
  expect(sql).toContain(`r.quantity !~ '${WHOLE_PATTERN.source}'`);
  expect(sql).toContain(`r.pieces_per_carton !~ '${WHOLE_PATTERN.source}'`);
  expect(sql).toContain(`r.price_max !~ '${PRICE_PATTERN.source}'`);
  expect(sql).toContain(`r.total_cost !~ '${COST_PATTERN.source}'`);
  expect(sql).toContain("jsonb_array_length(p_rows) not between 1 and 1000");
});

test("caps equal the products table rules the database checks", () => {
  expect(sql).toContain(`char_length(name) not between 1 and ${STOCK_LIMITS.maxNameChars}`);
  expect(sql).toContain(`quantity not between 0 and ${STOCK_LIMITS.maxQuantity}`);
  expect(sql).toContain(`ppc not between 1 and ${STOCK_LIMITS.maxCarton}`);
  expect(sql).toContain(`pmin not between 0 and ${STOCK_LIMITS.maxPrice}`);
  expect(sql).toContain(`cost not between 0 and ${STOCK_LIMITS.maxCost}`);
  expect(sql).toContain(`row_no integer not null check (row_no between 2 and ${STOCK_LIMITS.maxRowNo})`);
  expect(sql).toContain(`n.row_count > ${STOCK_LIMITS.maxDataRows} or n.last_row_no <= n.row_count or n.last_row_no > ${STOCK_LIMITS.maxRowNo}`);
  expect(sql).toContain(`p_max_rows integer default ${COMMIT_CHUNK}`);
});
