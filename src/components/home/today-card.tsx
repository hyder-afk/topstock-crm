"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { setTaskDone } from "@/app/(app)/leads/[id]/actions";
import { CardError, HomeCard, RowSkeletons } from "@/components/home/home-card";
import { homeKey } from "@/components/home/use-home";
import { refreshTasks } from "@/components/tasks/use-tasks";
import { useToast } from "@/components/ui/toast";
import type { HomeData, HomeScope, HomeToday, TodayTask } from "@/lib/home";
import { primaryZone } from "@/lib/timezones";
import { cn } from "@/lib/utils";

// Today (Day 5 design 7.10): overdue first ("Overdue · 2 days" in the red token, with the word), then meetings with
// their times (DM Mono, in the profile zone, plus the lead's own time when its zone differs: the dual zone label of Day
// 4b/4c), then the rest. Ticking a check marks the task done at once (Undo in the
// toast) through the lead page's setTaskDone (set_task_done, Day 4b). Six rows, then "+3 more · Open Tasks".
// Tasks are always the caller's own, whatever the scope.

const ROW = "flex min-h-14 items-center gap-2 md:min-h-12";

function TaskRow({ task, zone, onDone }: { task: TodayTask; zone: string | undefined; onDone: (t: TodayTask, el: HTMLElement) => void }) {
  const t = useTranslations("Home.today");
  const format = useFormatter();
  const when = task.overdue
    ? task.overdue_days
      ? t("overdueDays", { days: task.overdue_days })
      : t("overdue")
    : task.due_at
      ? format.dateTime(new Date(task.due_at), { hour: "2-digit", minute: "2-digit", timeZone: zone })
      : t("allDay");
  // A meeting with a lead in another zone also shows the lead's time (Day 4c's list_tasks gives the lead's calling zone).
  const theirZone = task.company_call_zone ? primaryZone(task.company_call_zone) : null;
  const theirs =
    !task.overdue && task.kind === "meeting" && task.due_at && theirZone && zone && theirZone !== zone
      ? format.dateTime(new Date(task.due_at), { hour: "2-digit", minute: "2-digit", timeZone: theirZone })
      : null;
  return (
    <li className={ROW}>
      <button
        type="button"
        role="checkbox"
        aria-checked={false}
        aria-label={t("markDone", { title: task.title })}
        onClick={(e) => onDone(task, e.currentTarget)}
        className="group grid size-11 shrink-0 place-items-center rounded-full transition-[scale] duration-150 active:scale-[0.94]"
      >
        <span className="grid size-5 place-items-center rounded-full border-2 border-muted-foreground transition-colors group-hover:border-foreground">
          <Check aria-hidden="true" strokeWidth={3} className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        {task.company_id ? (
          // 20 px tall in the row; on phones the tap area reaches 44 px (12 px above and below, at least 44 px wide), so
          // the row keeps its height and matches its skeleton (Day 7c phone pass).
          <Link
            href={`/leads/${task.company_id}`}
            className="relative flex max-w-full min-w-0 self-start text-sm font-medium hover:underline max-sm:before:absolute max-sm:before:inset-x-0 max-sm:before:-inset-y-3 max-sm:before:min-w-11 max-sm:before:content-['']"
          >
            <span className="truncate">{task.title}</span>
          </Link>
        ) : (
          <span className="truncate text-sm font-medium">{task.title}</span>
        )}
        <span className="truncate text-xs text-muted-foreground">
          {[t(`kind.${task.kind}`), task.company_name].filter(Boolean).join(" · ")}
        </span>
      </div>
      <span
        className={cn(
          "shrink-0 text-right text-xs",
          task.overdue ? "font-bold text-status-red" : task.due_at ? "font-mono text-foreground" : "text-muted-foreground",
        )}
      >
        {when}
        {theirs ? <span className="block font-mono text-muted-foreground">{t("theirTime", { time: theirs })}</span> : null}
      </span>
    </li>
  );
}

