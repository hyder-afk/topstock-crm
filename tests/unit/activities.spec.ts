import { expect, test } from "@playwright/test";
import {
  OUTCOMES_FOR_TYPE,
  editActivityInput,
  followUpRule,
  logActivityInput,
  normaliseBody,
  textLength,
  timelineParams,
} from "@/lib/activities";

// The composer's and call panel's request (server action logActivity): Zod strictObject, the same rules as
// log_activity, so a bad request never reaches the database (which checks everything again).
const lead = "0b6d1d2e-6f0e-4d3e-9a51-6a2f6f0e1a11";
const contact = "1c7e2e3f-7a1f-4e4f-8b62-7b3a7a1f2b22";
const base = {
  leadId: lead,
  type: "note",
  outcome: null,
  body: "Called back about the denim lot.",
  contactId: null,
  dialled: null,
  followUpDate: null,
  followUpAt: null,
  leadName: "Maison Verdane",
  requestId: "2d8f3f40-8b20-4f50-9c73-8c4b8b203c33",
};
const ok = (v: object) => logActivityInput.safeParse({ ...base, ...v }).success;
const hint = (v: object) => {
  const r = logActivityInput.safeParse({ ...base, ...v });
  return r.success ? null : r.error.issues.map((i) => i.message);
};

test("a note, a call and the other kinds pass", () => {
  expect(ok({})).toBe(true);
  expect(ok({ type: "call", outcome: "no_answer", body: "", dialled: "lead" })).toBe(true);
  expect(ok({ type: "email", outcome: "sent" })).toBe(true);
  expect(ok({ type: "whatsapp", outcome: "sent", body: "" })).toBe(true);
  expect(ok({ type: "meeting", outcome: "held" })).toBe(true);
  expect(ok({ type: "meeting", outcome: null, followUpAt: "2026-10-14T08:00:00.000Z" })).toBe(true);
});

test("strictObject: an unknown key is refused (no mass assignment)", () => {
  expect(ok({ user_id: lead })).toBe(false);
  expect(ok({ created_at: "2026-01-01T00:00:00Z" })).toBe(false);
  expect(ok({ p_from_queue: true })).toBe(false);
});

test("outcome by kind of entry", () => {
  expect(hint({ type: "note", outcome: "sent" })).toContain("outcome");
  expect(hint({ type: "call", outcome: null })).toContain("outcome");
  expect(hint({ type: "call", outcome: "held" })).toContain("outcome");
  expect(hint({ type: "email", outcome: "no_answer" })).toContain("outcome");
  expect(hint({ type: "meeting", outcome: "sent" })).toContain("outcome");
  expect(OUTCOMES_FOR_TYPE.call).toHaveLength(8);
});

test("follow-up rules: Interested a date or time, Book meeting a time, Spoke optional, the rest none", () => {
  expect(followUpRule("call", "interested")).toBe("date_or_time");
  expect(followUpRule("call", "meeting_booked")).toBe("time");
  expect(followUpRule("call", "connected")).toBe("optional");
  expect(followUpRule("call", "no_answer")).toBe("none");
  expect(followUpRule("note", null)).toBe("optional");
  expect(hint({ type: "call", outcome: "interested" })).toContain("follow_up_required");
  expect(ok({ type: "call", outcome: "interested", followUpDate: "2026-10-14" })).toBe(true);
  expect(hint({ type: "call", outcome: "meeting_booked", followUpDate: "2026-10-14" })).toContain("follow_up_required");
  expect(ok({ type: "call", outcome: "meeting_booked", followUpAt: "2026-10-14T08:00:00.000Z" })).toBe(true);
  expect(hint({ type: "call", outcome: "no_answer", followUpDate: "2026-10-14" })).toContain("follow_up_range");
  expect(hint({ type: "call", outcome: "connected", followUpDate: "2026-10-14", followUpAt: "2026-10-14T08:00:00.000Z" })).toContain(
    "follow_up_range",
  );
  expect(hint({ type: "meeting", outcome: null, followUpDate: "2026-10-14" })).toContain("follow_up_required");
  expect(ok({ followUpDate: "2026-02-30" })).toBe(false);
  expect(ok({ followUpAt: "tomorrow" })).toBe(false);
});

test("dialled: calls only, a contact needs its id, Wrong number needs it", () => {
  expect(hint({ type: "note", dialled: "lead" })).toContain("dialled");
  expect(hint({ type: "call", outcome: "no_answer", dialled: "contact" })).toContain("dialled");
  expect(ok({ type: "call", outcome: "no_answer", dialled: "contact", contactId: contact })).toBe(true);
  expect(hint({ type: "call", outcome: "wrong_number" })).toContain("dialled");
  expect(ok({ type: "call", outcome: "wrong_number", dialled: "lead" })).toBe(true);
  expect(ok({ type: "call", outcome: "no_answer", dialled: "office" })).toBe(false);
});

test("text: a note needs some; control characters and bidi overrides are refused; 10,000 code points at most", () => {
  expect(hint({ body: "   \n\t " })).toContain("body_required");
  expect(hint({ body: "abc\u0007" })).toContain("chars");
  expect(hint({ body: "abc\u202Edef" })).toContain("chars");
  expect(hint({ body: "abc\u2066x" })).toContain("chars");
  expect(ok({ body: "line one\r\nline two\ttabbed" })).toBe(true);
  expect(ok({ body: "a".repeat(10_000) })).toBe(true);
  expect(hint({ body: "a".repeat(10_001) })).toContain("too_long");
  // An emoji is one character to the database (two UTF-16 units).
  expect(ok({ body: "😀".repeat(10_000) })).toBe(true);
  expect(textLength("😀é")).toBe(2);
  expect(normaliseBody("a\r\nb\rc")).toBe("a\nb\nc");
  expect(logActivityInput.parse({ ...base, body: "a\r\nb" }).body).toBe("a\nb");
});

test("ids and the lead name are checked", () => {
  expect(ok({ leadId: "1" })).toBe(false);
  expect(ok({ requestId: "not-a-uuid" })).toBe(false);
  expect(ok({ leadName: "" })).toBe(false);
  expect(ok({ leadName: "x".repeat(201) })).toBe(false);
  expect(ok({ leadName: "Evil\u202Ename" })).toBe(false);
});

test("edit: strict, same text rules", () => {
  expect(editActivityInput.safeParse({ id: lead, body: "ok" }).success).toBe(true);
  expect(editActivityInput.safeParse({ id: lead, body: "ok", type: "call" }).success).toBe(false);
  expect(editActivityInput.safeParse({ id: lead, body: "\u0000" }).success).toBe(false);
});

test("timeline query parameters: known kinds only, both cursor parts are instants, nothing else", () => {
  expect(timelineParams.safeParse({}).success).toBe(true);
  expect(timelineParams.safeParse({ types: "call" }).success).toBe(true);
  expect(timelineParams.safeParse({ types: "call,email" }).success).toBe(false);
  expect(timelineParams.safeParse({ types: "sms" }).success).toBe(false);
  expect(timelineParams.safeParse({ before_at: "2026-10-11T10:00:00.000Z", before_id: lead }).success).toBe(true);
  expect(timelineParams.safeParse({ before_at: "yesterday", before_id: lead }).success).toBe(false);
  expect(timelineParams.safeParse({ limit: "100" }).success).toBe(false);
});
