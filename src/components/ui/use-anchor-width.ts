"use client";

import { useCallback, useRef, useState } from "react";

// A floating list as wide as its field, sized before its first paint. Radix only writes its own
// --radix-…-trigger-width after the list is positioned, inside floating-ui's resize watcher; a list whose width
// depended on it widened inside that watcher's callback, which WebKit reports as "ResizeObserver loop completed with
// undelivered notifications" (PR #19, CI WebKit: the probe named floating-ui's autoUpdate on the popper wrapper).
// Measuring the field when the list opens and passing the width in the same render keeps the list's size fixed.
//
// Use: call `measure()` where the list opens (before or with setOpen(true)), put `ref` on the field (the pickers take
// no ref of their own), `style` on the floating content, and size it with var(--anchor-width, 0px).
export function useAnchorWidth<T extends HTMLElement>() {
  const node = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const measure = useCallback(() => {
    const w = node.current?.getBoundingClientRect().width;
    if (w) setWidth(w);
  }, []);
  const style = width === null ? undefined : ({ "--anchor-width": `${width}px` } as React.CSSProperties);
  return { ref: node, measure, style };
}