export function TodayCard({
  today,
  zone,
  scope,
  loading,
  onRetry,
}: {
  today: HomeToday | null;
  zone: string | undefined;
  scope: HomeScope;
  loading: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations("Home.today");
  const tErr = useTranslations("Errors");
  const qc = useQueryClient();
  const toast = useToast();

  const done = async (task: TodayTask, check: HTMLElement) => {
    // The ticked row leaves the list: focus moves to the next row's check, else the previous one, else the heading,
    // never to the page body.
    const row = check.closest("li");
    const sib = (el: Element | null | undefined) => el?.querySelector<HTMLElement>('[role="checkbox"]') ?? null;
    (sib(row?.nextElementSibling) ?? sib(row?.previousElementSibling) ?? check.closest("section")?.querySelector<HTMLElement>("h2"))?.focus();
    const key = homeKey(scope);
    const before = qc.getQueryData<HomeData>(key);
    qc.setQueryData<HomeData>(key, (old) => (old ? withoutTask(old, task) : old));
    const res = await setTaskDone({ id: task.id, on: true }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    if (!res.ok) {
      qc.setQueryData(key, before);
      toast.show(t("failed"));
      return;
    }
    // Home, the Tasks page and the lead's Tasks card all show it (refreshTasks reads Home again too).
    refreshTasks(qc, task.company_id);
    toast.show(t("done"), {
      label: t("undo"),
      run: async () => {
        const again = await setTaskDone({ id: task.id, on: false }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
        refreshTasks(qc, task.company_id);
        if (!again.ok) toast.show(tErr(again.error));
      },
    });
  };

  const more = today ? today.total - today.items.length : 0;
  return (
    <HomeCard
      labelId="home-today"
      title={t("title")}
      className="col-span-12 lg:col-span-7"
      busy={loading}
      action={
        <Link href="/tasks" className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground sm:min-h-0">
          {t("openTasks")}
        </Link>
      }
    >
      {loading ? (
        <RowSkeletons count={4} />
      ) : !today ? (
        <CardError onRetry={onRetry} />
      ) : today.items.length === 0 ? (
        <div className="flex flex-col items-start gap-1">
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
          {/* Day 4c's Tasks page opens with its quick add at the top (T focuses it). */}
          <Link href="/tasks" className="inline-flex min-h-11 items-center text-sm font-bold underline underline-offset-4">
            {t("addTask")}
          </Link>
        </div>
      ) : (
        <>
          <ul className="-mx-2 flex flex-col">
            {today.items.map((task) => (
              <TaskRow key={task.id} task={task} zone={zone} onDone={(x, el) => void done(x, el)} />
            ))}
          </ul>
          {more > 0 ? (
            <Link href="/tasks" className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground">
              {t("more", { count: more })} · {t("openTasks")}
            </Link>
          ) : null}
        </>
      )}
    </HomeCard>
  );
}

/** Home after a task is ticked: off the Today list, and out of the Tasks due and calm-line counts. */
function withoutTask(data: HomeData, task: TodayTask): HomeData {
  const today = data.today.ok
    ? {
        ok: true as const,
        data: {
          total: Math.max(0, data.today.data.total - 1),
          overdue: Math.max(0, data.today.data.overdue - (task.overdue ? 1 : 0)),
          items: data.today.data.items.filter((x) => x.id !== task.id),
        },
      }
    : data.today;
  const summary = data.summary.ok
    ? {
        ok: true as const,
        data: {
          ...data.summary.data,
          tasks: {
            overdue: Math.max(0, data.summary.data.tasks.overdue - (task.overdue ? 1 : 0)),
            today: Math.max(0, data.summary.data.tasks.today - (task.overdue ? 0 : 1)),
            meetings: data.summary.data.tasks.meetings,
          },
        },
      }
    : data.summary;
  return { ...data, today, summary };
}
