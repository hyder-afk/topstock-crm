"use client";

import Link from "next/link";
import { useCallback } from "react";
import { ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { CountUp } from "@/components/home/count-up";
import { KPI_CARD_CLASS, KPI_LABEL_CLASS, KPI_SUB_CLASS } from "@/components/home/kpi-card";
import { useAnalyticsFilters } from "@/components/analytics/analytics-context";
import { BlockError, Bone, blockView } from "@/components/analytics/card";
import { ListQualityCard, ListQualitySkeleton } from "@/components/analytics/list-quality";
import { useViewWarmers } from "@/components/analytics/use-analytics";
import type { AnalyticsData } from "@/lib/analytics/fetch";
import { DEFAULT_IDLE, idleOptions } from "@/lib/analytics/params";
import { coverageScope, filtersToSearch, formatCount, overdueHref, untouchedHref, type AnalyticsFilters } from "@/lib/analytics/view";
import { cn } from "@/lib/utils";

// "Right now" (design 1.4, 1.5, 4.1, 4.2, 4.7): the state of the lists today, not inside the range, so it sits apart
// from "This period" (a hairline and its own heading saying the dates do not apply). It follows the person filter. Four
// tiles: Untouched N+ days (7, 30 or 90 days, the Leads list's own options, chosen in the tile) linking to the Leads list
// that holds exactly those leads; Never contacted; No next step (no exact Leads filter exists, so no link); Overdue
// tasks linking to Tasks (own or team; no link when a manager or admin picked someone else, as Tasks has no per-person
// view). Then List quality per import for admins. A tile at zero says "All caught up". Numbers count up on the first
// view only (CountUp, never under reduced motion).

const TILE_SPAN = "col-span-6 lg:col-span-3";
const NUMBER_CLASS = "text-2xl font-medium md:text-[28px] md:leading-9 min-[1440px]:text-[32px] min-[1440px]:leading-10";

function Tile({
  id,
  label,
  value,
  sub,
  href,
  linkLabel,
  control,
  dot,
}: {
  id: string;
  label: string;
  value: number;
  sub: string;
  href?: string | null;
  linkLabel?: string;
  control?: React.ReactNode;
  dot?: boolean;
}) {
  const t = useTranslations("Analytics.rightNow");
  const locale = useLocale();
  const num = useCallback((n: number) => formatCount(n, locale), [locale]);
  return (
    <div
      className={cn(
        KPI_CARD_CLASS,
        TILE_SPAN,
        "relative",
        href && "transition-[scale,background-color] duration-150 hover:bg-card/80 has-[a:active]:scale-[0.98]",
      )}
      data-coverage-tile={id}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={cn(KPI_LABEL_CLASS, "flex items-start gap-1.5")}>
          {dot ? <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-red" /> : null}
          {label}
        </span>
        {href ? <ChevronRight aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" /> : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className={NUMBER_CLASS} data-kpi-number="">
          <CountUp value={value} format={num} />
        </span>
        {control}
      </div>
      <span className={cn(KPI_SUB_CLASS, "line-clamp-2")} data-coverage-sub="">
        {value === 0 ? t("caughtUp") : sub}
      </span>
      {href ? (
        // The whole tile is the link's hit area (a stretched link): the 7/30/90 switch sits above it, never inside it.
        <Link href={href} data-tile-link="" className="absolute inset-0 rounded-lg">
          <span className="sr-only">{linkLabel}</span>
        </Link>
      ) : null}
    </div>
  );
}

/** 7 / 30 / 90 untouched days: a small segmented switch in the Untouched tile, in the URL (idle=) like every filter. */
function IdleSwitch() {
  const t = useTranslations("Analytics.rightNow.idle");
  const { filters, setFilters } = useAnalyticsFilters();
  const warm = useViewWarmers();
  const current = filters.idle ?? DEFAULT_IDLE;
  const withIdle = (idle: number): AnalyticsFilters => ({ ...filters, idle: idle === DEFAULT_IDLE ? undefined : idle });
  return (
    <div role="group" aria-label={t("label")} className="relative z-10 inline-flex shrink-0 rounded-md bg-muted p-1">
      {idleOptions.map((days) => (
        <button
          key={days}
          type="button"
          aria-pressed={current === days}
          aria-label={t("long", { days })}
          onClick={() => setFilters(withIdle(days))}
          {...warm(filtersToSearch(withIdle(days)))}
          className={cn(
            "min-h-11 min-w-11 rounded-sm px-2 font-mono text-xs font-medium whitespace-nowrap transition-[background-color,color,scale] duration-150 active:scale-[0.97] lg:min-h-8 lg:min-w-0",
            current === days ? "bg-pill text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("short", { days })}
        </button>
      ))}
    </div>
  );
}

function ErrorTile({ label, onRetry }: { label: string; onRetry: () => void }) {
  const t = useTranslations("Analytics.rightNow");
  return (
    <div className={cn(KPI_CARD_CLASS, TILE_SPAN)} data-coverage-tile="">
      <span className={KPI_LABEL_CLASS}>{label}</span>
      <BlockError block={t("block")} onRetry={onRetry} />
    </div>
  );
}

function CoverageTiles({ data, loading, onRetry }: { data: AnalyticsData | undefined; loading: boolean; onRetry: () => void }) {
  const t = useTranslations("Analytics.rightNow");
  const { role, self, viewFilters } = useAnalyticsFilters();
  const view = blockView(data?.coverage, loading);
  if (view.kind === "loading") return <CoverageSkeleton />;
  const shownIdle = view.kind === "ok" ? view.data.idle_days : (viewFilters.idle ?? DEFAULT_IDLE);
  if (view.kind === "error") {
    return (
      <>
        {[t("untouched.label", { days: shownIdle }), t("never.label"), t("noNextStep.label"), t("overdue.label")].map((label) => (
          <ErrorTile key={label} label={label} onRetry={onRetry} />
        ))}
      </>
    );
  }
  const c = view.data;
  // The figures' own person (the answer's), so a link never points at another view's list.
  const scope = coverageScope(role, data?.rep ?? undefined, self);
  const overdue = overdueHref(scope);
  return (
    <>
      <Tile
        id="untouched"
        label={t("untouched.label", { days: c.idle_days })}
        value={c.untouched}
        sub={t("untouched.sub", { days: c.idle_days })}
        href={untouchedHref(c.idle_days, scope)}
        linkLabel={t("untouched.link")}
        control={<IdleSwitch />}
      />
      <Tile id="never" label={t("never.label")} value={c.never_contacted} sub={t("never.sub")} />
      <Tile id="noNextStep" label={t("noNextStep.label")} value={c.no_next_step} sub={t("noNextStep.sub")} />
      <Tile
        id="overdue"
        label={t("overdue.label")}
        value={c.overdue_tasks}
        sub={overdue ? t("overdue.sub") : t("overdue.subOther")}
        href={overdue}
        linkLabel={t("overdue.link")}
        dot={c.overdue_tasks > 0}
      />
    </>
  );
}

export function RightNow({ data, loading, busy, stale, onRetry }: { data: AnalyticsData | undefined; loading: boolean; busy: boolean; stale: boolean; onRetry: () => void }) {
  const t = useTranslations("Analytics.rightNow");
  const { role } = useAnalyticsFilters();
  return (
    <section aria-labelledby="analytics-right-now" className="mt-6 flex flex-col gap-3 border-t border-border pt-6" data-right-now="">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 id="analytics-right-now" className="font-mono text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("title")}
        </h2>
        <p className="text-[13px] text-muted-foreground">
          <span aria-hidden="true">· </span>
          {t("note")}
        </p>
      </div>
      <div
        className="grid grid-cols-12 gap-3 transition-opacity duration-200 data-[stale=true]:opacity-60 sm:gap-4 min-[1440px]:gap-6"
        data-stale={stale || undefined}
      >
        <div role="group" aria-label={t("rowLabel")} aria-busy={busy || undefined} className="col-span-12 grid grid-cols-12 gap-3 sm:gap-4 min-[1440px]:gap-6">
          <CoverageTiles data={data} loading={loading} onRetry={onRetry} />
        </div>
        {role === "admin" ? <ListQualityCard data={data} loading={loading} busy={busy} onRetry={onRetry} /> : null}
      </div>
    </section>
  );
}

export function CoverageSkeleton() {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={cn(KPI_CARD_CLASS, TILE_SPAN)} aria-hidden="true">
          <div className={cn(KPI_LABEL_CLASS, "flex items-start")}>
            <Bone className="h-[18px] w-24" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className={cn(NUMBER_CLASS, "flex items-center")}>
              <Bone className="h-[0.8em] w-16" />
            </div>
            {i === 0 ? <Bone className="h-11 w-[140px] rounded-md lg:h-10 lg:w-[116px]" /> : null}
          </div>
          <div className={cn(KPI_SUB_CLASS, "flex items-center")}>
            <Bone className="h-[14px] w-28 max-w-full" />
          </div>
        </div>
      ))}
    </>
  );
}

/** The whole "Right now" section's skeleton (loading.tsx and the body's Suspense fallback). */
export function RightNowSkeleton({ batches }: { batches?: boolean }) {
  return (
    <div className="mt-6 flex flex-col gap-3 border-t border-border pt-6" aria-hidden="true">
      <Bone className="h-4 w-56 max-w-full" />
      <div className="grid grid-cols-12 gap-3 sm:gap-4 min-[1440px]:gap-6">
        <div className="col-span-12 grid grid-cols-12 gap-3 sm:gap-4 min-[1440px]:gap-6">
          <CoverageSkeleton />
        </div>
        {batches === false ? null : (
          <div
            className={cn(
              "col-span-12 flex min-w-0 flex-col gap-3 rounded-lg bg-card p-4 sm:p-6",
              batches ? undefined : "group-data-[role=manager]/app:hidden group-data-[role=rep]/app:hidden",
            )}
          >
            <Bone className="h-6 w-56" />
            <ListQualitySkeleton />
          </div>
        )}
      </div>
    </div>
  );
}
