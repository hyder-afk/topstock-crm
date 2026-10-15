import type { StageKey } from "@/lib/deals";
import { stepStage } from "@/lib/deals";

// What a key press on a focused deal card means (Day 5 design 7.7, D24). Digits are read from `event.code` (the key's
// place), so AZERTY's top row (& é " ' () works without Shift; Shift+←/→ move one stage; E, O, U, N, Delete. Letters the
// "G then a letter" chord uses (h l p i t a m) are never card keys. Quiet while typing, composing, with a dialog open,
// with a modifier (other than Shift for the arrows), or while a G chord is pending. Unit-tested
// (tests/unit/board-keys.spec.ts).
export type CardKeyAction =
  | { kind: "move"; to: StageKey }
  | { kind: "open" }
  | { kind: "editValue" }
  | { kind: "openLead" }
  | { kind: "undo" }
  | { kind: "delete" }
  | { kind: "menu" }
  | null;

const DIGIT_STAGE: Record<string, StageKey> = { "1": "lead", "2": "qualified", "3": "negotiations", "4": "won", "5": "lost" };

export type KeyLike = {
  key: string;
  code: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
};

export function cardKeyAction(
  e: KeyLike,
  stage: StageKey,
  ctx: { typing: boolean; dialogOpen: boolean; chordPending: boolean },
): CardKeyAction {
  if (e.isComposing || ctx.typing || ctx.dialogOpen || ctx.chordPending) return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    const to = stepStage(stage, e.key === "ArrowRight" ? 1 : -1);
    return to ? { kind: "move", to } : null;
  }
  if (e.shiftKey && e.key === "F10") return { kind: "menu" };
  if (e.shiftKey) return null;
  const digit = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
  if (digit) return { kind: "move", to: DIGIT_STAGE[digit[1]] };
  if (e.key === "Enter") return { kind: "open" };
  if (e.key === "ContextMenu") return { kind: "menu" };
  if (e.key === "Delete" || e.key === "Backspace") return { kind: "delete" };
  switch (e.key.toLowerCase()) {
    case "e":
      return { kind: "editValue" };
    case "o":
      return { kind: "openLead" };
    case "u":
      return { kind: "undo" };
    default:
      return null;
  }
}

/** Page keys on the pipeline (N new deal, U and Cmd/Ctrl+Z undo): the same quiet rules, no card needed. */
export function pageKeyAction(e: KeyLike, ctx: { typing: boolean; dialogOpen: boolean; chordPending: boolean }): "new" | "undo" | null {
  if (e.isComposing || ctx.typing || ctx.dialogOpen || ctx.chordPending || e.altKey) return null;
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") return "undo";
  if (e.metaKey || e.ctrlKey || e.shiftKey) return null;
  if (e.key.toLowerCase() === "n") return "new";
  if (e.key.toLowerCase() === "u") return "undo";
  return null;
}
