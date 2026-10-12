"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EyeOff } from "lucide-react";
import { StockStatusBadge, useQtyText } from "@/components/inventory/bits";
import { pieces as fmtPieces, priceRange, pricePerPiece } from "@/lib/inventory/format";
import { productRef, weekStart } from "@/lib/inventory/status";
import type { StockRow } from "@/lib/inventory/types";
import { availabilityFill, type QtyUnit } from "@/lib/inventory/units";
import { cn } from "@/lib/utils";

// The stock table (design 10.1): virtualised rows (TanStack Virtual) over keyset pages of 100. Columns: Product (name,
// P-ref and category muted) · Price/pc (min–max) · Pcs/ctn · In warehouse (available, the bar against 3 × the reorder
// point, "on hand / held" on hover) · In transit (pieces and ETA week) · Cost/pc (managers and admins) · Status. At 768
// the stock columns fold into one; under 768 each product is a card with its available pieces large. Up and Down (or J
// and K) move between products and open each; the page never scrolls sideways (the table scrolls inside its box).

const headerHeight = 44;
type Layout = "wide" | "medium" | "narrow";
const queries = { wide: "(min-width: 1024px)", medium: "(min-width: 768px)" };
function subscribe(cb: () => void) {
  const a = window.matchMedia(queries.wide);
  const b = window.matchMedia(queries.medium);
  a.addEventListener("change", cb);
  b.addEventListener("change", cb);
  return () => {
    a.removeEventListener("change", cb);
    b.removeEventListener("change", cb);
  };
}
function useLayout(): Layout {
  return useSyncExternalStore(
    subscribe,
    () => (window.matchMedia(queries.wide).matches ? "wide" : window.matchMedia(queries.medium).matches ? "medium" : "narrow"),
    () => "wide",
  );
}

