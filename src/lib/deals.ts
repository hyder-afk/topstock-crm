import { z } from "zod";
import { isoDate } from "@/lib/activities";
import { isMoney } from "@/lib/money";

// Deals and the pipeline (Day 5 design sections 4.4, 5.5 and 5.6). The lists and limits below are the database's own
// literals (migration 20261015090000_deals_pipeline.sql); tests/unit/day5-parity.spec.ts reads the migration and fails
// when they drift.
export const stageKeys = ["lead", "qualified", "negotiations", "won", "lost"] as const;
export type StageKey = (typeof stageKeys)[number];
export const openStageKeys = ["lead", "qualified", "negotiations"] as const;
export type OpenStageKey = (typeof openStageKeys)[number];
/** The board's columns, left to right (Lost is a drop band, not a column: design D19). */
export const boardColumns = ["lead", "qualified", "negotiations", "won"] as const;
export type BoardColumnKey = (typeof boardColumns)[number];
export const lostReasons = ["price", "timing", "no_stock", "competitor", "no_response", "shipping", "mistake", "other"] as const;
export type LostReason = (typeof lostReasons)[number];
/** from_stock = Warehouse inventory, direct_from_source = Supplier Stock (Day 6 order types, design section 10). */
export const fulfilments = ["from_stock", "direct_from_source"] as const;
export type Fulfilment = (typeof fulfilments)[number];
export const DEAL_UNDO_SECONDS = 120;
export const DEAL_TOAST_SECONDS = 10;
export const STALL_DAYS = { lead: 7, qualified: 14, negotiations: 21 } as const;
/** The Won column and the Lost line cover the last 30 days (D19). */
export const WON_WINDOW_DAYS = 30;
export const DEAL_TITLE_MAX = 120;
export const LOST_NOTE_MAX = 500;
/** The note's counter shows from 450 characters (design 7.6). */
export const LOST_NOTE_COUNTER_FROM = 450;
/** Cards per column on the board's first paint, and per "Show more" page (pipeline_board, list_stage_deals: 1 to 100). */
export const BOARD_PAGE = 50;
/** Columns with more loaded cards than this are virtualised (design 7.3; spike S10). */
export const VIRTUALISE_FROM = 60;
export const sortOrders = ["recent", "oldest", "value", "close"] as const;
export type SortOrder = (typeof sortOrders)[number];
export const updateFields = ["title", "value", "expected_close", "fulfilment", "contact_id", "owner_id"] as const;
export type UpdateField = (typeof updateFields)[number];

