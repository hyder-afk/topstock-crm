import { expect, test } from "@playwright/test";
import { focusOnArrival, startArrivalFocus, type ArrivalEnv } from "@/components/shell/arrival-focus";

// ArrivalFocus's frame loop (src/components/shell/arrival-focus.tsx) against a fake page: a clock, frames run by hand,
// elements that take the focus, and the person's pointerdown/keydown. The browser journey is team.spec's
// demoting_yourself (the focus lands on More's title); this covers what that run cannot time: a press during the
// window, Strict Mode's mount-cleanup-mount, and the window's end.

type El = { name: string; focus(): void };

function fakePage() {
  let clock = 1_000;
  let active: El | null = null;
  const focused: string[] = [];
  const el = (name: string): El => {
    const e: El = {
      name,
      focus() {
        active = e;
        focused.push(name);
      },
    };
    return e;
  };
  const body = el("body");
  const main = el("main");
  const title = el("more-title");
  const confirm = el("confirm");
  const other = el("other");
  active = confirm; // the dialog's Confirm still holds the focus as the page arrives
  let frames = new Map<number, () => void>();
  let lastFrame = 0;
  const listeners = new Set<() => void>();
  const env: ArrivalEnv = {
    now: () => clock,
    activeElement: () => active,
    body: () => body,
    main: () => main,
    byId: (id) => (id === "more-title" ? title : null),
    onUserAction: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    frame: (fn) => {
      frames.set(++lastFrame, fn);
      return lastFrame;
    },
    cancelFrame: (id) => frames.delete(id),
  };
  return {
    env,
    els: { body, main, title, confirm, other },
    focused,
    listeners,
    get active() {
      return active?.name ?? null;
    },
    // The browser moves the focus without calling focus() (a dialog unmounting, a click on plain text drops it to <body>).
    setActive(e: El | null) {
      active = e;
    },
    // Runs one animation frame, `ms` later.
    step(ms = 16) {
      clock += ms;
      const run = frames;
      frames = new Map();
      for (const fn of run.values()) fn();
    },
    run(ms: number) {
      for (let t = 0; t < ms; t += 16) this.step();
    },
    // The person presses: listeners first (capture), then the browser moves the focus.
    press(then: El | null) {
      for (const fn of [...listeners]) fn();
      active = then;
    },
    pendingFrames: () => frames.size,
    advance(ms: number) {
      clock += ms;
    },
  };
}

test("the title takes the focus once the dialog's Confirm lets go, and again if the refresh drops it", () => {
  const p = fakePage();
  focusOnArrival("more-title", p.env.now());
  const cleanup = startArrivalFocus("more-title", p.env);
  expect(p.active).toBe("confirm"); // held by the control that sent the person here: left alone
  p.step();
  p.setActive(p.els.body); // the dialog unmounts
  p.step();
  expect(p.active).toBe("more-title");
  p.setActive(p.els.body); // router.refresh() redraws and drops the focus
  p.step();
  expect(p.active).toBe("more-title");
  cleanup();
});

test("<main>, focused by a dialog's fallback, counts as free (team.spec, CI on PR #18)", () => {
  const p = fakePage();
  focusOnArrival("more-title", p.env.now());
  startArrivalFocus("more-title", p.env);
  p.setActive(p.els.main);
  p.step();
  expect(p.active).toBe("more-title");
});

test("a key pressed during the window stops the loop: the focus never jumps back to the title", () => {
  const p = fakePage();
  focusOnArrival("more-title", p.env.now());
  startArrivalFocus("more-title", p.env);
  p.setActive(p.els.body);
  p.step();
  expect(p.active).toBe("more-title");
  // The person presses a key that moves the focus to <body> (Escape in a widget that blurs, for instance).
  p.press(p.els.body);
  p.run(1_500);
  expect(p.active).toBe("body");
  expect(p.focused).toEqual(["more-title"]);
  expect(p.listeners.size).toBe(0);
  expect(p.pendingFrames()).toBe(0);
});

