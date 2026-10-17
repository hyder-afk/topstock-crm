import { expect, test } from "@playwright/test";
import {
  InfiniteQueryObserver,
  QueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  refreshTasks,
  removeTask,
  restoreTask,
  tasksKey,
  type TaskPageWithCounts,
} from "@/components/tasks/use-tasks";
import type { TaskListRow } from "@/lib/tasks";

// The Tasks page's optimistic removal (Day 4c review finding 12): a list read already on its way when a task is taken
// off must not bring the task back when it lands (keyboard triage: X on A starts a refetch; X on B 300 ms later).
const row = (id: string): TaskListRow => ({
  id,
  title: `Task ${id}`,
  kind: "todo",
  due_date: "2026-10-12",
  due_at: null,
  done_at: null,
  assignee_id: null,
  assignee_first_name: null,
  assignee_last_name: null,
  company_id: null,
  company_name: null,
  company_call_zone: null,
  company_lead_status: null,
  contact_id: null,
  contact_name: null,
  created_by: null,
  sort_at: null,
  can_edit: true,
});
const page = (ids: string[]): TaskPageWithCounts => ({
  rows: ids.map(row),
  next: null,
  counts: null,
});
const shown = (client: QueryClient) =>
  client
    .getQueryData<InfiniteData<TaskPageWithCounts>>(tasksKey("mine", "today"))
    ?.pages.flatMap((p) => p.rows.map((r) => r.id));

test("a list read in flight does not bring back a task removed meanwhile", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The server's answer is read when the request starts (B still open), and arrives 100 ms later.
  let db = ["B", "C"];
  const observer = new InfiniteQueryObserver(client, {
    queryKey: tasksKey("mine", "today"),
    queryFn: async () => {
      const answer = page(db);
      await new Promise((r) => setTimeout(r, 100));
      return answer;
    },
    initialPageParam: null,
    getNextPageParam: () => null,
  });
  const stop = observer.subscribe(() => {});
  await expect.poll(() => shown(client)).toEqual(["B", "C"]);
  // A's action finished: the list is read again (B still open in that read).
  void client.invalidateQueries({ queryKey: ["tasks"] });
  await new Promise((r) => setTimeout(r, 30));
  // X on B while that read is on its way; B's action then commits.
  await removeTask(client, "B");
  db = ["C"];
  expect(shown(client)).toEqual(["C"]);
  await new Promise((r) => setTimeout(r, 150));
  expect(shown(client)).toEqual(["C"]);
  stop();
  client.clear();
});

// Bugs audit M5: A and B ticked one after the other (B is off the lists while its action waits behind A's), then A's
// fails. Only A comes back, at its place; putting back the whole lists from A's snapshot brought B back on its old tab.
test("a failed tick puts back its own task only, where it was", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(tasksKey("mine", "today"), { pages: [page(["A", "B", "C"])], pageParams: [null] });
  client.setQueryData(tasksKey("mine", "done"), { pages: [page(["D"])], pageParams: [null] });
  const snapA = await removeTask(client, "A");
  await removeTask(client, "B");
  expect(shown(client)).toEqual(["C"]);
  restoreTask(client, snapA, "A");
  expect(shown(client)).toEqual(["A", "C"]);
  // Already back (a refetch brought it): not added twice; a list that never held it is left alone.
  restoreTask(client, snapA, "A");
  expect(shown(client)).toEqual(["A", "C"]);
  expect(client.getQueryData<InfiniteData<TaskPageWithCounts>>(tasksKey("mine", "done"))?.pages[0].rows.map((r) => r.id)).toEqual(["D"]);
  client.clear();
});

// Bugs audit L3: a task ticked on the Tasks page left Home's Today card stale (and the reverse, see today-card.tsx).
test("refreshTasks reads Home again with the task lists", () => {
  const client = new QueryClient();
  client.setQueryData(["home", "mine"], { any: 1 });
  client.setQueryData(tasksKey("mine", "today"), { pages: [page(["A"])], pageParams: [null] });
  client.setQueryData(["lead-tasks", "L"], []);
  refreshTasks(client, "L");
  expect(client.getQueryState(["home", "mine"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(tasksKey("mine", "today"))?.isInvalidated).toBe(true);
  expect(client.getQueryState(["lead-tasks", "L"])?.isInvalidated).toBe(true);
  client.clear();
});
