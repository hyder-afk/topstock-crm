"use client";

import { useEffect } from "react";

// Where the focus goes when a screen sends the person to another page after the control they used is gone (for
// instance stepping yourself down on Team lands on More). Next.js leaves the focus alone on navigation, so without this
// it would fall to <body>. The sending screen names the target just before navigating; the page that draws the target
// focuses it once, on arrival, if nothing else has the focus by then. A target not reached within 10 s is forgotten.
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
    const free = !document.activeElement || document.activeElement === document.body;
    if (free) document.getElementById(target)?.focus();
  }, [target]);
  return null;
}
