"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { createTask, deleteTask, setTaskCancelled, setTaskDone, updateTask } from "@/app/(app)/tasks/actions";
import { useStepUp } from "@/components/auth/step-up-dialog";
import { useClientNow } from "@/components/lead/local-time";
import { QuickAdd, type QuickTask } from "@/components/tasks/quick-add";
import { TaskRow, type RowActions } from "@/components/tasks/task-row";
import { insertTask, prefetchTasks, refreshTasks, removeTask, restoreLists, useTaskList, type TaskPageWithCounts } from "@/components/tasks/use-tasks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { TabList, TabPanel } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/db-errors";
import { retryKeepingFocus } from "@/lib/focus";
import type { TeamMember } from "@/lib/leads";
import { isTyping } from "@/lib/shortcuts";
import { TASK_TABS, bucketOf, type TaskBucket, type TaskCounts, type TaskListRow, type TaskScope } from "@/lib/tasks";
import { cn } from "@/lib/utils";

const ID_BASE = "tasks";

// The Tasks page (Day 4 design 7.5): a single centred column of 880 px at most. Title; Today · Overdue · Upcoming ·
// Done tabs with their counts (count_tasks); Mine / Team for managers and admins; quick add; 56 px rows. Buckets follow
// the person's own time zone (the database decides; this page shows labels in the same zone). Done (X or Space) and
// Dismiss (D) take effect at once with Undo; Delete (⌫) asks first, then a fresh code. J and K move between tasks, E
// edits inline, Enter opens the task's lead, T starts a new task. Focus never drops to the page when a row leaves.
export function TasksWorkspace({
  initialTab,
  initialScope,
  initialPage,
  zone,
  canTeam,
  team,
  stepUpSeconds,
}: {
  initialTab: TaskBucket;
  initialScope: TaskScope;
  initialPage: TaskPageWithCounts | null;
  zone: string;
  canTeam: boolean;
  team: TeamMember[];
  stepUpSeconds: number;
}) {
  const t = useTranslations("Tasks");
  const tErr = useTranslations("Errors");
  const format = useFormatter();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useClientNow(30_000);
  const [tab, setTabState] = useState<TaskBucket>(initialTab);
  const [scope, setScopeState] = useState<TaskScope>(initialScope);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ task: TaskListRow; from: HTMLElement } | null>(null);
  const quickRef = useRef<HTMLInputElement>(null);
  // Where the focus goes back when the delete question closes (the state is cleared before Radix asks).
  const deleteFrom = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { ensureFresh, requireFresh, dialog: stepUpDialog } = useStepUp(stepUpSeconds, "bodyDeleteTask");
  // The server read the first tab: its page seeds that query only.
  const initial = initialTab === tab && initialScope === scope ? initialPage : null;
  const list = useTaskList(scope, tab, initial);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.rows) ?? [], [list.data]);
  // The counts from the latest first page read (any tab), kept while another tab loads.
  const [counts, setCounts] = useState<TaskCounts | null>(initialPage?.counts ?? null);
  const fresh = list.data?.pages[0]?.counts ?? null;
  const [seen, setSeen] = useState(fresh);
  if (fresh !== seen) {
    setSeen(fresh);
    if (fresh) setCounts(fresh);
  }

  const writeUrl = useCallback((nextTab: TaskBucket, nextScope: TaskScope) => {
    const url = new URL(window.location.href);
    if (nextTab === "today") url.searchParams.delete("tab");
    else url.searchParams.set("tab", nextTab);
    if (nextScope === "mine") url.searchParams.delete("scope");
    else url.searchParams.set("scope", nextScope);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  }, []);
  const setTab = (next: TaskBucket) => {
    setTabState(next);
    setEditing(null);
    writeUrl(next, scope);
  };
  const setScope = (next: TaskScope) => {
    setScopeState(next);
    setEditing(null);
    writeUrl(tab, next);
  };

  const fail = useCallback((res: Extract<ActionResult<unknown>, { ok: false }>) => {
    toast.show(tErr(res.error === "invalid" && res.hint ? `hint.${res.hint}` : res.error));
  }, [toast, tErr]);

  // The control that should take the focus when this row leaves the list: the next row's check, else the previous
  // one's, else the list's tab panel (WCAG 2.4.3; the 4b lesson: focus never falls to <body>).
  const focusAfterLeaving = useCallback((from: HTMLElement) => {
    const row = from.closest("li");
    const check = (el: Element | null | undefined) => el?.querySelector<HTMLElement>("[data-task-check]") ?? null;
    const target = check(row?.nextElementSibling) ?? check(row?.previousElementSibling) ?? document.getElementById(`${ID_BASE}-panel-${tab}`);
    target?.focus({ preventScroll: true });
    return target;
  }, [tab]);

  const actions = useMemo<RowActions>(() => {
    const call = async <T,>(p: Promise<ActionResult<T>>): Promise<ActionResult<T>> => p.catch(() => ({ ok: false as const, error: "unavailable" as const }));
    return {
      toggle: (task, check, failed) => {
        const on = !task.done_at;
        // The check fills first, then the row leaves its list (it now belongs to another tab).
        window.setTimeout(async () => {
          focusAfterLeaving(check);
          const snapshot = await removeTask(queryClient, task.id);
          const res = await call(setTaskDone({ id: task.id, on }));
          if (!res.ok) {
            restoreLists(queryClient, snapshot);
            failed();
            fail(res);
            return;
          }
          refreshTasks(queryClient, task.company_id);
          toast.show(on ? t("done", { title: task.title }) : t("reopened", { title: task.title }), {
            label: t("undo"),
            run: async () => {
              const back = await call(setTaskDone({ id: task.id, on: !on }));
              refreshTasks(queryClient, task.company_id);
              if (!back.ok) fail(back);
            },
          });
        }, 160);
      },
      dismiss: (task, from) => {
        focusAfterLeaving(from);
        void (async () => {
          const snapshot = await removeTask(queryClient, task.id);
          const res = await call(setTaskCancelled({ id: task.id, on: true }));
          if (!res.ok) {
            restoreLists(queryClient, snapshot);
            fail(res);
            return;
          }
          refreshTasks(queryClient, task.company_id);
          toast.show(t("dismissed", { title: task.title }), {
            label: t("undo"),
            run: async () => {
              const back = await call(setTaskCancelled({ id: task.id, on: false }));
              refreshTasks(queryClient, task.company_id);
              if (!back.ok) fail(back);
            },
          });
        })();
      },
      askDelete: (task, from) => {
        deleteFrom.current = from;
        setDeleting({ task, from });
      },
      save: async (task, edit) => {
        const res = await call(updateTask({ id: task.id, title: edit.title, dueDate: edit.dueDate, dueAt: edit.dueAt, assigneeId: edit.assigneeId, contactId: task.contact_id }));
        if (!res.ok) {
          fail(res);
          return false;
        }
        refreshTasks(queryClient, task.company_id);
        toast.show(t("saved"));
        return true;
      },
    };
  }, [queryClient, toast, t, fail, focusAfterLeaving]);

  const confirmDelete = async () => {
    if (!deleting) return;
    const { task, from } = deleting;
    const fallback = () => document.getElementById(`${ID_BASE}-panel-${tab}`);
    if (!(await ensureFresh(120, fallback))) return;
    let res = await deleteTask({ id: task.id }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    if (!res.ok && res.error === "step_up") {
      if (!(await requireFresh())) return;
      res = await deleteTask({ id: task.id }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    }
    setDeleting(null);
    if (!res.ok) {
      fail(res);
      return;
    }
    // The dialog gives the focus back when it has closed: to the neighbour of the deleted task.
    deleteFrom.current = focusAfterLeaving(from);
    await removeTask(queryClient, task.id);
    refreshTasks(queryClient, task.company_id);
    toast.show(t("deleted"));
  };

  const add = async (q: QuickTask) => {
    const requestId = crypto.randomUUID();
    const res = await createTask({
      title: q.title,
      leadId: q.lead?.id ?? null,
      contactId: null,
      kind: q.kind,
      dueDate: q.dueDate,
      dueAt: q.dueAt,
      assigneeId: null,
      requestId,
    }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    if (!res.ok) {
      fail(res);
      return false;
    }
    // Shown at once in its tab when that tab is loaded (marked pending until the list is read again).
    const row: TaskListRow = {
      id: res.data.id,
      title: q.title,
      kind: q.kind,
      due_date: q.dueDate,
      due_at: q.dueAt,
      done_at: null,
      assignee_id: null,
      assignee_first_name: null,
      assignee_last_name: null,
      company_id: q.lead?.id ?? null,
      company_name: q.lead?.name ?? null,
      company_call_zone: null,
      company_lead_status: null,
      contact_id: null,
      contact_name: null,
      created_by: null,
      sort_at: q.dueAt,
      can_edit: true,
      pending: true,
    };
    const bucket = bucketOf(row, zone, new Date());
    insertTask(queryClient, "mine", bucket, row);
    refreshTasks(queryClient, q.lead?.id ?? null);
    toast.show(t("quickAdd.added", { title: q.title }));
    return true;
  };

  // Keys (not while typing, with a modifier, or while a dialog is open): T new task, J/K move, X done, E edit,
  // D dismiss, Backspace/Delete delete, Enter on a task opens its lead. Attached once; it always runs the latest handler.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    keyHandler.current = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target) || document.querySelector("[role=dialog],[role=menu]")) return;
      const key = event.key.toLowerCase();
      // A task still being added (its check disabled) is skipped by J/K.
      const checks = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-task-check]:not(:disabled)") ?? [])];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const row = active?.closest<HTMLElement>("[data-task-id]") ?? null;
      const rowTask = row ? rows.find((r) => r.id === row.dataset.taskId) : undefined;
      const rowCheck = row?.querySelector<HTMLElement>("[data-task-check]") ?? null;
      if (key === "t" && !event.shiftKey) {
        event.preventDefault();
        quickRef.current?.focus();
      } else if (key === "j" || key === "k") {
        if (checks.length === 0) return;
        event.preventDefault();
        const at = rowCheck ? checks.indexOf(rowCheck) : -1;
        const next = at < 0 ? (key === "j" ? 0 : checks.length - 1) : Math.min(checks.length - 1, Math.max(0, at + (key === "j" ? 1 : -1)));
        checks[next]?.focus();
        checks[next]?.scrollIntoView({ block: "nearest" });
      } else if (rowTask && rowCheck && !rowTask.pending) {
        if (key === "x") {
          event.preventDefault();
          rowCheck.click();
        } else if (key === "e" && rowTask.can_edit && !rowTask.done_at) {
          event.preventDefault();
          setEditing(rowTask.id);
        } else if (key === "d" && rowTask.can_edit && !rowTask.done_at) {
          event.preventDefault();
          actions.dismiss(rowTask, rowCheck);
        } else if ((event.key === "Backspace" || event.key === "Delete") && rowTask.can_edit) {
          event.preventDefault();
          actions.askDelete(rowTask, rowCheck);
        } else if (event.key === "Enter" && active === rowCheck) {
          // Enter opens the task's lead; it never ticks the check (X or Space do), even on a task with no lead.
          event.preventDefault();
          if (rowTask.company_id) router.push(`/leads/${rowTask.company_id}`);
        }
      }
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const tabs = TASK_TABS.map((id) => ({
    id,
    label: (
      <span className="inline-flex items-baseline gap-1.5">
        {t(`tabs.${id}`)}
        {id !== "done" && counts ? (
          <span className={cn("font-mono text-xs", id === "overdue" && counts.overdue > 0 ? "text-status-red" : "text-muted-foreground")}>
            {format.number(counts[id])}
          </span>
        ) : null}
      </span>
    ),
  }));

  let body: React.ReactNode;
  if (list.isPending) {
    body = <TaskRowsSkeleton />;
  } else if (list.isError && rows.length === 0) {
    body = (
      <div role="alert" className="flex flex-col items-start gap-3 p-4 sm:p-5">
        <p className="font-bold">{t("error")}</p>
        <Button
          variant="quiet"
          onClick={(e) => void retryKeepingFocus(e.currentTarget, () => document.getElementById(`${ID_BASE}-panel-${tab}`), () => list.refetch())}
        >
          {t("retry")}
        </Button>
      </div>
    );
  } else if (rows.length === 0) {
    body = <p className="p-4 text-muted-foreground sm:p-5">{t(`empty.${tab}`)}</p>;
  } else {
    body = (
      <>
        {/* Keyed by scope and tab: another list is a new list, so its rows show without fading in (AnimatePresence's
            initial={false} applies again); only a task added to the list on screen fades in (design 7.8). */}
        <ul key={`${scope}:${tab}`} ref={listRef} aria-label={t("listLabel", { tab: t(`tabs.${tab}`) })} className="flex flex-col">
          <AnimatePresence initial={false}>
            {rows.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                zone={zone}
                now={now}
                showAssignee={scope === "team"}
                editing={editing === task.id}
                onEditChange={setEditing}
                actions={actions}
                team={team}
                canAssign={canTeam}
              />
            ))}
          </AnimatePresence>
        </ul>
        {list.hasNextPage ? (
          <div className="border-t border-border p-3">
            <Button variant="quiet" width="full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? t("loadingMore") : t("showMore")}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[880px] min-w-0 flex-col gap-5 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
          {counts ? (
            // The number of tasks due today or overdue, said in words to assistive tech.
            <span className="font-mono text-base text-muted-foreground">
              <span aria-hidden="true">{format.number(counts.today + counts.overdue)}</span>
              <span className="sr-only">{t("dueCount", { count: counts.today + counts.overdue })}</span>
            </span>
          ) : null}
        </div>
        {canTeam ? (
          <div role="group" aria-label={t("scopeLabel")} className="flex gap-0.5 rounded-md bg-muted p-1">
            {(["mine", "team"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={scope === s}
                onClick={() => setScope(s)}
                onPointerEnter={() => prefetchTasks(queryClient, s, tab)}
                className={cn(
                  "min-h-11 rounded-[10px] px-3.5 text-sm transition-[background-color,color,transform] duration-150 active:scale-[0.97] sm:min-h-9",
                  scope === s ? "bg-pill text-foreground shadow-[0_1px_3px_rgb(14_14_16/0.12)]" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`scope.${s}`)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <QuickAdd ref={quickRef} zone={zone} now={now} onAdd={add} />

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabList items={tabs} value={tab} onChange={setTab} onIntent={(id) => prefetchTasks(queryClient, scope, id)} label={t("tabsLabel")} idBase={ID_BASE} />
          <p className="hidden text-xs text-muted-foreground lg:block">{t("keysHint")}</p>
        </div>
        <TabPanel idBase={ID_BASE} id={tab} className="min-w-0 overflow-hidden rounded-lg bg-card">
          {body}
        </TabPanel>
      </div>

      <Dialog open={!!deleting} onOpenChange={(open) => (open ? null : setDeleting(null))}>
        <DialogContent
          className={cn(phoneSheet, "sm:w-[min(440px,calc(100%-32px))]")}
          onCloseAutoFocus={(e) => {
            // Back to the row (still there when the delete was cancelled), else the list.
            e.preventDefault();
            const from = deleteFrom.current;
            if (from?.isConnected) from.focus();
            else document.getElementById(`${ID_BASE}-panel-${tab}`)?.focus();
          }}
        >
          <div className="flex flex-col gap-5 p-6">
            <div className="flex flex-col gap-2">
              <DialogTitle className="text-xl font-bold text-balance">{t("deleteConfirm.title")}</DialogTitle>
              <DialogDescription className="text-muted-foreground">{t("deleteConfirm.body", { title: deleting?.task.title ?? "" })}</DialogDescription>
            </div>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="quiet" onClick={() => setDeleting(null)}>
                {t("cancel")}
              </Button>
              <Button variant="neutral" onClick={() => void confirmDelete()}>
                {t("deleteConfirm.confirm")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {stepUpDialog}
    </div>
  );
}

/** Rows as they will be (56 px, a check, two lines): the loading state of a tab and of the route. */
export function TaskRowsSkeleton({ count = 5 }: { count?: number }) {
  const bar = "rounded-sm bg-muted motion-safe:animate-pulse";
  return (
    <ul aria-hidden="true" className="flex flex-col">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="flex min-h-14 items-start gap-2 border-b border-border px-2 py-1.5 last:border-b-0 sm:px-3">
          <span className="grid size-11 shrink-0 place-items-center sm:size-10">
            <span className="size-5 rounded-full border-2 border-muted" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1.5 py-2">
            <span className={`h-4 ${i % 2 ? "w-2/3" : "w-1/2"} ${bar}`} />
            <span className={`h-3 w-40 ${bar}`} />
          </span>
        </li>
      ))}
    </ul>
  );
}
