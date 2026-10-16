"use client";

import { useEffect } from "react";

// Where the focus goes when a screen sends the person to another page after the control they used is gone (for
// instance stepping yourself down on Team lands on More). Next.js leaves the focus alone on navigation, so without this
// it would fall to <body>. The sending screen names the target just before navigating; the page that draws the target
// focuses it on arrival whenever the focus is free in the next 1.5 s. A target not reached within 10 s is forgotten.
type Pending = { id: string; until: number; stopAt?: number; held?: unknown };
let pending: Pending | null = null;

const WINDOW_MS = 1500;
const FORGET_MS = 10_000;

export function focusOnArrival(id: string, now: number = performance.now()) {
  pending = { id, until: now + FORGET_MS };
}

// What the frame loop needs from the page, so its rules can be tested without a browser (tests/unit/arrival-focus.spec.ts).
export type ArrivalEnv = {
  now(): number;
  activeElement(): unknown;
  body(): unknown;
  main(): unknown;
  byId(id: string): { focus(): void } | null;
  // Calls `fn` on the person's first pointerdown or keydown; returns the function that stops listening.
  onUserAction(fn: () => void): () => void;
  frame(fn: () => void): number;
  cancelFrame(id: number): void;
};

function browserEnv(): ArrivalEnv {
  return {
    now: () => performance.now(),
    activeElement: () => document.activeElement,
    body: () => document.body,
    main: () => document.querySelector("main"),
    byId: (id) => document.getElementById(id),
    onUserAction: (fn) => {
      // Capture on window: runs before the press moves the focus, and before any handler can stop the event.
      window.addEventListener("pointerdown", fn, true);
      window.addEventListener("keydown", fn, true);
      return () => {
        window.removeEventListener("pointerdown", fn, true);
        window.removeEventListener("keydown", fn, true);
      };
    },
    frame: (fn) => requestAnimationFrame(fn),
    cancelFrame: (id) => cancelAnimationFrame(id),
  };
}

// Starts (or, after a Strict Mode remount, resumes) the arrival window for `target`; returns the effect's cleanup.
//
// For a short while after arrival the focus can still be held by the control that sent the person here (a dialog's
// Confirm while it animates out) or dropped to <body> by the refresh that follows the navigation. So the target is
// focused whenever the focus is free during that window, frame by frame (CI, PR #18: checking once on mount found the
// focus taken and gave up). The window ends, and the pending target is forgotten, when the 1.5 s are up, when the focus
// is somewhere the person put it, or on the person's first pointerdown or keydown: once they act the focus is theirs,
// even when their click drops it to <body>.
//
// The cleanup only stops this run's frames and listeners. It leaves the pending target, its end time and the element
// that held the focus at arrival in place: React's Strict Mode (dev) mounts, cleans up and mounts again straight away,
// and the second mount must carry on the same window instead of finding nothing to do (or starting a new 1.5 s).
export function startArrivalFocus(target: string, env: ArrivalEnv = browserEnv()): () => void {
  const next = pending;
  if (!next || next.id !== target) return () => {};
  const start = env.now();
  if (start > next.until || (next.stopAt !== undefined && start >= next.stopAt)) {
    pending = null;
    return () => {};
  }
  next.stopAt ??= start + WINDOW_MS;
  if (!("held" in next)) next.held = env.activeElement();
  const stopAt = next.stopAt;
  let frame = 0;
  let stopped = false;
  let stopListening = () => {};
  const stop = () => {
    stopped = true;
    env.cancelFrame(frame);
    stopListening();
  };
  const finish = () => {
    stop();
    if (pending === next) pending = null;
  };
  stopListening = env.onUserAction(finish);
  const tick = () => {
    if (stopped) return;
    const active = env.activeElement();
    const el = env.byId(target);
    // <main> counts as free: it only holds the focus as the fallback of a dialog that closed while this page was still
    // loading (focusPageIfLost found no heading yet), never as a place the person chose (CI, PR #18).
    if (!active || active === env.body() || active === env.main()) el?.focus();
    else if (active !== el && active !== next.held) return finish();
    if (env.now() < stopAt) frame = env.frame(tick);
    else finish();
  };
  tick();
  return () => {
    if (!stopped) stop();
  };
}

export function ArrivalFocus({ target }: { target: string }) {
  useEffect(() => startArrivalFocus(target), [target]);
  return null;
}
