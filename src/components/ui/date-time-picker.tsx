"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { DatePicker } from "@/components/ui/date-picker";
import { TimePicker } from "@/components/ui/time-picker";
import { joinDateTime, splitDateTime, type WeekStart } from "@/lib/pickers/calendar";
import { pickerChangeEvent, type PickerChangeEvent } from "@/lib/pickers/event";
import type { HourCycle } from "@/lib/pickers/time";
import { cn } from "@/lib/utils";

// Replacement for <input type="datetime-local"> (Haider 15 Oct 2026: no native pickers): a DatePicker and a
// TimePicker side by side. The value is "YYYY-MM-DDTHH:MM", or "" while either half is missing (as the native field),
// submitted through one hidden input named `name`; onChange reads e.target.value. min and max take the same shape:
// their date bounds the calendar, their time bounds the list on that first or last day. `id` goes on the date
// button, so <label htmlFor={id}> keeps naming the field; the time box is named by its own label ("Time").

export type DateTimePickerProps = {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?(event: PickerChangeEvent): void;
  onValueChange?: (value: string) => void;
  min?: string;
  max?: string;
  /** Time put in when a day is picked before any time (e.g. "09:00"); none by default. */
  defaultTime?: string;
  step?: number;
  disabled?: boolean;
  required?: boolean;
  hourCycle?: HourCycle;
  weekStartsOn?: WeekStart;
  timeZone?: string;
  className?: string;
  form?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
} & { [data: `data-${string}`]: string | undefined };

export function DateTimePicker({
  id,
  name,
  value,
  defaultValue,
  onChange,
  onValueChange,
  min,
  max,
  defaultTime,
  step,
  disabled,
  required,
  hourCycle,
  weekStartsOn,
  timeZone,
  className,
  form,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: DateTimePickerProps) {
  const t = useTranslations("Pickers");
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue ?? "");
  const full = splitDateTime(controlled ? value : inner);
  // A half-filled field keeps its half here; the value stays "" until both halves are there.
  const [partial, setPartial] = useState<{ date: string; time: string } | null>(null);
  const shown = full.date ? full : partial ?? full;
  const lo = splitDateTime(min);
  const hi = splitDateTime(max);

  const update = (date: string, time: string) => {
    const next = joinDateTime(date, time);
    setPartial(next ? null : { date, time });
    const before = joinDateTime(full.date, full.time);
    if (next === before) return;
    if (!controlled) setInner(next);
    onValueChange?.(next);
    onChange?.(pickerChangeEvent(name, next));
  };

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}
      {...rest}
    >
      <DatePicker
        id={id}
        value={shown.date}
        onValueChange={(date) => update(date, shown.time || (date && defaultTime ? defaultTime : ""))}
        min={lo.date || undefined}
        max={hi.date || undefined}
        disabled={disabled}
        required={required}
        weekStartsOn={weekStartsOn}
        timeZone={timeZone}
        aria-describedby={describedBy}
        aria-invalid={ariaInvalid}
        className="w-auto min-w-[11rem] flex-[1_1_11rem]"
      />
      <TimePicker
        value={shown.time}
        onValueChange={(time) => update(shown.date, time)}
        step={step}
        min={shown.date && shown.date === lo.date ? lo.time : undefined}
        max={shown.date && shown.date === hi.date ? hi.time : undefined}
        disabled={disabled}
        required={required}
        hourCycle={hourCycle}
        aria-label={t("time")}
        aria-describedby={describedBy}
        aria-invalid={ariaInvalid}
        className="w-[8.5rem] flex-[0_0_auto]"
      />
      {name ? <input type="hidden" name={name} value={joinDateTime(full.date, full.time)} form={form} disabled={disabled} /> : null}
    </div>
  );
}
