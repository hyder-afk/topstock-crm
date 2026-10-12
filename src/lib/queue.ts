import { z } from "zod";
import { logActivityInput, outcomeForKey, type CallOutcome, type LogActivityInput } from "@/lib/activities";
import { nextOpening } from "@/lib/timezones";

// The work queue (Day 4 design 4.2, 5.4, 7.4): types of what the database answers, the requests the server actions
// take (Zod strictObject, nothing unknown passes), the keys, and the outcome kept in this tab while it is not saved.

/** Who the queue serves: Mine (everyone), Mine + unassigned and Team (managers and admins; the database checks). */
export const QUEUE_SCOPES = ["mine", "mine_unassigned", "team"] as const;
export type QueueScope = (typeof QUEUE_SCOPES)[number];

export const QUEUE_REASONS = ["follow_up", "negotiation", "warm", "retry", "returning", "first_call"] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];

/** Claims last 10 minutes (the database sets it); the page renews every 4 minutes while visible and in use. */
export const CLAIM_MINUTES = 10;
export const RENEW_EVERY_MS = 4 * 60_000;
/** "In use": a key or a click in the last 10 minutes. A closed laptop holds its leads 10 minutes at most. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;
/** This session's skips and logged leads sent with each claim (the database takes at most 200). */
export const MAX_EXCLUDE = 200;
/** A failed save is tried again after these waits, then the screen offers Retry. */
export const RETRY_DELAYS_MS = [500, 1000, 2000] as const;
/** sessionStorage: the outcomes not saved yet (this tab only), and the lunch switch (remembered for the session). */
export const PENDING_KEY = "topstock.queue.pending";
export const SKIP_LUNCH_KEY = "topstock.queue.skipLunch";
/** The release route reads at most this much (design 4.2: 32 KB). */
export const RELEASE_MAX_BYTES = 32 * 1024;

export type QueueContact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  phone_wrong: boolean;
};

/** One card (claim_next_lead's private.queue_card). */
export type QueueCard = {
  id: string;
  name: string;
  lead_status: string;
  owner: { id: string; first_name: string | null; last_name: string | null } | null;
  phone: string | null;
  phone_wrong: boolean;
  email: string | null;
  city: string | null;
  country: string | null;
  timezone: string | null;
  call_zone: string;
  local_time_open: boolean;
  next_action_at: string | null;
  last_activity_at: string | null;
  reason: QueueReason;
  attempts: number;
  claimed_until: string | null;
  can_edit: boolean;
  contacts: QueueContact[];
  recent: { id: string; type: string; outcome: string | null; body: string | null; truncated: boolean; created_at: string; user_first_name: string | null }[];
  my_open_tasks: { id: string; title: string; kind: string; due_date: string | null; due_at: string | null }[];
};

export type QueueSummary = {
  callable_now: number;
  follow_ups_due: number;
  later_today: number;
  no_number: number;
  claimed_by_others: number;
  waiting_by_zone: { key: string; count: number }[];
};

/** claim_next_lead's answer: the cards won, the kept cards still claimed, and the counts when nothing was found. */
export type ClaimAnswer = { cards: QueueCard[]; kept: string[]; summary: QueueSummary | null };

const uuid = z.uuid();
const scope = z.enum(QUEUE_SCOPES);
const exclude = z.array(uuid).max(MAX_EXCLUDE);

/** Start (or start again): the caller's own live claims come back first, then up to 2 cards in all. */
export const startQueueInput = z.strictObject({ scope, exclude, anyHours: z.boolean(), skipLunch: z.boolean() });

/**
 * The next card after an outcome or a skip: `keep` is the card the screen still holds (at most 1); one card is
 * claimed when the screen holds one, two when it holds none (the database: keep + count ≤ 3).
 */
export const claimNextInput = z.strictObject({ scope, keep: z.array(uuid).max(1), exclude, anyHours: z.boolean(), skipLunch: z.boolean() });
export type ClaimNextInput = z.infer<typeof claimNextInput>;

/** A call outcome from the queue (always a call), then optionally the next card, in one dispatch (design D3). */
export const queueOutcomeInput = z.strictObject({
  log: logActivityInput.refine((v) => v.type === "call" && v.outcome !== null, { message: "outcome" }),
  next: claimNextInput.nullable(),
});
export type QueueOutcomeInput = z.input<typeof queueOutcomeInput>;

export const undoOutcomeInput = z.strictObject({ activityId: uuid, leadId: uuid });
/** Leads to let go (null: all of the caller's claims). */
export const releaseInput = z.strictObject({ ids: z.array(uuid).max(3).nullable() });
/** The release route's body (sent on pagehide): a few ids at most, or nothing for all. */
export const releaseBody = z.strictObject({ ids: z.array(uuid).max(3).optional() });
/** GET /api/queue/summary. */
export const summaryParams = z.strictObject({ scope: scope.optional(), skip_lunch: z.enum(["0", "1"]).optional() });

