// U and Cmd/Ctrl+Z outside the board (the lead page, Home, any page with the call panel): Day 5 design 5.3 says they take
// back the latest change this tab made, whether that was a logged entry (undo_activity) or a deal move (undoDealMove).
// Both stores keep when the change was made (`at`, this tab's clock) and until when it may be undone (the server's
// window); the newer of the two still undoable wins.

export type Undoable = { at: number; until: number };

export function newerUndo<E extends Undoable, M extends Undoable>(
  entry: E | null,
  move: M | null,
  now: number = Date.now(),
): { kind: "entry"; entry: E } | { kind: "move"; move: M } | null {
  const e = entry && entry.until > now ? entry : null;
  const m = move && move.until > now ? move : null;
  if (e && m) return m.at > e.at ? { kind: "move", move: m } : { kind: "entry", entry: e };
  if (m) return { kind: "move", move: m };
  if (e) return { kind: "entry", entry: e };
  return null;
}
