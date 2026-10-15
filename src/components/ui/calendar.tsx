"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  addMonths,
  clampIso,
  compareIso,
  formatIsoDate,
  isInRange,
  isIsoDate,
  isOutOfRange,
  monthLabel,
  monthMatrix,
  moveFocus,
  parseIsoDate,
  todayIso,
  weekdayNames,
  type IsoDate,
  type WeekStart,
} from "@/lib/pickers/calendar";
import { cn } from "@/lib/utils";

// The month grid behind DatePicker and DateRangePicker (WAI-ARIA date picker dialog pattern): a table with role grid,
// one focusable day at a time. Arrows move a day or a week, PageUp/PageDown a month (with Shift a year), Home/End the
// start/end of the week, Enter or Space picks. Monday first by default (France, the EU); names come from Intl.

export type CalendarProps = {
  /** The chosen day ("YYYY-MM-DD"), or a range's ends. */
  selected?: IsoDate | null;
  rangeFrom?: IsoDate | null;
  rangeTo?: IsoDate | null;
  onPick: (iso: IsoDate) => void;
  min?: string | null;
  max?: string | null;
  weekStartsOn?: WeekStart;
  /** Today's day for the marker; computed in the browser (optionally in a zone) when not given. */
  today?: IsoDate;
  timeZone?: string;
  /** Focus the day on mount (the popover opened). */
  autoFocus?: boolean;
  className?: string;
};

export function Calendar({ selected, rangeFrom, rangeTo, onPick, min, max, weekStartsOn = 1, today: todayProp, timeZone, autoFocus = false, className }: CalendarProps) {
  const t = useTranslations("Pickers");
  const locale = useLocale();
  const id = useId();
  // The calendar renders only inside an opened popover (in the browser), so reading the clock here is safe.
  const [today] = useState(() => todayProp ?? todayIso(timeZone));
  const start = [selected, rangeFrom, today].find((d): d is IsoDate => isIsoDate(d)) ?? today;
  const [focused, setFocused] = useState<IsoDate>(() => clampIso(start, min, max));
  const p = parseIsoDate(focused)!;
  const weeks = useMemo(() => monthMatrix(p.y, p.m, weekStartsOn), [p.y, p.m, weekStartsOn]);
  const shortNames = useMemo(() => weekdayNames(locale, weekStartsOn, "short"), [locale, weekStartsOn]);
  const longNames = useMemo(() => weekdayNames(locale, weekStartsOn, "long"), [locale, weekStartsOn]);
  const grid = useRef<HTMLTableElement>(null);
  const wantFocus = useRef(autoFocus);

  // Focus follows the focused day after a key press, a month change by keyboard, or on opening.
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`button[data-iso="${focused}"]`)?.focus({ preventScroll: true });
  }, [focused]);

  const moveTo = (iso: IsoDate, focus: boolean) => {
    wantFocus.current = focus;
    setFocused(clampIso(iso, min, max));
  };

  const shiftMonth = (months: number) => moveTo(addMonths(focused, months), false);

  const firstOfMonth = `${focused.slice(0, 7)}-01`;
  const prevDisabled = !!min && compareIso(firstOfMonth, min) <= 0;
  const nextDisabled = !!max && compareIso(weeks.flat().filter((d) => d.inMonth).at(-1)!.iso, max) >= 0;
  const headingId = `${id}-month`;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          disabled={prevDisabled}
          aria-label={t("previousMonth")}
          className="grid size-11 place-items-center rounded-md text-foreground transition-transform duration-150 hover:bg-muted active:scale-[0.97] disabled:opacity-40 sm:size-9"
        >
          <ChevronLeft aria-hidden="true" strokeWidth={1.75} className="size-5" />
        </button>
        <h2 id={headingId} aria-live="polite" className="text-base font-bold capitalize">
          {monthLabel(locale, p.y, p.m)}
        </h2>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          disabled={nextDisabled}
          aria-label={t("nextMonth")}
          className="grid size-11 place-items-center rounded-md text-foreground transition-transform duration-150 hover:bg-muted active:scale-[0.97] disabled:opacity-40 sm:size-9"
        >
          <ChevronRight aria-hidden="true" strokeWidth={1.75} className="size-5" />
        </button>
      </div>
      <table ref={grid} role="grid" aria-labelledby={headingId} className="w-full border-collapse">
        <thead>
          <tr>
            {shortNames.map((name, i) => (
              <th key={i} scope="col" abbr={longNames[i]} className="h-8 text-xs font-bold text-muted-foreground">
                <span aria-hidden="true">{name.replace(/\.$/, "")}</span>
                <span className="sr-only">{longNames[i]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0].iso}>
              {week.map((day) => {
                const isSelected = day.iso === selected || day.iso === rangeFrom || day.iso === rangeTo;
                const inRange = isInRange(day.iso, rangeFrom, rangeTo);
                const outside = isOutOfRange(day.iso, min, max);
                const isToday = day.iso === today;
                return (
                  <td key={day.iso} role="gridcell" aria-selected={isSelected || inRange || undefined} className="p-0.5 text-center">
                    <button
                      type="button"
                      data-iso={day.iso}
                      tabIndex={day.iso === focused ? 0 : -1}
                      aria-label={formatIsoDate(day.iso, locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                      aria-current={isToday ? "date" : undefined}
                      aria-disabled={outside || undefined}
                      onClick={() => {
                        if (outside) return;
                        moveTo(day.iso, false);
                        onPick(day.iso);
                      }}
                      onKeyDown={(e) => {
                        const next = moveFocus(day.iso, e.key, { shiftKey: e.shiftKey, weekStartsOn, min, max });
                        if (next) {
                          e.preventDefault();
                          moveTo(next, true);
                        }
                      }}
                      onFocus={() => {
                        if (day.iso !== focused) setFocused(day.iso);
                      }}
                      className={cn(
                        "relative mx-auto grid size-11 place-items-center rounded-md font-mono text-sm transition-transform duration-150 active:scale-[0.97] sm:size-9",
                        !day.inMonth && "text-muted-foreground",
                        inRange && !isSelected && "bg-muted",
                        isSelected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                        outside && "cursor-not-allowed opacity-40 hover:bg-transparent",
                        isToday && "font-bold",
                      )}
                    >
                      {day.day}
                      {isToday ? (
                        <span aria-hidden="true" className={cn("absolute bottom-1 size-1 rounded-full", isSelected ? "bg-primary-foreground" : "bg-foreground")} />
                      ) : null}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
