"use client";

import { useMemo, useState } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { pickerChangeEvent, type PickerChangeEvent } from "@/lib/pickers/event";
import { flattenEntries, parseOptionChildren, resolveSelectValue, type PickerOption } from "@/lib/pickers/options";
import { cn } from "@/lib/utils";
import { fieldTrigger, floatingPanel } from "./picker-styles";
import { useAnchorWidth } from "./use-anchor-width";

// The app's own select (Haider 15 Oct 2026: no native pickers or popups). A Radix listbox on our tokens: arrows,
// typeahead, Home/End, Enter/Space and Escape come from Radix, on the closed trigger too, as on a native select.
// Drop-in for the old native one: the same <option>/<optgroup> children, `name` (submitted through a hidden input, so
// server actions reading FormData keep working), `value`/`defaultValue`, `onChange` (reads e.target.value),
// `disabled`, `required` (aria-required, never a browser bubble) and every aria-* / data-* / id on the trigger, so
// <Label htmlFor> keeps naming it. Inside a form Radix also renders an inert copy of its own (aria-hidden, no name,
// not focusable, never shown, never submitted).

// Radix keeps "" for "nothing chosen", so an <option value=""> travels under this stand-in and comes back as "".
const EMPTY = "\u0000empty";
const toRadix = (value: string) => (value === "" ? EMPTY : value);
const fromRadix = (value: string) => (value === EMPTY ? "" : value);

export type SelectProps = Omit<React.ComponentProps<"button">, "ref" | "value" | "defaultValue" | "onChange" | "type" | "children"> & {
  children?: React.ReactNode;
  value?: string;
  defaultValue?: string;
  /** Called with { target: { name, value } } when the person picks another option (not when `value` changes). */
  onChange?(event: PickerChangeEvent): void;
  onValueChange?: (value: string) => void;
  required?: boolean;
  /** Shown while the value is "" and no option has the value "" (without it the first option shows, as natively). */
  placeholder?: string;
  /** Classes for the floating list. */
  contentClassName?: string;
};

export function Select({
  children,
  name,
  value,
  defaultValue,
  onChange,
  onValueChange,
  disabled,
  required,
  placeholder,
  form,
  className,
  contentClassName,
  ...triggerProps
}: SelectProps) {
  const t = useTranslations("Pickers");
  const entries = useMemo(() => parseOptionChildren(children), [children]);
  const options = useMemo(() => flattenEntries(entries), [entries]);
  const [inner, setInner] = useState(defaultValue);
  const controlled = value !== undefined;
  const current = resolveSelectValue(options, controlled ? value : inner, placeholder !== undefined);
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const { ref: anchorRef, measure: measureAnchor, style: anchorStyle } = useAnchorWidth<HTMLButtonElement>();
  const onOpenChange = (next: boolean) => {
    if (next) measureAnchor();
    setOpen(next);
  };

  const pick = (radixValue: string) => {
    const next = fromRadix(radixValue);
    if (next === current) return;
    if (!controlled) setInner(next);
    onValueChange?.(next);
    onChange?.(pickerChangeEvent(name, next));
  };

  return (
    <>
      <SelectPrimitive.Root
        value={selected ? toRadix(current) : ""}
        onValueChange={pick}
        open={open}
        onOpenChange={onOpenChange}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          ref={anchorRef}
          aria-required={required || undefined}
          // The submitted value, readable without opening the list (tests assert it; the hidden input needs a name).
          data-value={current}
          className={cn(fieldTrigger, "data-[placeholder]:text-muted-foreground", className)}
          {...triggerProps}
        >
          {/* Our own copy of the chosen option's words (Radix would otherwise copy them out of the hidden list). */}
          <SelectPrimitive.Value placeholder={placeholder ?? t("choose")}>
            {selected ? <span className="block truncate">{selected.label}</span> : undefined}
          </SelectPrimitive.Value>
          <SelectPrimitive.Icon asChild>
            <ChevronDown aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={8}
            collisionPadding={16}
            // Width from the trigger, measured on opening (use-anchor-width.ts); 420 px tall until Radix knows the space.
            style={anchorStyle}
            className={cn(
              floatingPanel,
              "max-h-[min(var(--radix-select-content-available-height,420px),420px)] min-w-[max(var(--anchor-width,0px),180px)] max-w-[calc(100vw-32px)] overflow-hidden",
              contentClassName,
            )}
          >
            <SelectPrimitive.ScrollUpButton className="flex h-7 items-center justify-center text-muted-foreground">
              <ChevronUp aria-hidden="true" strokeWidth={1.75} className="size-4" />
            </SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport className="p-1.5">
              {entries.map((entry, i) =>
                entry.kind === "group" ? (
                  <SelectPrimitive.Group key={`group-${i}`}>
                    <SelectPrimitive.Label className="px-3 pt-2 pb-1 text-xs font-bold text-muted-foreground">{entry.label}</SelectPrimitive.Label>
                    {entry.options.map((option) => (
                      <Item key={option.value} option={option} />
                    ))}
                  </SelectPrimitive.Group>
                ) : (
                  <Item key={entry.value} option={entry} />
                ),
              )}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className="flex h-7 items-center justify-center text-muted-foreground">
              <ChevronDown aria-hidden="true" strokeWidth={1.75} className="size-4" />
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
      {name ? <input type="hidden" name={name} value={current} form={form} disabled={disabled} /> : null}
    </>
  );
}

function Item({ option }: { option: PickerOption }) {
  return (
    <SelectPrimitive.Item
      value={toRadix(option.value)}
      textValue={option.textValue}
      disabled={option.disabled}
      data-option={option.value}
      className="relative flex min-h-11 cursor-pointer items-center rounded-md py-2 pr-3 pl-9 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted sm:min-h-9"
    >
      <SelectPrimitive.ItemIndicator className="absolute left-3 grid size-4 place-items-center">
        <Check aria-hidden="true" strokeWidth={2} className="size-4" />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
