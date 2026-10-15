"use client";

import Link from "next/link";
import { Package } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { CardError, Dot, HomeCard, RowSkeletons } from "@/components/home/home-card";
import type { LowStockCard as LowStock } from "@/lib/home";

// Low stock (Day 5 design 7.12, D30), filled from Day 6's own contract stock_alerts() (Haider's decision B, 15 Oct
// 2026). Before inventory is set up (the Day 5c stub answers null): a package icon and one calm sentence, no link, in the
// same grid cell, so nothing moves when inventory lands. After: "3 low · 1 sold out · 2 deals waiting", up to 5 low
// products with what is available against the reorder level (DM Mono), stock in transit (muted, never counted as
// available) and a dot-plus-word "Low" badge, then up to three quiet follow-up lines that appear only when their count
// is above zero (late arrivals, new stock requests, holds ending within 2 days), each opening its Inventory tab.
// "Open inventory" opens the Low filter. Status colour stays in the dots and the badge word. The card fails alone.

const FOLLOW_UPS = [
  { key: "arrivingLate", field: "arriving_late", href: "/inventory?tab=arriving", tone: "amber" },
  { key: "requestsNew", field: "requests_new", href: "/inventory?tab=requests", tone: null },
  { key: "holdsEndingSoon", field: "holds_ending_soon", href: "/inventory?tab=reserved", tone: "amber" },
] as const;

export function LowStockCard({ lowStock, loading, onRetry }: { lowStock: LowStock | null | undefined; loading: boolean; onRetry: () => void }) {
  const t = useTranslations("Home.lowStock");
  const format = useFormatter();
  const followUps = lowStock ? FOLLOW_UPS.map((f) => ({ ...f, count: lowStock[f.field] })).filter((f) => f.count > 0) : [];
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
      ) : (
        <>
          {lowStock.low + lowStock.sold_out === 0 ? (
            <p className="text-sm text-muted-foreground">{t("allGood")}</p>
          ) : (
            <>
              <p className="text-sm">
                {[t("summary", { low: lowStock.low, soldOut: lowStock.sold_out }),
                  lowStock.deals_waiting > 0 ? t("dealsWaiting", { count: lowStock.deals_waiting }) : null].filter(Boolean).join(" · ")}
              </p>
              {lowStock.sample.length > 0 ? (
                <ul className="-mx-2 flex flex-col">
                  {lowStock.sample.map((item) => (
                    <li key={item.id} className="flex min-h-14 items-center gap-3 px-2 md:min-h-12">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{item.name}</span>
                        <span className="truncate font-mono text-xs">
                          {t("available", { available: format.number(item.available), reorder: format.number(item.reorder_point) })}
                        </span>
                        {item.arriving > 0 ? (
                          <span className="truncate text-xs text-muted-foreground">{t("inTransit", { count: format.number(item.arriving) })}</span>
                        ) : null}
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-bold">
                        <Dot tone="amber" />
                        <span className="text-status-amber">{t("low")}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
          {followUps.length > 0 ? (
            <ul aria-label={t("followUps")} className="-mx-2 flex flex-col border-t border-border pt-2">
              {followUps.map((f) => (
                <li key={f.key}>
                  <Link
                    href={f.href}
                    className="flex min-h-11 items-center gap-2 rounded-sm px-2 text-sm text-muted-foreground hover:text-foreground md:min-h-9"
                  >
                    {f.tone ? <Dot tone={f.tone} /> : <span aria-hidden="true" className="inline-block size-2 shrink-0" />}
                    <span className="min-w-0">{t(f.key, { count: f.count })}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </HomeCard>
  );
}
