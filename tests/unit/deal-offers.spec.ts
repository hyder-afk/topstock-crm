import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { DEAL_FREE_DELETE_SECONDS, deleteOffered, freeDeleteUntil, reopenOffered } from "@/lib/deals";

// Day 7 follow-up: the deal's Reopen and Delete are left out where the database would refuse them (it still refuses
// them): Reopen on a won deal that stock records hold, Delete while they hold the deal, and the creator's no-code
// Delete after its 120 s. `held` undefined means the details are not loaded, so nothing is hidden on a guess.
const migration = (name: string) => readFileSync(join(__dirname, "../../supabase/migrations", name), "utf8");

test("Delete: stock records hold the deal -> never; not known -> as can_delete says", () => {
  expect(deleteOffered({ can_delete: true, held: true, until: null }, 0)).toBe(false);
  expect(deleteOffered({ can_delete: true, held: false, until: null }, 0)).toBe(true);
  expect(deleteOffered({ can_delete: true, until: null }, 0)).toBe(true);
  expect(deleteOffered({ can_delete: false, held: false, until: null }, 0)).toBe(false);
});

test("Delete: the creator's window closes at created_at + 120 s; an admin's never does", () => {
  const created = "2026-10-16T10:00:00.000Z";
  const t0 = Date.parse(created);
  const creator = freeDeleteUntil({ created_at: created }, false);
  expect(creator).toBe(t0 + 120_000);
  expect(deleteOffered({ can_delete: true, held: false, until: creator }, t0 + 119_999)).toBe(true);
  expect(deleteOffered({ can_delete: true, held: false, until: creator }, t0 + 120_000)).toBe(false);
  expect(deleteOffered({ can_delete: true, until: creator }, t0 + 3_600_000)).toBe(false);
  const admin = freeDeleteUntil({ created_at: created }, true);
  expect(admin).toBeNull();
  expect(deleteOffered({ can_delete: true, held: false, until: admin }, t0 + 3_600_000)).toBe(true);
});

test("Reopen: only a won deal is held back by stock records; a lost one always reopens; open deals have no Reopen", () => {
  expect(reopenOffered({ status: "won", can_edit: true, held: true })).toBe(false);
  expect(reopenOffered({ status: "won", can_edit: true, held: false })).toBe(true);
  expect(reopenOffered({ status: "won", can_edit: true })).toBe(true);
  expect(reopenOffered({ status: "lost", can_edit: true, held: true })).toBe(true);
  expect(reopenOffered({ status: "won", can_edit: false, held: false })).toBe(false);
  expect(reopenOffered({ status: "open", can_edit: true, held: false })).toBe(false);
});

test("the 120 s and the two get_deal keys are the database's", () => {
  expect(DEAL_FREE_DELETE_SECONDS).toBe(120);
  // deals_delete's creator branch (Day 5a) and the card's can_delete use the same 120 s.
  expect(migration("20261015090000_deals_pipeline.sql")).toContain("d.created_at > now() - interval '120 seconds'");
  const sheet = migration("20261022120000_deal_sheet_actions.sql");
  expect(sheet).toContain("'stock_held', coalesce(private.deal_held_by_stock(d.id), false)");
  expect(sheet).toContain("then d.created_at + interval '120 seconds' end");
  // Read-only: the migration defines no table, policy or trigger, and redefines only get_deal.
  const code = sheet.replace(/--[^\n]*/g, "");
  expect(code).not.toMatch(/\b(create|alter|drop)\s+(table|policy|trigger)\b/i);
  expect([...code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_.]+)/gi)].map((m) => m[1])).toEqual([
    "private.deal_held_by_stock",
    "public.get_deal",
  ]);
});