/** Characters the database refuses in deal titles and lost notes (deals_title_safe, deals_note_safe; C1 as well). */
export const UNSAFE_TITLE = /[\u0001-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;
export const UNSAFE_NOTE = /[\u0001-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

/** A board card (private.deal_cards): one row per deal the caller sees. `value` is a decimal string, or null (no value). */
export type DealCard = {
  id: string;
  stage: StageKey;
  title: string | null;
  company_id: string;
  company_name: string;
  city: string | null;
  country: string | null;
  lead_status: string;
  contact_id: string | null;
  contact_name: string | null;
  value: string | null;
  currency: string;
  status: "open" | "won" | "lost";
  stage_entered_at: string;
  closed_at: string | null;
  expected_close: string | null;
  fulfilment: Fulfilment | null;
  owner_id: string | null;
  owner_first_name: string | null;
  owner_last_name: string | null;
  version: number;
  last_activity_at: string | null;
  is_stalled: boolean;
  quiet_days: number | null;
  lost_reason: LostReason | null;
  created_at: string;
  can_edit: boolean;
};

export type Cursor = { after_at: string; after_id: string } | null;
export type BoardColumn = {
  key: OpenStageKey;
  stall_days: number | null;
  count: number;
  value: string;
  no_value: number;
  stalled: number;
  cards: DealCard[];
  next: Cursor;
};
export type Board = {
  scope: "team" | "mine";
  owner_id: string | null;
  stages: BoardColumn[];
  won: { count: number; value: string; cards: DealCard[]; next: Cursor };
  lost: { count: number; reasons: { code: LostReason; count: number }[] };
  open_total: { count: number; value: string };
};
export type BoardSummary = Omit<Board, "stages" | "won"> & {
  stages: Omit<BoardColumn, "cards" | "next">[];
  won: { count: number; value: string };
};

export type DealHistoryRow = {
  id: number;
  kind: "open" | "move" | "won" | "lost" | "reopen" | "undo";
  from_stage: StageKey | null;
  to_stage: StageKey;
  actor_id: string | null;
  actor_first_name: string | null;
  created_at: string;
  undoes: number | null;
  undone: boolean;
  value: string | null;
  lost_reason: LostReason | null;
};
/** get_deal: the card plus the lead, contact, owner, rights, Undo, history and the last entries (never their text). */
export type DealDetail = DealCard & {
  lead: { id: string; name: string; city: string | null; country: string | null; lead_status: string; can_edit: boolean };
  contact: { id: string; first_name: string | null; last_name: string | null } | null;
  owner: { id: string; first_name: string | null; last_name: string | null } | null;
  can_delete: boolean;
  stall_days: number | null;
  undo: { history_id: number; to_stage: StageKey; until: string } | null;
  history: DealHistoryRow[];
  activities: { id: string; type: string; outcome: string | null; user_first_name: string | null; created_at: string }[];
};

/** What move_deal answers (D5: a conflict is a result, not an error). */
export type MoveResult =
  | {
      result: "moved";
      deal: DealCard;
      history_id: number;
      undone: boolean;
      undo_until: string | null;
      lead_status_before: string | null;
      lead_status_after: string | null;
      replayed: boolean;
    }
  | { result: "conflict"; deal: DealCard | null; changed_by_first_name: string | null }
  | { result: "unchanged"; deal: DealCard };
export type UpdateResult = { result: "updated"; deal: DealCard } | { result: "conflict"; deal: DealCard | null; changed_by_first_name: string | null };
export type OpenResult = {
  deal: DealCard;
  open_deal_count: number;
  replayed: boolean;
  lead_status_before: string | null;
  lead_status_after: string | null;
  undo_until: string;
};
/** get_lead's deals brief (5b) and claim cards (4c rebase). */
export type LeadDealsBrief = {
  open_count: number;
  latest_open: { id: string; title: string | null; stage: StageKey; value: string | null; stage_entered_at: string; is_stalled: boolean; version: number } | null;
};

// ---- Inputs (server actions; z.strictObject: nothing unknown passes). Money is the wire string. -------------------
const uuid = z.uuid();
const money = z.string().refine(isMoney, { message: "value" });
const version = z.int().min(0);
const title = z
  .string()
  .trim()
  .max(400)
  .refine((s) => Array.from(s).length <= DEAL_TITLE_MAX, { message: "deal_title" })
  .refine((s) => !UNSAFE_TITLE.test(s) && !s.includes("\u0000"), { message: "deal_title" });
const note = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((s) => Array.from(s).length <= LOST_NOTE_MAX, { message: "lost_note" })
  .refine((s) => !UNSAFE_NOTE.test(s) && !s.includes("\u0000"), { message: "lost_note" });

export const openDealInput = z.strictObject({
  leadId: uuid,
  title: title.nullable(),
  value: money.nullable(),
  expectedClose: isoDate.nullable(),
  fulfilment: z.enum(fulfilments).nullable(),
  contactId: uuid.nullable(),
  ownerId: uuid.nullable(),
  requestId: uuid,
});
export const moveInput = z.strictObject({ id: uuid, stage: z.enum(openStageKeys), version, requestId: uuid });
export const winInput = z.strictObject({ id: uuid, version, value: money, fulfilment: z.enum(fulfilments), requestId: uuid });
export const loseInput = z
  .strictObject({ id: uuid, version, reason: z.enum(lostReasons), note: note.nullable(), requestId: uuid })
  .refine((v) => v.reason !== "other" || v.note !== null, { message: "lost_note_required", path: ["note"] });
export const reopenInput = z.strictObject({ id: uuid, stage: z.enum(openStageKeys), version, requestId: uuid });
export const undoInput = z.strictObject({ id: uuid, historyId: z.int().positive(), toStage: z.enum(stageKeys), version, requestId: uuid });
export const updateDealInput = z
  .strictObject({
    id: uuid,
    version,
    fields: z.array(z.enum(updateFields)).min(1).max(updateFields.length),
    title: title.nullable().optional(),
    value: money.nullable().optional(),
    expectedClose: isoDate.nullable().optional(),
    fulfilment: z.enum(fulfilments).nullable().optional(),
    contactId: uuid.nullable().optional(),
    ownerId: uuid.nullable().optional(),
  })
  .refine((v) => new Set(v.fields).size === v.fields.length, { message: "fields" });
export const dealIdInput = z.strictObject({ id: uuid });

// ---- Route queries (GET /api/pipeline/*, /api/deals/[id], /api/leads/[id]/deals) ------------------------------------
export const scopeParam = z.enum(["team", "mine"]);
export const boardParams = z.strictObject({ scope: scopeParam.optional(), owner: uuid.optional() });
export const stageParams = z
  .strictObject({
    stage: z.enum(stageKeys),
    scope: scopeParam.optional(),
    owner: uuid.optional(),
    stalled: z.enum(["1"]).optional(),
    order: z.enum(["recent", "oldest"]).optional(),
    after_at: z.iso.datetime({ offset: true }).optional(),
    after_id: uuid.optional(),
  })
  .refine((v) => (v.after_at === undefined) === (v.after_id === undefined), { message: "bad_cursor" });

// ---- Days in stage and stalled (design 5.5, D16; the SQL is the source: deal_cards) ---------------------------------
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Whole days since `since` (elapsed time, no time zone: 7 × 24 h is 7 days on a clock-change week too). */
export function elapsedDays(since: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(since)) / DAY));
}

