"use client";

import Link from "next/link";
import { Package } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { CardError, Dot, HomeCard, RowSkeletons } from "@/components/home/home-card";
import type { LowStockCard as LowStock } from "@/lib/home";

// Low stock (Day 5 design 7.12, D30; the Day 6 contract in design section 10). Before Day 6 (home_low_stock answers
// null): a package icon and one calm sentence, no link (Inventory is still a placeholder), in the same grid cell, so
// nothing moves when inventory lands. After Day 6: "3 low · 1 out · 2 deals waiting", up to 5 products with what is
// available against the reorder level (DM Mono), stock in transit (muted, never counted as available) and a dot-plus-
// word badge, and "Open inventory". The card fails alone.

export function LowStockCard({ lowStock, loading, onRetry }: { lowStock: LowStock | null | undefined; loading: boolean; onRetry: () => void }) {
  const t = useTranslations("Home.lowStock");
  const format = useFormatter();
  const date = (d: string) => format.dateTime(new Date(`${d}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <HomeCard
      labelId="home-low-stock"
      title={t("title")}
      className="col-span-12 lg:col-span-5"
      busy={loading}
      action={
        lowStock ? (
          <Link href="/inventory?filter=low" className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground sm:min-h-0">
            {t("open")}
          </Link>
        ) : undefined
      }
    >
      {loading ? (
        <RowSkeletons count={3} />
      ) : lowStock === undefined ? (
        <CardError onRetry={onRetry} />
      ) : lowStock === null ? (
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Package aria-hidden="true" strokeWidth={1.75} className="size-[22px]" />
          </span>
          <p className="max-w-[48ch] pt-2.5 text-sm text-muted-foreground">{t("notReady")}</p>
        </div>
      ) : lowStock.items.length === 0 && lowStock.low + lowStock.out === 0 ? (
        <p className="text-sm text-muted-foreground">{t("allGood")}</p>
      ) : (
        <>
          <p className="text-sm">
            {[t("summary", { low: format.number(lowStock.low), out: format.number(lowStock.out) }),
              lowStock.deals_waiting ? t("dealsWaiting", { count: lowStock.deals_waiting }) : null].filter(Boolean).join(" · ")}
          </p>
          <ul className="-mx-2 flex flex-col">
            {lowStock.items.map((item) => (
              <li key={item.product_id} className="flex min-h-14 items-center gap-3 px-2 md:min-h-12">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{item.name}</span>
                  <span className="truncate font-mono text-xs">
                    {t("available", { available: format.number(item.available), reorder: format.number(item.reorder_point) })}
                  </span>
                  {item.in_transit > 0 ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {[t("inTransit", { count: format.number(item.in_transit) }), item.next_eta ? t("eta", { date: date(item.next_eta) }) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  ) : null}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-bold">
                  <Dot tone={item.state === "out" ? "red" : "amber"} />
                  <span className={item.state === "out" ? "text-status-red" : "text-status-amber"}>{t(item.state)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </HomeCard>
  );
}
