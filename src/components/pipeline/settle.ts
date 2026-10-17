import { animate } from "motion/react";
import { springs } from "@/lib/motion";

// The spring settle (Day 5 design 7.4): after a drop, the card is already in its new place (optimistic); it starts where
// the dragged copy was let go and springs home, transform only. If the card is outside its column's view (or not drawn
// yet in a virtualised column), it is brought into view first, instantly, so the settle always lands on a visible card.
// Interruptible: picking the card up again stops the animation where it is (Motion animations start from the current
// value). A thrown card carries the release speed into the settle (vx, vy in px/s; Apple audit #16), so the motion goes
// on from the hand instead of stopping and easing home. Reduced motion: no travel, a fade of at most 120 ms.
export type SettleFrom = { id: string; left: number; top: number; token: number; vx?: number; vy?: number };

export function cardElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-deal-card="${CSS.escape(id)}"]`);
}

export function settle(from: SettleFrom, reduce: boolean) {
  const el = cardElement(from.id);
  if (!el) return;
  const box = el.getBoundingClientRect();
  const view = el.closest<HTMLElement>("[data-column-scroll]");
  const vr = view?.getBoundingClientRect();
  if (box.bottom < 0 || box.top > window.innerHeight || (vr && (box.bottom < vr.top || box.top > vr.bottom))) {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  const now = el.getBoundingClientRect();
  if (reduce) {
    animate(el, { opacity: [0.4, 1] }, { duration: 0.12 });
    return;
  }
  const dx = from.left - now.left;
  const dy = from.top - now.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  animate(el, { x: [dx, 0], y: [dy, 0], scale: [1.03, 1] }, {
    ...springs.settle,
    x: { ...springs.settle, velocity: from.vx ?? 0 },
    y: { ...springs.settle, velocity: from.vy ?? 0 },
  });
}
