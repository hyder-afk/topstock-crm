"use client";

import Link from "next/link";
import { useContext, useLayoutEffect, useRef } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { animate } from "motion/react";
import { FirstVisitContext, prefersReducedMotion } from "@/components/home/count-up";
import { CardError, HomeCard } from "@/components/home/home-card";
import { stageShares, winRatePercent, type HomeSummary } from "@/lib/home";
import { formatMoney } from "@/lib/money";
import { springs } from "@/lib/motion";

// Pipeline (Day 5 design 7.10, D25): a 14 px bar of the three open stages sized by value, in ink at 30, 60 and 100 %
// (no status colours), with a legend (stage, count, value); the 90-day win rate once 5 deals have closed; the Lost line
// over 30 days by reason. No chart library. On the first Home of a tab the segments grow (scaleX, 30 ms apart), never
// under reduced motion.

const INK = ["opacity-30", "opacity-60", "opacity-100"];

export function PipelineSnapshot({
  summary,
  title,
  loading,
  onRetry,
}: {
  summary: HomeSummary | null;
  title: string;
  loading: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations("Home.pipeline");
  const tStage = useTranslations("Stages");
  const tReason = useTranslations("LostReasons");
  const format = useFormatter();
  const locale = useLocale();
  const firstVisit = useContext(FirstVisitContext);
  const bar = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!firstVisit || prefersReducedMotion() || !bar.current) return;
    const segments = Array.from(bar.current.children) as HTMLElement[];
    const runs = segments.map((el, i) => animate(el, { scaleX: [0, 1] }, { ...springs.smooth, delay: i * 0.03 }));
    return () => runs.forEach((r) => r.stop());
  }, [firstVisit]);

  const open = summary?.open;
  const nothing = summary && open && open.count === 0 && summary.win_rate.won + summary.win_rate.lost === 0 && summary.lost_30.count === 0;
  const rate = summary ? winRatePercent(summary.win_rate) : null;
  return (
    <HomeCard
      labelId="home-pipeline"
      title={title}
      className="col-span-12 lg:col-span-5"
      busy={loading}
      action={
        <Link href="/pipeline" className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground sm:min-h-0">
          {t("open")}
        </Link>
      }
    >
      {loading ? (
        <PipelineSnapshotSkeleton />
      ) : !summary || !open ? (
        <CardError onRetry={onRetry} />
      ) : nothing ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div ref={bar} role="img" aria-label={t("barLabel")} className="flex h-3.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
            {stageShares(open.by_stage).map((s, i) =>
              s.share > 0 ? (
                <div
                  key={s.key}
                  className={`h-full origin-left bg-foreground ${INK[i]}`}
                  style={{ flexBasis: `${(s.share * 100).toFixed(2)}%` }}
                />
              ) : null,
            )}
          </div>
          <ul className="flex flex-col gap-1">
            {open.by_stage.map((s, i) => (
              <li key={s.key} className="flex min-h-8 items-center gap-2 text-sm">
                <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-sm bg-foreground ${INK[i]}`} />
                <span className="min-w-0 flex-1 truncate">{tStage(s.key)}</span>
                <span className="text-muted-foreground">{t("deals", { count: s.count })}</span>
                <span className="w-24 shrink-0 text-right font-mono">{formatMoney(s.value, locale)}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-1 text-sm">
            <p>
              {rate !== null
                ? t("winRate", { rate: format.number(rate), won: summary.win_rate.won, lost: summary.win_rate.lost })
                : <span className="text-muted-foreground">{t("winRateEmpty")}</span>}
            </p>
            <p className="text-muted-foreground">
              {summary.lost_30.count === 0
                ? t("lostNone")
                : [t("lost", { count: summary.lost_30.count }),
                   ...summary.lost_30.reasons.map((r) => `${tReason(r.code)} ${r.count}`)].join(" · ")}
            </p>
          </div>
        </div>
      )}
    </HomeCard>
  );
}

export function PipelineSnapshotSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="h-3.5 w-full rounded-full bg-muted motion-safe:animate-pulse" />
      <div className="flex flex-col gap-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex min-h-8 items-center gap-2">
            <div className="h-4 w-32 rounded-sm bg-muted motion-safe:animate-pulse" />
            <div className="ml-auto h-4 w-24 rounded-sm bg-muted motion-safe:animate-pulse" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <div className="h-5 w-64 max-w-full rounded-sm bg-muted motion-safe:animate-pulse" />
        <div className="h-5 w-48 max-w-full rounded-sm bg-muted motion-safe:animate-pulse" />
      </div>
    </div>
  );
}
