"use client";

import { useId, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  formatIsoDate,
  formatTypedDate,
  isIsoDate,
  isOutOfRange,
  numericDateOrder,
  orderRange,
  parseTypedDate,
  type IsoDate,
  type WeekStart,
} from "@/lib/pickers/calendar";
import { pickerChangeEvent, type PickerChangeEvent } from "@/lib/pickers/event";
import { cn } from "@/lib/utils";
import { fieldTrigger, floatingPanel, idList } from "./picker-styles";

// The app's own date picker (Haider 15 Oct 2026: no native date input). A button shows the day in words; it opens a
// popover with the month grid (calendar.tsx). With `typed` the field is a text box too: the day in the locale's digit
// order ("15/10/2026" in French), checked when it loses focus or on Enter. The value is "YYYY-MM-DD" or "", as
// <input type="date"> gave, submitted through a hidden input named `name`; onChange reads e.target.value. Preset chips
// (Today, Tomorrow) stay with the caller, outside the picker.

type Common = {
  id?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  required?: boolean;
  weekStartsOn?: WeekStart;
  /** The zone whose today is marked (the browser's by default). */
  timeZone?: string;
  className?: string;
  form?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
} & { [data: `data-${string}`]: string | undefined };

export type DatePickerProps = Common & {
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?(event: PickerChangeEvent): void;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  /** A text box for typing the day, with the calendar on a button beside it. */
  typed?: boolean;
  /** Offer "Clear" in the popover (default: when not required). */
  clearable?: boolean;
};

export function DatePicker({
  id,
  name,
  value,
  defaultValue,
  onChange,
  onValueChange,
  min,
  max,
  disabled,
  required,
  placeholder,
  typed = false,
  clearable = !required,
  weekStartsOn = 1,
  timeZone,
  className,
  form,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: DatePickerProps) {
  const t = useTranslations("Pickers");
  const locale = useLocale();
  const uid = useId();
  const [inner, setInner] = useState(defaultValue ?? "");
  const controlled = value !== undefined;
  const current = isIsoDate(controlled ? value : inner) ? (controlled ? value : inner)! : "";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [badText, setBadText] = useState(false);
  // Typed field: a calendar opened from the text box (Alt+Down) gives focus back to the text box when it closes.
  const textRef = useRef<HTMLInputElement>(null);
  const fromText = useRef(false);

  const emit = (next: string) => {
    if (next === current) return;
    if (!controlled) setInner(next);
    onValueChange?.(next);
    onChange?.(pickerChangeEvent(name, next));
  };
  const commit = (next: string) => {
    setBadText(false);
    setDraft(null);
    emit(next);
  };

  const commitText = () => {
    if (draft === null) return;
    const text = draft.trim();
    if (!text) return commit("");
    const parsed = parseTypedDate(text, locale);
    if (parsed && !isOutOfRange(parsed, min, max)) return commit(parsed);
    // Like the native field with a half-typed day: the value is empty and the field says it is invalid; the text stays.
    setBadText(true);
    if (current !== "") {
      if (!controlled) setInner("");
      onValueChange?.("");
      onChange?.(pickerChangeEvent(name, ""));
    }
  };

  const shown = current ? formatIsoDate(current, locale) : "";
  const valueId = `${uid}-value`;
  const invalid = ariaInvalid ?? (badText || undefined);
  const pattern = typedPattern(locale, t);

  const panel = (
    <PopoverContent
      className={cn(floatingPanel, "w-auto p-3")}
      aria-label={t("chooseDate")}
      onOpenAutoFocus={(e) => e.preventDefault()} // the calendar focuses its own day
      onCloseAutoFocus={(e) => {
        if (!fromText.current) return;
        fromText.current = false;
        e.preventDefault();
        textRef.current?.focus();
      }}
    >
      <Calendar
        selected={current || null}
        onPick={(iso) => {
          commit(iso);
          setOpen(false);
        }}
        min={min}
        max={max}
        weekStartsOn={weekStartsOn}
        timeZone={timeZone}
        autoFocus
      />
      {clearable && current ? (
        <div className="mt-2 flex justify-end border-t border-border pt-2">
          <button
            type="button"
            onClick={() => {
              commit("");
              setOpen(false);
            }}
            className="min-h-11 rounded-md px-3 text-sm font-bold text-foreground transition-transform duration-150 hover:bg-muted active:scale-[0.97] sm:min-h-9"
          >
            {t("clear")}
          </button>
        </div>
      ) : null}
    </PopoverContent>
  );

  const hidden = name ? <input type="hidden" name={name} value={current} form={form} disabled={disabled} /> : null;

  if (typed) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div className={cn("relative flex min-w-0 items-center", className)}>
            <input
              ref={textRef}
              id={id}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              placeholder={placeholder ?? pattern}
              value={draft ?? (current ? formatTypedDate(current, locale) : "")}
              onChange={(e) => {
                setDraft(e.target.value);
                setBadText(false);
                // Checked on blur or Enter only: some call sites save on change (a product's ETA), and a half-typed day
                // ("10/20/20") can already be a valid one.
              }}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft !== null) {
                  e.preventDefault(); // checks the text instead of submitting a half-typed day
                  commitText();
                } else if (e.key === "ArrowDown" && e.altKey) {
                  e.preventDefault();
                  fromText.current = true;
                  setOpen(true);
                }
              }}
              disabled={disabled}
              aria-required={required || undefined}
              aria-invalid={invalid}
              aria-describedby={idList(valueId, describedBy)}
              className="min-h-11 w-full min-w-0 rounded-md border border-border bg-background py-2 pr-12 pl-3 font-mono text-base text-foreground placeholder:text-muted-foreground aria-invalid:border-status-red disabled:opacity-60"
              {...rest}
            />
            {/* The day in words, for screen readers (the box holds digits). */}
            <span id={valueId} className="sr-only">
              {shown || t("noDate")}
            </span>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label={current ? t("changeDate", { date: shown }) : t("chooseDate")}
                className="absolute right-0 grid size-11 place-items-center rounded-md text-muted-foreground transition-transform duration-150 hover:text-foreground active:scale-[0.97] disabled:opacity-60 sm:right-1 sm:size-9"
              >
                <CalendarDays aria-hidden="true" strokeWidth={1.75} className="size-4" />
              </button>
            </PopoverTrigger>
          </div>
        </PopoverAnchor>
        {panel}
        {hidden}
      </Popover>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* role="combobox", as Select and Combobox: aria-required is not allowed on a button. Radix adds
          aria-haspopup="dialog" and aria-expanded (the APG date picker pattern). */}
      <PopoverTrigger
        id={id}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-required={required || undefined}
        aria-invalid={invalid}
        aria-describedby={idList(valueId, describedBy)}
        className={cn(fieldTrigger, !current && "text-muted-foreground", className)}
        {...rest}
      >
        <span id={valueId} className="block min-w-0 truncate">
          {shown || placeholder || t("chooseDate")}
        </span>
        <CalendarDays aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      {panel}
      {hidden}
    </Popover>
  );
}

