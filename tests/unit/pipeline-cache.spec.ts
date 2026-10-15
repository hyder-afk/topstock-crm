import { expect, test } from "@playwright/test";
import type { Board, DealCard } from "@/lib/deals";
import { addCard, appendPage, applyMove, findCard, removeCard, replaceCard, restoreFromLost, sortLoaded } from "@/lib/pipeline-cache";

// The board in the query cache (Day 5 design 7.5 and 8.4): the optimistic move, its rollback, a conflict's reconcile and
// two queued moves, each keeping counts, totals and cursors right.
const T0 = "2026-10-01T09:00:00.000Z";
const NOW = "2026-10-12T09:00:00.000Z";
let n = 0;
function card(stage: DealCard["stage"], value: string | null, extra: Partial<DealCard> = {}): DealCard {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    stage, title: `Deal ${n}`, company_id: "c", company_name: `Lead ${n}`, city: null, country: "FR", lead_status: "warm",
    contact_id: null, contact_name: null, value, currency: "EUR",
    status: stage === "won" ? "won" : stage === "lost" ? "lost" : "open",
    stage_entered_at: T0, closed_at: stage === "won" ? T0 : null, expected_close: null, fulfilment: null, owner_id: "o",
    owner_first_name: "Ada", owner_last_name: "L", version: 3, last_activity_at: null, is_stalled: false, quiet_days: 11,
    lost_reason: null, created_at: T0, can_edit: true, ...extra,
  };
}
function board(): Board {
  const lead = [card("lead", "1000.00"), card("lead", null, { is_stalled: true })];
  const qualified = [card("qualified", "250.50")];
  const won = [card("won", "900.00")];
  return {
    scope: "team", owner_id: null,
    stages: [
      { key: "lead", stall_days: 7, count: 5, value: "3000.00", no_value: 2, stalled: 1, cards: lead, next: { after_at: T0, after_id: lead[1].id } },
      { key: "qualified", stall_days: 14, count: 1, value: "250.50", no_value: 0, stalled: 0, cards: qualified, next: null },
      { key: "negotiations", stall_days: 21, count: 0, value: "0.00", no_value: 0, stalled: 0, cards: [], next: null },
    ],
    won: { count: 1, value: "900.00", cards: won, next: null },
    lost: { count: 2, reasons: [{ code: "price", count: 1 }, { code: "timing", count: 1 }] },
    open_total: { count: 6, value: "3250.50" },
  };
}
const col = (b: Board, key: string) => b.stages.find((s) => s.key === key)!;

test("applyMove: the card leaves Lead and leads Qualified, 0 days and not stalled; both columns and the total fixed", () => {
  const b = board();
  const id = b.stages[0].cards[1].id; // no value, stalled
  const m = applyMove(b, id, "qualified", NOW);
  expect(col(m, "lead")).toMatchObject({ count: 4, value: "3000.00", no_value: 1, stalled: 0 });
  expect(col(m, "lead").cards.map((c) => c.id)).not.toContain(id);
  expect(col(m, "qualified")).toMatchObject({ count: 2, no_value: 1, value: "250.50" });
  expect(col(m, "qualified").cards[0]).toMatchObject({ id, stage: "qualified", stage_entered_at: NOW, is_stalled: false, quiet_days: 0, status: "open" });
  expect(m.open_total).toEqual({ count: 6, value: "3250.50" });
  expect(col(m, "lead").next).toEqual(b.stages[0].next); // cursors kept
});

test("applyMove: Longest in stage puts the moved card last", () => {
  const b = board();
  const id = b.stages[0].cards[0].id;
  expect(col(applyMove(b, id, "qualified", NOW, {}, "oldest"), "qualified").cards.at(-1)!.id).toBe(id);
});

