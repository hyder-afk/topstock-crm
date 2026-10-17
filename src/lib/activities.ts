import { z } from "zod";
import { isMoney } from "@/lib/money";

// Timeline entries and call outcomes (Day 4 design 5.2 and 5.5). The lists match the database's
// activities_outcome_fits_type check and log_activity's rules; tests/unit/day4-parity.spec.ts reads the migrations.
export const ACTIVITY_TYPES = ["call", "email", "whatsapp", "meeting", "note"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Call outcomes in pad order: keys 1 to 7, then 0 for Spoke (Haider, 11 Oct: a 7th key, Do not contact). */
export const CALL_OUTCOMES = [
  "no_answer",
  "voicemail",
  "wrong_number",
  "not_interested",
  "interested",
  "meeting_booked",
  "do_not_contact",
  "connected",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
/**
 * The call outcomes that reached someone (Home's K4 "calls today: reached" and Analytics' connect rate). No answer,
 * voicemail and wrong number are dials that reached nobody. One list for both: tests/unit/analytics.spec.ts checks it
 * against home_summary's SQL and every list in the Analytics migration.
 */
export const REACHED_OUTCOMES = ["connected", "interested", "meeting_booked", "not_interested", "do_not_contact"] as const;
export const OTHER_OUTCOMES = ["sent", "held", "no_show"] as const;
export type Outcome = CallOutcome | (typeof OTHER_OUTCOMES)[number];

export const OUTCOME_DIGIT: Record<CallOutcome, number> = {
  no_answer: 1,
  voicemail: 2,
  wrong_number: 3,
  not_interested: 4,
  interested: 5,
  meeting_booked: 6,
  do_not_contact: 7,
  connected: 0,
};

/** The outcomes each kind of entry may carry (null: none). */
export const OUTCOMES_FOR_TYPE: Record<ActivityType, readonly (Outcome | null)[]> = {
  call: CALL_OUTCOMES,
  email: [null, "sent"],
  whatsapp: [null, "sent"],
  meeting: [null, "held", "no_show"],
  note: [null],
};

/** Undo works for the author for 2 minutes (design D2); the toast offers it for the first 10 seconds. */
export const UNDO_SECONDS = 120;
export const UNDO_TOAST_SECONDS = 10;
/** Text limits: the database refuses more than 10,000 characters; the counter shows from 9,000. */
export const BODY_MAX = 10_000;
export const BODY_COUNTER_FROM = 9_000;
/** The timeline loads 30 entries a page (keyset); a shown body is cut at 2,000 characters ("Show more"). */
export const TIMELINE_PAGE_SIZE = 30;
export const BODY_SHOWN = 2_000;

/**
 * Characters the database refuses in entry text (activities_body_safe): C0 controls except tab and line feed, DEL, C1
 * controls (Day 4a review), and the bidi overrides and isolates (a note cannot reorder the text around it).
 */
export const UNSAFE_TEXT = /[\u0001-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

/** Line breaks as the database stores them (CRLF and lone CR become LF). */
export function normaliseBody(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Length as the database counts it (code points, not UTF-16 units). */
export function textLength(text: string): number {
  return Array.from(text).length;
}

export type FollowUpRule = "date_or_time" | "time" | "optional" | "none";

/**
 * What follow-up an entry takes (log_activity): Interested needs a date or a time; Book meeting a time; Spoke, emails,
 * WhatsApp messages, meetings and notes one optionally (a call task; a meeting entry with no outcome and a time books
 * a meeting); the other call outcomes none.
 */
export function followUpRule(type: ActivityType, outcome: Outcome | null): FollowUpRule {
  if (type === "call") {
    if (outcome === "interested") return "date_or_time";
    if (outcome === "meeting_booked") return "time";
    if (outcome === "connected") return "optional";
    return "none";
  }
  return "optional";
}

/** True when the outcome's change needs a confirmation first (Do not contact: compliance, and it hides Call). */
export function needsConfirm(outcome: Outcome | null): boolean {
  return outcome === "do_not_contact";
}

/**
 * The outcome a key press stands for, or null. Digits are read from `event.code` (the key's place), never
 * `event.key`: on Henri's and Kais's AZERTY keyboards the top row types & é " ' ( - è à without Shift (design 7.7).
 * Presses with a modifier and during IME composition (dead keys) are not outcomes. The caller also skips presses
 * while the person types in a field (isTyping) or a dialog is open.
 */
export function outcomeForKey(e: {
  code: string;
  isComposing?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): CallOutcome | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  const m = /^(?:Digit|Numpad)([0-7])$/.exec(e.code);
  if (!m) return null;
  const digit = Number(m[1]);
  return CALL_OUTCOMES.find((o) => OUTCOME_DIGIT[o] === digit) ?? null;
}

const uuid = z.uuid();
const safeText = (max: number) =>
  z
    .string()
    .transform(normaliseBody)
    .refine((s) => textLength(s) <= max, { message: "too_long" })
    // NUL as well: PostgreSQL text cannot hold it at all.
    .refine((s) => !UNSAFE_TEXT.test(s) && !s.includes("\u0000"), { message: "chars" });

/** A calendar date ("2026-10-12"). */
export const isoDate = z.iso.date();
/** An instant with its offset ("2026-10-12T09:00:00.000Z"). */
export const isoInstant = z.iso.datetime({ offset: true });

/**
 * Log an entry (server action logActivity). Field rules mirror log_activity so a bad request is refused before it
 * reaches the database; the database checks everything again. `leadName` only words the follow-up task's title
 * ("Follow up with {lead}") in the caller's language: a title anyone could type, so it carries no authority.
 */
export const logActivityInput = z
  .strictObject({
    leadId: uuid,
    type: z.enum(ACTIVITY_TYPES),
    outcome: z.enum([...CALL_OUTCOMES, ...OTHER_OUTCOMES]).nullable(),
    body: safeText(BODY_MAX),
    contactId: uuid.nullable(),
    dialled: z.enum(["lead", "contact"]).nullable(),
    followUpDate: isoDate.nullable(),
    followUpAt: isoInstant.nullable(),
    leadName: z.string().trim().min(1).max(200).refine((s) => !UNSAFE_TEXT.test(s)),
    requestId: uuid,
    // Day 5b (design 4.4): the deal this entry is about (one of the lead's deals the caller sees), or a deal to open
    // from an Interested or Book meeting call, with an optional title and value (a decimal string).
    dealId: uuid.nullable().optional(),
    openDeal: z
      .strictObject({
        title: z
          .string()
          .trim()
          .max(400)
          .refine((s) => Array.from(s).length <= 120 && !/[\u0001-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u0000]/.test(s), { message: "deal_title" })
          .nullable(),
        value: z.string().refine(isMoney, { message: "value" }).nullable(),
      })
      .nullable()
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.openDeal && (v.type !== "call" || (v.outcome !== "interested" && v.outcome !== "meeting_booked") || v.dealId)) {
      ctx.addIssue({ code: "custom", path: ["openDeal"], message: "state" });
    }
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (!OUTCOMES_FOR_TYPE[v.type].includes(v.outcome)) issue("outcome", "outcome");
    if (v.type === "note" && v.body.trim() === "") issue("body", "body_required");
    if (v.dialled !== null && v.type !== "call") issue("dialled", "dialled");
    if (v.dialled === "contact" && v.contactId === null) issue("dialled", "dialled");
    if (v.outcome === "wrong_number" && v.dialled === null) issue("dialled", "dialled");
    if (v.followUpDate !== null && v.followUpAt !== null) issue("followUpAt", "follow_up_range");
    const rule = followUpRule(v.type, v.outcome);
    const hasFollowUp = v.followUpDate !== null || v.followUpAt !== null;
    if (rule === "none" && hasFollowUp) issue("followUpDate", "follow_up_range");
    if (rule === "date_or_time" && !hasFollowUp) issue("followUpDate", "follow_up_required");
    if (rule === "time" && v.followUpAt === null) issue("followUpAt", "follow_up_required");
    if (v.type === "meeting" && v.outcome === null && v.followUpDate !== null) issue("followUpAt", "follow_up_required");
  });
export type LogActivityInput = z.input<typeof logActivityInput>;

export const editActivityInput = z.strictObject({ id: uuid, body: safeText(BODY_MAX) });
export const activityIdInput = z.strictObject({ id: uuid });

/** What log_activity answers (the same answer again for a replayed request id). */
export type LoggedActivity = {
  activity_id: string;
  replayed: boolean;
  editable: boolean | null;
  status_before: string | null;
  status_after: string | null;
  next_action_at: string | null;
  owner_changed: boolean;
  wrong_number_marked: boolean;
  task_id: string | null;
  completed_task_ids: string[];
  cancelled_task_ids: string[];
  created_at: string;
  undo_until: string | null;
  /** Day 5b: the deal the entry names, and the deal an Interested or Book meeting call opened (or why it did not). */
  deal_id?: string | null;
  deal?: { id: string; opened: true; open_deal_count: number } | { opened: false; reason: "not_editable" | "dnc" | "rate_limited" } | null;
};

export type UndoneActivity = {
  activity_id: string;
  restored: { status: boolean; next_action_at: boolean; owner: boolean; phone_wrong: boolean; contact_phone_wrong: boolean };
  task_deleted: boolean;
  tasks_reopened: number;
  /** Day 5b: the deal the call opened went with it ("removed"), or stayed because it changed since ("kept"). */
  deal?: "removed" | "kept" | null;
  lead: { lead_status: string; next_action_at: string | null; owner_id: string | null; last_activity_at: string | null } | null;
};

/** One timeline row (list_lead_activities). */
export type TimelineEntry = {
  id: string;
  type: ActivityType;
  outcome: Outcome | null;
  body: string | null;
  truncated: boolean;
  contact_id: string | null;
  contact_name: string | null;
  user_id: string | null;
  user_first_name: string | null;
  user_last_name: string | null;
  created_at: string;
  edited_at: string | null;
  is_mine: boolean;
  undo_until: string | null;
  task_title: string | null;
  task_due_date: string | null;
  task_due_at: string | null;
  task_done_at: string | null;
  /** Browser only: an entry being saved (optimistic), not yet confirmed by the database. */
  pending?: boolean;
};

export type TimelinePage = { entries: TimelineEntry[]; next: { before_at: string; before_id: string } | null };

/** Timeline filter chips: all, or one kind of entry. */
export const TIMELINE_FILTERS = ["all", "call", "email", "whatsapp", "meeting", "note"] as const;
export type TimelineFilter = (typeof TIMELINE_FILTERS)[number];

/** Query parameters of GET /api/leads/<id>/activities. */
export const timelineParams = z.strictObject({
  types: z.enum(ACTIVITY_TYPES).optional(),
  before_at: isoInstant.optional(),
  before_id: uuid.optional(),
});
