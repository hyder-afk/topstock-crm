import { expect, test } from "@playwright/test";
import {
  CLAIM_MARGIN_MS,
  CLAIM_MS,
  addExcluded,
  addPending,
  claimCount,
  claimNextInput,
  claimsStale,
  emptyReason,
  firstOpening,
  queueKeyFor,
  queueOutcomeInput,
  lostKept,
  readPending,
  releaseBody,
  releaseInput,
  removePending,
  renewedUntil,
  startQueueInput,
  type PendingOutcome,
} from "@/lib/queue";
import { CALL_WINDOW, openUntilMinutes } from "@/lib/timezones";

// The work queue's pure parts (Day 4 design 5.4, 7.4, 7.7): requests, keys, the not-saved store, empty states.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const next = { scope: "mine", keep: [], exclude: [], anyHours: false, skipLunch: false };
const log = {
  leadId: id(1),
  type: "call",
  outcome: "no_answer",
  body: "",
  contactId: null,
  dialled: "lead",
  followUpDate: null,
  followUpAt: null,
  leadName: "Maison Verdane",
  requestId: id(2),
};

test("requests: strict objects, bounds the database also checks", () => {
  expect(startQueueInput.safeParse({ scope: "mine", exclude: [], anyHours: false, skipLunch: false }).success).toBe(true);
  expect(startQueueInput.safeParse({ scope: "everyone", exclude: [], anyHours: false, skipLunch: false }).success).toBe(false);
  expect(startQueueInput.safeParse({ scope: "mine", exclude: [], anyHours: false, skipLunch: false, count: 3 }).success).toBe(false);
  expect(claimNextInput.safeParse({ ...next, keep: [id(1)] }).success).toBe(true);
  expect(claimNextInput.safeParse({ ...next, keep: [id(1), id(2)] }).success).toBe(false);
  expect(claimNextInput.safeParse({ ...next, exclude: Array.from({ length: 201 }, (_, i) => id(i)) }).success).toBe(false);
  expect(claimNextInput.safeParse({ ...next, exclude: ["not-a-uuid"] }).success).toBe(false);
  expect(queueOutcomeInput.safeParse({ log, next }).success).toBe(true);
  expect(queueOutcomeInput.safeParse({ log, next: null }).success).toBe(true);
  // Only calls with an outcome come from the queue; extra keys never pass (no mass assignment).
  expect(queueOutcomeInput.safeParse({ log: { ...log, type: "note", outcome: null, body: "x" }, next }).success).toBe(false);
  expect(queueOutcomeInput.safeParse({ log: { ...log, outcome: null }, next }).success).toBe(false);
  expect(queueOutcomeInput.safeParse({ log: { ...log, p_from_queue: false }, next }).success).toBe(false);
  expect(queueOutcomeInput.safeParse({ log, next, userId: id(9) }).success).toBe(false);
  // Interested needs its follow-up (log_activity's rule, checked before the database).
  expect(queueOutcomeInput.safeParse({ log: { ...log, outcome: "interested" }, next }).success).toBe(false);
  expect(queueOutcomeInput.safeParse({ log: { ...log, outcome: "interested", followUpDate: "2026-10-13" }, next }).success).toBe(true);
  expect(releaseInput.safeParse({ ids: null }).success).toBe(true);
  expect(releaseInput.safeParse({ ids: [id(1), id(2), id(3), id(4)] }).success).toBe(false);
  expect(releaseBody.safeParse({}).success).toBe(true);
  expect(releaseBody.safeParse({ ids: [id(1)] }).success).toBe(true);
  expect(releaseBody.safeParse({ ids: [id(1)], all: true }).success).toBe(false);
});

test("claim count: two cards when the screen holds none, one with a buffer, none with two", () => {
  expect(claimCount(0)).toBe(2);
  expect(claimCount(1)).toBe(1);
  expect(claimCount(2)).toBe(0);
});

