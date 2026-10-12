"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Search, X } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Kbd } from "@/components/ui/kbd";
import { UnitToggle, setDisplayUnit } from "@/components/inventory/bits";
import { STOCK_FILTERS, STOCK_SORTS, type StockFilter, type StockFilters } from "@/lib/inventory/filters";
import { pieces as fmtPieces } from "@/lib/inventory/format";
import type { StockSummary } from "@/lib/inventory/types";
import type { QtyUnit } from "@/lib/inventory/units";
import { isTyping } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

// The Stock tab's controls (design 10.1): search (/ focuses it, 150 ms debounce), filter chips with counts, category,
// sort, and the pcs/ctn display switch. Archived is offered to admins only.
export function StockToolbar({
  filters,
  onChange,
  summary,
  isAdmin,
  unit,
}: {
  filters: StockFilters;
  onChange: (next: StockFilters) => void;
  summary: StockSummary | undefined;
  isAdmin: boolean;
  unit: QtyUnit;
}) {
  const t = useTranslations("Inventory.toolbar");
  const tf = useTranslations("Inventory.filters");
  const locale = useLocale();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(filters.q ?? "");
  const [seenQ, setSeenQ] = useState(filters.q ?? "");
  if ((filters.q ?? "") !== seenQ) {
    setSeenQ(filters.q ?? "");
    setText(filters.q ?? "");
  }
  // The search is sent 150 ms after the last key.
  useEffect(() => {
    const value = text.trim();
    if (value === (filters.q ?? "")) return;
    const timer = window.setTimeout(() => onChange({ ...filters, q: value || undefined }), 150);
    return () => window.clearTimeout(timer);
  }, [text, filters, onChange]);
  // "/" focuses the search here (quiet while typing or in a dialog). Capture phase, so it runs before the app-wide "/"
  // (which opens the command menu on every other page) and stops it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const counts: Partial<Record<StockFilter, number>> = summary
    ? {
        all: summary.products,
        low: summary.low,
        sold_out: summary.sold_out,
        in_transit: summary.arriving,
        held: summary.held,
        hidden: summary.hidden,
        archived: summary.archived,
      }
    : {};
  const current = filters.filter ?? "all";
  const chips = STOCK_FILTERS.filter((f) => f !== "archived" || isAdmin);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-[1_1_220px]">
          <label htmlFor={`${id}-q`} className="sr-only">
            {t("search")}
          </label>
          <Search aria-hidden="true" strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            id={`${id}-q`}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={100}
            placeholder={t("searchPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className="min-h-11 w-full rounded-md border border-border bg-card pr-16 pl-9 text-base text-foreground placeholder:text-muted-foreground sm:min-h-10 [&::-webkit-search-cancel-button]:hidden"
          />
          {text ? (
            <button
              type="button"
              aria-label={t("clearSearch")}
              onClick={() => {
                setText("");
                onChange({ ...filters, q: undefined });
                inputRef.current?.focus();
              }}
              className="absolute top-1/2 right-1 grid size-11 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:text-foreground sm:size-9"
            >
              <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
            </button>
          ) : (
            <Kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 lg:inline-grid">/</Kbd>
          )}
        </div>
        {summary && summary.categories.length > 0 ? (
          <div className="w-full min-w-0 sm:w-40">
            <label htmlFor={`${id}-cat`} className="sr-only">
              {t("category")}
            </label>
            <Select
              id={`${id}-cat`}
              value={filters.category ?? ""}
              onChange={(e) => onChange({ ...filters, category: e.target.value || undefined })}
              className="bg-card sm:min-h-10"
            >
              <option value="">{t("allCategories")}</option>
              {summary.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="min-w-0 flex-1 sm:w-40 sm:flex-none">
          <label htmlFor={`${id}-sort`} className="sr-only">
            {t("sort")}
          </label>
          <Select
            id={`${id}-sort`}
            value={filters.sort ?? "name"}
            onChange={(e) => onChange({ ...filters, sort: e.target.value as StockFilters["sort"] })}
            className="bg-card sm:min-h-10"
          >
            {STOCK_SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`sorts.${s}`)}
              </option>
            ))}
          </Select>
        </div>
        <UnitToggle value={unit} onChange={setDisplayUnit} label={t("unit")} />
      </div>
      <div
        role="group"
        aria-label={t("filters")}
        className="-mx-4 flex snap-x gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden"
      >
        {chips.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={current === f}
            onClick={() => onChange({ ...filters, filter: f === "all" ? undefined : f })}
            className={cn(
              "inline-flex min-h-11 shrink-0 snap-start items-center gap-2 rounded-md border px-3 text-sm whitespace-nowrap transition-[color,background-color,transform] duration-150 active:scale-[0.97] sm:min-h-9",
              current === f ? "border-foreground bg-foreground text-background" : "border-border bg-card text-foreground hover:bg-muted",
            )}
          >
            {tf(f)}
            {counts[f] !== undefined ? (
              <span className={cn("font-mono text-xs", current === f ? "opacity-80" : "text-muted-foreground")}>{fmtPieces(locale, counts[f] as number)}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
