"use client";

import { useId, useMemo, useState } from "react";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { pickerChangeEvent, type PickerChangeEvent } from "@/lib/pickers/event";
import { flattenEntries, parseOptionChildren, searchScore, type PickerOption } from "@/lib/pickers/options";
import { cn } from "@/lib/utils";
import { fieldTrigger, floatingPanel, idList, listItem } from "./picker-styles";

// A searchable picker for long lists (countries, time zones, teammates, deals): a field-like button opens a popover
// with a search box and the list (cmdk). Type to filter (accents and case ignored), arrows move, Enter picks, Escape
// closes and focus returns to the button. It never fetches: a caller that searches the server passes
// `onSearchChange`, `shouldFilter={false}`, `loading`, and the options it got (plus `selectedLabel` for a value that is
// not among them). Form-compatible like Select: `name` submits through a hidden input, onChange reads e.target.value,
// and the same <option> children work (or pass `options`).

const EMPTY = "\u0000empty"; // cmdk needs a non-empty value per item; <option value=""> travels under this stand-in.
const toItem = (value: string) => (value === "" ? EMPTY : value);
const fromItem = (value: string) => (value === EMPTY ? "" : value);

export type ComboboxOption = { value: string; label: React.ReactNode; textValue?: string; keywords?: string[]; disabled?: boolean };

export type ComboboxProps = Omit<React.ComponentProps<"button">, "value" | "defaultValue" | "onChange" | "type" | "children"> & {
  options?: ComboboxOption[];
  /** Or <option>/<optgroup> children, as for Select. */
  children?: React.ReactNode;
  value?: string;
  defaultValue?: string;
  onChange?(event: PickerChangeEvent): void;
  onValueChange?: (value: string) => void;
  required?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** The chosen option's label when it is not in `options` (e.g. a server search returned other rows). */
  selectedLabel?: React.ReactNode;
  /** Skeleton rows instead of results while the caller is fetching. */
  loading?: boolean;
  /** Set false when the caller filters (server search); the list then shows `options` as given. */
  shouldFilter?: boolean;
  onSearchChange?: (search: string) => void;
  contentClassName?: string;
};

export function Combobox({
  options: optionsProp,
  children,
  name,
  value,
  defaultValue,
  onChange,
  onValueChange,
  disabled,
  required,
  placeholder,
  searchPlaceholder,
  emptyText,
  selectedLabel,
  loading = false,
  shouldFilter = true,
  onSearchChange,
  form,
  className,
  contentClassName,
  "aria-describedby": describedBy,
  onKeyDown,
  ...triggerProps
}: ComboboxProps) {
  const t = useTranslations("Pickers");
  const id = useId();
  const options: PickerOption[] = useMemo(
    () =>
      optionsProp
        ? optionsProp.map((o) => ({ value: o.value, label: o.label, textValue: o.textValue ?? (typeof o.label === "string" ? o.label : ""), disabled: !!o.disabled, keywords: o.keywords }))
        : flattenEntries(parseOptionChildren(children)),
    [optionsProp, children],
  );
  const [inner, setInner] = useState(defaultValue ?? "");
  const controlled = value !== undefined;
  const current = controlled ? value : inner;
  const selected = options.find((o) => o.value === current);
  const shown = selected?.label ?? (current ? selectedLabel : undefined);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState("");
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      // Each opening starts with an empty search, the chosen option highlighted.
      setSearch("");
      onSearchChange?.("");
      setActive(toItem(current));
    }
  };

  const pick = (next: string) => {
    setOpen(false);
    if (next === current) return;
    if (!controlled) setInner(next);
    onValueChange?.(next);
    onChange?.(pickerChangeEvent(name, next));
  };

  const valueId = `${id}-value`;
  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          type="button"
          disabled={disabled}
          // A select-only combobox whose popup is a dialog with a search box (WAI-ARIA 1.2 allows a dialog popup): the
          // label names it and the chosen option is read as its value and its description.
          role="combobox"
          aria-required={required || undefined}
          data-value={current}
          // As a select-only combobox: Down or Up (and Alt+Down) open the list from the closed button.
          onKeyDown={(e) => {
            onKeyDown?.(e);
            if (!e.defaultPrevented && !open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              onOpenChange(true);
            }
          }}
          aria-describedby={idList(valueId, describedBy)}
          className={cn(fieldTrigger, !shown && "text-muted-foreground", className)}
          {...triggerProps}
        >
          <span id={valueId} className="block min-w-0 truncate">
            {shown ?? placeholder ?? t("choose")}
          </span>
          <ChevronsUpDown aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent
          className={cn(floatingPanel, "w-[min(360px,calc(100vw-32px))] min-w-[var(--radix-popover-trigger-width)] p-0", contentClassName)}
          aria-label={searchPlaceholder ?? t("search")}
        >
          <Command
            label={searchPlaceholder ?? t("search")}
            value={active}
            onValueChange={setActive}
            shouldFilter={shouldFilter}
            filter={(_value, text, keywords) => searchScore(text, keywords ?? [])}
            loop
            vimBindings={false}
            className="flex flex-col"
          >
            {/* The box has no outline of its own: the line under it takes the focus colour instead. */}
            <div className="flex items-center gap-2 border-b border-border px-3 focus-within:border-ring">
              <Search aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
              <Command.Input
                value={search}
                onValueChange={(text) => {
                  setSearch(text);
                  onSearchChange?.(text);
                }}
                placeholder={searchPlaceholder ?? t("search")}
                autoComplete="off"
                spellCheck={false}
                className="h-12 min-w-0 flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
              />
            </div>
            <Command.List className="max-h-[min(50vh,320px)] overflow-y-auto overscroll-contain p-1.5">
              {loading ? (
                <Command.Loading label={t("loading")}>
                  <div aria-hidden="true" className="flex flex-col gap-1.5 p-1.5">
                    <div className="h-8 rounded-md bg-muted motion-safe:animate-pulse" />
                    <div className="h-8 rounded-md bg-muted motion-safe:animate-pulse" />
                    <div className="h-8 rounded-md bg-muted motion-safe:animate-pulse" />
                  </div>
                </Command.Loading>
              ) : (
                <>
                  <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText ?? t("noMatch")}</Command.Empty>
                  {options.map((option) => (
                    <Command.Item
                      key={option.value}
                      value={toItem(option.value)}
                      keywords={[option.textValue, ...(option.keywords ?? [])]}
                      disabled={option.disabled}
                      data-option={option.value}
                      onSelect={(itemValue) => pick(fromItem(itemValue))}
                      className={listItem}
                    >
                      {option.value === current ? (
                        <Check aria-hidden="true" strokeWidth={2} className="absolute left-3 size-4" />
                      ) : null}
                      <span className="min-w-0 truncate">{option.label}</span>
                      {option.value === current ? <span className="sr-only">, {t("chosen")}</span> : null}
                    </Command.Item>
                  ))}
                </>
              )}
            </Command.List>
          </Command>
        </PopoverContent>
      </Popover>
      {name ? <input type="hidden" name={name} value={current} form={form} disabled={disabled} /> : null}
    </>
  );
}