test("excluded leads: newest first, once each, at most 200", () => {
  expect(addExcluded([id(1), id(2)], id(3))).toEqual([id(3), id(1), id(2)]);
  expect(addExcluded([id(1), id(2)], id(2))).toEqual([id(2), id(1)]);
  const many = Array.from({ length: 200 }, (_, i) => id(i));
  const out = addExcluded(many, id(999));
  expect(out).toHaveLength(200);
  expect(out[0]).toBe(id(999));
  expect(out).not.toContain(id(199));
});

test("keys: digits by position (AZERTY), letters by meaning, quiet with modifiers and IME", () => {
  expect(queueKeyFor({ code: "Digit1", key: "&" })).toEqual({ kind: "outcome", outcome: "no_answer" });
  expect(queueKeyFor({ code: "Digit7", key: "è" })).toEqual({ kind: "outcome", outcome: "do_not_contact" });
  expect(queueKeyFor({ code: "Numpad0", key: "0" })).toEqual({ kind: "outcome", outcome: "connected" });
  expect(queueKeyFor({ code: "Digit8", key: "_" })).toBeNull();
  expect(queueKeyFor({ code: "KeyS", key: "s" })).toEqual({ kind: "skip" });
  expect(queueKeyFor({ code: "KeyS", key: "S", shiftKey: true })).toEqual({ kind: "skip" });
  expect(queueKeyFor({ code: "KeyN", key: "n" })).toEqual({ kind: "note" });
  expect(queueKeyFor({ code: "KeyC", key: "c" })).toEqual({ kind: "call" });
  expect(queueKeyFor({ code: "KeyU", key: "u" })).toEqual({ kind: "undo" });
  expect(queueKeyFor({ code: "KeyW", key: "z", metaKey: true })).toEqual({ kind: "undo" }); // AZERTY: Z sits on KeyW
  expect(queueKeyFor({ code: "KeyZ", key: "z", ctrlKey: true })).toEqual({ kind: "undo" });
  expect(queueKeyFor({ code: "KeyZ", key: "z", ctrlKey: true, shiftKey: true })).toBeNull();
  expect(queueKeyFor({ code: "KeyC", key: "c", metaKey: true })).toBeNull(); // copy
  expect(queueKeyFor({ code: "Digit1", key: "1", ctrlKey: true })).toBeNull();
  expect(queueKeyFor({ code: "KeyS", key: "s", isComposing: true })).toBeNull();
});

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}
const pending = (n: number): PendingOutcome => ({
  input: { ...(log as unknown as PendingOutcome["input"]), requestId: id(100 + n) },
  leadName: "Maison Verdane",
  at: n,
});

test("not-saved outcomes: kept once per request id, removed when saved, unreadable store reads as none", () => {
  const s = memoryStore();
  expect(readPending(s)).toEqual([]);
  addPending(pending(1), s);
  addPending(pending(1), s);
  addPending(pending(2), s);
  expect(readPending(s).map((p) => p.input.requestId)).toEqual([id(101), id(102)]);
  removePending(id(101), s);
  expect(readPending(s).map((p) => p.input.requestId)).toEqual([id(102)]);
  removePending(id(102), s);
  expect(s.m.size).toBe(0);
  s.setItem("topstock.queue.pending", "{not json");
  expect(readPending(s)).toEqual([]);
  s.setItem("topstock.queue.pending", JSON.stringify([{ input: { requestId: "x" }, leadName: 1, at: "a" }]));
  expect(readPending(s)).toEqual([]);
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  expect(readPending(throwing)).toEqual([]);
  expect(() => addPending(pending(3), throwing)).not.toThrow();
  expect(readPending(null)).toEqual([]);
});

test("first opening among waiting zones; the larger group on a tie", () => {
  // Monday 12 Oct 2026 06:00 UTC: 07:00 in London, 08:00 in Paris, 02:00 in New York.
  const at = new Date("2026-10-12T06:00:00Z");
  const first = firstOpening([{ key: "Europe/London", count: 3 }, { key: "Europe/Paris", count: 9 }, { key: "US", count: 40 }], at);
  expect(first?.key).toBe("Europe/Paris");
  expect(first?.opensAt.toISOString()).toBe("2026-10-12T07:00:00.000Z");
  const tie = firstOpening([{ key: "Europe/Paris", count: 2 }, { key: "Europe/Berlin", count: 5 }], at);
  expect(tie?.key).toBe("Europe/Berlin");
  expect(firstOpening([], at)).toBeNull();
});

