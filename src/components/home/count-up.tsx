"use client";

import { createContext, useContext, useLayoutEffect, useRef } from "react";
import { animate } from "motion/react";
import { COUNT_UP_HYDRATION_MS } from "@/lib/home";
import { cn } from "@/lib/utils";

// Count-up (Day 5 design 7.11, D29). The server renders the final number, readable without JavaScript, under the CSS
// rise entrance. On the first Home of a tab, when hydration lands within 800 ms of navigation start and motion is
// allowed, each number counts from 0 in 0.7 s; later a changed figure eases from the old value in 0.3 s and an unchanged
// one does not move. Frames are written into the text node React owns (no re-render per frame). No layout shift: the
// number sits in a one-cell grid over an invisible copy of the final text (DM Mono: every digit is as wide), the moving
// copy is aria-hidden and screen readers get the final value once.

let counted = false; // this tab already counted (module state: one per tab, like the greeting's)

/** Decided once per Home mount, in the browser: count up now? (false on the server and on later visits). */
export function decideFirstVisit(): boolean {
  if (typeof window === "undefined" || counted) return false;
  return performance.now() < COUNT_UP_HYDRATION_MS;
}
/** Called once Home has mounted: later visits in this tab do not count. */
export function markHomeVisited() {
  counted = true;
}

export const FirstVisitContext = createContext(false);

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const EASE = [0.16, 1, 0.3, 1] as const;

export function CountUp({
  value,
  format,
  className,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
}) {
  const firstVisit = useContext(FirstVisitContext);
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null); // the value on screen after the last run
  const final = format(value);

  useLayoutEffect(() => {
    const node = ref.current?.firstChild;
    if (!node) return;
    // Read here, not through a hook that settles after the first render (that would restart and cut the count).
    const reduced = prefersReducedMotion();
    const first = shown.current === null;
    const from = first ? (firstVisit && !reduced ? 0 : value) : (shown.current as number);
    shown.current = value;
    if (from === value || reduced) {
      const text = format(value);
      if (node.nodeValue !== text) node.nodeValue = text; // React already wrote it; never touch the text needlessly
      return;
    }
    node.nodeValue = format(from); // before paint: no flash of the final value
    const controls = animate(from, value, {
      duration: first ? 0.7 : 0.3,
      ease: EASE,
      onUpdate: (v) => {
        node.nodeValue = format(Math.round(v));
      },
    });
    return () => controls.stop();
    // format changes identity with the locale only; value drives the run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, firstVisit]);

  return (
    <span className={cn("inline-grid font-mono tabular-nums", className)}>
      <span aria-hidden="true" className="invisible [grid-area:1/1]">
        {final}
      </span>
      <span ref={ref} aria-hidden="true" className="[grid-area:1/1]">
        {final}
      </span>
      <span className="sr-only">{final}</span>
    </span>
  );
}
