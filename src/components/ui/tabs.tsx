"use client";

import { useEffect, useRef, useState } from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { springs } from "@/lib/motion";
import { cn } from "@/lib/utils";

// Hand-built WAI-ARIA tabs (Day 4 design D12: no new dependency, like the hand-built dock). A tablist of buttons with a
// roving tabindex: Left and Right move between tabs (and wrap), Home and End jump to the ends; the tab that gets the
// focus is shown at once (automatic activation: panels draw from data already cached or prefetched). The selected
// tab's pill slides with Motion's layoutId and the `smooth` spring; reduced motion moves it instantly. On phones the
// strip scrolls sideways inside itself (snap), never the page. Hovering or focusing a tab calls onIntent (prefetch).
export type TabItem<T extends string> = { id: T; label: React.ReactNode };

export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
export const panelId = (base: string, id: string) => `${base}-panel-${id}`;

/**
 * Scrolls a sideways tab strip (only the strip, never the page) so the tab is whole on screen. The strip snaps each tab
 * to its start (`snap-mandatory`), so any other scroll position is snapped again by the browser and can leave the tab
 * cut: the strip goes to the first tab start from which this tab shows whole, measured in fractional pixels.
 */
function revealTab(el: HTMLElement) {
  const strip = el.parentElement;
  if (!strip || strip.scrollWidth <= strip.clientWidth) return;
  const box = strip.getBoundingClientRect();
  const at = (b: Element) => b.getBoundingClientRect().left - box.left - strip.clientLeft + strip.scrollLeft;
  const left = at(el);
  const right = left + el.getBoundingClientRect().width;
  const view = strip.clientWidth;
  if (left >= strip.scrollLeft - 0.5 && right <= strip.scrollLeft + view + 0.5) return;
  let target = left;
  if (left > strip.scrollLeft) {
    for (const b of Array.from(strip.children)) {
      const start = at(b);
      if (start + view >= right) {
        target = Math.min(start, left);
        break;
      }
    }
  }
  strip.scrollLeft = target;
}

export function TabList<T extends string>({
  items,
  value,
  onChange,
  onIntent,
  label,
  idBase,
  className,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  onIntent?: (id: T) => void;
  label: string;
  idBase: string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const refs = useRef(new Map<T, HTMLButtonElement>());
  // The pill follows the selected tab one frame later: the click's own frame only shows the new panel, and Motion
  // measures the tabs for the slide once that layout is done (measuring in the same frame doubled the page's layout
  // work; design 8.6 gives a tab switch 100 ms).
  const [pill, setPill] = useState(value);
  useEffect(() => {
    if (pill === value) return;
    const frame = requestAnimationFrame(() => setPill(value));
    return () => cancelAnimationFrame(frame);
  }, [pill, value]);

  // The selected tab is always in view in a strip that scrolls sideways (phones): on load (a deep link to ?tab=files)
  // and after a change made elsewhere (Details opened from the header). Read after paint, in an effect.
  useEffect(() => {
    const el = refs.current.get(value);
    if (el) revealTab(el);
  }, [value]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((i) => i.id === value);
    const next =
      event.key === "ArrowRight" ? items[(index + 1) % items.length]
      : event.key === "ArrowLeft" ? items[(index - 1 + items.length) % items.length]
      : event.key === "Home" ? items[0]
      : event.key === "End" ? items[items.length - 1]
      : null;
    if (!next) return;
    event.preventDefault();
    onChange(next.id);
    const el = refs.current.get(next.id);
    if (!el) return;
    el.focus({ preventScroll: true });
    revealTab(el);
  };

  return (
    <LayoutGroup id={idBase}>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className={cn(
          "flex max-w-full snap-x snap-mandatory gap-0.5 overflow-x-auto overscroll-x-contain rounded-md bg-muted p-1 [scrollbar-width:none] sm:self-start [&::-webkit-scrollbar]:hidden",
          className,
        )}
      >
        {items.map((item) => {
          const selected = item.id === value;
          return (
            <button
              key={item.id}
              ref={(el) => {
                if (el) refs.current.set(item.id, el);
                else refs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={tabId(idBase, item.id)}
              aria-selected={selected}
              aria-controls={panelId(idBase, item.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(item.id)}
              onPointerEnter={() => onIntent?.(item.id)}
              onFocus={() => onIntent?.(item.id)}
              className={cn(
                "relative min-h-11 shrink-0 snap-start rounded-[10px] px-3.5 text-sm whitespace-nowrap transition-[color,transform] duration-150 active:scale-[0.97] sm:min-h-9",
                selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                "focus-visible:outline-offset-[-2px]",
              )}
            >
              {item.id === pill ? (
                <motion.span
                  layoutId="pill"
                  aria-hidden="true"
                  transition={reduce ? { duration: 0 } : springs.smooth}
                  className="absolute inset-0 rounded-[10px] bg-pill shadow-[0_1px_3px_rgb(14_14_16/0.12)]"
                />
              ) : null}
              <span className="relative">{item.label}</span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

/** The panel of one tab. Only the selected panel is drawn; it is focusable so keyboard users land on its content. */
export function TabPanel({
  idBase,
  id,
  className,
  children,
}: {
  idBase: string;
  id: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="tabpanel" id={panelId(idBase, id)} aria-labelledby={tabId(idBase, id)} tabIndex={0} className={cn("focus-visible:outline-offset-4", className)}>
      {children}
    </div>
  );
}
