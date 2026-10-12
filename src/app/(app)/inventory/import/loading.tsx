import { getTranslations } from "next-intl/server";
import { cn } from "@/lib/utils";

const bar = "rounded-sm bg-muted motion-safe:animate-pulse";

// One line of text at its real height (24 px for body text, 20 px for small text), so nothing moves when it arrives.
function Line({ className, small = false }: { className: string; small?: boolean }) {
  return (
    <div className={cn("flex items-center", small ? "h-5" : "h-6")}>
      <div className={cn(bar, small ? "h-3" : "h-4", className)} />
    </div>
  );
}

// Matches the stock import page (the lead import's layout, history rail from 1280 px): title and subtitle, the step
// card (step counter on phones, steps, heading, intro, the drop
// zone with its contents, the "nothing changes" line) and the Past imports rail with three rows at their real height.
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="flex flex-1 flex-col gap-6">
      <span className="sr-only">{t("loading")}</span>
      <div aria-hidden="true" className="flex flex-col gap-1">
        <div className="flex h-8 items-center sm:h-9">
          <div className={cn(bar, "h-6 w-56 sm:h-7")} />
        </div>
        <Line className="w-full max-w-[600px]" />
        <Line className="w-2/3 max-w-[380px]" />
      </div>
      <div aria-hidden="true" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <div className="flex flex-col gap-6 rounded-lg bg-card p-4 sm:p-8">
          <div className="flex flex-col gap-2">
            <div className="flex h-4 items-center sm:hidden">
              <div className={cn(bar, "h-3 w-20")} />
            </div>
            <div className={cn(bar, "h-6 w-36 sm:w-full sm:max-w-[460px]")} />
          </div>
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <div className="flex h-7 items-center">
                <div className={cn(bar, "h-5 w-48")} />
              </div>
              <Line className="w-full max-w-[560px]" />
              <Line className="w-3/4 max-w-[360px]" />
            </div>
            <div className="flex flex-col items-start gap-4 rounded-lg border border-dashed border-border p-6 sm:p-8">
              <div className={cn(bar, "size-11 rounded-md")} />
              <div className="flex w-full flex-col gap-1">
                <Line className="w-64 max-w-full" />
                <Line small className="w-44" />
                <Line small className="w-72 max-w-full" />
              </div>
              <div className={cn(bar, "h-11 w-32 rounded-md")} />
            </div>
            <Line small className="w-80 max-w-full" />
          </div>
        </div>
        <div className="flex flex-col gap-4 rounded-lg bg-card p-4 sm:p-6">
          <div className="flex h-7 items-center">
            <div className={cn(bar, "h-5 w-32")} />
          </div>
          <div className="flex flex-col divide-y divide-border">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                <Line className="w-48" />
                <Line small className="w-40" />
                <div className={cn(bar, "h-5 w-28")} />
                <Line small className="w-56 max-w-full" />
                <div className="flex h-11 items-center gap-4">
                  <div className={cn(bar, "h-4 w-16")} />
                  <div className={cn(bar, "h-4 w-24")} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
