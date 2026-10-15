"use client";

import { Suspense, use, useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { AttentionCard } from "@/components/home/attention-card";
import { FirstVisitContext, decideFirstVisit, markHomeVisited } from "@/components/home/count-up";
import { KpiRow, KpiRowSkeleton } from "@/components/home/kpi-card";
import { LowStockCard } from "@/components/home/low-stock-card";
import { PipelineSnapshot } from "@/components/home/pipeline-snapshot";
import { QueueCard } from "@/components/home/queue-card";
import { RecentActivity } from "@/components/home/recent-activity";
import { TodayCard } from "@/components/home/today-card";
import { useHomeScope } from "@/components/home/home-scope";
import { homeKey, useHome } from "@/components/home/use-home";
import type { HomeData, Part } from "@/lib/home";
import type { TeamMember } from "@/lib/leads";

// Home's cards (Day 5 design 7.10): the calm line, the KPI row, then Today · Work queue, Needs attention · Pipeline,
// Recent activity · Low stock (DOM order is reading order). Cache-first (D32, spike S14): the query cache's data at once
// when the dock warmed it, otherwise the server's promise read with use() under the page's Suspense skeleton. Each card
// shows its own loading, empty and error state; a failed refresh keeps the last figures and says how old they are.

const HomeDealSheet = dynamic(() => import("@/components/home/home-deal-sheet"), { ssr: false });

const ok = <T,>(p: Part<T> | undefined): T | null => (p && p.ok ? p.data : null);

export function HomeView({
  teamPromise,
  canAssign,
  stepUpSeconds,
  initialDeal,
}: {
  initialDeal: string | null;
  teamPromise: Promise<TeamMember[]>;
  canAssign: boolean;
  stepUpSeconds: number;
}) {
  const { scope, canSwitch, initial } = useHomeScope();
  const qc = useQueryClient();
  const t = useTranslations("Home");
  const format = useFormatter();
  const cached = qc.getQueryData<HomeData>(homeKey(scope));
  const first = cached ?? (scope === initial.scope ? use(initial.promise) : null) ?? undefined;
  const query = useHome(scope, first);
  const data = query.data;
  const [firstVisit] = useState(decideFirstVisit);
  useEffect(() => markHomeVisited(), []);
  // The deal sheet over Home is in the URL (?deal=), so it survives a reload and can be shared, like the board's.
  const [dealId, setDealId] = useState<string | null>(initialDeal);
  const [sheetLoaded, setSheetLoaded] = useState(initialDeal !== null);
  const showDeal = useCallback((id: string | null) => {
    if (id) setSheetLoaded(true);
    setDealId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("deal", id);
    else url.searchParams.delete("deal");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  }, []);
  const openDeal = useCallback((id: string) => showDeal(id), [showDeal]);
  const retry = useCallback(() => void query.refetch(), [query]);

  const loading = !data && query.isPending;
  const summary = ok(data?.summary);
  const heading = (title: string) => (canSwitch && scope === "team" ? t("scope.heading", { title }) : title);
  const tasks = summary?.tasks;
  const calm = !tasks
    ? null
    : tasks.today === 0 && tasks.meetings === 0
      ? t("nothingToday")
      : tasks.meetings === 0
        ? t("calmTasks", { tasks: tasks.today })
        : tasks.today === 0
          ? t("calmMeetings", { meetings: tasks.meetings })
          : t("calmLine", { tasks: tasks.today, meetings: tasks.meetings });

  return (
    <FirstVisitContext.Provider value={firstVisit}>
      <div className="flex min-h-6 flex-col gap-1 text-base text-muted-foreground" aria-live="polite">
        {loading ? <div className="h-6 w-72 max-w-full rounded-sm bg-muted motion-safe:animate-pulse" aria-hidden="true" /> : <p>{calm}</p>}
        {query.isRefetchError && data ? (
          <p role="status" className="flex flex-wrap items-center gap-x-3 text-sm">
            <span>{t("refreshFailed", { ago: format.relativeTime(new Date(data.at), new Date(query.errorUpdatedAt)) })}</span>
            <button type="button" onClick={retry} className="inline-flex min-h-11 items-center font-bold text-foreground underline underline-offset-4">
              {t("retry")}
            </button>
          </p>
        ) : null}
      </div>
      <div
        className="mt-4 grid grid-cols-12 gap-3 transition-opacity duration-200 data-[stale=true]:opacity-60 sm:gap-4"
        data-stale={query.isPlaceholderData || undefined}
        aria-busy={query.isPlaceholderData || undefined}
      >
        <div role="group" aria-label={t("kpi.rowLabel")} className="col-span-12 grid grid-cols-12 gap-3 sm:gap-4">
          {loading ? <KpiRowSkeleton /> : <KpiRow summary={summary} onRetry={retry} />}
        </div>
        <TodayCard today={ok(data?.today)} zone={summary?.zone} scope={scope} loading={loading} onRetry={retry} />
        <QueueCard newLeads={summary?.new_leads ?? null} />
        <AttentionCard
          attention={ok(data?.attention)}
          title={heading(t("attention.title"))}
          loading={loading}
          onRetry={retry}
          onOpenDeal={openDeal}
        />
        <PipelineSnapshot summary={summary} title={heading(t("pipeline.title"))} loading={loading} onRetry={retry} />
        <RecentActivity
          recent={ok(data?.recent)}
          title={heading(t("recent.title"))}
          loading={loading}
          onRetry={retry}
          answeredAt={data?.at ?? 0}
        />
        <LowStockCard lowStock={data?.lowStock.ok ? data.lowStock.data : undefined} loading={loading} onRetry={retry} />
      </div>
      {sheetLoaded ? (
        <Suspense fallback={null}>
          <HomeDealSheet dealId={dealId} onClose={() => showDeal(null)} teamPromise={teamPromise} canAssign={canAssign} stepUpSeconds={stepUpSeconds} />
        </Suspense>
      ) : null}
    </FirstVisitContext.Provider>
  );
}
