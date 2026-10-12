"use client";

import { memo, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { motion, useReducedMotion } from "motion/react";
import { Building2, Check, Ellipsis } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { kindIcon } from "@/components/tasks/quick-add";
import { personName, type TeamMember } from "@/lib/leads";
import { springs } from "@/lib/motion";
import { bucketOf, dueParts, type TaskListRow } from "@/lib/tasks";
import { localDate, primaryZone, zonedInstant } from "@/lib/timezones";
import { cn } from "@/lib/utils";

export type RowActions = {
  toggle: (task: TaskListRow, check: HTMLElement) => void;
  dismiss: (task: TaskListRow, from: HTMLElement) => void;
  askDelete: (task: TaskListRow, from: HTMLElement) => void;
  save: (task: TaskListRow, edit: { title: string; dueDate: string | null; dueAt: string | null; assigneeId: string | null }) => Promise<boolean>;
};

function initials(first: string | null, last: string | null) {
  return `${(first ?? "").trim().charAt(0)}${(last ?? "").trim().charAt(0)}`.toUpperCase() || "·";
}

/** "Today", "Tomorrow 10:00", "Mon 14 Oct": the due label in the person's own zone. */
function useDue(zone: string) {
  const t = useTranslations("Tasks");
  const format = useFormatter();
  return (task: Pick<TaskListRow, "due_date" | "due_at">, now: Date) => {
    const p = dueParts(task, zone, now);
    if (p.day === "none") return t("noDate");
    const day =
      p.day === "today" || p.day === "tomorrow" || p.day === "yesterday"
        ? t(p.day)
        : format.dateTime(new Date(`${p.day}T12:00:00Z`), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    return p.time ? `${day} ${p.time}` : day;
  };
}

// One task (Day 4 design 7.5): a 56 px row with the round check (44 px target on phones), the title, the lead (link,
// prefetched on hover), the due label in DM Mono ("Tomorrow 10:00"; call tasks add "10:00 their time"), "Overdue" in
// the red text token with the word, the kind icon, the assignee's initials in Team, and a ⋯ menu (Edit, Dismiss,
// Delete). E turns the row into an inline edit form. The row fades out and the list closes the gap (Motion layout).
export const TaskRow = memo(function TaskRow({
  task,
  zone,
  now,
  showAssignee,
  editing,
  onEditChange,
  actions,
  team,
  canAssign,
}: {
  task: TaskListRow;
  zone: string;
  now: Date | null;
  showAssignee: boolean;
  editing: boolean;
  onEditChange: (id: string | null) => void;
  actions: RowActions;
  team: TeamMember[];
  canAssign: boolean;
}) {
  const t = useTranslations("Tasks");
  const format = useFormatter();
  const reduce = useReducedMotion();
  const due = useDue(zone);
  const checkRef = useRef<HTMLButtonElement>(null);
  const done = !!task.done_at;
  const [checking, setChecking] = useState(false);
  const overdue = !done && now ? bucketOf(task, zone, now) === "overdue" : false;
  const Icon = kindIcon[task.kind] ?? kindIcon.todo;
  const theirZone = task.company_call_zone ? primaryZone(task.company_call_zone) : null;
  const theirs =
    task.kind === "call" && task.due_at && theirZone && theirZone !== zone
      ? format.dateTime(new Date(task.due_at), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: theirZone })
      : null;
  const shownChecked = done !== checking;

  return (
    <motion.li
      layout={reduce ? false : "position"}
      initial={false}
      exit={{ opacity: 0 }}
      transition={reduce ? { duration: 0.12 } : springs.smooth}
      data-task-id={task.id}
      // Long lists (pages of 50 add up): rows far off screen skip layout and paint until they come near.
      className={cn("flex min-h-14 items-start gap-2 border-b border-border px-2 py-1.5 [contain-intrinsic-size:auto_64px] [content-visibility:auto] last:border-b-0 sm:px-3", task.pending && "opacity-70")}
    >
      {editing ? (
        <EditForm task={task} zone={zone} team={team} canAssign={canAssign} onSave={(v) => actions.save(task, v)} onClose={() => onEditChange(null)} />
      ) : (
        <>
          <button
            ref={checkRef}
            type="button"
            role="checkbox"
            aria-checked={shownChecked}
            aria-label={done ? t("markOpen", { title: task.title }) : t("markDone", { title: task.title })}
            data-task-check
            disabled={task.pending}
            onClick={(e) => {
              setChecking(true);
              actions.toggle(task, e.currentTarget);
            }}
            className="group grid size-11 shrink-0 place-items-center rounded-full transition-transform duration-150 active:scale-[0.94] sm:size-10"
          >
            <span
              className={cn(
                "grid size-5 place-items-center rounded-full border-2 transition-[background-color,border-color] duration-150",
                shownChecked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground group-hover:border-foreground",
              )}
            >
              <Check aria-hidden="true" strokeWidth={3} className={cn("size-3 transition-opacity", shownChecked ? "opacity-100" : "opacity-0 group-hover:opacity-60")} />
            </span>
          </button>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 sm:py-2">
            <span dir="auto" className={cn("text-sm break-words", done && "text-muted-foreground line-through decoration-1")}>
              {task.title}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Icon aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
                <span className="sr-only">{t(`kinds.${task.kind}`)}</span>
                <span className="font-mono">
                  {done && task.done_at && now
                    ? t("doneAt", { when: format.dateTime(new Date(task.done_at), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }) })
                    : now
                      ? due(task, now)
                      : " "}
                </span>
              </span>
              {theirs ? <span className="font-mono">{t("theirTime", { time: theirs })}</span> : null}
              {overdue ? <span className="font-bold text-status-red">{t("overdue")}</span> : null}
              {task.company_id && task.company_name ? (
                <Link
                  href={`/leads/${task.company_id}`}
                  data-task-lead
                  className="inline-flex min-h-6 max-w-full items-center gap-1 text-foreground underline-offset-4 hover:underline"
                >
                  <Building2 aria-hidden="true" strokeWidth={1.75} className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{task.company_name}</span>
                </Link>
              ) : null}
              {task.contact_name ? <span className="truncate">{task.contact_name}</span> : null}
              {task.company_lead_status === "do_not_contact" ? (
                <span className="inline-flex items-center gap-1">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-status-red" />
                  {t("dncLead")}
                </span>
              ) : null}
            </span>
          </div>
          {showAssignee ? (
            <span
              title={personName({ first_name: task.assignee_first_name, last_name: task.assignee_last_name })}
              className="mt-2.5 grid size-8 shrink-0 place-items-center rounded-full bg-muted font-mono text-[11px] text-muted-foreground sm:mt-2"
            >
              <span className="sr-only">{t("assignee", { name: personName({ first_name: task.assignee_first_name, last_name: task.assignee_last_name }) })}</span>
              <span aria-hidden="true">{initials(task.assignee_first_name, task.assignee_last_name)}</span>
            </span>
          ) : null}
          {task.can_edit && !task.pending ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t("menu", { title: task.title })}
                className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97] sm:size-10"
              >
                <Ellipsis aria-hidden="true" strokeWidth={1.75} className="size-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
                {!done ? <DropdownMenuItem onSelect={() => onEditChange(task.id)}>{t("edit")}</DropdownMenuItem> : null}
                {!done ? (
                  <DropdownMenuItem onSelect={() => checkRef.current && actions.dismiss(task, checkRef.current)}>{t("dismiss")}</DropdownMenuItem>
                ) : null}
                {!done ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onSelect={() => checkRef.current && actions.askDelete(task, checkRef.current)} className="text-status-red">
                  {t("delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      )}
    </motion.li>
  );
});

function EditForm({
  task,
  zone,
  team,
  canAssign,
  onSave,
  onClose,
}: {
  task: TaskListRow;
  zone: string;
  team: TeamMember[];
  canAssign: boolean;
  onSave: (v: { title: string; dueDate: string | null; dueAt: string | null; assigneeId: string | null }) => Promise<boolean>;
  onClose: () => void;
}) {
  const t = useTranslations("Tasks");
  const tLeads = useTranslations("Leads");
  const id = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(task.title);
  const initialDate = task.due_at ? localDate(zone, new Date(task.due_at)) : (task.due_date ?? "");
  const initialTime = task.due_at
    ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).format(new Date(task.due_at))
    : "";
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  const [assignee, setAssignee] = useState(task.assignee_id ?? "");
  const [busy, setBusy] = useState(false);
  const meetingNeedsTime = task.kind === "meeting" && (!date || !time);

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  const save = async () => {
    if (busy || !title.trim() || meetingNeedsTime) return;
    setBusy(true);
    const dueAt = date && time ? zonedInstant(date, time, zone).toISOString() : null;
    const ok = await onSave({ title: title.trim(), dueDate: dueAt ? null : date || null, dueAt, assigneeId: assignee || null });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <form
      aria-label={t("editLabel")}
      className="flex min-w-0 flex-1 flex-col gap-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-bold">{t("editTitle")}</span>
        <input
          ref={titleRef}
          name="title"
          value={title}
          maxLength={300}
          dir="auto"
          autoComplete="off"
          onChange={(e) => setTitle(e.target.value)}
          aria-invalid={!title.trim() || undefined}
          className="min-h-11 rounded-md border border-border bg-background px-3 text-base text-foreground aria-invalid:border-status-red"
        />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t("quickAdd.date")}</span>
          <input
            type="date"
            name="due_date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="min-h-11 rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground sm:min-h-9"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{task.kind === "meeting" ? t("quickAdd.timeRequired") : t("quickAdd.time")}</span>
          <input
            type="time"
            name="due_time"
            value={time}
            disabled={!date}
            aria-invalid={meetingNeedsTime || undefined}
            onChange={(e) => setTime(e.target.value)}
            className="min-h-11 rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground aria-invalid:border-status-red disabled:opacity-60 sm:min-h-9"
          />
        </label>
        {canAssign && team.length > 0 ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t("editAssignee")}</span>
            <select
              name="assignee"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="min-h-11 rounded-md border border-border bg-background px-3 text-sm text-foreground sm:min-h-9"
            >
              {team.map((m) => (
                <option key={m.id} value={m.id}>
                  {personName(m) || tLeads("noName")}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <p id={`${id}-why`} className={cn("text-sm text-status-red", !meetingNeedsTime && "sr-only")}>
        {meetingNeedsTime ? t("quickAdd.needTime") : null}
      </p>
      <div className="flex gap-2">
        <Button type="submit" variant="neutral" aria-disabled={busy || !title.trim() || meetingNeedsTime || undefined} aria-describedby={`${id}-why`}>
          {busy ? t("saving") : t("save")}
        </Button>
        <Button variant="quiet" onClick={onClose}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
