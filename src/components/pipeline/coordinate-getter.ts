import type { KeyboardCoordinateGetter } from "@dnd-kit/core";

// The keyboard drag (Day 5 design 7.3): Space picks a card up, then the arrow keys jump from stage to stage instead of
// nudging 10 px at a time. ←/→ go to the previous or next drop target in board order (Lead, Qualified, Negotiations,
// Won, then the Lost band); on a phone, where one column fills the width, ↑/↓ do the same; elsewhere they do nothing.
// Each jump scrolls the target into view. Pure parts are unit-tested (tests/unit/coordinate-getter.spec.ts).
export const DROP_ORDER = ["lead", "qualified", "negotiations", "won", "lost"] as const;

/** The drop target an arrow key leads to from `current`, or null (no move: an end of the board, or not an arrow). */
export function jumpTarget(code: string, current: string, phone: boolean, available: readonly string[] = DROP_ORDER): string | null {
  const order = DROP_ORDER.filter((id) => available.includes(id));
  const i = order.indexOf(current as (typeof DROP_ORDER)[number]);
  const step = code === "ArrowRight" || (phone && code === "ArrowDown") ? 1 : code === "ArrowLeft" || (phone && code === "ArrowUp") ? -1 : 0;
  if (!step) return null;
  if (i < 0) return order[0] ?? null;
  const next = order[i + step];
  return next ?? null;
}

/** The coordinates that put the dragged card in the middle of the target (dnd-kit moves the card's top-left corner). */
export function centreIn(target: { left: number; top: number; width: number; height: number }, card: { width: number; height: number }) {
  return {
    x: target.left + target.width / 2 - card.width / 2,
    y: target.top + Math.min(target.height / 2, 96) - card.height / 2,
  };
}

export function makeColumnJump(isPhone: () => boolean): KeyboardCoordinateGetter {
  return (event, { context, currentCoordinates }) => {
    const stage = context.active?.data.current?.stage as string | undefined;
    const current = context.over ? String(context.over.id) : (stage ?? "lead");
    const available = [...context.droppableRects.keys()].map(String);
    const target = jumpTarget(event.code, current, isPhone(), available);
    if (!target) {
      // Up and down on a wide board, and the ends: the card stays where it is (no 10 px nudge).
      if (event.code.startsWith("Arrow")) event.preventDefault();
      return currentCoordinates;
    }
    event.preventDefault();
    const node = context.droppableContainers.get(target)?.node.current;
    node?.scrollIntoView({ inline: "center", block: "nearest" });
    const rect = node?.getBoundingClientRect() ?? context.droppableRects.get(target);
    const card = context.collisionRect ?? { width: 0, height: 0 };
    return rect ? centreIn(rect, card) : currentCoordinates;
  };
}
