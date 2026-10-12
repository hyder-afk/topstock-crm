import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { dealPath, elapsedDays, stallState, stepStage, nextStage, reopenStage, type DealHistoryRow, type StageKey } from "@/lib/deals";

// Days in stage and Stalled (Day 5 design 5.5, D16). The SQL (private.deal_cards) is the source; these cases are shared
// with deals_attack.sql's "stall-cases" block, read from that file so both sides run the same lines:
// stage | hours in stage | hours since the lead's last activity (or null) | stalled | quiet days.
const attack = readFileSync(join(__dirname, "../../supabase/tests/deals_attack.sql"), "utf8");
const block = attack.slice(attack.indexOf("-- stall-cases:start"), attack.indexOf("-- stall-cases:end"));
const lines = block.slice(block.indexOf("$cases$") + 7, block.lastIndexOf("$cases$")).trim().split("\n");

// A fixed, unambiguous instant (UTC, with its offset), so the cases never depend on the machine's zone or ICU data.
const NOW = Date.parse("2026-10-20T10:00:00.000Z");
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

test("the shared stall cases match the SQL's (deals_attack.sql stall-cases)", () => {
  expect(lines.length).toBeGreaterThanOrEqual(16);
  for (const line of lines) {
    const [stage, inStage, quietHours, stalled, quiet] = line.split("|");
    const got = stallState(stage as StageKey, ago(Number(inStage)), quietHours === "null" ? null : ago(Number(quietHours)), NOW);
    expect({ stalled: got.stalled, quiet: got.quiet }, line).toEqual({
      stalled: stalled === "true",
      quiet: quiet === "null" ? null : Number(quiet),
    });
  }
});

test("7 x 24 h minus 1 ms is not stalled; one ms past 7 x 24 h is (Lead)", () => {
  const limit = 7 * 24 * HOUR;
  expect(stallState("lead", new Date(NOW - limit + 1).toISOString(), null, NOW).stalled).toBe(false);
  expect(stallState("lead", new Date(NOW - limit).toISOString(), null, NOW).stalled).toBe(false);
  expect(stallState("lead", new Date(NOW - limit - 1).toISOString(), null, NOW).stalled).toBe(true);
});

test("the 25 Oct 2026 EU clock change: elapsed days, not calendar days", () => {
  // Entered Lead on Mon 19 Oct 12:00 Paris (10:00 UTC); Paris went back an hour on Sun 25 Oct.
  const entered = "2026-10-19T10:00:00.000Z";
  const at = (iso: string) => Date.parse(iso);
  expect(elapsedDays(entered, at("2026-10-26T09:59:59.999Z"))).toBe(6); // 11:59 Paris on Mon 26: not yet 7 x 24 h
  expect(elapsedDays(entered, at("2026-10-26T10:00:00.000Z"))).toBe(7); // 11:00 Paris: exactly 168 h later
  expect(stallState("lead", entered, null, at("2026-10-26T10:00:00.001Z")).stalled).toBe(true);
  expect(stallState("lead", entered, null, at("2026-10-26T09:59:59.000Z")).stalled).toBe(false);
});

test("the 1 Nov 2026 US clock change: the same 24 h days", () => {
  const entered = "2026-10-26T16:00:00.000Z"; // 12:00 in New York (EDT)
  expect(elapsedDays(entered, Date.parse("2026-11-09T16:00:00.000Z"))).toBe(14); // 11:00 EST, 336 h later
  expect(stallState("qualified", entered, null, Date.parse("2026-11-09T16:00:00.000Z")).stalled).toBe(false);
  expect(stallState("qualified", entered, null, Date.parse("2026-11-09T16:00:01.000Z")).stalled).toBe(true);
});

test("a deal opened today on a lead untouched for a month is not stalled; a call yesterday clears a 30-day deal", () => {
  expect(stallState("lead", ago(1), ago(30 * 24), NOW)).toEqual({ stalled: false, quiet: 0 });
  expect(stallState("qualified", ago(30 * 24), ago(24), NOW)).toEqual({ stalled: false, quiet: 1 });
});

test("an undo restoring a 10-day clock shows 10 days and stalled in Lead", () => {
  expect(elapsedDays(ago(10 * 24), NOW)).toBe(10);
  expect(stallState("lead", ago(10 * 24), null, NOW)).toEqual({ stalled: true, quiet: 10 });
});

test("closed deals are never stalled; days never go below 0 (a clock running behind)", () => {
  expect(stallState("won", ago(1000), null, NOW)).toEqual({ stalled: false, quiet: null });
  expect(stallState("lost", ago(1000), null, NOW)).toEqual({ stalled: false, quiet: null });
  expect(elapsedDays(new Date(NOW + 5 * HOUR).toISOString(), NOW)).toBe(0);
});

test("steps, the next-step chip and the reopen stage", () => {
  expect(stepStage("lead", 1)).toBe("qualified");
  expect(stepStage("negotiations", 1)).toBe("won");
  expect(stepStage("lead", -1)).toBeNull();
  expect(stepStage("won", 1)).toBeNull();
  expect(stepStage("lost", -1)).toBeNull();
  expect(nextStage("negotiations")).toBe("won");
  expect(nextStage("won")).toBeNull();
  const row = (id: number, kind: DealHistoryRow["kind"], from: StageKey | null, to: StageKey): DealHistoryRow => ({
    id, kind, from_stage: from, to_stage: to, actor_id: null, actor_first_name: null, created_at: ago(100 - id), undoes: null, undone: false, value: null, lost_reason: null,
  });
  expect(reopenStage([row(3, "lost", "qualified", "lost"), row(2, "move", "lead", "qualified")])).toBe("qualified");
  expect(reopenStage([])).toBe("negotiations");
});

test("the deal's path folds undo pairs and counts days per stage", () => {
  const h: DealHistoryRow[] = [
    { id: 1, kind: "open", from_stage: null, to_stage: "lead", actor_id: null, actor_first_name: null, created_at: ago(20 * 24), undoes: null, undone: false, value: null, lost_reason: null },
    { id: 2, kind: "move", from_stage: "lead", to_stage: "qualified", actor_id: null, actor_first_name: null, created_at: ago(17 * 24), undoes: null, undone: false, value: null, lost_reason: null },
    { id: 3, kind: "move", from_stage: "qualified", to_stage: "negotiations", actor_id: null, actor_first_name: null, created_at: ago(12 * 24), undoes: null, undone: true, value: null, lost_reason: null },
    { id: 4, kind: "undo", from_stage: "negotiations", to_stage: "qualified", actor_id: null, actor_first_name: null, created_at: ago(12 * 24 - 1), undoes: 3, undone: false, value: null, lost_reason: null },
    { id: 5, kind: "move", from_stage: "qualified", to_stage: "negotiations", actor_id: null, actor_first_name: null, created_at: ago(12 * 24), undoes: null, undone: false, value: null, lost_reason: null },
  ];
  expect(dealPath(h, NOW)).toEqual([
    { stage: "lead", days: 3, current: false },
    { stage: "qualified", days: 5, current: false },
    { stage: "negotiations", days: 12, current: true },
  ]);
});
