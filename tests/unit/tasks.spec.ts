import { expect, test } from "@playwright/test";
import { chipDate, createTaskInput, isOverdue, taskSwitchInput } from "@/lib/tasks";

// Date chips and the task request (Day 4 design 7.2 and 8.4 task-dates): calendar dates in the viewer's zone, so
// Haider's "Today" in Karachi is Karachi's today; "Next week" is the next Monday.
test("chips in Europe/Paris and Asia/Karachi on the same instant", () => {
  const late = new Date("2026-10-12T21:30:00Z"); // Monday 23:30 in Paris, Tuesday 02:30 in Karachi
  expect(chipDate("today", "Europe/Paris", late)).toBe("2026-10-12");
  expect(chipDate("today", "Asia/Karachi", late)).toBe("2026-10-13");
  expect(chipDate("tomorrow", "Europe/Paris", late)).toBe("2026-10-13");
  expect(chipDate("tomorrow", "Asia/Karachi", late)).toBe("2026-10-14");
  expect(chipDate("in2days", "Asia/Karachi", late)).toBe("2026-10-15");
  expect(chipDate("nextWeek", "Europe/Paris", late)).toBe("2026-10-19");
});

test("across the clock change and on a Sunday", () => {
  const sunday = new Date("2026-10-25T10:00:00Z"); // Sunday 25 Oct, summer time ends in Paris
  expect(chipDate("today", "Europe/Paris", sunday)).toBe("2026-10-25");
  expect(chipDate("tomorrow", "Europe/Paris", sunday)).toBe("2026-10-26");
  expect(chipDate("nextWeek", "Europe/Paris", sunday)).toBe("2026-10-26");
  const friday = new Date("2026-10-23T15:00:00Z");
  expect(chipDate("nextWeek", "Europe/Paris", friday)).toBe("2026-10-26");
  expect(chipDate("in2days", "Europe/Paris", friday)).toBe("2026-10-25");
});

test("overdue: before today (all-day) or before now (timed); done never", () => {
  const now = new Date("2026-10-12T10:00:00Z");
  expect(isOverdue({ due_date: "2026-10-11", due_at: null, done_at: null }, "Europe/Paris", now)).toBe(true);
  expect(isOverdue({ due_date: "2026-10-12", due_at: null, done_at: null }, "Europe/Paris", now)).toBe(false);
  expect(isOverdue({ due_date: null, due_at: "2026-10-12T09:59:00Z", done_at: null }, "Europe/Paris", now)).toBe(true);
  expect(isOverdue({ due_date: "2026-10-01", due_at: null, done_at: "2026-10-02T00:00:00Z" }, "Europe/Paris", now)).toBe(false);
});

const lead = "0b6d1d2e-6f0e-4d3e-9a51-6a2f6f0e1a11";
const base = {
  title: "Follow up with Maison Verdane",
  leadId: lead,
  contactId: null,
  kind: "call",
  dueDate: "2026-10-13",
  dueAt: null,
  assigneeId: null,
  requestId: "2d8f3f40-8b20-4f50-9c73-8c4b8b203c33",
};
const ok = (v: object) => createTaskInput.safeParse({ ...base, ...v }).success;

test("task request: strict, a title, a date or a time, a meeting has a time", () => {
  expect(ok({})).toBe(true);
  expect(ok({ done_at: "2026-10-12T00:00:00Z" })).toBe(false);
  expect(ok({ created_by: lead })).toBe(false);
  expect(ok({ title: "  " })).toBe(false);
  expect(ok({ title: "x".repeat(301) })).toBe(false);
  expect(ok({ title: "Line\nbreak" })).toBe(false);
  expect(ok({ title: "Bidi\u202Etrick" })).toBe(false);
  expect(ok({ dueAt: "2026-10-13T08:00:00.000Z" })).toBe(false);
  expect(ok({ kind: "meeting", dueDate: null, dueAt: null })).toBe(false);
  expect(ok({ kind: "meeting", dueDate: null, dueAt: "2026-10-13T08:00:00.000Z" })).toBe(true);
  expect(ok({ kind: "errand" })).toBe(false);
  expect(ok({ leadId: null, contactId: lead })).toBe(false);
  expect(taskSwitchInput.safeParse({ id: lead, on: true }).success).toBe(true);
  expect(taskSwitchInput.safeParse({ id: lead, on: "yes" }).success).toBe(false);
  expect(taskSwitchInput.safeParse({ id: lead, on: true, done_at: "now" }).success).toBe(false);
});
