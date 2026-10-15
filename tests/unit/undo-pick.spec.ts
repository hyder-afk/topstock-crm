import { expect, test } from "@playwright/test";
import { newerUndo } from "@/lib/undo-pick";

// U and Cmd/Ctrl+Z outside the board take back the newer of the last logged entry and the last deal move (design 5.3).
const now = 1_000_000;
const entry = (at: number, until = at + 120_000) => ({ kind: "e", at, until });
const move = (at: number, until = at + 120_000) => ({ kind: "m", at, until });

test("the newer change wins while both can be undone", () => {
  expect(newerUndo(entry(now - 60_000), move(now - 10_000), now)?.kind).toBe("move");
  expect(newerUndo(entry(now - 10_000), move(now - 60_000), now)?.kind).toBe("entry");
});

test("only what is still in its window counts", () => {
  // The entry is newer but its window has closed: the move is undone.
  expect(newerUndo(entry(now - 1_000, now - 1), move(now - 60_000), now)?.kind).toBe("move");
  expect(newerUndo(entry(now - 60_000), move(now - 1_000, now - 1), now)?.kind).toBe("entry");
  expect(newerUndo(null, move(now - 130_000), now)).toBeNull();
  expect(newerUndo(null, null, now)).toBeNull();
  expect(newerUndo(entry(now - 5_000), null, now)?.kind).toBe("entry");
});
