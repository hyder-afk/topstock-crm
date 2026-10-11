"use client";

import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";

// A text area that grows with its text up to `maxRows` lines, then scrolls inside itself (Day 4 design 7.2). Height is
// set from scrollHeight after each change (CSS field-sizing is not in every engine the team uses yet).
export function Textarea({
  className,
  maxRows = 12,
  ref,
  value,
  ...props
}: React.ComponentProps<"textarea"> & { maxRows?: number }) {
  const inner = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    // Empty: the CSS minimum height is right, and measuring would force a layout of the whole page on mount.
    if (value === "" && !el.style.height) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    const max = line * maxRows + 16;
    el.style.height = `${Math.min(el.scrollHeight + 2, max)}px`;
    el.style.overflowY = el.scrollHeight + 2 > max ? "auto" : "hidden";
  }, [value, maxRows]);

  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      value={value}
      className={cn(
        "min-h-24 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-base text-foreground placeholder:text-muted-foreground",
        "aria-invalid:border-status-red disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
