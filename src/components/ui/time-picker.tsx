"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Clock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { pickerChangeEvent, type PickerChangeEvent } from "@/lib/pickers/event";
import { formatTime, isTime, isTimeOutOfRange, nearestTimeIndex, parseTypedTime, timeList, type HourCycle } from "@/lib/pickers/time";
import { cn } from "@/lib/utils";
import { floatingPanel, idList } from "./picker-styles";
import { useAnchorWidth } from "./use-anchor-width";

// The app's own time picker (Haider 15 Oct 2026: no native time input). A WAI-ARIA combobox: type the time ("9:15",
// "0915", "9h15", "9:15 pm") or open the list of 15-minute steps with Alt+Down, Down or the clock button; arrows move,
// Enter picks, Escape closes; the text is checked when the field loses focus. The value is "HH:MM" (24-hour) or "",
// as <input type="time"> gave, submitted through a hidden input named `name`. It reads 24-hour in both languages, as
// every time in the app does (Day 4b decision 3, docs/log.md); `hourCycle` can ask for the locale's own clock.
// Typed "9:15 pm" is still understood.

export type TimePickerProps = {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?(event: PickerChangeEvent): void;
  onValueChange?: (value: string) => void;
  /** Minutes between list entries (typed times may fall between them). */
  step?: number;
  min?: string;
  max?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  hourCycle?: HourCycle;
  className?: string;
  form?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  ref?: React.Ref<HTMLInputElement>;
} & { [data: `data-${string}`]: string | undefined };

export function TimePicker({
  id,
  name,
  value,
  defaultValue,
  onChange,
  onValueChange,
  step = 15,
  min,
  max,
  disabled,
  required,
  placeholder,
  hourCycle,
  className,
  form,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  ref,
  ...rest
}: TimePickerProps) {
  const t = useTranslations("Pickers");
  const locale = useLocale();
  const cycle = hourCycle ?? "h23";
  const uid = useId();
  const [inner, setInner] = useState(defaultValue ?? "");
  const controlled = value !== undefined;
  const raw = controlled ? value : inner;
  const current = isTime(raw) ? raw : "";
  const times = useMemo(() => timeList(step, min, max), [step, min, max]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [badText, setBadText] = useState(false);
  const { ref: anchorRef, measure: measureAnchor, style: anchorStyle } = useAnchorWidth<HTMLDivElement>();
  const listRef = useRef<HTMLUListElement>(null);

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
    const parsed = parseTypedTime(text);
    if (parsed && !isTimeOutOfRange(parsed, min, max)) return commit(parsed);
    setBadText(true); // the text stays, the value is empty (as the native field with a half-typed time)
    if (current !== "") {
      if (!controlled) setInner("");
      onValueChange?.("");
      onChange?.(pickerChangeEvent(name, ""));
    }
  };

  const openList = () => {
    if (disabled) return;
    const typed = draft !== null ? parseTypedTime(draft) : null;
    setActive(Math.max(0, nearestTimeIndex(times, typed ?? (current || "09:00"))));
    measureAnchor();
    setOpen(true);
  };

  // The highlighted time stays in view (on opening it is the current or nearest one).
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, active]);

  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-opt-${i}`;
  const invalid = ariaInvalid ?? (badText || undefined);
  const text = draft ?? (current ? formatTime(current, locale, cycle) : "");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div ref={anchorRef} className={cn("relative flex min-w-0 items-center", className)}>
          <input
            ref={ref}
            id={id}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={open && times[active] ? optionId(active) : undefined}
            aria-required={required || undefined}
            aria-invalid={invalid}
            aria-describedby={idList(describedBy)}
            inputMode={cycle === "h23" ? "numeric" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder ?? (cycle === "h23" ? t("timePattern24") : t("timePattern12"))}
            value={text}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value);
              setBadText(false);
              const typed = parseTypedTime(e.target.value);
              if (typed && open) setActive(Math.max(0, nearestTimeIndex(times, typed)));
              // The value follows the typing, as the native field's did: a button that waits for a time is ready
              // before the field loses focus (the text is tidied on blur or Enter).
              if (!e.target.value.trim()) emit("");
              else if (typed && !isTimeOutOfRange(typed, min, max)) emit(typed);
            }}
            onBlur={() => {
              commitText();
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (!open) return openList();
                if (e.altKey && e.key === "ArrowUp") return setOpen(false);
                setActive((a) => (e.key === "ArrowDown" ? Math.min(times.length - 1, a + 1) : Math.max(0, a - 1)));
              } else if (open && (e.key === "PageDown" || e.key === "PageUp")) {
                e.preventDefault();
                setActive((a) => (e.key === "PageDown" ? Math.min(times.length - 1, a + 4) : Math.max(0, a - 4)));
              } else if (e.key === "Enter") {
                if (open && times[active]) {
                  e.preventDefault();
                  commit(times[active]);
                  setOpen(false);
                } else if (draft !== null) {
                  e.preventDefault(); // checks the text instead of submitting a half-typed time
                  commitText();
                }
              } else if (e.key === "Escape" && open) {
                e.preventDefault();
                e.stopPropagation(); // closes the list only, not a dialog around the field
                setOpen(false);
              }
            }}
            className="min-h-11 w-full min-w-0 rounded-md border border-border bg-background py-2 pr-12 pl-3 font-mono text-base text-foreground placeholder:text-muted-foreground aria-invalid:border-status-red disabled:opacity-60"
            {...rest}
          />
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            aria-label={t("chooseTime")}
            onMouseDown={(e) => e.preventDefault()} // keeps focus in the field
            onClick={() => (open ? setOpen(false) : openList())}
            className="absolute right-0 grid size-11 place-items-center rounded-md text-muted-foreground transition-transform duration-150 hover:text-foreground active:scale-[0.97] disabled:opacity-60 sm:right-1 sm:size-9"
          >
            <Clock aria-hidden="true" strokeWidth={1.75} className="size-4" />
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        // Width from the field, measured on opening (use-anchor-width.ts).
        style={anchorStyle}
        className={cn(floatingPanel, "w-[max(var(--anchor-width,0px),160px)] p-1.5")}
        // Focus stays in the field (combobox pattern); a press on the field itself is not "outside".
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
      >
        <ul ref={listRef} id={listId} role="listbox" aria-label={t("times")} className="max-h-64 overflow-y-auto overscroll-contain">
          {times.map((time, i) => (
            <li
              key={time}
              id={optionId(i)}
              data-index={i}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                commit(time);
                setOpen(false);
              }}
              className={cn(
                "relative flex min-h-11 cursor-pointer items-center rounded-md py-2 pr-3 pl-9 font-mono text-sm select-none sm:min-h-9",
                i === active && "bg-muted",
              )}
            >
              {time === current ? <Check aria-hidden="true" strokeWidth={2} className="absolute left-3 size-4" /> : null}
              {formatTime(time, locale, cycle)}
            </li>
          ))}
        </ul>
      </PopoverContent>
      {name ? <input type="hidden" name={name} value={current} form={form} disabled={disabled} /> : null}
    </Popover>
  );
}
