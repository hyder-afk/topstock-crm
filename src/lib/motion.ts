// Spring presets (Master Plan 4, "Motion"). Animate transform and opacity only.
export const springs = {
  snappy: { type: "spring", stiffness: 400, damping: 30 },
  smooth: { type: "spring", stiffness: 300, damping: 30 },
  sheet: { type: "spring", stiffness: 260, damping: 32 },
  gentle: { type: "spring", stiffness: 180, damping: 24 },
  bead: { type: "spring", stiffness: 380, damping: 30, mass: 0.9 },
  // A dropped card coming home (Day 5b): critically damped, no overshoot, at rest in about 300 ms (design 8.6: ≤ 450).
  settle: { type: "spring", stiffness: 520, damping: 46 },
} as const;

// Where a flick would come to rest (Apple's projection with a deceleration rate of 0.99); velocity in px/s.
export function project(velocity: number, decelerationRate = 0.99) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

export type PointerSample = { t: number; x: number; y: number };

/** The release speed (px/s) at `now` from the last pointer samples (t in ms): the move over the most recent ~50 ms (at
 *  least two samples), so a hand that stopped before letting go gives 0 and a throw gives its speed. Clamped to
 *  ±4000 px/s. */
export function releaseVelocity(samples: readonly PointerSample[], now: number, windowMs = 50): { x: number; y: number } {
  const last = samples.at(-1);
  if (!last || samples.length < 2 || now - last.t > windowMs) return { x: 0, y: 0 };
  let first = samples[samples.length - 2];
  for (let i = samples.length - 2; i >= 0; i--) {
    first = samples[i];
    if (last.t - samples[i].t >= windowMs) break;
  }
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return { x: 0, y: 0 };
  const clamp = (v: number) => Math.max(-4000, Math.min(4000, v));
  return { x: clamp((last.x - first.x) / dt), y: clamp((last.y - first.y) / dt) };
}
