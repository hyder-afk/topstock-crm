"use client";

import { useInfiniteQuery, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { TaskBucket, TaskCounts, TaskCursor, TaskListRow, TaskPage, TaskScope } from "@/lib/tasks";

// The Tasks page's data (Day 4 design 7.5): one infinite query per scope and tab, ["tasks", scope, bucket], pages of
// 50 from GET /api/tasks (keyset). The first page carries the tab counts.
export type TaskPageWithCounts = TaskPage & { counts: TaskCounts | null };

export const tasksKey = (scope: TaskScope, bucket: TaskBucket) => ["tasks", scope, bucket] as const;

export async function fetchTasks(bucket: TaskBucket, scope: TaskScope, cursor: TaskCursor | null): Promise<TaskPageWithCounts> {
  const params = new URLSearchParams({ bucket });
  if (scope !== "mine") params.set("scope", scope);
  if (cursor) {
    if (cursor.after_sort) params.set("after_sort", cursor.after_sort);
    params.set("after_id", cursor.after_id);
  }
  const res = await fetch(`/api/tasks?${params.toString()}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as TaskPageWithCounts;
}

export function useTaskList(scope: TaskScope, bucket: TaskBucket, initial: TaskPageWithCounts | null) {
  return useInfiniteQuery({
    queryKey: tasksKey(scope, bucket),
    queryFn: ({ pageParam }) => fetchTasks(bucket, scope, pageParam),
    initialPageParam: null as TaskCursor | null,
    getNextPageParam: (last) => last.next,
    initialData: initial ? { pages: [initial], pageParams: [null] } : undefined,
    staleTime: 15_000,
  });
}

export function prefetchTasks(queryClient: QueryClient, scope: TaskScope, bucket: TaskBucket) {
  void queryClient.prefetchInfiniteQuery({
    queryKey: tasksKey(scope, bucket),
    queryFn: ({ pageParam }) => fetchTasks(bucket, scope, pageParam as TaskCursor | null),
    initialPageParam: null as TaskCursor | null,
    staleTime: 15_000,
  });
}

type Lists = InfiniteData<TaskPageWithCounts>;
export type ListsSnapshot = [readonly unknown[], Lists | undefined][];

/**
 * Takes a task off every loaded list (optimistic), and answers what was there, to put it back on failure. A list read
 * still on its way is cancelled first (as the 4b timeline does), so an answer that started before this change cannot
 * bring the task back.
 */
export async function removeTask(queryClient: QueryClient, id: string): Promise<ListsSnapshot> {
  await queryClient.cancelQueries({ queryKey: ["tasks"] });
  const snapshot = queryClient.getQueriesData<Lists>({ queryKey: ["tasks"] });
  queryClient.setQueriesData<Lists>({ queryKey: ["tasks"] }, (old) =>
    old ? { ...old, pages: old.pages.map((p) => ({ ...p, rows: p.rows.filter((r) => r.id !== id) })) } : old,
  );
  return snapshot;
}

/**
 * A change that failed puts back its own task only, at the place it had in each list of the snapshot; everything else
 * stays as the lists are now (bugs audit M5: putting back whole lists brought back a task ticked since, on its old tab).
 */
export function restoreTask(queryClient: QueryClient, snapshot: ListsSnapshot, id: string) {
  for (const [key, before] of snapshot) {
    const page = before?.pages.findIndex((p) => p.rows.some((r) => r.id === id)) ?? -1;
    if (!before || page < 0) continue;
    const index = before.pages[page].rows.findIndex((r) => r.id === id);
    const row = before.pages[page].rows[index];
    queryClient.setQueryData<Lists>(key, (old) => {
      if (!old?.pages.length || old.pages.some((p) => p.rows.some((r) => r.id === id))) return old;
      const at = Math.min(page, old.pages.length - 1);
      return { ...old, pages: old.pages.map((p, i) => (i === at ? { ...p, rows: [...p.rows.slice(0, index), row, ...p.rows.slice(index)] } : p)) };
    });
  }
}

/** Puts a just-added task at the top of a loaded list (shown at once, replaced when the list is read again). */
export function insertTask(queryClient: QueryClient, scope: TaskScope, bucket: TaskBucket, row: TaskListRow) {
  queryClient.setQueryData<Lists>(tasksKey(scope, bucket), (old) =>
    old ? { ...old, pages: old.pages.map((p, i) => (i === 0 ? { ...p, rows: [row, ...p.rows] } : p)) } : old,
  );
}

/** Everything the Tasks page, the lead pages and Home's Today card show about tasks is read again. */
export function refreshTasks(queryClient: QueryClient, leadId?: string | null) {
  void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  void queryClient.invalidateQueries({ queryKey: ["home"] });
  if (leadId) void queryClient.invalidateQueries({ queryKey: ["lead-tasks", leadId] });
}