export function StockTable({
  rows,
  total,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  activeId,
  onOpen,
  onPrefetch,
  showCost,
  unit,
}: {
  rows: StockRow[];
  total: number | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  activeId: string | null;
  onOpen: (id: string) => void;
  onPrefetch: (id: string) => void;
  showCost: boolean;
  unit: QtyUnit;
}) {
  const t = useTranslations("Inventory.table");
  const tPanel = useTranslations("Inventory.panel");
  const locale = useLocale();
  const format = useFormatter();
  const qty = useQtyText();
  const layout = useLayout();
  const scrollRef = useRef<HTMLDivElement>(null);

  const cols =
    layout === "wide"
      ? ["minmax(220px,2fr)", "150px", "84px", "180px", "160px", ...(showCost ? ["110px"] : []), "130px"]
      : layout === "medium"
        ? ["minmax(200px,2fr)", "140px", "minmax(170px,1fr)", "120px"]
        : ["minmax(0,1fr)"];
  const template = cols.join(" ");
  const minWidth = layout === "wide" ? 220 + 150 + 84 + 180 + 160 + (showCost ? 110 : 0) + 130 : 0;
  const rowHeight = layout === "narrow" ? 96 : 64;

  const virtualizer = useVirtualizer({
    count: rows.length + (hasNextPage || rows.length > 0 ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    scrollMargin: layout === "narrow" ? 0 : headerHeight,
    scrollPaddingStart: layout === "narrow" ? 0 : headerHeight,
  });
  useEffect(() => virtualizer.measure(), [rowHeight, virtualizer]);
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1].index : -1;
  useEffect(() => {
    if (lastIndex >= rows.length - 1 && hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [lastIndex, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const offset = layout === "narrow" ? 0 : headerHeight;
  function move(from: number, step: number) {
    const next = from + step;
    if (next < 0 || next >= rows.length) return;
    virtualizer.scrollToIndex(next, { align: "auto" });
    onOpen(rows[next].id);
    const focus = (tries: number) =>
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-link="${next}"]`);
        if (el) el.focus();
        else if (tries > 0) focus(tries - 1);
      });
    focus(3);
  }
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = Number((event.target as HTMLElement).dataset.rowLink ?? NaN);
    if (Number.isNaN(index) || event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    move(index, step);
  }

  const etaWeek = (eta: string | null) =>
    eta ? t("week", { date: format.dateTime(new Date(`${weekStart(eta)}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" }) }) : t("noEta");

  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label={t("label")}
      aria-rowcount={total !== null ? total + 1 : undefined}
      onKeyDown={onKeyDown}
      data-stock-scroll
      className="relative min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg bg-card"
    >
      <div style={{ minWidth }} className="relative">
        {layout !== "narrow" ? (
          <div
            role="row"
            aria-rowindex={1}
            style={{ gridTemplateColumns: template }}
            className="sticky top-0 z-10 grid h-11 items-center border-b border-border bg-card font-mono text-xs text-muted-foreground"
          >
            <div role="columnheader" className="truncate px-4">{t("product")}</div>
            <div role="columnheader" className="truncate px-3 text-right">{t("price")}</div>
            {layout === "wide" ? (
              <>
                <div role="columnheader" className="truncate px-3 text-right">{t("carton")}</div>
                <div role="columnheader" className="truncate px-3 text-right">{t("warehouse")}</div>
                <div role="columnheader" className="truncate px-3 text-right">{t("transit")}</div>
                {showCost ? <div role="columnheader" className="truncate px-3 text-right">{t("cost")}</div> : null}
              </>
            ) : (
              <div role="columnheader" className="truncate px-3 text-right">{t("stock")}</div>
            )}
            <div role="columnheader" className="truncate px-3">{t("status")}</div>
          </div>
        ) : null}
        <div style={{ height: virtualizer.getTotalSize() }} className="relative">
          {items.map((v) => {
            const r = rows[v.index];
            if (!r) {
              return (
                <div
                  key="tail"
                  role="row"
                  style={{ transform: `translateY(${v.start - offset}px)`, height: v.size }}
                  className="absolute inset-x-0 top-0 flex items-center px-4 text-sm text-muted-foreground"
                >
                  {hasNextPage ? (
                    <span role="cell" className="flex w-full items-center gap-3" aria-label={t("loadingMore")}>
                      <span className="h-4 w-1/3 rounded-sm bg-muted motion-safe:animate-pulse" />
                      <span className="h-4 w-1/5 rounded-sm bg-muted motion-safe:animate-pulse" />
                    </span>
                  ) : (
                    <span role="cell">{t("end")}</span>
                  )}
                </div>
              );
            }
            const active = r.id === activeId;
            const fill = availabilityFill(r.wh_available, r.reorder_point);
            const nameCell = (
              <a
                href={`/inventory/p/${r.id}`}
                data-row-link={v.index}
                aria-current={active || undefined}
                onFocus={() => onPrefetch(r.id)}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  onOpen(r.id);
                }}
                className="flex min-w-0 flex-1 flex-col rounded-sm focus-visible:outline-offset-2"
              >
                <span className="truncate font-bold" dir="auto">
                  {r.name}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
                  <span className="font-mono">{productRef(r.number)}</span>
                  {r.category ? <span className="truncate" dir="auto">· {r.category}</span> : null}
                  {!r.share_visible ? (
                    <span className="inline-flex items-center gap-1">
                      · <EyeOff aria-hidden="true" strokeWidth={1.75} className="size-3" />
                      {tPanel("hidden")}
                    </span>
                  ) : null}
                </span>
              </a>
            );
            const whCell = (
              <span className="flex min-w-0 flex-col items-end gap-1" title={t("onHandHeld", { onHand: fmtPieces(locale, r.wh_on_hand), held: fmtPieces(locale, r.wh_reserved) })}>
                <span className="font-mono">{qty(r.wh_available, r.pieces_per_carton, unit)}</span>
                {fill !== null ? (
                  <span aria-hidden="true" className="block h-1 w-20 overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn("block h-full origin-left rounded-full", r.status_key === "low" || r.status_key === "sold_out" ? "bg-status-amber" : "bg-foreground/60")}
                      style={{ transform: `scaleX(${fill})` }}
                    />
                  </span>
                ) : r.wh_reserved > 0 ? (
                  <span className="font-mono text-xs text-muted-foreground">{t("heldN", { n: fmtPieces(locale, r.wh_reserved) })}</span>
                ) : null}
              </span>
            );
            const trCell =
              r.tr_on_hand > 0 ? (
                <span className="flex min-w-0 flex-col items-end gap-0.5">
                  <span className="font-mono">{qty(r.tr_on_hand, r.pieces_per_carton, unit)}</span>
                  <span className="truncate text-xs text-muted-foreground">{etaWeek(r.transit_eta)}</span>
                </span>
              ) : (
                <span className="font-mono text-muted-foreground">–</span>
              );
            const price = priceRange(locale, r.price_min, r.price_max);
            return (
              <div
                key={r.id}
                role="row"
                aria-rowindex={v.index + 2}
                data-active={active || undefined}
                style={{ transform: `translateY(${v.start - offset}px)`, height: v.size, gridTemplateColumns: template }}
                onMouseEnter={() => onPrefetch(r.id)}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a,button,input")) return;
                  onOpen(r.id);
                }}
                className={cn(
                  "absolute inset-x-0 top-0 grid cursor-pointer items-center border-b border-border text-sm transition-colors duration-100",
                  active ? "bg-muted/60" : "hover:bg-muted/30 active:bg-muted/50",
                )}
              >
                {layout === "narrow" ? (
                  <div role="cell" className="flex min-w-0 items-center justify-between gap-3 px-4">
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      {nameCell}
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <StockStatusBadge status={r.status_key} />
                        {price ? <span className="truncate font-mono text-xs text-muted-foreground">{price}</span> : null}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5">
                      <span className="font-mono text-xl leading-tight">{fmtPieces(locale, r.wh_available)}</span>
                      <span className="text-xs text-muted-foreground">{t("availableShort")}</span>
                      {r.tr_on_hand > 0 ? <span className="font-mono text-xs text-muted-foreground">{t("plusTransit", { n: fmtPieces(locale, r.tr_on_hand) })}</span> : null}
                    </span>
                  </div>
                ) : (
                  <>
                    <div role="cell" className="flex min-w-0 items-center px-4">{nameCell}</div>
                    <div role="cell" className="truncate px-3 text-right font-mono text-xs">
                      {price ?? <span className="text-muted-foreground">{t("noPrice")}</span>}
                    </div>
                    {layout === "wide" ? (
                      <>
                        <div role="cell" className="px-3 text-right font-mono">{fmtPieces(locale, r.pieces_per_carton)}</div>
                        <div role="cell" className="flex justify-end px-3">{whCell}</div>
                        <div role="cell" className="flex justify-end px-3">{trCell}</div>
                        {showCost ? (
                          <div role="cell" className="px-3 text-right font-mono text-xs">
                            {r.cost_per_piece !== null ? pricePerPiece(locale, r.cost_per_piece) : <span className="text-muted-foreground">–</span>}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div role="cell" className="flex flex-col items-end justify-center gap-0.5 px-3">
                        <span className="font-mono">{qty(r.wh_available, r.pieces_per_carton, unit)}</span>
                        {r.tr_on_hand > 0 ? <span className="truncate font-mono text-xs text-muted-foreground">{t("plusTransit", { n: fmtPieces(locale, r.tr_on_hand) })}</span> : null}
                      </div>
                    )}
                    <div role="cell" className="flex min-w-0 px-3">
                      <StockStatusBadge status={r.status_key} />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function StockTableSkeleton() {
  return (
    <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-card">
      <div className="hidden h-11 border-b border-border md:block" />
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex h-24 items-center gap-4 border-b border-border px-4 md:h-16">
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-4 w-1/2 rounded-sm bg-muted motion-safe:animate-pulse md:w-1/3" />
            <div className="h-3 w-1/4 rounded-sm bg-muted motion-safe:animate-pulse" />
          </div>
          <div className="hidden h-4 w-24 rounded-sm bg-muted motion-safe:animate-pulse md:block" />
          <div className="h-6 w-16 rounded-sm bg-muted motion-safe:animate-pulse md:h-4" />
          <div className="hidden h-5 w-20 rounded-sm bg-muted motion-safe:animate-pulse md:block" />
        </div>
      ))}
    </div>
  );
}
