"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { SearchInput } from "@/components/ui/search-input";
import type { ShareItem } from "@/lib/share/schema";
import { cn } from "@/lib/utils";

// The client page's list (design 10.5), shared by the public page and the team's "What clients see": a search, category
// chips (two or more categories), "In our warehouse in France" then "Arriving". Rows are 64 px at least; a row is a
// button when the page takes requests. Filtering happens here only: nothing leaves the browser.

const LOW_CARTONS = 3;

export function ShareList({
  items,
  showInTransit,
  onPick,
  picked,
}: {
  items: ShareItem[];
  showInTransit: boolean;
  onPick?: (item: ShareItem) => void;
  picked?: ReadonlySet<number>;
}) {
  const t = useTranslations("Share");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const query = useDeferredValue(q.trim().toLocaleLowerCase());
  const categories = useMemo(
    () => [...new Set(items.map((i) => i.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)),
    [items],
  );
  const visible = useMemo(
    () =>
      items.filter(
        (i) =>
          (!category || i.category === category) &&
          (!query || i.name.toLocaleLowerCase().includes(query) || `p-${String(i.number).padStart(4, "0")}`.includes(query)),
      ),
    [items, category, query],
  );
  const warehouse = visible.filter((i) => i.warehouse > 0);
  const arriving = showInTransit ? visible.filter((i) => i.warehouse === 0 && i.transit > 0) : [];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex min-w-0 flex-col gap-3">
        <SearchInput
          name="search"
          label={t("searchLabel")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`${t("search")}…`}
          className="bg-card"
        />
        {categories.length >= 2 ? (
          <div role="radiogroup" aria-label={t("categories")} className="flex snap-x gap-2 overflow-x-auto overscroll-x-contain pb-1">
            {[null, ...categories].map((c) => (
              <button
                key={c ?? "*"}
                type="button"
                role="radio"
                aria-checked={category === c}
                onClick={() => setCategory(c)}
                className={cn(
                  "min-h-11 shrink-0 snap-start rounded-full px-4 text-sm whitespace-nowrap transition-[background-color,transform] duration-150 active:scale-[0.97]",
                  category === c ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                )}
              >
                {c ?? t("allCategories")}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {visible.length === 0 && q.trim() ? (
        <p className="rounded-lg bg-card p-4 text-sm text-muted-foreground" role="status">
          {t("noResults", { q: q.trim() })}
        </p>
      ) : null}
      {warehouse.length > 0 ? <Section id="share-warehouse" title={t("warehouse")} items={warehouse} onPick={onPick} picked={picked} /> : null}
      {arriving.length > 0 ? <Section id="share-arriving" title={t("arriving")} items={arriving} onPick={onPick} picked={picked} /> : null}
    </div>
  );
}

function Section({
  id,
  title,
  items,
  onPick,
  picked,
}: {
  id: string;
  title: string;
  items: ShareItem[];
  onPick?: (item: ShareItem) => void;
  picked?: ReadonlySet<number>;
}) {
  const format = useFormatter();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <h2 id={id} className="flex items-baseline gap-2 text-lg font-bold text-balance">
        {title}
        <span className="font-mono text-sm font-normal text-muted-foreground">{format.number(items.length)}</span>
      </h2>
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg bg-card">
        {items.map((i) => (
          <li key={i.number}>
            <ItemRow item={i} onPick={onPick} picked={picked?.has(i.number) ?? false} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function usePrice() {
  const format = useFormatter();
  return (value: string) => format.number(Number(value), { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function ItemRow({ item, onPick, picked }: { item: ShareItem; onPick?: (item: ShareItem) => void; picked: boolean }) {
  const t = useTranslations("Share");
  const format = useFormatter();
  const price = usePrice();
  const inWarehouse = item.warehouse > 0;
  const avail = inWarehouse ? item.warehouse : item.transit;
  const cartons = Math.floor(avail / item.piecesPerCarton);
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 font-bold break-words" translate="no">
          {item.name}
        </span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {t("availability", { pieces: format.number(avail), cartons, ppc: format.number(item.piecesPerCarton) })}
        </span>
        {inWarehouse && cartons > 0 && cartons <= LOW_CARTONS ? (
          <span className="flex items-center gap-1.5 text-xs">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-status-amber" />
            {t("onlyLeft", { count: cartons })}
          </span>
        ) : null}
        {!inWarehouse ? (
          <span className="self-start rounded-full bg-muted px-2 py-0.5 text-xs">
            {item.etaWeek ? t("arrivingWeek", { date: format.dateTime(new Date(`${item.etaWeek}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" }) }) : t("dateTbc")}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        {item.priceMax === null ? (
          <span className="text-sm text-muted-foreground">{t("priceOnRequest")}</span>
        ) : (
          <>
            <span className="font-mono text-base tabular-nums" aria-hidden="true">
              {price(item.priceMax)}
            </span>
            <span className="text-xs text-muted-foreground" aria-hidden="true">
              {t("perPiece")}
            </span>
            <span className="sr-only">{t("priceSr", { price: price(item.priceMax) })}</span>
          </>
        )}
        <span className="font-mono text-[11px] text-muted-foreground">{t("ref", { number: String(item.number).padStart(4, "0") })}</span>
      </span>
    </>
  );
  const cls = "flex min-h-16 w-full min-w-0 items-start gap-3 px-4 py-3 text-left";
  if (!onPick) return <div className={cls}>{body}</div>;
  return (
    <button
      type="button"
      data-item-number={item.number}
      onClick={() => onPick(item)}
      aria-pressed={picked}
      className={cn(cls, "transition-[background-color] duration-150 hover:bg-muted/50 active:bg-muted", picked && "bg-muted/60")}
    >
      {body}
    </button>
  );
}