test("applyMove to Won and to Lost: Won counts its value; Lost leaves the board and ticks its reason", () => {
  const b = board();
  const id = b.stages[1].cards[0].id;
  const won = applyMove(b, id, "won", NOW, { value: "18400.00", fulfilment: "direct_from_source" });
  expect(won.won).toMatchObject({ count: 2, value: "19300.00" });
  expect(won.won.cards[0]).toMatchObject({ id, status: "won", closed_at: NOW, value: "18400.00", fulfilment: "direct_from_source", quiet_days: null });
  expect(won.open_total).toEqual({ count: 5, value: "3000.00" });
  const lost = applyMove(b, id, "lost", NOW, { lost_reason: "price" });
  expect(findCard(lost, id)).toBeNull();
  expect(lost.lost).toEqual({ count: 3, reasons: [{ code: "price", count: 2 }, { code: "timing", count: 1 }] });
  expect(col(lost, "qualified")).toMatchObject({ count: 0, value: "0.00" });
});

test("rollback restores the snapshot byte for byte (the same object)", () => {
  const b = board();
  const before = JSON.stringify(b);
  const snapshot = b;
  const moved = applyMove(applyMove(b, b.stages[0].cards[0].id, "qualified", NOW), b.stages[1].cards[0].id, "negotiations", NOW);
  expect(moved).not.toBe(snapshot);
  expect(JSON.stringify(snapshot)).toBe(before); // nothing was mutated in place
});

test("a conflict reconciles to the server's card where it really is", () => {
  const b = board();
  const id = b.stages[0].cards[0].id;
  const optimistic = applyMove(b, id, "qualified", NOW);
  const server = { ...b.stages[0].cards[0], stage: "negotiations" as const, version: 5, stage_entered_at: "2026-10-12T08:59:00.000Z", quiet_days: 0 };
  const r = replaceCard(optimistic, server, id);
  expect(findCard(r, id)).toMatchObject({ column: "negotiations" });
  expect(col(r, "qualified").count).toBe(1);
  expect(col(r, "negotiations")).toMatchObject({ count: 1, value: "1000.00" });
  // A card the board does not show any more (null) leaves it.
  expect(findCard(replaceCard(b, null, id), id)).toBeNull();
});

test("the server's answer for the same place swaps the object and keeps its position", () => {
  const b = board();
  const second = b.stages[0].cards[1];
  const r = replaceCard(b, { ...second, title: "Renamed" }, second.id);
  expect(col(r, "lead").cards[1].title).toBe("Renamed");
  expect(col(r, "lead").count).toBe(5);
});

test("two queued moves on one card add up (Lead -> Qualified -> Negotiations)", () => {
  const b = board();
  const id = b.stages[0].cards[0].id;
  const m = applyMove(applyMove(b, id, "qualified", NOW), id, "negotiations", NOW);
  expect(col(m, "lead").count).toBe(4);
  expect(col(m, "qualified").count).toBe(1);
  expect(col(m, "negotiations")).toMatchObject({ count: 1, value: "1000.00" });
  expect(m.open_total).toEqual(b.open_total);
});

test("an undone loss comes back from the Lost line", () => {
  const b = board();
  const back = card("qualified", "40.00", { lost_reason: "price" });
  const r = restoreFromLost(b, back, "price");
  expect(r.lost).toEqual({ count: 1, reasons: [{ code: "timing", count: 1 }] });
  expect(col(r, "qualified").count).toBe(2);
});

test("pages append without repeats; removing and adding stay symmetric", () => {
  const b = board();
  const extra = card("lead", "5.00");
  const p = appendPage(b, "lead", [b.stages[0].cards[0], extra], null);
  expect(col(p, "lead").cards).toHaveLength(3);
  expect(col(p, "lead").next).toBeNull();
  const id = b.stages[1].cards[0].id;
  expect(addCard(removeCard(b, id), b.stages[1].cards[0])).toEqual(b);
});

test("Value and Close date re-sort the loaded cards only, nulls last, ties in server order", () => {
  const a = card("lead", "10.00", { expected_close: "2026-11-01" });
  const b = card("lead", null, { expected_close: null });
  const c = card("lead", "200.00", { expected_close: "2026-10-20" });
  const d = card("lead", "10.00", { expected_close: "2026-10-20" });
  expect(sortLoaded([a, b, c, d], "value").map((x) => x.id)).toEqual([c.id, a.id, d.id, b.id]);
  expect(sortLoaded([a, b, c, d], "close").map((x) => x.id)).toEqual([c.id, d.id, a.id, b.id]);
  expect(sortLoaded([a, b], "recent")).toEqual([a, b]);
});
