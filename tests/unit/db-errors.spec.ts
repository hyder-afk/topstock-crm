import { expect, test } from "@playwright/test";
import { INVALID_HINTS, toActionFailure } from "@/lib/db-errors";

// The error contract (Day 4 design 4): only the SQLSTATE and the hint are read, never the database's message.
test("step-up, not editable, forbidden", () => {
  expect(toActionFailure({ code: "42501", hint: "step_up" })).toEqual({ ok: false, error: "step_up" });
  expect(toActionFailure({ code: "42501", hint: "not_editable" })).toEqual({ ok: false, error: "not_editable" });
  expect(toActionFailure({ code: "42501", hint: null })).toEqual({ ok: false, error: "forbidden" });
  expect(toActionFailure({ code: "42501", hint: "source" })).toEqual({ ok: false, error: "forbidden" });
});

test("22023 hints: rate limit, undo window, then the named rules", () => {
  expect(toActionFailure({ code: "22023", hint: "rate_limited" })).toEqual({ ok: false, error: "rate_limited" });
  expect(toActionFailure({ code: "22023", hint: "undo_expired" })).toEqual({ ok: false, error: "expired" });
  for (const hint of ["body_too_long", "body_chars", "body_required", "follow_up_required", "task_kind", "task_due", "zone_not_in_country"]) {
    expect(toActionFailure({ code: "22023", hint })).toEqual({ ok: false, error: "invalid", hint });
  }
  expect(toActionFailure({ code: "22023", hint: "something_new" })).toEqual({ ok: false, error: "invalid" });
  expect(toActionFailure({ code: "23514", hint: null })).toEqual({ ok: false, error: "invalid" });
  expect(INVALID_HINTS).toContain("state");
});

test("not found, and everything else is unavailable (no raw text)", () => {
  expect(toActionFailure({ code: "P0002" })).toEqual({ ok: false, error: "not_found" });
  expect(toActionFailure({ code: "XX000", hint: "Failing row contains (secret)" } as never)).toEqual({ ok: false, error: "unavailable" });
  expect(toActionFailure(null)).toEqual({ ok: false, error: "unavailable" });
  expect(toActionFailure({ code: "PGRST301" })).toEqual({ ok: false, error: "unavailable" });
});
