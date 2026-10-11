"use client";

import { useId } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Kbd } from "@/components/ui/kbd";
import { CALL_OUTCOMES, OUTCOME_DIGIT, type CallOutcome, type FollowUpRule } from "@/lib/activities";
import { DATE_CHIPS, chipDate, type DateChip } from "@/lib/tasks";
import { addDays, localDate, primaryZone, zoneCity, zonedInstant } from "@/lib/timezones";
import { cn } from "@/lib/utils";

// The outcome pad (Day 4 design 5.5 and 7.3), shared by the call panel and the composer: keys 1 to 7 and 0 (read
// through event.code by the parent, so AZERTY works), each button names its key (aria-keyshortcuts). Selected is the
// neutral fill: status colours never fill controls (DESIGN.md). Keys are 56 px tall on phones, 44 px from tablet width
// (design 7.9: the pad is the main touch surface during a call).
export function OutcomePad({
  value,
  onChange,
  disabled = {},
  className,
}: {
  value: CallOutcome | null;
  onChange: (outcome: CallOutcome) => void;
  disabled?: Partial<Record<CallOutcome, boolean>>;
  className?: string;
}) {
  const t = useTranslations("Outcomes");
  return (
    <div role="group" aria-label={t("padLabel")} className={cn("grid grid-cols-2 gap-1.5", className)}>
      {CALL_OUTCOMES.map((o) => {
        const on = value === o;
        const digit = String(OUTCOME_DIGIT[o]);
        return (
          <button
            key={o}
            type="button"
            data-outcome={o}
            aria-pressed={on}
            aria-keyshortcuts={digit}
            disabled={disabled[o]}
            onClick={() => onChange(o)}
            className={cn(
              "flex min-h-14 min-w-0 items-center sm:min-h-11 justify-between gap-2 rounded-md px-3 text-left text-sm transition-[background-color,color,transform] duration-150 active:scale-[0.97] disabled:opacity-50",
              on ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:brightness-95 dark:hover:brightness-125",
            )}
          >
            <span className="min-w-0 break-words">{t(o)}</span>
            <Kbd className={cn("shrink-0", on && "border-transparent bg-primary-foreground/15 text-primary-foreground")}>{digit}</Kbd>
          </button>
        );
      })}
    </div>
  );
}

export type FollowUp = { date: string | null; time: string | null };
export const noFollowUp: FollowUp = { date: null, time: null };

/** The follow-up as log_activity takes it: a calendar date, or (with a time) an instant in the viewer's zone. */
export function followUpArgs(f: FollowUp, viewerZone: string): { followUpDate: string | null; followUpAt: string | null } {
  if (!f.date) return { followUpDate: null, followUpAt: null };
  if (f.time) return { followUpDate: null, followUpAt: zonedInstant(f.date, f.time, viewerZone).toISOString() };
  return { followUpDate: f.date, followUpAt: null };
}

/** True when the follow-up meets the rule (Interested: a date; Book meeting: a date and a time). */
export function followUpReady(rule: FollowUpRule, f: FollowUp): boolean {
  if (rule === "date_or_time") return !!f.date;
  if (rule === "time") return !!f.date && !!f.time;
  return true;
}

/**
 * Date chips (Today, Tomorrow, In 2 days, Next week, Pick a date) and a time, in the viewer's zone. A time shows both
 * clocks when the lead's zone differs ("10:00 for you · 09:00 in London"). `rule` "time" makes the time required.
 */
export function FollowUpPicker({
  rule,
  value,
  onChange,
  viewerZone,
  leadZoneKey,
  now,
  legend,
}: {
  rule: FollowUpRule;
  value: FollowUp;
  onChange: (f: FollowUp) => void;
  viewerZone: string;
  leadZoneKey: string;
  now: Date;
  legend?: string;
}) {
  const t = useTranslations("Composer");
  const format = useFormatter();
  const id = useId();
  if (rule === "none") return null;
  const dates = Object.fromEntries(DATE_CHIPS.map((c) => [c, chipDate(c, viewerZone, now)])) as Record<DateChip, string>;
  const chip = DATE_CHIPS.find((c) => dates[c] === value.date) ?? null;
  const picking = !!value.date && !chip;
  const today = localDate(viewerZone, now);
  const leadZone = primaryZone(leadZoneKey);
  const instant = value.date && value.time ? zonedInstant(value.date, value.time, viewerZone) : null;
  const theirs = instant && leadZone !== viewerZone ? format.dateTime(instant, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: leadZone }) : null;
  const required = rule === "time";

  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 text-sm font-bold">{legend ?? t("followUp")}</legend>
      <div className="flex flex-wrap gap-1.5">
        {DATE_CHIPS.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={chip === c}
            title={format.dateTime(new Date(`${dates[c]}T12:00:00Z`), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}
            onClick={() => onChange(chip === c && rule === "optional" ? noFollowUp : { ...value, date: dates[c] })}
            className={cn(
              "min-h-11 rounded-md px-3 text-sm transition-[background-color,color,transform] duration-150 active:scale-[0.97] sm:min-h-9",
              chip === c ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:brightness-95 dark:hover:brightness-125",
            )}
          >
            {t(`chips.${c}`)}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={picking}
          onClick={() => onChange({ ...value, date: value.date && !chip ? value.date : addDays(today, 3) })}
          className={cn(
            "min-h-11 rounded-md px-3 text-sm transition-[background-color,color,transform] duration-150 active:scale-[0.97] sm:min-h-9",
            picking ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:brightness-95 dark:hover:brightness-125",
          )}
        >
          {t("chips.pick")}
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {picking ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t("date")}</span>
            <input
              type="date"
              name="follow_up_date"
              value={value.date ?? ""}
              min={today}
              max={addDays(today, 365)}
              onChange={(e) => onChange({ ...value, date: e.target.value || null })}
              className="min-h-11 rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground"
            />
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{required ? t("timeRequired") : t("time")}</span>
          <input
            type="time"
            name="follow_up_time"
            value={value.time ?? ""}
            aria-describedby={`${id}-time`}
            aria-invalid={required && !!value.date && !value.time ? true : undefined}
            disabled={!value.date}
            onChange={(e) => onChange({ ...value, time: e.target.value || null })}
            className="min-h-11 rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground aria-invalid:border-status-red disabled:opacity-60"
          />
        </label>
      </div>
      <p id={`${id}-time`} className="min-h-5 text-xs text-muted-foreground">
        {instant && theirs ? t("bothClocks", { mine: value.time ?? "", theirs, place: zoneCity(leadZone) }) : null}
      </p>
    </fieldset>
  );
}
