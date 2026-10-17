const bar = "rounded-sm bg-muted motion-safe:animate-pulse";

// The pipeline's skeleton (Day 5 design 7.1), block for block: the toolbar (title and totals, New deal; the scope,
// owner, stalled and sort chips), the stage tabs on phones, then four columns of three 120 px card blocks (one column
// with the next one peeking at 390, two at 768, four from 1024) and the Lost line; from tablet width the columns fill the
// screen as the board's do (board.tsx). Used by loading.tsx and by the page's Suspense boundary while the board streams.
export function PipelineSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-5 pt-2 md:min-h-[calc(100dvh-190px)]">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <div className={`h-9 w-36 sm:h-10 sm:w-44 ${bar}`} />
            <div className={`h-7 w-32 ${bar}`} />
          </div>
          <div className="h-11 w-full rounded-md bg-muted motion-safe:animate-pulse sm:w-36" />
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="h-11 w-36 rounded-md bg-muted motion-safe:animate-pulse sm:h-10" />
          <div className="h-11 w-24 rounded-md bg-card sm:h-9" />
          <div className="h-11 w-36 rounded-md bg-card sm:h-9" />
          <div className="h-11 w-40 rounded-md bg-card sm:h-9" />
        </div>
      </div>
      <ColumnsBlocks />
    </div>
  );
}

// Below the toolbar: the stage tabs on phones, the four columns and the Lost line.
function ColumnsBlocks() {
  return (
    <>
      <div className="-mx-4 flex gap-1 overflow-hidden px-4 py-2 md:hidden">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`h-11 w-24 shrink-0 ${bar}`} />
        ))}
      </div>
      <div className="-mx-4 flex gap-3 overflow-hidden px-4 pb-2 sm:-mx-8 sm:px-8 md:min-h-min md:grow md:basis-0 lg:mx-0 lg:grid lg:grid-cols-[repeat(4,minmax(220px,1fr))] lg:px-0 xl:gap-4">
        {[0, 1, 2, 3].map((c) => (
          <div key={c} className="flex w-[calc(100vw-48px)] shrink-0 flex-col gap-2 rounded-lg bg-[color-mix(in_oklab,var(--muted)_45%,transparent)] p-2 md:w-[calc((100%-12px)/2)] lg:w-auto">
            <div className="flex min-h-14 flex-col justify-center gap-1.5 px-1 pt-1">
              <div className={`h-4 w-28 ${bar}`} />
              <div className={`h-3 w-20 ${bar}`} />
            </div>
            <div className="flex flex-col gap-2 overflow-hidden md:min-h-[360px] md:grow md:basis-0">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[120px] shrink-0 rounded-lg border border-border bg-card" />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className={`h-5 w-72 md:-mt-2 ${bar}`} />
    </>
  );
}

// The columns alone, under the board's real toolbar, while a scope, owner or order not read before loads (board.tsx):
// the toolbar the person just used stays where it is, and so does their keyboard focus. The same blocks and gaps as the
// board's columns; the wrapper grows into the space the toolbar leaves, as the board's columns do.
export function PipelineColumnsSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-5 md:grow">
      <span className="sr-only">{label}</span>
      <ColumnsBlocks />
    </div>
  );
}
