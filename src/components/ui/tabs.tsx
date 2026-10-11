"use client";

import { useRef } from "react";
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
    el?.focus();
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
              {selected ? (
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
