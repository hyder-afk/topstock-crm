import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { nextWorkingDate, nextWorkingDay } from "@/lib/timezones";

// The browser's copy of private.next_working_day (Day 4 design 5.5: "working day" means 09:00 local on a later weekday
// in the lead's calling zone; a span uses its eastern end). The cases are read from the SQL test itself (between the
// "next-working-day:start/end" markers in supabase/tests/outcome_attack.sql), so both copies answer the same.
const sql = readFileSync(join(__dirname, "../../supabase/tests/outcome_attack.sql"), "utf8");
const block = sql.slice(sql.indexOf("-- next-working-day:start"), sql.indexOf("-- next-working-day:end"));
const cases = [...block.matchAll(/\('([^']+)', (\d+), '([^']+)', '([^']+)'\)/g)].map((m) => ({
  at: m[1].replace(" ", "T").replace(/\+00$/, "Z"),
  days: Number(m[2]),
  key: m[3],
  expected: m[4].replace(" ", "T").replace(/\+00$/, "Z"),
}));

test("the shared cases are found", () => {
  expect(cases.length).toBeGreaterThanOrEqual(15);
});

for (const c of cases) {
  test(`${c.at} + ${c.days} working day(s) in ${c.key} → ${c.expected}`, () => {
    expect(nextWorkingDay(new Date(c.at), c.days, c.key).toISOString()).toBe(new Date(c.expected).toISOString());
  });
}

test("bounds as in SQL: 1 to 10 working days", () => {
  expect(() => nextWorkingDay(new Date(), 0, "Europe/Paris")).toThrow();
  expect(() => nextWorkingDay(new Date(), 11, "Europe/Paris")).toThrow();
});

test("the default follow-up date for Interested is the lead's next working day", () => {
  // Friday 17:30 in Paris: Monday.
  expect(nextWorkingDate(new Date("2026-10-09T15:30:00Z"), "Europe/Paris")).toBe("2026-10-12");
  // Already Tuesday in Karachi: Wednesday.
  expect(nextWorkingDate(new Date("2026-10-12T23:30:00Z"), "Asia/Karachi")).toBe("2026-10-14");
});
