"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { rememberFocus, returnFocus, type FocusReturn } from "@/lib/focus-return";

/**
 * Keeps the focus in a list whose rows can vanish under it (a refetch that drops the focused row: a deal that left
 * Home's Needs attention after a move, a reopened deal's row menu). While a row inside `container` has the focus, its
 * place is remembered; when an update removes it and the focus fell to <body>, the row now at that place (or the one
 * before, or the card's heading) takes it. `version` is whatever changes when the rows change.
 */
export function useKeepFocus(container: RefObject<HTMLElement | null>, version: unknown) {
  const last = useRef<FocusReturn | null>(null);
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const onIn = (e: FocusEvent) => {
      last.current = rememberFocus(e.target as Element);
    };
    const onOut = (e: FocusEvent) => {
      // Focus went somewhere else on purpose (a dialog, another card): nothing to keep.
      if (e.relatedTarget instanceof Node && !el.contains(e.relatedTarget)) last.current = null;
    };
    el.addEventListener("focusin", onIn);
    el.addEventListener("focusout", onOut);
    return () => {
      el.removeEventListener("focusin", onIn);
      el.removeEventListener("focusout", onOut);
    };
  }, [container]);
  useLayoutEffect(() => {
    const r = last.current;
    if (!r?.el || r.el.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    returnFocus(r);
  }, [version]);
}
