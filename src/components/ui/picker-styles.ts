// Shared looks for the app's own pickers (Select, Combobox, DatePicker, TimePicker): a field-height trigger on our
// tokens (its border darkens on hover, the way a pressable thing answers the pointer; a red invalid border stays red),
// and the floating panel the popovers and menus already use (DESIGN.md: solid card, border, shadow, radius 20).
export const fieldTrigger =
  "flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-base text-foreground transition-transform duration-150 active:scale-[0.99] enabled:not-aria-invalid:hover:border-muted-foreground aria-invalid:border-status-red disabled:opacity-60";

export const floatingPanel =
  "floating-content z-50 rounded-lg border border-border bg-card text-foreground shadow-[0_16px_40px_rgb(14_14_16/0.18)] focus:outline-none";

export const listItem =
  "relative flex min-h-11 cursor-pointer items-center rounded-md py-2 pr-3 pl-9 text-sm outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-muted sm:min-h-9";

/** Join ids for aria-describedby / aria-labelledby, skipping empty ones. */
export function idList(...ids: (string | false | null | undefined)[]): string | undefined {
  const list = ids.filter(Boolean).join(" ");
  return list || undefined;
}
