"use client";

import { useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CountUp } from "@/components/home/count-up";
import { KPI_CARD_CLASS, KPI_LABEL_CLASS, KPI_SUB_CLASS } from "@/components/home/kpi-card";
import { BlockError, Bone, blockView } from "@/components/analytics/card";
import type { AnalyticsData } from "@/lib/analytics/fetch";
import { formatCount, formatDays, formatPercent, formatTileMoney, ratio } from "@/lib/analytics/view";
import { cn } from "@/lib/utils";

// The six "This period" tiles (design 1.8, 4.1): Calls, Connect rate, Won, Win rate, Median cycle, Revenue. Home's tile
// classes; 2 columns each from 1280 with a 28 px number (32 px from 1440: six tiles are narrower than Home's four), 3 per
// row at 768 and 1024, 2 x 3 on phones (sub-line hidden under 360 px). Numbers count up on the first view of Analytics
// in this tab only (CountUp, never under reduced motion); a changed figure eases from the old one. Not links in P2.

const TILE_SPAN = "col-span-6 md:col-span-4 xl:col-span-2";
const NUMBER_CLASS = "text-2xl font-medium md:text-[28px] md:leading-9 min-[1440px]:text-[32px] min-[1440px]:leading-10";

function Tile({ label, number, sub, muted }: { label: string; number: React.ReactNode; sub: React.ReactNode; muted?: boolean }) {
  return (
    <div className={cn(KPI_CARD_CLASS, TILE_SPAN)} data-tile="">
      <span className={KPI_LABEL_CLASS}>{label}</span>
      <span className={cn(NUMBER_CLASS, muted && "text-muted-foreground")} data-kpi-number="">
        {number}
      </span>
      <span className={cn(KPI_SUB_CLASS, "line-clamp-2")}>{sub}</span>
    </div>
  );
}

function ErrorTile({ label, block, onRetry }: { label: string; block: string; onRetry: () => void }) {
  return (
    <div className={cn(KPI_CARD_CLASS, TILE_SPAN)} data-tile="">
      <span className={KPI_LABEL_CLASS}>{label}</span>
      <BlockError block={block} onRetry={onRetry} />
    </div>
  );
}

export function KpiTiles({ data, loading, onRetry }: { data: AnalyticsData | undefined; loading: boolean; onRetry: () => void }) {
  const t = useTranslations("Analytics.kpi");
  const ta = useTranslations("Analytics");
  const locale = useLocale();
  const num = useCallback((n: number) => formatCount(n, locale), [locale]);
  const pct = useCallback((n: number) => formatPercent(n / 100, locale), [locale]);
  const money = useCallback((n: number) => formatTileMoney(n, locale), [locale]);
  const days = useCallback((n: number) => t("cycle.value", { days: formatDays(n / 10, locale) }), [t, locale]);
  if (loading && !data) return <KpiTilesSkeleton />;
  const activity = blockView(data?.activity, loading);
  const pipeline = blockView(data?.pipeline, loading);
  const sales = blockView(data?.sales, loading);

  const tiles: React.ReactNode[] = [];
  if (activity.kind === "ok") {
    const c = activity.data.totals;
    const rate = ratio(c.reached, c.calls);
    tiles.push(
      <Tile key="calls" label={t("calls.label")} number={<CountUp value={c.calls} format={num} />} sub={t("calls.sub", { count: c.reached })} />,
      <Tile
        key="connect"
        label={t("connect.label")}
        number={rate === null ? "—" : <CountUp value={Math.round(rate * 100)} format={pct} />}
        muted={rate === null}
        sub={rate === null ? t("connect.none") : t("connect.sub", { reached: c.reached, calls: c.calls })}
      />,
    );
  } else {
    const block = ta("calls.block");
    tiles.push(<ErrorTile key="calls" label={t("calls.label")} block={block} onRetry={onRetry} />, <ErrorTile key="connect" label={t("connect.label")} block={block} onRetry={onRetry} />);
  }
  if (pipeline.kind === "ok") {
    const p = pipeline.data;
    const winRate = p.win_rate.rate;
    const cycle = p.cycle.median_days;
    tiles.push(
      <Tile key="won" label={t("won.label")} number={<CountUp value={Math.round(Number(p.won.value))} format={money} />} sub={t("won.sub", { count: p.won.count })} />,
      <Tile
        key="winRate"
        label={t("winRate.label")}
        number={winRate === null ? "—" : <CountUp value={Math.round(winRate * 100)} format={pct} />}
        muted={winRate === null}
        sub={winRate === null ? t("winRate.notEnough") : t("winRate.sub", { won: p.win_rate.won, lost: p.win_rate.lost })}
      />,
      <Tile
        key="cycle"
        label={t("cycle.label")}
        number={cycle === null ? "—" : <CountUp value={Math.round(cycle * 10)} format={days} />}
        muted={cycle === null}
        sub={cycle === null ? t("cycle.notEnough") : t("cycle.sub", { count: p.cycle.n })}
      />,
    );
  } else {
    const block = ta("funnel.block");
    tiles.push(
      <ErrorTile key="won" label={t("won.label")} block={block} onRetry={onRetry} />,
      <ErrorTile key="winRate" label={t("winRate.label")} block={block} onRetry={onRetry} />,
      <ErrorTile key="cycle" label={t("cycle.label")} block={block} onRetry={onRetry} />,
    );
  }
  if (sales.kind === "ok") {
    const s = sales.data.totals;
    tiles.push(<Tile key="revenue" label={t("revenue.label")} number={<CountUp value={Math.round(Number(s.revenue))} format={money} />} sub={t("revenue.sub", { count: s.sales })} />);
  } else {
    tiles.push(<ErrorTile key="revenue" label={t("revenue.label")} block={ta("revenue.block")} onRetry={onRetry} />);
  }
  return <>{tiles}</>;
}

/** The tiles' skeleton, block for block. */
export function KpiTilesSkeleton() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className={cn(KPI_CARD_CLASS, TILE_SPAN)} aria-hidden="true">
          <div className={cn(KPI_LABEL_CLASS, "flex items-start")}>
            <Bone className="h-[18px] w-20" />
          </div>
          <div className={cn(NUMBER_CLASS, "flex items-center")}>
            <Bone className="h-[0.8em] w-24" />
          </div>
          <div className={cn(KPI_SUB_CLASS, "flex items-center")}>
            <Bone className="h-[14px] w-28 max-w-full" />
          </div>
        </div>
      ))}
    </>
  );
}
