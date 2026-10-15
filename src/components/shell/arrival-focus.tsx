"use client";

import { useEffect } from "react";

// Where the focus goes when a screen sends the person to another page after the control they used is gone (for
// instance stepping yourself down on Team lands on More). Next.js leaves the focus alone on navigation, so without this
// it would fall to <body>. The sending screen names the target just before navigating; the page that draws the target
// focuses it on arrival whenever the focus is free in the next 1.5 s. A target not reached within 10 s is forgotten.
let pending: { id: string; until: number } | null = null;

export function focusOnArrival(id: string) {
  pending = { id, until: Date.now() + 10_000 };
}

export function ArrivalFocus({ target }: { target: string }) {
  useEffect(() => {
    const next = pending;
    if (!next || next.id !== target) return;
    pending = null;
    if (Date.now() > next.until) return;
    // For a short while after arrival the focus can still be held by the control that sent the person here (a dialog's
    // Confirm while it animates out) or dropped to <body> by the refresh that follows the navigation. So the target is
    // focused whenever the focus is free during that window, frame by frame; a focus the person moved anywhere else is
    // kept (CI, PR #18: checking once on mount found the focus taken and gave up).
    const held = document.activeElement;
    const stopAt = performance.now() + 1500;
    let frame = 0;
    const tick = () => {
      const active = document.activeElement;
      const el = document.getElementById(target);
      if (!active || active === document.body) el?.focus();
      else if (active !== el && active !== held) return;
      if (performance.now() < stopAt) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return null;
}
