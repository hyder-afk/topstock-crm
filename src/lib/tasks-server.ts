import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TASK_PAGE_SIZE, nextCursor, type TaskBucket, type TaskCounts, type TaskCursor, type TaskListRow, type TaskPage, type TaskScope } from "@/lib/tasks";

// One page of a Tasks tab (list_tasks, keyset) and the tab counts (count_tasks). Shared by the Tasks page (first
// page, server-rendered) and GET /api/tasks. "invalid": the database refused the request itself (a bad cursor);
// "forbidden": a scope reserved to managers and admins; null: it could not answer.
export async function fetchTaskPage(
  supabase: SupabaseClient,
  bucket: TaskBucket,
  scope: TaskScope,
  cursor: TaskCursor | null,
): Promise<TaskPage | "invalid" | "forbidden" | null> {
  const { data, error } = await supabase.rpc("list_tasks", {
    p_bucket: bucket,
    p_scope: scope,
    p_after_sort: cursor?.after_sort ?? null,
    p_after_id: cursor?.after_id ?? null,
    p_limit: TASK_PAGE_SIZE,
  });
  if (error?.code === "22023") return "invalid";
  if (error?.code === "42501") return "forbidden";
  if (error) return null;
  const rows = (data ?? []) as TaskListRow[];
  return { rows, next: nextCursor(rows, TASK_PAGE_SIZE) };
}

export async function fetchTaskCounts(supabase: SupabaseClient, scope: TaskScope): Promise<TaskCounts | null> {
  const { data, error } = await supabase.rpc("count_tasks", { p_scope: scope });
  return error ? null : (data as TaskCounts);
}
