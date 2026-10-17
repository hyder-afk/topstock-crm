import { expect, test } from "@playwright/test";
import { releaseVelocity } from "@/lib/motion";

// The pipeline drop's release speed (Apple audit #16): the pointer's move over the last ~50 ms before letting go.
test("a throw gives its speed over the last 50 ms", () => {
  const samples = [0, 16, 32, 48, 64, 80].map((t, i) => ({ t, x: i * 20, y: i * -5 }));
  const v = releaseVelocity(samples, 82);
  // 20 px per 16 ms = 1250 px/s; -5 px per 16 ms = -312.5 px/s.
  expect(v.x).toBeCloseTo(1250, 0);
  expect(v.y).toBeCloseTo(-312.5, 0);
});

test("a hand that stopped before letting go gives no speed", () => {
  const samples = [0, 16, 32].map((t, i) => ({ t, x: i * 20, y: 0 }));
  expect(releaseVelocity(samples, 200)).toEqual({ x: 0, y: 0 });
});

test("one sample or none gives no speed; a wild flick is clamped to 4000 px/s", () => {
  expect(releaseVelocity([], 0)).toEqual({ x: 0, y: 0 });
  expect(releaseVelocity([{ t: 0, x: 0, y: 0 }], 0)).toEqual({ x: 0, y: 0 });
  const v = releaseVelocity([{ t: 0, x: 0, y: 0 }, { t: 10, x: 900, y: -900 }], 10);
  expect(v).toEqual({ x: 4000, y: -4000 });
});