/**
 * Stalled, as private.deal_cards decides it: an open stage with a limit, and neither a stage move nor any contact on the
 * lead for more than the limit (24 h a day). `quiet` is the days since the later of the two. Shared cases:
 * tests/unit/days-in-stage.spec.ts reads deals_attack.sql's stall-cases block.
 */
export function stallState(
  stage: StageKey,
  stageEnteredAt: string,
  lastActivityAt: string | null,
  now: number,
  stallDays: Partial<Record<StageKey, number>> = STALL_DAYS,
): { stalled: boolean; quiet: number | null } {
  if (stage === "won" || stage === "lost") return { stalled: false, quiet: null };
  const since = Math.max(Date.parse(stageEnteredAt), lastActivityAt ? Date.parse(lastActivityAt) : -Infinity);
  const limit = stallDays[stage];
  return {
    stalled: limit !== undefined && since < now - limit * DAY,
    quiet: Math.floor((now - since) / DAY),
  };
}

/** The stage a deal moves to one step right or left on the board (Shift+→/←): null at either end. */
export function stepStage(stage: StageKey, dir: 1 | -1): StageKey | null {
  if (stage === "lost") return null;
  const order: StageKey[] = ["lead", "qualified", "negotiations", "won"];
  const i = order.indexOf(stage);
  return order[i + dir] ?? null;
}

/** The next-step chip on a card (design 7.2): "→ Qualified", "→ Negotiations", or "Mark won" in Negotiations. */
export function nextStage(stage: StageKey): StageKey | null {
  return stage === "lead" ? "qualified" : stage === "qualified" ? "negotiations" : stage === "negotiations" ? "won" : null;
}

/** How a closed deal reopens by default: the stage it was closed from (its history), else Negotiations. */
export function reopenStage(history: Pick<DealHistoryRow, "kind" | "from_stage" | "to_stage">[]): OpenStageKey {
  const closing = history.find((h) => (h.kind === "won" || h.kind === "lost") && h.from_stage);
  const from = closing?.from_stage;
  return from === "lead" || from === "qualified" || from === "negotiations" ? from : "negotiations";
}

/** "Lead 3 days → Qualified 5 days → Negotiations, 12 days so far" (design 7.6): undo pairs folded, oldest first. */
export function dealPath(history: DealHistoryRow[], now: number): { stage: StageKey; days: number; current: boolean }[] {
  const undone = new Set(history.filter((h) => h.kind === "undo" && h.undoes !== null).map((h) => h.undoes));
  const rows = [...history]
    .filter((h) => h.kind !== "undo" && !undone.has(h.id))
    .sort((a, b) => a.id - b.id);
  return rows.map((h, i) => {
    const end = i + 1 < rows.length ? Date.parse(rows[i + 1].created_at) : now;
    return { stage: h.to_stage, days: Math.max(0, Math.floor((end - Date.parse(h.created_at)) / DAY)), current: i === rows.length - 1 };
  });
}
