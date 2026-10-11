// What the app shows for a database refusal (Day 4 design 4, error contract). Only the SQLSTATE and the hint are read:
// the database's own message never leaves the server (it can name a column or carry a value), and messages never hold
// values anyway (constant pre-checks). Each action answers { ok: false, error, hint? } and the screen words it.
export type AppError =
  | "step_up" // a fresh authenticator code is needed: the screen opens "Confirm it's you", then retries
  | "forbidden" // not yours to change (row level security, or a session without two-factor)
  | "not_editable" // only the author can change an entry
  | "invalid" // a value the database refused; `hint` says which rule
  | "rate_limited" // too many in a minute
  | "expired" // the 2 minutes to undo are over
  | "not_found" // missing, or not visible to this person (the same answer for both)
  | "busy"
  | "quota"
  | "type_mismatch"
  | "unavailable"; // anything else: connection, database down, unknown

/** 22023 hints the screens word on their own (design 4 and the Day 4a/4b migrations). */
export const INVALID_HINTS = [
  "outcome",
  "body_required",
  "body_too_long",
  "body_chars",
  "dialled",
  "follow_up_required",
  "follow_up_range",
  "task_title",
  "bounds",
  "bad_cursor",
  "bad_types",
  "zone_not_in_country",
  "until_cool_off_only",
  "state",
  "task_kind",
  "task_due",
  "lead_has_files",
] as const;
export type InvalidHint = (typeof INVALID_HINTS)[number];

export type ActionFailure = { ok: false; error: AppError; hint?: InvalidHint };
export type ActionResult<T> = { ok: true; data: T } | ActionFailure;

const hintErrors: Record<string, AppError> = {
  step_up: "step_up",
  not_editable: "not_editable",
  rate_limited: "rate_limited",
  undo_expired: "expired",
  busy: "busy",
  quota: "quota",
  too_many_pending: "busy",
  object_mismatch: "type_mismatch",
};

/** The app's answer for a PostgREST error ({ code, hint }); null or a missing code is "unavailable". */
export function toActionFailure(error: { code?: string | null; hint?: string | null } | null | undefined): ActionFailure {
  const code = error?.code ?? "";
  const hint = error?.hint ?? "";
  if (hint && hintErrors[hint]) return { ok: false, error: hintErrors[hint] };
  if (code === "42501") return { ok: false, error: "forbidden" };
  if (code === "P0002") return { ok: false, error: "not_found" };
  if (code === "22023" || code === "23514" || code === "23502" || code === "22P02" || code === "22007" || code === "22008" || code === "23503") {
    return (INVALID_HINTS as readonly string[]).includes(hint)
      ? { ok: false, error: "invalid", hint: hint as InvalidHint }
      : { ok: false, error: "invalid" };
  }
  return { ok: false, error: "unavailable" };
}

/** A refused request before any database call (Zod), worded like the database's own refusal. */
export function invalid(hint?: InvalidHint): ActionFailure {
  return hint ? { ok: false, error: "invalid", hint } : { ok: false, error: "invalid" };
}
