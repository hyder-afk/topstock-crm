import type { LostReason, StageKey } from "@/lib/deals";

// The last deal move this tab made, for U, Cmd/Ctrl+Z, the toast and the card menu (Day 5 design 5.3: 2 minutes). A
// store of its own (no React, no server actions), so the app-wide call panel can compare it with the last logged entry
// without loading the pipeline's code on every page.
export type LastMove = {
  id: string;
  historyId: number;
  toStage: StageKey;
  fromStage: StageKey;
  version: number;
  /** When this tab made the move (its clock), to tell it from a newer logged entry (U on the lead page). */
  at: number;
  until: number;
  leadId: string;
  lostReason: LostReason | null;
};

let lastMove: LastMove | null = null;

export function lastUndoableMove(): LastMove | null {
  return lastMove && lastMove.until > Date.now() ? lastMove : null;
}

/** The move just made (null: nothing undoable). */
export function setLastMove(move: LastMove | null) {
  lastMove = move;
}

/** Forgets the last move when it is this one (undone, or its deal deleted). */
export function clearLastMove(match: (m: LastMove) => boolean) {
  if (lastMove && match(lastMove)) lastMove = null;
}