/** How many cards to claim given the cards kept (the database refuses a count of 0, or more than 3 claims). */
export function claimCount(kept: number): 1 | 2 | 0 {
  if (kept >= 2) return 0;
  return kept === 1 ? 1 : 2;
}

/** The most recent ids first, each once, at most MAX_EXCLUDE (older skips drop off). */
export function addExcluded(list: readonly string[], ...ids: string[]): string[] {
  const out = [...ids.filter(Boolean), ...list];
  return [...new Set(out)].slice(0, MAX_EXCLUDE);
}

export type QueueKey =
  | { kind: "outcome"; outcome: CallOutcome }
  | { kind: "skip" }
  | { kind: "note" }
  | { kind: "call" }
  | { kind: "undo" };

/**
 * What a key press means on the queue screen, or null. Digits by `event.code` (AZERTY-safe, through outcomeForKey);
 * letters by `event.key` (S skip, N note, C call, U undo; Cmd/Ctrl+Z undo). The caller skips presses while typing,
 * during IME composition and while a dialog is open.
 */
export function queueKeyFor(e: { code: string; key: string; isComposing?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): QueueKey | null {
  if (e.isComposing) return null;
  const outcome = outcomeForKey(e);
  if (outcome) return { kind: "outcome", outcome };
  const key = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === "z") return { kind: "undo" };
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (key === "s") return { kind: "skip" };
  if (key === "n") return { kind: "note" };
  if (key === "c") return { kind: "call" };
  if (key === "u") return { kind: "undo" };
  return null;
}

/** An outcome kept in this tab until the database has it (its request id makes a second save a replay). */
export type PendingOutcome = { input: Omit<LogActivityInput, "type"> & { type: "call" }; leadName: string; at: number };

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function store(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const pendingShape = z.array(
  z.object({
    input: z.object({ requestId: uuid, leadId: uuid, type: z.literal("call") }).passthrough(),
    leadName: z.string(),
    at: z.number(),
  }),
);

/** The outcomes not saved yet (oldest first); an unreadable store reads as none. */
export function readPending(s: Store | null = store()): PendingOutcome[] {
  try {
    const raw = s?.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed = pendingShape.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as unknown as PendingOutcome[]) : [];
  } catch {
    return [];
  }
}

function writePending(list: PendingOutcome[], s: Store | null) {
  try {
    if (list.length === 0) s?.removeItem(PENDING_KEY);
    else s?.setItem(PENDING_KEY, JSON.stringify(list.slice(-20)));
  } catch {
    // Storage full or blocked: the outcome is still retried from memory while the page stays open.
  }
}

/** Keeps an outcome until it is saved: one entry per request id, never two. */
export function addPending(item: PendingOutcome, s: Store | null = store()): PendingOutcome[] {
  const list = readPending(s).filter((p) => p.input.requestId !== item.input.requestId);
  list.push(item);
  writePending(list, s);
  return list;
}

export function removePending(requestId: string, s: Store | null = store()): PendingOutcome[] {
  const list = readPending(s).filter((p) => p.input.requestId !== requestId);
  writePending(list, s);
  return list;
}

/** The lunch switch, remembered for this session (off by default, Haider 11 Oct). */
export function readSkipLunch(s: Store | null = store()): boolean {
  try {
    return s?.getItem(SKIP_LUNCH_KEY) === "1";
  } catch {
    return false;
  }
}
export function writeSkipLunch(on: boolean, s: Store | null = store()) {
  try {
    s?.setItem(SKIP_LUNCH_KEY, on ? "1" : "0");
  } catch {
    // Not remembered: the switch still works on this page.
  }
}

/**
 * The calling zone that opens first among those with leads waiting ("UK leads open at 09:00 London time"): the
 * earliest next opening, the larger group on a tie. Null when none opens within a week.
 */
export function firstOpening(waiting: QueueSummary["waiting_by_zone"], at: Date, skipLunch = false): { key: string; count: number; opensAt: Date } | null {
  let best: { key: string; count: number; opensAt: Date } | null = null;
  for (const w of waiting) {
    const opensAt = nextOpening(w.key, at, skipLunch);
    if (!opensAt) continue;
    if (!best || opensAt.getTime() < best.opensAt.getTime() || (opensAt.getTime() === best.opensAt.getTime() && w.count > best.count)) {
      best = { key: w.key, count: w.count, opensAt };
    }
  }
  return best;
}

/** Which empty state the queue shows when no card came back. */
export type EmptyReason = "noneMine" | "outsideHours" | "allDone";
export function emptyReason(summary: QueueSummary | null, scope: QueueScope, mineHasLeads: boolean): EmptyReason {
  if (scope === "mine" && !mineHasLeads) return "noneMine";
  if (summary && summary.waiting_by_zone.length > 0) return "outsideHours";
  return "allDone";
}

/** POST /api/queue/next: the next card(s) (after a Skip, or when the reserve ran dry). */
export const nextBody = z.strictObject({ next: claimNextInput });
/** The outcome route reads at most this much (a 10,000-character note can be 40 KB of UTF-8). */
export const OUTCOME_MAX_BYTES = 64 * 1024;
