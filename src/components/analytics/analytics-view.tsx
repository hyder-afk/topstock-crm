"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { FirstVisitContext } from "@/components/home/count-up";
import { useAnalyticsFilters, useAnalyticsView } from "@/components/analytics/analytics-context";
import { CallsCard, FunnelCard, LostCard, ProductsCard, RevenueCard, SpeedCard } from "@/components/analytics/blocks";
import { HeatmapCard } from "@/components/analytics/heatmap";
import { KpiTiles } from "@/components/analytics/kpi-tiles";
import { RightNow } from "@/components/analytics/right-now";
import { TeamCard } from "@/components/analytics/team-table";
import { RateLimited } from "@/components/analytics/use-analytics";
import { COUNT_UP_HYDRATION_MS } from "@/lib/home";
import { formatClock, formatRange } from "@/lib/analytics/view";

// The streamed part of Analytics (design 4.1, 4.5, 4.7): the range line with "Updated HH:MM" (a polite live region, one
// short update when new figures land), the quiet 429 line, then "This period": six tiles and the chart cards, and
// "Right now" (coverage and, for admins, list quality), apart from the dates. A filter
// change keeps the old frame at 60 % until the new figures land (no skeleton then), with each card aria-busy. A block
// that failed shows its own error with Try again; the rest stand. A 429 keeps the old frame and says when to try again.

let visited = false; // this tab already showed Analytics (module state: one per tab, like Home's count-up)

/**
 * Count up and rise on this view? Only on the first view of Analytics in this tab, and never on a hard load whose
 * hydration came late (the server's numbers were already on screen): after a client navigation the tiles are new on
 * the page; on a hard load only when hydration landed within 800 ms of navigation start (Home's D29 rule).
 */
function decideFirstVisit(): boolean {
  if (typeof window === "undefined" || visited) return false;
  const serverTiles = document.querySelector("[data-analytics-body]") !== null;
  return !serverTiles || performance.now() < COUNT_UP_HYDRATION_MS;
}

/** The range line under the title, in the server's words until the figures land. */
export function RangeLine({ from, to }: { from: string; to: string }) {
  const t = useTranslations("Analytics");
  const locale = useLocale();
  return (
    <p className="text-sm text-muted-foreground" data-range-line="">
      {t("rangeLine", { range: formatRange(from, to, locale) })}
    </p>
  );
}

export function AnalyticsStatus() {
  const t = useTranslations("Analytics");
  const locale = useLocale();
  const { query, data } = useAnalyticsView();
  const limited = query.error instanceof RateLimited ? query.error : query.failureReason instanceof RateLimited ? query.failureReason : null;
  return (
    <div className="flex flex-col gap-1">
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground" data-updated="">
        {data ? (
          <>
            {t("rangeLine", { range: formatRange(data.from, data.to, locale) })}
            {" · "}
            {t("updated", { time: formatClock(data.at, locale) })}
          </>
        ) : null}
      </p>
      {limited && data ? (
        <p className="text-[13px] text-muted-foreground" data-rate-limited="">
          {t("rateLimited", { seconds: limited.seconds })}
        </p>
      ) : null}
    </div>
  );
}

export function AnalyticsBody() {
  const t = useTranslations("Analytics");
  const { query, data: frame } = useAnalyticsView();
  const { bodyMounted, role, viewFilters } = useAnalyticsFilters();
  useEffect(() => bodyMounted(), [bodyMounted]);
  const [firstVisit] = useState(decideFirstVisit);
  useEffect(() => {
    visited = true;
  }, []);
  const retry = useCallback(() => void query.refetch(), [query]);
  const limited = query.error instanceof RateLimited || query.failureReason instanceof RateLimited;
  // The old frame stays through a refetch and a 429; a view that failed otherwise never shows another view's figures:
  // its cards say they could not load, with Try again.
  const data = query.isError && query.isPlaceholderData && !limited ? undefined : frame;
  // A skeleton only while this view has no figures at all (and no failure yet); a failed first load shows each card's
  // error with the filters still usable.
  const loading = !data && query.isFetching && !query.isError;
  const stale = query.isPlaceholderData && data !== undefined;
  const busy = stale || (query.isFetching && !limited);
  const seesTeam = role !== "rep" && !viewFilters.rep;
  const bucket = data?.bucket ?? "day";
  const common = { loading, busy, onRetry: retry };

  return (
    <FirstVisitContext.Provider value={firstVisit}>
      <section aria-labelledby="analytics-this-period" className="mt-4 flex flex-col gap-3" data-analytics-body="">
        <h2 id="analytics-this-period" className="font-mono text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("thisPeriod")}
        </h2>
        <div
          className="grid grid-cols-12 gap-3 transition-opacity duration-200 data-[stale=true]:opacity-60 sm:gap-4 min-[1440px]:gap-6"
          data-stale={stale || undefined}
        >
          <div role="group" aria-label={t("kpi.rowLabel")} aria-busy={busy || undefined} className="col-span-12 grid grid-cols-12 gap-3 sm:gap-4 min-[1440px]:gap-6">
            <KpiTiles data={data} loading={loading} onRetry={retry} />
          </div>
          <CallsCard part={data?.activity} bucket={bucket} {...common} />
          <SpeedCard part={data?.speed} {...common} />
          <FunnelCard part={data?.pipeline} {...common} />
          <LostCard part={data?.pipeline} {...common} />
          {seesTeam ? <TeamCard data={data} {...common} /> : null}
          <HeatmapCard part={data?.callTimes} {...common} />
          <RevenueCard part={data?.sales} bucket={bucket} {...common} />
          <ProductsCard part={data?.sales} {...common} />
        </div>
      </section>
      <RightNow data={data} loading={loading} busy={busy} stale={stale} onRetry={retry} />
    </FirstVisitContext.Provider>
  );
}
