"use client";

import { useCallback, useId, useRef } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useDroppable } from "@dnd-kit/core";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { DealCardView } from "@/components/pipeline/deal-card";
import { VIRTUALISE_FROM, type BoardColumnKey, type DealCard } from "@/lib/deals";
import { formatMoney } from "@/lib/money";
import { springs } from "@/lib/motion";
import { cn } from "@/lib/utils";

// One column of the board (Day 5 design 7.1 and 7.3): a section labelled by its h2, with "9 deals, €48,200, 2 stalled"
// as its description; a drop target as a whole (unmounted cards never matter). From tablet width it scrolls on its own
// under a sticky header; on a phone the page scrolls and the column shows 30 cards at a time. More than 60 loaded cards
// are virtualised (TanStack Virtual); the card being dragged always stays drawn (rangeExtractor: spike S10). Neighbours
// move with Motion layout="position" on the li (spike S13: composes with the virtual row's translateY).
export function Column({
  column,
  title,
  count,
  value,
  stalled,
  cards,
  hiddenCount,
  canShowMore,
  loadingMore,
  loadMoreFailed,
  onShowMore,
  showOwner,
  now,
  stallDays,
  tabStopId,
  dimId,
  activeId,
  over,
  dragging,
  phone,
  emptyText,
  footer,
  disabledDrop,
}: {
  column: BoardColumnKey;
  title: string;
  count: number;
  value: string;
  stalled: number;
  cards: DealCard[];
  hiddenCount: number;
  canShowMore: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  onShowMore: () => void;
  showOwner: boolean;
  now: number;
  stallDays: number | null;
  tabStopId: string | null;
  dimId: string | null;
  activeId: string | null;
  over: boolean;
  dragging: boolean;
  phone: boolean;
  emptyText: string;
  footer?: React.ReactNode;
  disabledDrop?: boolean;
}) {
  const t = useTranslations("Pipeline");
  const locale = useLocale();
  const format = useFormatter();
  const reduce = useReducedMotion();
  const headingId = useId();
  const summaryId = useId();
  const { setNodeRef } = useDroppable({ id: column, disabled: disabledDrop });
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = !phone && cards.length > VIRTUALISE_FROM;
  const activeIndex = activeId ? cards.findIndex((c) => c.id === activeId) : -1;
  const rangeExtractor = useCallback(
    (range: Range) => {
      const r = defaultRangeExtractor(range);
      return activeIndex >= 0 && !r.includes(activeIndex) ? [...r, activeIndex].sort((a, b) => a - b) : r;
    },
    [activeIndex],
  );
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual: the column re-renders with its cards
  const virtualizer = useVirtualizer({
    count: virtual ? cards.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 136,
    overscan: 6,
    rangeExtractor,
    getItemKey: (i) => cards[i]?.id ?? i,
  });

  const summary = t("columnSummary", { count, value: formatMoney(value, locale), stalled });
  const card = (c: DealCard) => (
    <DealCardView
      card={c}
      now={now}
      stallDays={stallDays}
      showOwner={showOwner}
      tabStop={c.id === tabStopId}
      dim={c.id === dimId}
    />
  );

  return (
    <section
      ref={setNodeRef}
      aria-labelledby={headingId}
      aria-describedby={summaryId}
      data-column={column}
      data-over={over || undefined}
      className={cn(
        "flex min-w-0 shrink-0 snap-start flex-col rounded-lg transition-colors duration-150",
        "w-[calc(100vw-48px)] md:w-[calc((100%-12px)/2)] lg:w-auto",
        over ? "bg-muted" : "bg-[color-mix(in_oklab,var(--muted)_45%,transparent)]",
      )}
    >
      <header className="sticky top-0 z-[2] flex min-h-14 flex-col justify-center gap-0.5 rounded-t-lg px-3 pt-3 pb-2">
        <h2 id={headingId} className="flex items-baseline gap-2 text-sm font-bold">
          <span className="min-w-0 break-words">{over && dragging ? (column === "won" ? t("dropWon") : t("dropHere")) : title}</span>
          <span className="font-mono text-xs font-medium text-muted-foreground tabular-nums">{format.number(count)}</span>
        </h2>
        <p id={summaryId} className="text-xs text-muted-foreground">
          <span aria-hidden="true" className="font-mono tabular-nums">
            {formatMoney(value, locale)}
          </span>
          {stalled > 0 ? (
            <span aria-hidden="true">
              {" · "}
              {t("stalledCount", { count: stalled })}
            </span>
          ) : null}
          <span className="sr-only">{summary}</span>
        </p>
      </header>
      <div
        ref={scrollRef}
        data-column-scroll={column}
        className={cn(
          "flex-1 px-2 pb-2",
          !phone && "overflow-y-auto overscroll-contain md:h-[calc(100dvh-var(--board-top,300px)-152px)] md:min-h-[360px] md:flex-none",
        )}
      >
        {cards.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : virtual ? (
          <ul role="list" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const c = cards[row.index];
              return (
                <li
                  key={c.id}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0 pb-2"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <motion.div layout={reduce ? false : "position"} transition={springs.smooth}>
                    {card(c)}
                  </motion.div>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul role="list" className="flex flex-col gap-2">
            {cards.map((c) => (
              <motion.li key={c.id} layout={reduce || dragging ? false : "position"} transition={springs.smooth}>
                {card(c)}
              </motion.li>
            ))}
          </ul>
        )}
        {canShowMore || hiddenCount > 0 || loadMoreFailed ? (
          <div className="flex flex-col items-center gap-1 pt-3 pb-1 text-xs text-muted-foreground">
            {loadMoreFailed ? (
              <p role="alert" className="flex items-center gap-2">
                {t("loadMoreFailed")}
                <Button variant="link" className="min-h-11 text-xs sm:min-h-9" onClick={onShowMore}>
                  {t("retry")}
                </Button>
              </p>
            ) : (
              <Button variant="quiet" className="min-h-11 w-full text-sm sm:min-h-9" disabled={loadingMore} onClick={onShowMore}>
                {t("showMore", { count: format.number(Math.min(phone ? 30 : 50, Math.max(hiddenCount, count - cards.length) || (phone ? 30 : 50))) })}
              </Button>
            )}
            <span className="font-mono tabular-nums">{t("showingOf", { shown: format.number(cards.length), total: format.number(count) })}</span>
          </div>
        ) : null}
        {footer}
      </div>
    </section>
  );
}
