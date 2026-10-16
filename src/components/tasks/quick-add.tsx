"use client";

import { forwardRef, useId, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { CalendarClock, ListTodo, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { TimePicker } from "@/components/ui/time-picker";
import { Tooltip } from "@/components/ui/tooltip";
import { LeadPicker, type PickedLead } from "@/components/tasks/lead-picker";
import { QUICK_CHIPS, TASK_KINDS, chipDate, type TaskKind } from "@/lib/tasks";
import { addDays, localDate, zonedInstant } from "@/lib/timezones";
import { cn } from "@/lib/utils";

export type QuickTask = { title: string; kind: TaskKind; dueDate: string | null; dueAt: string | null; lead: PickedLead | null };
type Chip = (typeof QUICK_CHIPS)[number] | "pick" | null;

export const kindIcon: Record<TaskKind, typeof ListTodo> = { todo: ListTodo, call: Phone, meeting: CalendarClock };

const chipClass = (on: boolean) =>
  cn(
    "min-h-11 shrink-0 rounded-md px-3 text-sm whitespace-nowrap transition-[background-color,color,transform] duration-150 active:scale-[0.97] sm:min-h-9",
    on ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:brightness-95 dark:hover:brightness-125",
  );

// Quick add (Day 4 design 7.5): "Add a task…", date chips (Today, Tomorrow, Next week, Pick a date) plus an optional
// time, the kind (a meeting needs a time), and "Link a lead". Enter adds. Dates are calendar dates in the person's own
// zone (the profile's, as the buckets); a time makes it a timed task at that wall-clock time in that zone. On phones the
// chips row scrolls sideways inside itself, never the page.
export const QuickAdd = forwardRef<HTMLInputElement, { zone: string; now: Date | null; onAdd: (task: QuickTask) => Promise<boolean> }>(function QuickAdd(
  { zone, now, onAdd },
  ref,
) {
  const t = useTranslations("Tasks");
  const format = useFormatter();
  const id = useId();
  const [title, setTitle] = useState("");
  const [chip, setChip] = useState<Chip>("today");
  const [picked, setPicked] = useState<string | null>(null);
  const [time, setTime] = useState("");
  const [kind, setKind] = useState<TaskKind>("todo");
  const [lead, setLead] = useState<PickedLead | null>(null);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const timeRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const today = now ? localDate(zone, now) : null;
  const date = !now ? null : chip === "pick" ? picked : chip ? chipDate(chip, zone, now) : null;
  const needsTime = kind === "meeting" && (!date || !time);
  const reason = title.trim() === "" ? t("quickAdd.needTitle") : needsTime ? t("quickAdd.needTime") : null;

  const submit = async () => {
    setTried(true);
    // The first field to fix takes the focus (the title, or a meeting's time).
    if (title.trim() === "") titleRef.current?.focus();
    else if (needsTime) (date ? timeRef.current : titleRef.current)?.focus();
    if (reason || busy) return;
    setBusy(true);
    const dueAt = date && time ? zonedInstant(date, time, zone).toISOString() : null;
    const ok = await onAdd({ title: title.trim(), kind, dueDate: dueAt ? null : date, dueAt, lead });
    setBusy(false);
    if (ok) {
      setTitle("");
      setTried(false);
    }
  };

  return (
    <form noValidate
      aria-label={t("quickAdd.label")}
      className="flex min-w-0 flex-col gap-3 rounded-lg bg-card p-4 sm:p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex min-w-0 gap-2">
        <label htmlFor={id} className="sr-only">
          {t("quickAdd.label")}
        </label>
        <input
          ref={(el) => {
            titleRef.current = el;
            if (typeof ref === "function") ref(el);
            else if (ref) ref.current = el;
          }}
          id={id}
          name="task_title"
          type="text"
          autoComplete="off"
          maxLength={300}
          dir="auto"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("quickAdd.placeholder")}
          aria-describedby={`${id}-reason`}
          aria-invalid={tried && !!reason ? true : undefined}
          className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-base text-foreground placeholder:text-muted-foreground aria-invalid:border-status-red"
        />
        <Button type="submit" variant="neutral" aria-disabled={!!reason || busy || undefined} className="shrink-0">
          {busy ? t("quickAdd.adding") : t("quickAdd.add")}
        </Button>
      </div>

      <div role="group" aria-label={t("quickAdd.dateLabel")} className="-mx-1 flex min-w-0 gap-1.5 overflow-x-auto overscroll-x-contain px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {QUICK_CHIPS.map((c) => (
          <Tooltip key={c} content={now ? format.dateTime(new Date(`${chipDate(c, zone, now)}T12:00:00Z`), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }) : null}>
            <button type="button" aria-pressed={chip === c} onClick={() => setChip(chip === c ? null : c)} className={chipClass(chip === c)}>
              {t(`chips.${c}`)}
            </button>
          </Tooltip>
        ))}
        <button
          type="button"
          aria-pressed={chip === "pick"}
          onClick={() => {
            setChip(chip === "pick" ? null : "pick");
            if (!picked && today) setPicked(addDays(today, 3));
          }}
          className={chipClass(chip === "pick")}
        >
          {t("chips.pick")}
        </button>
      </div>

      <div className="flex min-w-0 flex-wrap items-end gap-3">
        {chip === "pick" ? (
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor={`${id}-date`} className="text-muted-foreground">{t("quickAdd.date")}</label>
            <DatePicker
              id={`${id}-date`}
              name="task_date"
              typed
              value={picked ?? ""}
              min={today ? addDays(today, -365) : undefined}
              max={today ? addDays(today, 365 * 2) : undefined}
              timeZone={zone}
              onValueChange={(v) => setPicked(v || null)}
            />
          </div>
        ) : null}
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${id}-time`} className="text-muted-foreground">{kind === "meeting" ? t("quickAdd.timeRequired") : t("quickAdd.time")}</label>
          <TimePicker
            ref={timeRef}
            id={`${id}-time`}
            name="task_time"
            value={time}
            disabled={!date}
            required={kind === "meeting"}
            aria-invalid={tried && kind === "meeting" && !time ? true : undefined}
            aria-describedby={`${id}-reason`}
            onValueChange={setTime}
          />
        </div>
        <div role="group" aria-label={t("quickAdd.kindLabel")} className="flex gap-0.5 rounded-md bg-muted p-1">
          {TASK_KINDS.map((k) => {
            const Icon = kindIcon[k];
            return (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-[10px] px-3 text-sm transition-[background-color,color,transform] duration-150 active:scale-[0.97] sm:min-h-7",
                  kind === k ? "bg-pill text-foreground shadow-[0_1px_3px_rgb(14_14_16/0.12)]" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" strokeWidth={1.75} className="size-4" />
                {t(`kinds.${k}`)}
              </button>
            );
          })}
        </div>
        <LeadPicker value={lead} onChange={setLead} />
      </div>
      <p id={`${id}-reason`} className={cn("min-h-5 text-sm", tried && reason ? "text-status-red" : "sr-only")} role={tried && reason ? "alert" : undefined}>
        {tried && reason ? reason : null}
      </p>
    </form>
  );
});
