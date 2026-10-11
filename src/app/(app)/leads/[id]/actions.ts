"use server";

import { getTranslations } from "next-intl/server";
import { z } from "zod";
import {
  activityIdInput,
  editActivityInput,
  isoInstant,
  logActivityInput,
  type LoggedActivity,
  type UndoneActivity,
} from "@/lib/activities";
import { requireSession } from "@/lib/auth";
import { INVALID_HINTS, invalid, toActionFailure, type ActionResult, type InvalidHint } from "@/lib/db-errors";
import { createTaskInput, taskSwitchInput, type TaskSwitch } from "@/lib/tasks";

// The lead page's writes (Day 4 design 4.1). Each action: Zod strictObject first (nothing unknown passes), then
// requireSession() (two-factor sessions only; anything else is sent back to sign in), then one database function with
// its arguments named one by one (never a spread of client input). Row level security and the functions decide who
// may change what; the answer is { ok: true, data } or { ok: false, error, hint } with codes only, never database
// text. Deletes need a fresh code: the database answers step_up and the screen asks for one, then retries.

// The Zod refusal worded like the database's (the first issue that names a known hint).
const zodHints: Record<string, InvalidHint> = { too_long: "body_too_long", chars: "body_chars" };
function zodHint(error: z.ZodError): InvalidHint | undefined {
  for (const issue of error.issues) {
    const hint = zodHints[issue.message] ?? issue.message;
    if ((INVALID_HINTS as readonly string[]).includes(hint)) return hint as InvalidHint;
  }
  return undefined;
}

export async function logActivity(input: unknown): Promise<ActionResult<LoggedActivity>> {
  const parsed = logActivityInput.safeParse(input);
  if (!parsed.success) return invalid(zodHint(parsed.error));
  const v = parsed.data;
  const { supabase } = await requireSession();
  // The follow-up task's title in the caller's language (used only when the entry makes a task).
  const t = await getTranslations("Outcomes.taskTitle");
  const meeting = v.outcome === "meeting_booked" || (v.type === "meeting" && v.outcome === null);
  const taskTitle =
    v.outcome === "wrong_number" ? t("rightNumber", { lead: v.leadName }) : meeting ? t("meeting", { lead: v.leadName }) : t("followUp", { lead: v.leadName });
  const { data, error } = await supabase.rpc("log_activity", {
    p_company: v.leadId,
    p_type: v.type,
    p_outcome: v.outcome,
    p_body: v.body.trim() === "" ? null : v.body,
    p_contact: v.contactId,
    p_dialled: v.dialled,
    p_follow_up_date: v.followUpDate,
    p_follow_up_at: v.followUpAt,
    p_task_title: taskTitle,
    p_request_id: v.requestId,
    p_from_queue: false,
  });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as LoggedActivity };
}

export async function undoActivity(input: unknown): Promise<ActionResult<UndoneActivity>> {
  const parsed = activityIdInput.safeParse(input);
  if (!parsed.success) return invalid();
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("undo_activity", { p_id: parsed.data.id });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as UndoneActivity };
}

export async function editActivity(input: unknown): Promise<ActionResult<null>> {
  const parsed = editActivityInput.safeParse(input);
  if (!parsed.success) return invalid(zodHint(parsed.error));
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("edit_activity", { p_id: parsed.data.id, p_body: parsed.data.body });
  if (error) return toActionFailure(error);
  return { ok: true, data: null };
}

export async function deleteActivity(input: unknown): Promise<ActionResult<null>> {
  const parsed = activityIdInput.safeParse(input);
  if (!parsed.success) return invalid();
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("delete_activity", { p_id: parsed.data.id });
  if (error) return toActionFailure(error);
  return { ok: true, data: null };
}

// An IANA zone name ("America/Los_Angeles"); the database checks it is one of the lead's country's zones.
const zoneId = z.string().max(64).regex(/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/);
const timezoneInput = z.strictObject({ leadId: z.uuid(), timezone: zoneId.nullable() });

export async function setLeadTimezone(input: unknown): Promise<ActionResult<{ timezone: string | null; call_zone_key: string }>> {
  const parsed = timezoneInput.safeParse(input);
  if (!parsed.success) return invalid("zone_not_in_country");
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("set_lead_timezone", { p_id: parsed.data.leadId, p_timezone: parsed.data.timezone });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as { timezone: string | null; call_zone_key: string } };
}

const nextActionInput = z.strictObject({ leadId: z.uuid(), at: isoInstant.nullable() });

export async function setNextAction(input: unknown): Promise<ActionResult<{ next_action_at: string | null }>> {
  const parsed = nextActionInput.safeParse(input);
  if (!parsed.success) return invalid("bounds");
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("set_lead_next_action", { p_id: parsed.data.leadId, p_at: parsed.data.at });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as { next_action_at: string | null } };
}

export async function createTask(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = createTaskInput.safeParse(input);
  if (!parsed.success) return invalid(zodHint(parsed.error) ?? "task_title");
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("create_task", {
    p_title: v.title,
    p_company: v.leadId,
    p_contact: v.contactId,
    p_kind: v.kind,
    p_due_date: v.dueDate,
    p_due_at: v.dueAt,
    p_assignee: v.assigneeId,
    p_request_id: v.requestId,
  });
  if (error) return toActionFailure(error);
  return { ok: true, data: { id: data as string } };
}

export async function setTaskDone(input: unknown): Promise<ActionResult<TaskSwitch>> {
  const parsed = taskSwitchInput.safeParse(input);
  if (!parsed.success) return invalid("state");
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("set_task_done", { p_id: parsed.data.id, p_done: parsed.data.on });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as TaskSwitch };
}

export async function setTaskCancelled(input: unknown): Promise<ActionResult<TaskSwitch>> {
  const parsed = taskSwitchInput.safeParse(input);
  if (!parsed.success) return invalid("state");
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("set_task_cancelled", { p_id: parsed.data.id, p_cancelled: parsed.data.on });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as TaskSwitch };
}
