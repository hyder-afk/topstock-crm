"use client";

import { Bone } from "@/components/analytics/card";
import { ChartSkeleton, FunnelSkeleton, SpeedSkeleton } from "@/components/analytics/blocks";
import { HeatmapSkeleton } from "@/components/analytics/heatmap";
import { KpiTilesSkeleton } from "@/components/analytics/kpi-tiles";
import { TeamSkeleton } from "@/components/analytics/team-table";
import { cn } from "@/lib/utils";

// Analytics' skeleton, block for block (design 4.7): the same grid, card spans and chart heights as the page at every
// width (chart areas 240 px, 200 px on phones; heatmap rows 7 × 32 px, the phone's 44 px rows; the team table 3 rows).
// Used by analytics/loading.tsx (the whole page) and by the page's Suspense boundary (the body, under the header and the
// filter row already on screen), so nothing jumps when the figures land. No spinners. The Team card shows for managers
// and admins only (the app layout's data-role; the page decides for real).

function CardSkeleton({ span, children, action = false, className }: { span: string; children: React.ReactNode; action?: boolean; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-3 rounded-lg bg-card p-4 sm:p-6", span, className)} aria-hidden="true">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <Bone className="h-6 w-36" />
        {action ? <Bone className="h-9 w-44" /> : null}
      </div>
      {children}
    </div>
  );
}

export function AnalyticsBodySkeleton({ team }: { team?: boolean }) {
  return (
    <div className="mt-4 flex flex-col gap-3" aria-hidden="true" data-analytics-skeleton="">
      <Bone className="h-4 w-24" />
      <div className="grid grid-cols-12 gap-3 sm:gap-4 min-[1440px]:gap-6">
        <div className="col-span-12 grid grid-cols-12 gap-3 sm:gap-4 min-[1440px]:gap-6">
          <KpiTilesSkeleton />
        </div>
        <CardSkeleton span="col-span-12 xl:col-span-8">
          <ChartSkeleton legend minis />
        </CardSkeleton>
        <CardSkeleton span="col-span-12 xl:col-span-4">
          <SpeedSkeleton />
        </CardSkeleton>
        <CardSkeleton span="col-span-12 lg:col-span-7">
          <FunnelSkeleton />
        </CardSkeleton>
        <CardSkeleton span="col-span-12 lg:col-span-5">
          <ChartSkeleton bars={4} />
        </CardSkeleton>
        {team === false ? null : (
          <CardSkeleton span="col-span-12" className={team ? undefined : "group-data-[role=rep]/app:hidden"}>
            <TeamSkeleton />
          </CardSkeleton>
        )}
        <CardSkeleton span="col-span-12" action>
          <HeatmapSkeleton />
        </CardSkeleton>
        <CardSkeleton span="col-span-12 lg:col-span-7">
          <ChartSkeleton />
        </CardSkeleton>
        <CardSkeleton span="col-span-12 lg:col-span-5">
          <ChartSkeleton bars={6} />
        </CardSkeleton>
      </div>
    </div>
  );
}

/** The header block: the title is real text in the page; here the status line and the filter row's places. */
export function AnalyticsHeaderSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <Bone className="h-5 w-72 max-w-full" />
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 gap-2">
          <Bone className="h-11 w-[412px] max-w-full shrink rounded-md" />
          <Bone className="hidden h-11 w-28 shrink-0 rounded-md sm:block" />
        </div>
        <Bone className="h-11 w-full rounded-md group-data-[role=rep]/app:hidden sm:w-80" />
      </div>
    </div>
  );
}
