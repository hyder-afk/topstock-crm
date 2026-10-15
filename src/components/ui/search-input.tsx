"use client";

import { useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// Replaces <input type="search"> (Haider 15 Oct 2026: no native popups, so no WebKit clear cross or search history
// bubble): a text box with role searchbox and the app's own clear button. Escape clears a filled box, as the native
// field did; inside a Radix dialog Radix sees Escape first and closes the dialog, also as before.
// onChange receives a real React change event, also when the clear button empties the box, so handlers written for
// the native field (e.target.value) keep working. className goes on the input; wrapperClassName on the outer span.

export type SearchInputProps = Omit<React.ComponentProps<"input">, "type" | "role"> & {
  /** Show the magnifier at the start (default true). */
  icon?: boolean;
  wrapperClassName?: string;
  /** The search box's name for screen readers when no visible label names it. */
  label?: string;
};

// Sets the value the way typing does, so React fires onChange with a genuine event.
function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function SearchInput({ icon = true, wrapperClassName, label, className, value, defaultValue, onChange, onKeyDown, disabled, ref, ...props }: SearchInputProps) {
  const t = useTranslations("Pickers");
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Tracks whether there is text, for the clear button (controlled or not).
  const [filled, setFilled] = useState(() => String(value ?? defaultValue ?? "") !== "");
  const hasText = value !== undefined ? String(value) !== "" : filled;

  const clear = () => {
    const input = inputRef.current;
    if (!input) return;
    setNativeValue(input, "");
    setFilled(false);
    input.focus();
  };

  return (
    <span className={cn("relative block min-w-0", wrapperClassName)}>
      {icon ? (
        <Search aria-hidden="true" strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      ) : null}
      <input
        ref={(node) => {
          inputRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        type="text"
        role="searchbox"
        aria-label={label}
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        onChange={(e) => {
          setFilled(e.target.value !== "");
          onChange?.(e);
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (!e.defaultPrevented && e.key === "Escape" && e.currentTarget.value !== "") {
            e.preventDefault();
            e.stopPropagation();
            clear();
          }
        }}
        className={cn(
          "min-h-11 w-full rounded-md border border-border bg-background pr-11 text-base text-foreground placeholder:text-muted-foreground disabled:opacity-60",
          icon ? "pl-9" : "pl-3",
          className,
        )}
        {...props}
      />
      {hasText && !disabled ? (
        <button
          type="button"
          onClick={clear}
          aria-label={t("clearSearch")}
          className="absolute top-1/2 right-1 grid size-10 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97] sm:size-9"
        >
          <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
        </button>
      ) : null}
    </span>
  );
}
