"use client";

import Link from "next/link";
import { useCallback } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { CountUp, shouldRise } from "@/components/home/count-up";
import { CardError } from "@/components/home/home-card";
import type { HomeSummary } from "@/lib/home";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

// The KPI row (Day 5 design 7.10, D27): Open pipeline, Won this month, Calls today, Tasks due. Each card is a link
// (Pipeline, Pipeline, the work queue, Tasks). 132 px from 1280 up with a 36 px DM Mono number; 28 px at 768 and 1024
// (where a French label may take two lines, the height kept for it); 2 x 2 tiles with a 24 px number on phones, the
// sub-line hidden under 360 px.

export const KPI_CARD_CLASS =
  "flex min-h-[112px] min-w-0 flex-col justify-between gap-2 rounded-lg bg-card p-3 sm:p-4 xl:min-h-[132px]";
export const KPI_LABEL_CLASS = "text-[13px] leading-[18px] text-muted-foreground lg:min-h-[36px] xl:min-h-0";
export const KPI_NUMBER_CLASS = "text-2xl font-medium md:text-[28px] md:leading-9 xl:text-[36px] xl:leading-10";
export const KPI_SUB_CLASS = "text-[13px] leading-[18px] text-muted-foreground max-[359px]:hidden";

function KpiCard({
  href,
  label,
  number,
  sub,
}: {
  href: string;
  label: string;
  number: React.ReactNode;
  sub: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        KPI_CARD_CLASS,
        "col-span-6 transition-[scale,background-color] duration-150 hover:bg-card/80 active:scale-[0.98] lg:col-span-3",
        shouldRise() && "animate-page",
      )}
    >
      <span className={KPI_LABEL_CLASS}>{label}</span>
      <span className={KPI_NUMBER_CLASS} data-kpi-number="">
        {number}
      </span>
      <span className={cn(KPI_SUB_CLASS, "truncate")}>{sub}</span>
    </Link>
  );
}

export function KpiRow({ summary, onRetry }: { summary: HomeSummary | null; onRetry: () => void }) {
  const t = useTranslations("Home.kpi");
  const locale = useLocale();
  const format = useFormatter();
  const money = useCallback((n: number) => formatMoney(String(n), locale), [locale]);
  const num = useCallback((n: number) => format.number(n), [format]);
  if (!summary) {
    return (
      <div className={cn(KPI_CARD_CLASS, "col-span-12 justify-center")}>
        <CardError message={t("rowFailed")} onRetry={onRetry} />
      </div>
    );
  }
  const o = summary.open;
  const openSub =
    o.count === 0
      ? t("open.empty")
      : [t("open.deals", { count: o.count }), o.stalled ? t("open.stalled", { count: o.stalled }) : null,
         o.no_value ? t("open.noValue", { count: o.no_value }) : null].filter(Boolean).join(" · ");
  const c = summary.calls_today;
  const k = summary.tasks;
  const due = k.today + k.overdue;
  return (
    <>
      <KpiCard
        href="/pipeline"
        label={t("open.label")}
        number={<CountUp value={Math.round(Number(o.value))} format={money} />}
        sub={openSub}
      />
      <KpiCard
        href="/pipeline"
        label={t("won.label")}
        number={<CountUp value={Math.round(Number(summary.won_month.value))} format={money} />}
        sub={t("won.deals", { count: summary.won_month.count })}
      />
      <KpiCard
        href="/leads/queue"
        label={t("calls.label")}
        number={<CountUp value={c.count} format={num} />}
        sub={c.count === 0 ? t("calls.empty") : t("calls.reached", { count: c.reached })}
      />
      <KpiCard
        href="/tasks"
        label={t("tasks.label")}
        number={<CountUp value={due} format={num} />}
        sub={due === 0 ? t("tasks.empty") : t("tasks.overdue", { count: k.overdue })}
      />
    </>
  );
}

/** The KPI row's skeleton, block for block (number-width blocks). */
export function KpiRowSkeleton() {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={cn(KPI_CARD_CLASS, "col-span-6 lg:col-span-3")} aria-hidden="true">
          <div className={cn(KPI_LABEL_CLASS, "flex items-start")}>
            <div className="h-[18px] w-24 rounded-sm bg-muted motion-safe:animate-pulse" />
          </div>
          <div className={cn(KPI_NUMBER_CLASS, "flex items-center")}>
            <div className="h-[0.8em] w-28 rounded-sm bg-muted motion-safe:animate-pulse" />
          </div>
          <div className={cn(KPI_SUB_CLASS, "flex items-center")}>
            <div className="h-[14px] w-32 max-w-full rounded-sm bg-muted motion-safe:animate-pulse" />
          </div>
        </div>
      ))}
    </>
  );
}
