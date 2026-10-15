import { expect, test } from "@playwright/test";
import { bucketOf, chipDate, createTaskInput, dueParts, isOverdue, nextCursor, taskSwitchInput, tasksParams, updateTaskInput, type TaskListRow } from "@/lib/tasks";

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

// Day 4c: the Tasks page's buckets and labels in the caller's own zone (design 5.6), the GET parameters and the edit.

test("buckets: Paris and Karachi on the same instant (Haider's today is Karachi's today)", () => {
  // Monday 12 Oct 2026, 19:30 UTC: 21:30 in Paris, Tuesday 00:30 in Karachi (PKT has no daylight saving).
  const now = new Date("2026-10-12T19:30:00Z");
  const monday = { due_date: "2026-10-12", due_at: null, done_at: null };
  const tuesday = { due_date: "2026-10-13", due_at: null, done_at: null };
  expect(bucketOf(monday, "Europe/Paris", now)).toBe("today");
  expect(bucketOf(monday, "Asia/Karachi", now)).toBe("overdue");
  expect(bucketOf(tuesday, "Europe/Paris", now)).toBe("upcoming");
  expect(bucketOf(tuesday, "Asia/Karachi", now)).toBe("today");
  // A time later tonight in Paris is Tuesday in Karachi.
  const timed = { due_date: null, due_at: "2026-10-12T21:00:00Z", done_at: null };
  expect(bucketOf(timed, "Europe/Paris", now)).toBe("today");
  expect(bucketOf(timed, "Asia/Karachi", now)).toBe("today");
  const tomorrowParis = { due_date: null, due_at: "2026-10-13T08:00:00Z", done_at: null };
  expect(bucketOf(tomorrowParis, "Europe/Paris", now)).toBe("upcoming");
  expect(bucketOf(tomorrowParis, "Asia/Karachi", now)).toBe("today");
  // Past times are overdue anywhere; no date is upcoming; done is done.
  expect(bucketOf({ due_date: null, due_at: "2026-10-12T19:00:00Z", done_at: null }, "Asia/Karachi", now)).toBe("overdue");
  expect(bucketOf({ due_date: null, due_at: null, done_at: null }, "Europe/Paris", now)).toBe("upcoming");
  expect(bucketOf({ ...monday, done_at: "2026-10-12T10:00:00Z" }, "Europe/Paris", now)).toBe("done");
});

test("due labels: today, tomorrow, yesterday or the date; 24-hour time in the zone", () => {
  const now = new Date("2026-10-12T19:30:00Z");
  expect(dueParts({ due_date: "2026-10-12", due_at: null }, "Europe/Paris", now)).toEqual({ day: "today", time: null });
  expect(dueParts({ due_date: "2026-10-12", due_at: null }, "Asia/Karachi", now)).toEqual({ day: "yesterday", time: null });
  expect(dueParts({ due_date: null, due_at: "2026-10-13T08:00:00Z" }, "Europe/Paris", now)).toEqual({ day: "tomorrow", time: "10:00" });
  expect(dueParts({ due_date: null, due_at: "2026-10-13T08:00:00Z" }, "Asia/Karachi", now)).toEqual({ day: "today", time: "13:00" });
  expect(dueParts({ due_date: "2026-10-20", due_at: null }, "Europe/Paris", now)).toEqual({ day: "2026-10-20", time: null });
  expect(dueParts({ due_date: null, due_at: null }, "Europe/Paris", now)).toEqual({ day: "none", time: null });
});

test("GET /api/tasks parameters: buckets whitelisted, a cursor needs its id", () => {
  const after = "00000000-0000-4000-8000-000000000001";
  expect(tasksParams.safeParse({ bucket: "today" }).success).toBe(true);
  expect(tasksParams.safeParse({ bucket: "today", scope: "team" }).success).toBe(true);
  expect(tasksParams.safeParse({ bucket: "cancelled" }).success).toBe(false);
  expect(tasksParams.safeParse({ bucket: "today", scope: "org" }).success).toBe(false);
  expect(tasksParams.safeParse({ bucket: "today", after_sort: "2026-10-12T10:00:00Z", after_id: after }).success).toBe(true);
  expect(tasksParams.safeParse({ bucket: "today", after_sort: "2026-10-12T10:00:00Z" }).success).toBe(false);
  expect(tasksParams.safeParse({ bucket: "today", after_id: after }).success).toBe(false);
  // Upcoming's undated rows carry no time.
  expect(tasksParams.safeParse({ bucket: "upcoming", after_id: after }).success).toBe(true);
  expect(tasksParams.safeParse({ bucket: "today", sql: "x" }).success).toBe(false);
});

test("next cursor from the last row of a full page only", () => {
  const row = (n: number, sort: string | null) => ({ id: `id-${n}`, sort_at: sort }) as TaskListRow;
  expect(nextCursor([row(1, "2026-10-12T10:00:00Z")], 2)).toBeNull();
  expect(nextCursor([row(1, "2026-10-12T10:00:00Z"), row(2, null)], 2)).toEqual({ after_sort: null, after_id: "id-2" });
});

test("edit: a date or a time, a clean title, no extra fields", () => {
  const base = { id: "00000000-0000-4000-8000-000000000001", title: "Call back", dueDate: "2026-10-13", dueAt: null, assigneeId: null, contactId: null };
  expect(updateTaskInput.safeParse(base).success).toBe(true);
  expect(updateTaskInput.safeParse({ ...base, dueAt: "2026-10-13T08:00:00Z" }).success).toBe(false);
  expect(updateTaskInput.safeParse({ ...base, title: "  " }).success).toBe(false);
  expect(updateTaskInput.safeParse({ ...base, title: "a\u202Eb" }).success).toBe(false);
  expect(updateTaskInput.safeParse({ ...base, kind: "meeting" }).success).toBe(false);
});
