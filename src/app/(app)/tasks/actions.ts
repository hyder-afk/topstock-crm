"use server";

import { requireSession } from "@/lib/auth";
import { invalid, toActionFailure, type ActionResult } from "@/lib/db-errors";
import { createTaskInput, taskIdInput, taskSwitchInput, updateTaskInput, type TaskSwitch, type UpdatedTask } from "@/lib/tasks";

// The Tasks page's writes (Day 4 design 4.2). Each action: Zod strictObject first, then requireSession() (two-factor
// sessions only), then one database function with its arguments named one by one (never a spread of client input).
// The task guard and policies decide who may change what (reps keep tasks to themselves); the server sets every time
// (done, dismissed). Deleting needs a fresh code: the database answers step_up and the screen asks, then retries.
// Answers carry codes only, never database text.

export async function createTask(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = createTaskInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues.some((i) => i.message === "task_due") ? "task_due" : "task_title");
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

export async function updateTask(input: unknown): Promise<ActionResult<UpdatedTask>> {
  const parsed = updateTaskInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues.some((i) => i.message === "task_due") ? "task_due" : "task_title");
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("update_task", {
    p_id: v.id,
    p_title: v.title,
    p_due_date: v.dueDate,
    p_due_at: v.dueAt,
    p_assignee: v.assigneeId,
    p_contact: v.contactId,
  });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as UpdatedTask };
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

export async function deleteTask(input: unknown): Promise<ActionResult<null>> {
  const parsed = taskIdInput.safeParse(input);
  if (!parsed.success) return invalid();
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("delete_task", { p_id: parsed.data.id });
  if (error) return toActionFailure(error);
  return { ok: true, data: null };
}