test("a click elsewhere before the title is reached stops the loop: the focus stays where the click left it", () => {
  const p = fakePage();
  focusOnArrival("more-title", p.env.now());
  startArrivalFocus("more-title", p.env);
  p.step();
  expect(p.active).toBe("confirm");
  // A click on plain text: pointerdown, then the browser drops the focus to <body>, which used to count as "free".
  p.press(p.els.body);
  p.run(1_500);
  expect(p.active).toBe("body");
  expect(p.focused).toEqual([]);
  // The target is forgotten: a later mount of the same page does not reach for it either.
  startArrivalFocus("more-title", p.env);
  p.run(200);
  expect(p.focused).toEqual([]);
});

test("a click that focuses another control also wins", () => {
  const p = fakePage();
  focusOnArrival("more-title", p.env.now());
  startArrivalFocus("more-title", p.env);
  p.setActive(p.els.body);
  p.step();
  p.press(p.els.other);
  p.run(1_500);
  expect(p.active).toBe("other");
  expect(p.focused).toEqual(["more-title"]);
});

test("focus moved somewhere else without a press (script, autofocus) ends the window too", () => {
  const p = fakePage();
  focusOnArrival("more-title", p.env.now());
  startArrivalFocus("more-title", p.env);
  p.setActive(p.els.other);
  p.step();
  p.setActive(p.els.body);
  p.run(1_500);
  expect(p.focused).toEqual([]);
  expect(p.listeners.size).toBe(0);
});

test("Strict Mode: mount, cleanup, mount carries on the same window and still lands the focus", () => {
  const p = fakePage();
  focusOnArrival("more-title", p.env.now());
  const first = startArrivalFocus("more-title", p.env);
  first(); // React's dev double effect: cleanup before any frame ran
  expect(p.listeners.size).toBe(0);
  expect(p.pendingFrames()).toBe(0);
  const second = startArrivalFocus("more-title", p.env);
  expect(p.active).toBe("confirm"); // the Confirm noted at the first mount is still "held", not taken by the person
  p.step();
  p.setActive(p.els.body);
  p.step();
  expect(p.active).toBe("more-title");
  // Same window: it ends 1.5 s after the first mount, not the second.
  p.run(1_500);
  expect(p.pendingFrames()).toBe(0);
  expect(p.listeners.size).toBe(0);
  second();
});

test("Strict Mode after the focus landed: the remount keeps refocusing for the rest of the window", () => {
  const p = fakePage();
  p.setActive(p.els.body);
  focusOnArrival("more-title", p.env.now());
  const first = startArrivalFocus("more-title", p.env); // lands at once (the focus was free)
  expect(p.active).toBe("more-title");
  first();
  startArrivalFocus("more-title", p.env);
  p.setActive(p.els.body); // the refresh drops it
  p.step();
  expect(p.active).toBe("more-title");
});

test("the window ends after 1.5 s: the target is forgotten and a later drop to <body> is left alone", () => {
  const p = fakePage();
  p.setActive(p.els.body);
  focusOnArrival("more-title", p.env.now());
  startArrivalFocus("more-title", p.env);
  p.run(1_600);
  expect(p.pendingFrames()).toBe(0);
  expect(p.listeners.size).toBe(0);
  p.setActive(p.els.body);
  startArrivalFocus("more-title", p.env);
  p.run(200);
  expect(p.focused).toEqual(["more-title"]);
});

test("a page left mid-window without a press does not reach for the target when visited again later", () => {
  const p = fakePage();
  focusOnArrival("more-title", p.env.now());
  const cleanup = startArrivalFocus("more-title", p.env);
  p.step();
  cleanup(); // unmounted by a navigation the person did not make with a press
  p.advance(2_000);
  p.setActive(p.els.body);
  startArrivalFocus("more-title", p.env);
  p.run(200);
  expect(p.focused).toEqual([]);
});

test("a target not reached within 10 s is forgotten; another page's target is ignored", () => {
  const p = fakePage();
  p.setActive(p.els.body);
  focusOnArrival("more-title", p.env.now());
  startArrivalFocus("leads-title", p.env);
  p.run(100);
  expect(p.focused).toEqual([]);
  p.advance(10_001);
  startArrivalFocus("more-title", p.env);
  p.run(100);
  expect(p.focused).toEqual([]);
});
