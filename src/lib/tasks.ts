import { z } from "zod";
import { UNSAFE_TEXT, isoDate, isoInstant } from "@/lib/activities";
import { addDays, localDate, weekdayOf } from "@/lib/timezones";

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
