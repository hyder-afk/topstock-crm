import { expect, test } from "@playwright/test";
import { buildToday, dateInZone, listTaskRows, overdueDays, taskCounts, type ListTaskRow } from "@/lib/home";

// The Today card from Day 4c's list_tasks and count_tasks (since the 4c rebase): overdue first, then the day's meetings,
// then the rest; whole days late counted in the profile zone from the database's own "today". Instants are chosen far
// from any clock change (Karachi has none; Paris is on summer time until 25 Oct 2026), so other ICU zone data agree.
const row = (over: Partial<ListTaskRow>): ListTaskRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  title: "Call back",
  kind: "call",
  due_date: null,
  due_at: null,
  company_id: null,
  company_name: null,
  company_call_zone: null,
  ...over,
});

test("dateInZone gives the calendar date of an instant in a zone", () => {
  expect(dateInZone(new Date("2026-10-13T22:30:00Z"), "Asia/Karachi")).toBe("2026-10-14");
  expect(dateInZone(new Date("2026-10-13T21:30:00Z"), "Europe/Paris")).toBe("2026-10-13");
  expect(dateInZone(new Date("2026-10-13T22:30:00Z"), "Europe/Paris")).toBe("2026-10-14");
  expect(dateInZone(new Date("2026-10-13T22:30:00Z"), "Mars/Olympus")).toBeNull();
});

test("overdueDays counts whole days in the profile zone, 0 for earlier today", () => {
  expect(overdueDays({ due_date: "2026-10-11", due_at: null }, "2026-10-16", "Europe/Paris")).toBe(5);
  expect(overdueDays({ due_date: "2026-10-16", due_at: null }, "2026-10-16", "Europe/Paris")).toBe(0);
  // 22:30 UTC on the 13th is already the 14th in Karachi (UTC+5) but still the 13th in Los Angeles.
  expect(overdueDays({ due_date: null, due_at: "2026-10-13T22:30:00Z" }, "2026-10-16", "Asia/Karachi")).toBe(2);
  expect(overdueDays({ due_date: null, due_at: "2026-10-13T22:30:00Z" }, "2026-10-16", "America/Los_Angeles")).toBe(3);
  expect(overdueDays({ due_date: "2026-10-11", due_at: null }, null, "Europe/Paris")).toBeNull();
  expect(overdueDays({ due_date: null, due_at: "2026-10-13T22:30:00Z" }, "2026-10-16", null)).toBeNull();
  expect(overdueDays({ due_date: "2026-10-18", due_at: null }, "2026-10-16", "Europe/Paris")).toBeNull();
});

test("buildToday: overdue first, then meetings, then the rest, at most six; counts from count_tasks", () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const overdue = [row({ id: id(1), due_date: "2026-10-11" }), row({ id: id(2), due_date: "2026-10-15" })];
  const today = [
    row({ id: id(3), kind: "todo", due_date: "2026-10-16" }),
    row({ id: id(4), kind: "meeting", due_at: "2026-10-16T12:00:00Z", company_call_zone: "Asia/Karachi" }),
    row({ id: id(5), kind: "call", due_at: "2026-10-16T14:00:00Z" }),
    row({ id: id(6), kind: "meeting", due_at: "2026-10-16T15:00:00Z" }),
    row({ id: id(7), kind: "todo", due_date: "2026-10-16" }),
  ];
  const t = buildToday(overdue, today, { overdue: 2, today: 9, upcoming: 4 }, { today: "2026-10-16", zone: "Europe/Paris" });
  expect(t.items.map((i) => i.id)).toEqual([id(1), id(2), id(4), id(6), id(3), id(5)]);
  expect(t.items.map((i) => i.overdue)).toEqual([true, true, false, false, false, false]);
  expect(t.items.map((i) => i.overdue_days)).toEqual([5, 1, null, null, null, null]);
  expect(t.items[2].company_call_zone).toBe("Asia/Karachi");
  expect([t.total, t.overdue]).toEqual([11, 2]);
  // Without the day (the summary failed), overdue rows still show, without a day count.
  expect(buildToday(overdue, [], { overdue: 2, today: 0, upcoming: 0 }, null).items.map((i) => i.overdue_days)).toEqual([null, null]);
});

test("list_tasks rows and count_tasks parse, unknown columns dropped, a wrong shape refused", () => {
  const parsed = listTaskRows.safeParse([{ ...row({}), assignee_id: "x", sort_at: "2026-10-16T00:00:00Z", can_edit: true }]);
  expect(parsed.success).toBe(true);
  expect(parsed.success && Object.keys(parsed.data[0])).not.toContain("assignee_id");
  expect(listTaskRows.safeParse([{ ...row({}), kind: "party" }]).success).toBe(false);
  expect(taskCounts.safeParse({ overdue: 1, today: 2, upcoming: 3 }).success).toBe(true);
  expect(taskCounts.safeParse({ overdue: -1, today: 2, upcoming: 3 }).success).toBe(false);
});
