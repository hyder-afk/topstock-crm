import { expect, test } from "@playwright/test";
import { cardKeyAction, pageKeyAction } from "@/components/pipeline/use-board-keys";

// Card keys (Day 5 design 7.7, D24): digits by key position (AZERTY), Shift+arrows, E, O, U, Delete; quiet while
// typing, composing, with a dialog open, or with a pending "G then a letter" chord.
const quiet = { typing: false, dialogOpen: false, chordPending: false };

test("digits are read by position: AZERTY's ' on Digit4 opens Won; Numpad5 opens Lost", () => {
  expect(cardKeyAction({ code: "Digit4", key: "'" }, "negotiations", quiet)).toEqual({ kind: "move", to: "won" });
  expect(cardKeyAction({ code: "Numpad5", key: "5" }, "lead", quiet)).toEqual({ kind: "move", to: "lost" });
  expect(cardKeyAction({ code: "Digit1", key: "&" }, "qualified", quiet)).toEqual({ kind: "move", to: "lead" });
  expect(cardKeyAction({ code: "Digit6", key: "6" }, "lead", quiet)).toBeNull();
});

test("Shift+→/← move one stage; Shift+→ from Negotiations asks to win; nothing past the ends", () => {
  expect(cardKeyAction({ code: "ArrowRight", key: "ArrowRight", shiftKey: true }, "lead", quiet)).toEqual({ kind: "move", to: "qualified" });
  expect(cardKeyAction({ code: "ArrowRight", key: "ArrowRight", shiftKey: true }, "negotiations", quiet)).toEqual({ kind: "move", to: "won" });
  expect(cardKeyAction({ code: "ArrowLeft", key: "ArrowLeft", shiftKey: true }, "lead", quiet)).toBeNull();
  expect(cardKeyAction({ code: "ArrowLeft", key: "ArrowLeft" }, "qualified", quiet)).toBeNull(); // plain arrows walk the board
});

test("Enter, E, O, U, Delete, Backspace, Shift+F10 and the menu key", () => {
  expect(cardKeyAction({ code: "Enter", key: "Enter" }, "lead", quiet)).toEqual({ kind: "open" });
  expect(cardKeyAction({ code: "KeyE", key: "e" }, "lead", quiet)).toEqual({ kind: "editValue" });
  expect(cardKeyAction({ code: "KeyO", key: "o" }, "lead", quiet)).toEqual({ kind: "openLead" });
  expect(cardKeyAction({ code: "KeyU", key: "u" }, "lead", quiet)).toEqual({ kind: "undo" });
  expect(cardKeyAction({ code: "Delete", key: "Delete" }, "lead", quiet)).toEqual({ kind: "delete" });
  expect(cardKeyAction({ code: "Backspace", key: "Backspace" }, "lead", quiet)).toEqual({ kind: "delete" });
  expect(cardKeyAction({ code: "F10", key: "F10", shiftKey: true }, "lead", quiet)).toEqual({ kind: "menu" });
  expect(cardKeyAction({ code: "ContextMenu", key: "ContextMenu" }, "lead", quiet)).toEqual({ kind: "menu" });
});

test("the G chord's letters are never card keys", () => {
  for (const key of ["h", "l", "p", "i", "t", "a", "m", "g"]) {
    expect(cardKeyAction({ code: `Key${key.toUpperCase()}`, key }, "lead", quiet)).toBeNull();
  }
});

test("typing, composing, an open dialog, a pending G chord and modifiers are ignored", () => {
  const four = { code: "Digit4", key: "4" };
  expect(cardKeyAction(four, "lead", { ...quiet, typing: true })).toBeNull();
  expect(cardKeyAction({ ...four, isComposing: true }, "lead", quiet)).toBeNull();
  expect(cardKeyAction(four, "lead", { ...quiet, dialogOpen: true })).toBeNull();
  expect(cardKeyAction(four, "lead", { ...quiet, chordPending: true })).toBeNull();
  expect(cardKeyAction({ ...four, metaKey: true }, "lead", quiet)).toBeNull();
  expect(cardKeyAction({ ...four, ctrlKey: true }, "lead", quiet)).toBeNull();
  expect(cardKeyAction({ ...four, altKey: true }, "lead", quiet)).toBeNull();
  expect(cardKeyAction({ ...four, shiftKey: true }, "lead", quiet)).toBeNull();
});

test("page keys: N opens New deal; U and Cmd/Ctrl+Z undo; quiet the same way", () => {
  expect(pageKeyAction({ code: "KeyN", key: "n" }, quiet)).toBe("new");
  expect(pageKeyAction({ code: "KeyU", key: "u" }, quiet)).toBe("undo");
  expect(pageKeyAction({ code: "KeyZ", key: "z", metaKey: true }, quiet)).toBe("undo");
  expect(pageKeyAction({ code: "KeyZ", key: "z", ctrlKey: true }, quiet)).toBe("undo");
  expect(pageKeyAction({ code: "KeyZ", key: "z", ctrlKey: true, shiftKey: true }, quiet)).toBeNull();
  expect(pageKeyAction({ code: "KeyN", key: "n" }, { ...quiet, typing: true })).toBeNull();
  expect(pageKeyAction({ code: "KeyN", key: "n" }, { ...quiet, chordPending: true })).toBeNull();
  expect(pageKeyAction({ code: "KeyN", key: "N", shiftKey: true }, quiet)).toBeNull();
});
