import { z } from "zod";
import { UNSAFE_TEXT, isoDate, isoInstant } from "@/lib/activities";
import { addDays, localDate, localParts, weekdayOf } from "@/lib/timezones";

// Tasks on a lead (Day 4 design 3.1 and 7.1). Kinds match the database's tasks.kind check (day4-parity.spec.ts).
export const TASK_KINDS = ["todo", "call", "meeting"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_TITLE_MAX = 300;

const uuid = z.uuid();
// Titles: no control characters at all (tasks_title_safe), 1 to 300 characters after trimming.
const title = z
  .string()
  .trim()
  .min(1)
  .refine((s) => Array.from(s).length <= TASK_TITLE_MAX)
  .refine((s) => !UNSAFE_TEXT.test(s) && !/[\t\n\u0000]/.test(s));

/** Add a task (server action createTask). A date or a time, not both; a meeting needs a time (tasks_one_due, tasks_meeting_timed). */
export const createTaskInput = z
  .strictObject({
    title,
    leadId: uuid.nullable(),
    contactId: uuid.nullable(),
    kind: z.enum(TASK_KINDS),
    dueDate: isoDate.nullable(),
    dueAt: isoInstant.nullable(),
    assigneeId: uuid.nullable(),
    requestId: uuid,
  })
  .superRefine((v, ctx) => {
    if (v.dueDate !== null && v.dueAt !== null) ctx.addIssue({ code: "custom", path: ["dueAt"], message: "task_due" });
    if (v.kind === "meeting" && v.dueAt === null) ctx.addIssue({ code: "custom", path: ["dueAt"], message: "task_due" });
    if (v.contactId !== null && v.leadId === null) ctx.addIssue({ code: "custom", path: ["contactId"], message: "contact" });
  });

/** Done and dismissed are switches (set_task_done, set_task_cancelled): the server sets the times. */
export const taskSwitchInput = z.strictObject({ id: uuid, on: z.boolean() });

/** How many of a lead's open tasks Next step lists (one more is asked for, to know there are more). */
export const LEAD_TASKS_SHOWN = 20;

/** One task of a lead (list_lead_tasks). */
export type LeadTask = {
  id: string;
  title: string;
  kind: TaskKind;
  due_date: string | null;
  due_at: string | null;
  done_at: string | null;
  assignee_id: string | null;
  assignee_first_name: string | null;
  assignee_last_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  created_by: string | null;
  source_activity_id: string | null;
  created_at: string;
};

export type TaskSwitch = { id: string; done_at: string | null; completed_by: string | null; cancelled_at: string | null };

/** Date chips (composer follow-ups, quick add): calendar dates in the viewer's zone. */
export const DATE_CHIPS = ["today", "tomorrow", "in2days", "nextWeek"] as const;
export type DateChip = (typeof DATE_CHIPS)[number];

/**
 * The calendar date a chip stands for, in `zone` at `now`. "Next week" is the next Monday after today (on a Sunday that
 * is tomorrow: the coming week starts then).
 */
export function chipDate(chip: DateChip, zone: string, now: Date): string {
  const today = localDate(zone, now);
  if (chip === "today") return today;
  if (chip === "tomorrow") return addDays(today, 1);
  if (chip === "in2days") return addDays(today, 2);
  return addDays(today, 8 - weekdayOf(today));
}

/** True when a task is due before today in `zone` (all-day) or before now (timed): shown as "Overdue". */
export function isOverdue(task: Pick<LeadTask, "due_date" | "due_at" | "done_at">, zone: string, now: Date): boolean {
  if (task.done_at) return false;
  if (task.due_at) return new Date(task.due_at).getTime() < now.getTime();
  if (task.due_date) return task.due_date < localDate(zone, now);
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// The Tasks page (Day 4c, design 5.6 and 7.5): buckets in the caller's own time zone (profiles.timezone), worked out by
// the database; the same rules here only place a task the screen has just changed until the list is read again.

export const TASK_BUCKETS = ["overdue", "today", "upcoming", "done"] as const;
export type TaskBucket = (typeof TASK_BUCKETS)[number];
/** The tabs in screen order (Today first: what to do now). */
export const TASK_TABS = ["today", "overdue", "upcoming", "done"] as const satisfies readonly TaskBucket[];
export const TASK_SCOPES = ["mine", "team"] as const;
export type TaskScope = (typeof TASK_SCOPES)[number];
/** Rows per page (keyset; the database takes 1 to 100). */
export const TASK_PAGE_SIZE = 50;
/** Quick-add date chips (plus "Pick a date"). */
export const QUICK_CHIPS = ["today", "tomorrow", "nextWeek"] as const satisfies readonly DateChip[];

/** One row of list_tasks. */
export type TaskListRow = {
  id: string;
  title: string;
  kind: TaskKind;
  due_date: string | null;
  due_at: string | null;
  done_at: string | null;
  assignee_id: string | null;
  assignee_first_name: string | null;
  assignee_last_name: string | null;
  company_id: string | null;
  company_name: string | null;
  company_call_zone: string | null;
  company_lead_status: string | null;
  contact_id: string | null;
  contact_name: string | null;
  created_by: string | null;
  sort_at: string | null;
  can_edit: boolean;
  /** Browser only: a task added from this screen and not yet confirmed. */
  pending?: boolean;
};

export type TaskCursor = { after_sort: string | null; after_id: string };
export type TaskPage = { rows: TaskListRow[]; next: TaskCursor | null };
export type TaskCounts = { overdue: number; today: number; upcoming: number };

/** Query parameters of GET /api/tasks. A cursor needs its id; its time may be absent only in Upcoming (undated rows). */
export const tasksParams = z
  .strictObject({
    bucket: z.enum(TASK_BUCKETS),
    scope: z.enum(TASK_SCOPES).optional(),
    after_sort: isoInstant.optional(),
    after_id: uuid.optional(),
  })
  .refine((v) => (v.after_sort === undefined || v.after_id !== undefined) && (v.after_id === undefined || v.after_sort !== undefined || v.bucket === "upcoming"));

/** The next page's cursor from the last row of a full page (Upcoming's undated rows carry a null time). */
export function nextCursor(rows: readonly TaskListRow[], limit: number): TaskCursor | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  return { after_sort: last.sort_at, after_id: last.id };
}

/** Edit a task (update_task): title, a date or a time (not both), who it is for (null keeps them), the contact. */
export const updateTaskInput = z
  .strictObject({
    id: uuid,
    title,
    dueDate: isoDate.nullable(),
    dueAt: isoInstant.nullable(),
    assigneeId: uuid.nullable(),
    contactId: uuid.nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.dueDate !== null && v.dueAt !== null) ctx.addIssue({ code: "custom", path: ["dueAt"], message: "task_due" });
  });