test("empty states", () => {
  const summary = { callable_now: 0, follow_ups_due: 0, later_today: 0, no_number: 4, claimed_by_others: 0, waiting_by_zone: [] };
  expect(emptyReason(summary, "mine", false)).toBe("noneMine");
  expect(emptyReason(summary, "team", false)).toBe("allDone");
  expect(emptyReason({ ...summary, waiting_by_zone: [{ key: "US", count: 3 }] }, "mine", true)).toBe("outsideHours");
  expect(emptyReason(summary, "mine", true)).toBe("allDone");
  // After "Show leads outside calling hours", the waiting zones were offered already: no second offer.
  expect(emptyReason({ ...summary, waiting_by_zone: [{ key: "US", count: 3 }] }, "mine", true, true)).toBe("allDone");
  expect(emptyReason({ ...summary, waiting_by_zone: [{ key: "US", count: 3 }] }, "team", true, false)).toBe("outsideHours");
});

test("a kept card the database no longer holds for the caller leaves the screen", () => {
  // Start (no keep): nothing to check.
  expect(lostKept(null, [])).toEqual([]);
  expect(lostKept([], [])).toEqual([]);
  // The reserve card is still the caller's: kept.
  expect(lostKept([id(2)], [id(2)])).toEqual([]);
  // Its claim ended and a teammate took it (or it simply ended): the database does not list it.
  expect(lostKept([id(2)], [])).toEqual([id(2)]);
  expect(lostKept([id(2), id(3)], [id(3)])).toEqual([id(2)]);
  // An answer without the list keeps nothing.
  expect(lostKept([id(2)], undefined)).toEqual([id(2)]);
  expect(lostKept([id(2)], null)).toEqual([id(2)]);
});

test("cards on screen count as held until shortly before their claim ends", () => {
  const t0 = 1_800_000_000_000;
  const card = { claimedUntil: t0 + CLAIM_MS };
  expect(claimsStale([], t0 + CLAIM_MS * 2)).toBe(false);
  expect(claimsStale([card], t0)).toBe(false);
  expect(claimsStale([card], t0 + CLAIM_MS - CLAIM_MARGIN_MS - 1)).toBe(false);
  expect(claimsStale([card], t0 + CLAIM_MS - CLAIM_MARGIN_MS)).toBe(true);
  expect(claimsStale([card, { claimedUntil: t0 + 60_000 }], t0 + 60_000)).toBe(true);
  // A renewal holds the cards that were still held when it was sent, 10 minutes from then; it never revives one.
  const sentAt = t0 + 4 * 60_000;
  const [live, ended] = renewedUntil([card, { claimedUntil: t0 + 30_000 }], sentAt);
  expect(live.claimedUntil).toBe(sentAt + CLAIM_MS);
  expect(ended.claimedUntil).toBe(t0 + 30_000);
});

test("'open until': 12:00 before lunch with the lunch switch on in Europe, else 18:00", () => {
  // Monday 12 Oct 2026: 08:00 UTC is 10:00 in Paris (summer time) and 04:00 in New York; 11:00 UTC is 13:00 in Paris.
  const morning = new Date("2026-10-12T08:00:00Z");
  const afternoon = new Date("2026-10-12T13:00:00Z");
  expect(openUntilMinutes("Europe/Paris", morning, false)).toBe(CALL_WINDOW.end);
  expect(openUntilMinutes("Europe/Paris", morning, true)).toBe(CALL_WINDOW.lunch[0]);
  expect(openUntilMinutes("Europe/Paris", afternoon, true)).toBe(CALL_WINDOW.end);
  expect(openUntilMinutes("America/New_York", morning, true)).toBe(CALL_WINDOW.end);
});
