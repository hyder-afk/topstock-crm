"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { animate, motion, useMotionValue, useReducedMotion, type PanInfo } from "motion/react";
import { project, springs } from "@/lib/motion";
import { sectionForPath, sections, type SectionId } from "@/lib/nav";
import { cn } from "@/lib/utils";

const BEAD = 56; // px, the red bead that marks the current section

type Slot = { id: SectionId; x: number };

// The floating dock (Master Plan 4): bottom-centre on every width, a Signal Red bead sits over the current section.
// Tap a section, or drag the bead along the bar and let go: it snaps to the nearest section (velocity-projected) and
// opens it. Links stay real links, so keyboard, screen readers and middle-click work without the bead.
export function Dock() {
  const t = useTranslations("Nav");
  const pathname = usePathname();
  const router = useRouter();
  const reduce = useReducedMotion();
  const barRef = useRef<HTMLDivElement>(null);
  const links = useRef(new Map<SectionId, HTMLAnchorElement>());
  const dragging = useRef(false);
  const moved = useRef(false); // this press turned into a drag
  const placed = useRef(false);
  const x = useMotionValue(0);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [preview, setPreview] = useState<SectionId | null>(null);

  // Sections hidden at this width (Tasks and Analytics on phones) belong to More.
  const routeSection = sectionForPath(pathname);
  const active: SectionId =
    slots.length === 0 || slots.some((s) => s.id === routeSection) ? routeSection : "more";
  const shown = preview ?? active;

  // Where the bead sits over each visible section, in bar coordinates.
  const measure = useCallback(() => {
    const next: Slot[] = [];
    for (const s of sections) {
      const el = links.current.get(s.id);
      if (el && el.offsetParent !== null) next.push({ id: s.id, x: el.offsetLeft + el.offsetWidth / 2 - BEAD / 2 });
    }
    return next;
  }, []);

  // Measure on mount and on every resize (the observer fires once on observe); the bead jumps to its new place.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const observer = new ResizeObserver(() => {
      const next = measure();
      setSlots(next);
      const section = sectionForPath(window.location.pathname);
      const visible = next.some((s) => s.id === section) ? section : "more";
      // jump(), not set(): an instant move must not leave a velocity behind for the next spring to inherit.
      if (!dragging.current) x.jump(next.find((s) => s.id === visible)?.x ?? 0);
      placed.current = true;
    });
    observer.observe(bar);
    return () => observer.disconnect();
  }, [measure, x]);

  // On navigation the bead springs from wherever it is now (interruptible); reduced motion moves it instantly.
  useLayoutEffect(() => {
    if (!placed.current || dragging.current) return;
    const target = slots.find((s) => s.id === active)?.x;
    if (target === undefined || Math.abs(x.get() - target) < 0.5) return;
    if (reduce) x.jump(target);
    else animate(x, target, springs.bead);
  }, [active, slots, reduce, x]);

  const nearest = (value: number) =>
    slots.reduce((best, s) => (Math.abs(s.x - value) < Math.abs(best.x - value) ? s : best), slots[0]);

  const onDrag = () => {
    const id = nearest(x.get())?.id ?? null;
    if (id !== preview) setPreview(id);
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    dragging.current = false;
    setPreview(null);
    const target = nearest(x.get() + (reduce ? 0 : project(info.velocity.x)));
    if (!target) return;
    animate(x, target.x, reduce ? { duration: 0 } : { ...springs.bead, velocity: info.velocity.x });
    if (target.id !== active) {
      if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate(8);
      router.push(sections.find((s) => s.id === target.id)!.href);
    }
  };

  // Arrow keys move between sections, Home and End jump to the ends; Enter opens (native link behaviour).
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const order = slots.map((s) => links.current.get(s.id)).filter((el): el is HTMLAnchorElement => !!el);
    const index = order.indexOf(document.activeElement as HTMLAnchorElement);
    if (index < 0) return;
    const next =
      event.key === "ArrowRight" ? order[(index + 1) % order.length]
      : event.key === "ArrowLeft" ? order[(index - 1 + order.length) % order.length]
      : event.key === "Home" ? order[0]
      : event.key === "End" ? order[order.length - 1]
      : null;
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const minX = slots[0]?.x ?? 0;
  const maxX = slots[slots.length - 1]?.x ?? 0;
  const BeadIcon = sections.find((s) => s.id === shown)!.icon;

  return (
    <nav
      aria-label={t("label")}
      onKeyDown={onKeyDown}
      className="dock-glass fixed inset-x-0 bottom-[calc(16px+env(safe-area-inset-bottom,0px))] z-30 mx-auto h-16 w-[min(440px,calc(100%-24px))] rounded-xl border border-border shadow-[0_12px_32px_rgb(14_14_16/0.14)] lg:w-[min(600px,calc(100%-48px))]"
    >
      <div ref={barRef} className="relative grid h-full grid-flow-col auto-cols-fr">
        {sections.map((s) => {
          const Icon = s.icon;
          const on = shown === s.id;
          return (
            <Link
              key={s.id}
              href={s.href}
              ref={(el) => {
                if (el) links.current.set(s.id, el);
                else links.current.delete(s.id);
              }}
              aria-current={active === s.id ? "page" : undefined}
              className={cn(
                "group flex min-w-0 flex-col items-center justify-end gap-0.5 rounded-lg pb-2 text-[0.6875rem] tracking-[0.01em] transition-colors duration-150",
                on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                !s.phone && "hidden lg:flex",
                "focus-visible:outline-offset-[-4px]",
              )}
            >
              <Icon
                aria-hidden="true"
                strokeWidth={1.75}
                className={cn(
                  "size-[22px] transition-[opacity,transform] duration-150 group-active:scale-[0.86]",
                  on ? "opacity-0" : "opacity-100",
                )}
              />
              <span className="max-w-full truncate px-1">{t(s.id)}</span>
            </Link>
          );
        })}

        {/* The bead: decorative for assistive tech (the links carry the meaning); pointer-draggable for speed. */}
        <motion.div
          aria-hidden="true"
          data-testid="dock-bead"
          drag="x"
          dragConstraints={{ left: minX, right: maxX }}
          dragElastic={0.05}
          dragMomentum={false}
          onTapStart={() => {
            moved.current = false;
          }}
          onDragStart={() => {
            dragging.current = true;
            moved.current = true;
          }}
          // A tap (no drag) on the bead opens its section's main page, e.g. More while on Tasks on a phone, or
          // the leads list from a lead. A press that became a drag never counts as a tap.
          onTap={() => {
            const href = sections.find((s) => s.id === active)!.href;
            if (!moved.current && pathname !== href) router.push(href);
          }}
          onDrag={onDrag}
          onDragEnd={onDragEnd}
          whileDrag={reduce ? undefined : { scale: 1.08 }}
          style={{ x, width: BEAD, height: BEAD, touchAction: "none" }}
          className={cn(
            "absolute top-[-20px] left-0 grid cursor-grab place-items-center rounded-full bg-brand text-brand-foreground",
            "shadow-[0_8px_24px_rgb(14_14_16/0.25),0_0_0_6px_var(--background)] active:cursor-grabbing",
            slots.length === 0 && "opacity-0",
          )}
        >
          <BeadIcon strokeWidth={2} className="size-6" />
        </motion.div>
      </div>
    </nav>
  );
}
