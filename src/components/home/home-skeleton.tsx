import { KpiRowSkeleton } from "@/components/home/kpi-card";
import { RowSkeletons } from "@/components/home/home-card";
import { PipelineSnapshotSkeleton } from "@/components/home/pipeline-snapshot";
import { cn } from "@/lib/utils";

// Home's skeleton, block for block (Day 5 design 7.10): the same grid, card sizes and row heights as the page, at every
// width (KPIs 4 across from 1024, 2 x 2 below; cards 7 + 5 from 1024, full width below). Used by (app)/loading.tsx
// (whole page) and by the page's Suspense boundary (the cards, under the greeting that is already on screen).

function CardSkeleton({ span, children, action = false }: { span: string; children: React.ReactNode; action?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-3 rounded-lg bg-card p-4 sm:p-6", span)} aria-hidden="true">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <div className="h-6 w-36 rounded-sm bg-muted motion-safe:animate-pulse" />
        {action ? <div className="h-5 w-24 rounded-sm bg-muted motion-safe:animate-pulse" /> : null}
      </div>
      {children}
    </div>
  );
}

export function HomeBodySkeleton() {
  return (
    <>
      <div className="flex min-h-6 flex-col gap-1" aria-hidden="true">
        <div className="h-6 w-72 max-w-full rounded-sm bg-muted motion-safe:animate-pulse" />
      </div>
      <div className="mt-4 grid grid-cols-12 gap-3 sm:gap-4">
        <div className="col-span-12 grid grid-cols-12 gap-3 sm:gap-4">
          <KpiRowSkeleton />
        </div>
        <CardSkeleton span="col-span-12 lg:col-span-7" action>
          <RowSkeletons count={4} className="-mx-2 px-2" />
        </CardSkeleton>
        <CardSkeleton span="col-span-12 lg:col-span-5">
          <div className="flex min-h-12 flex-col justify-center gap-1">
            <div className="h-5 w-56 max-w-full rounded-sm bg-muted motion-safe:animate-pulse" />
            <div className="h-5 w-48 max-w-full rounded-sm bg-muted motion-safe:animate-pulse" />
          </div>
          {/* Start calling: the real button shows at once on the page; here its block. */}
          <div className="mt-auto h-14 w-full rounded-md bg-muted motion-safe:animate-pulse sm:h-11 lg:w-40" />
        </CardSkeleton>
        <CardSkeleton span="col-span-12 lg:col-span-7">
          <RowSkeletons count={3} className="-mx-2 px-2" />
        </CardSkeleton>
        <CardSkeleton span="col-span-12 lg:col-span-5" action>
          <PipelineSnapshotSkeleton />
        </CardSkeleton>
        <CardSkeleton span="col-span-12 lg:col-span-7">
          <RowSkeletons count={4} className="-mx-2 px-2" />
        </CardSkeleton>
        <CardSkeleton span="col-span-12 lg:col-span-5">
          <RowSkeletons count={3} className="-mx-2 px-2" />
        </CardSkeleton>
      </div>
    </>
  );
}

/** The greeting block's skeleton (date line, greeting, the scope switch's place on its baseline). */
export function HomeHeaderSkeleton() {
  return (
    <div className="flex items-end justify-between gap-4" aria-hidden="true">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="h-5 w-40 rounded-sm bg-muted motion-safe:animate-pulse" />
        <div className="h-10 w-56 max-w-full rounded-sm bg-muted motion-safe:animate-pulse sm:h-12" />
      </div>
    </div>
  );
}