export type UpdateTaskInput = z.infer<typeof updateTaskInput>;
export const taskIdInput = z.strictObject({ id: uuid });

/** What update_task answers. */
export type UpdatedTask = {
  id: string;
  title: string;
  kind: TaskKind;
  due_date: string | null;
  due_at: string | null;
  assignee_id: string | null;
  contact_id: string | null;
  done_at: string | null;
  cancelled_at: string | null;
  updated_at: string;
};

/** The bucket an open task belongs to in `zone` at `now` (the database's rules, design 5.6); done tasks are "done". */
export function bucketOf(task: Pick<TaskListRow, "due_date" | "due_at" | "done_at">, zone: string, now: Date): TaskBucket {
  if (task.done_at) return "done";
  const today = localDate(zone, now);
  if (task.due_at) {
    const at = new Date(task.due_at);
    if (at.getTime() < now.getTime()) return "overdue";
    return localDate(zone, at) === today ? "today" : "upcoming";
  }
  if (task.due_date) return task.due_date < today ? "overdue" : task.due_date === today ? "today" : "upcoming";
  return "upcoming";
}

/**
 * A task's due label parts in `zone`: the day ("today", "tomorrow", "yesterday" or the calendar date) and the time
 * ("10:00", 24-hour) for a timed task. The screen words them ("Tomorrow 10:00", "Mon 14 Oct").
 */
export function dueParts(task: Pick<TaskListRow, "due_date" | "due_at">, zone: string, now: Date): { day: "today" | "tomorrow" | "yesterday" | "none" | string; time: string | null } {
  if (!task.due_date && !task.due_at) return { day: "none", time: null };
  const today = localDate(zone, now);
  let date: string;
  let time: string | null = null;
  if (task.due_at) {
    const parts = localParts(zone, new Date(task.due_at));
    date = parts.date;
    time = `${String(Math.floor(parts.minutes / 60)).padStart(2, "0")}:${String(parts.minutes % 60).padStart(2, "0")}`;
  } else {
    date = task.due_date as string;
  }
  const day = date === today ? "today" : date === addDays(today, 1) ? "tomorrow" : date === addDays(today, -1) ? "yesterday" : date;
  return { day, time };
}
