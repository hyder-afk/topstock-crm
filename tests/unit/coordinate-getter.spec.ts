import { expect, test } from "@playwright/test";
import { DROP_ORDER, centreIn, jumpTarget } from "@/components/pipeline/coordinate-getter";

// The keyboard drag's stage jumps (Day 5 design 7.3 and 8.4).
test("→ walks Lead, Qualified, Negotiations, Won, then Lost; → at Lost stays", () => {
  expect(DROP_ORDER).toEqual(["lead", "qualified", "negotiations", "won", "lost"]);
  expect(jumpTarget("ArrowRight", "lead", false)).toBe("qualified");
  expect(jumpTarget("ArrowRight", "negotiations", false)).toBe("won");
  expect(jumpTarget("ArrowRight", "won", false)).toBe("lost");
  expect(jumpTarget("ArrowRight", "lost", false)).toBeNull();
});

test("← from Lead stays; ← from Won goes back to Negotiations", () => {
  expect(jumpTarget("ArrowLeft", "lead", false)).toBeNull();
  expect(jumpTarget("ArrowLeft", "won", false)).toBe("negotiations");
});

test("↑/↓ do nothing on a wide board and step on a phone", () => {
  expect(jumpTarget("ArrowDown", "lead", false)).toBeNull();
  expect(jumpTarget("ArrowUp", "qualified", false)).toBeNull();
  expect(jumpTarget("ArrowDown", "lead", true)).toBe("qualified");
  expect(jumpTarget("ArrowUp", "qualified", true)).toBe("lead");
});

test("only targets that exist count (the Lost band is mounted only while dragging)", () => {
  expect(jumpTarget("ArrowRight", "won", false, ["lead", "qualified", "negotiations", "won"])).toBeNull();
  expect(jumpTarget("ArrowRight", "unknown", false)).toBe("lead");
  expect(jumpTarget("KeyA", "lead", false)).toBeNull();
});

test("the card lands in the middle of the target", () => {
  expect(centreIn({ left: 100, top: 50, width: 300, height: 600 }, { width: 280, height: 120 })).toEqual({ x: 110, y: 86 });
  expect(centreIn({ left: 0, top: 0, width: 200, height: 100 }, { width: 100, height: 40 })).toEqual({ x: 50, y: 30 });
});
