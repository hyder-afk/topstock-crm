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