function typedPattern(locale: string, t: ReturnType<typeof useTranslations<"Pickers">>): string {
  const d = t("dayLetters");
  const m = t("monthLetters");
  const y = t("yearLetters");
  const order = numericDateOrder(locale);
  return order === "mdy" ? `${m}/${d}/${y}` : order === "ymd" ? `${y}-${m}-${d}` : `${d}/${m}/${y}`;
}

// ---------------------------------------------------------------------------------------------------------------------

export type DateRange = { from: string; to: string };

export type DateRangePickerProps = Common & {
  value?: DateRange;
  defaultValue?: DateRange;
  onValueChange?: (range: DateRange) => void;
  /** Hidden inputs for forms (e.g. "from" and "to"). */
  fromName?: string;
  toName?: string;
  placeholder?: string;
};

/**
 * A from-to range for filters: the first click picks the start, the second the end (in either order), then the
 * popover closes. Both ends "YYYY-MM-DD" or "".
 */
export function DateRangePicker({
  id,
  value,
  defaultValue,
  onValueChange,
  fromName,
  toName,
  min,
  max,
  disabled,
  required,
  placeholder,
  weekStartsOn = 1,
  timeZone,
  className,
  form,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: DateRangePickerProps) {
  const t = useTranslations("Pickers");
  const locale = useLocale();
  const uid = useId();
  const [inner, setInner] = useState<DateRange>(defaultValue ?? { from: "", to: "" });
  const controlled = value !== undefined;
  const range = controlled ? value : inner;
  const from = isIsoDate(range.from) ? range.from : "";
  const to = isIsoDate(range.to) ? range.to : "";
  const [open, setOpen] = useState(false);
  // The start picked in this opening, waiting for its end.
  const [anchor, setAnchor] = useState<IsoDate | null>(null);

  const commit = (next: DateRange) => {
    if (next.from === from && next.to === to) return;
    if (!controlled) setInner(next);
    onValueChange?.(next);
  };

  const label = (iso: string) => formatIsoDate(iso, locale, { day: "numeric", month: "short", year: "numeric" });
  const shown = from && to ? t("rangeValue", { from: label(from), to: label(to) }) : from ? t("rangeFromOnly", { from: label(from) }) : "";
  const valueId = `${uid}-value`;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setAnchor(null);
      }}
    >
      <PopoverTrigger
        id={id}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-required={required || undefined}
        aria-invalid={ariaInvalid}
        aria-describedby={idList(valueId, describedBy)}
        className={cn(fieldTrigger, !shown && "text-muted-foreground", className)}
        {...rest}
      >
        <span id={valueId} className="block min-w-0 truncate">
          {shown || placeholder || t("chooseDates")}
        </span>
        <CalendarDays aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className={cn(floatingPanel, "w-auto p-3")} aria-label={t("chooseDates")} onOpenAutoFocus={(e) => e.preventDefault()}>
        <Calendar
          rangeFrom={anchor ?? (from || null)}
          rangeTo={anchor ? null : to || null}
          onPick={(iso) => {
            if (!anchor) {
              setAnchor(iso);
              return;
            }
            commit(orderRange(anchor, iso));
            setAnchor(null);
            setOpen(false);
          }}
          min={min}
          max={max}
          weekStartsOn={weekStartsOn}
          timeZone={timeZone}
          autoFocus
        />
        <p role="status" className="mt-2 min-h-5 text-xs text-muted-foreground">
          {anchor ? t("pickEnd") : null}
        </p>
        {from || to ? (
          <div className="mt-1 flex justify-end border-t border-border pt-2">
            <button
              type="button"
              onClick={() => {
                commit({ from: "", to: "" });
                setAnchor(null);
                setOpen(false);
              }}
              className="min-h-11 rounded-md px-3 text-sm font-bold text-foreground transition-transform duration-150 hover:bg-muted active:scale-[0.97] sm:min-h-9"
            >
              {t("clear")}
            </button>
          </div>
        ) : null}
      </PopoverContent>
      {fromName ? <input type="hidden" name={fromName} value={from} form={form} disabled={disabled} /> : null}
      {toName ? <input type="hidden" name={toName} value={to} form={form} disabled={disabled} /> : null}
    </Popover>
  );
}
