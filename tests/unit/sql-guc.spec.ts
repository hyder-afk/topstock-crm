import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// No custom setting is read with a bare cast (Day 5 design, builder change 1 and threat 29). On a pooled connection a
// setting another request set with set_config(..., false) can read back as '' instead of missing, and ''::uuid or
// ''::boolean fails or, worse, a stale value is trusted. Day 5 reads none; any future read must be the safe form
// nullif(current_setting('name', true), '') so a missing or empty setting is null.
const dir = join(__dirname, "../../supabase/migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));

const SAFE = /nullif\(\s*current_setting\(\s*'[a-z0-9_.]+'\s*,\s*true\s*\)\s*,\s*''\s*\)/gi;

test("there are migrations to check", () => {
  expect(files.length).toBeGreaterThan(5);
  expect(files).toContain("20261015090000_deals_pipeline.sql");
});

for (const file of files) {
  test(`${file}: every current_setting( is nullif(current_setting('x', true), '')`, () => {
    // Comments are text, not code: drop "-- ..." to the end of the line first.
    const code = readFileSync(join(dir, file), "utf8").replace(/--[^\n]*/g, "");
    const all = code.match(/current_setting\s*\(/gi) ?? [];
    const safe = code.match(SAFE) ?? [];
    expect(all.length, `bare current_setting( in ${file}`).toBe(safe.length);
  });
}

test("the check itself: a bare read is caught, the safe form passes", () => {
  const count = (code: string) => [(code.match(/current_setting\s*\(/gi) ?? []).length, (code.match(SAFE) ?? []).length];
  expect(count("select current_setting('app.undo')::uuid")).toEqual([1, 0]);
  expect(count("select current_setting('app.undo', true)::uuid")).toEqual([1, 0]);
  expect(count("select nullif(current_setting('app.undo', true), '')::uuid")).toEqual([1, 1]);
});
