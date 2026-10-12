import { getTranslations } from "next-intl/server";
import { KpiSkeleton } from "@/components/inventory/inventory-workspace";
import { StockTableSkeleton } from "@/components/inventory/stock-table";

const bar = "rounded-sm bg-muted motion-safe:animate-pulse";

// Skeleton matching the Inventory page (design 10.1): title with its buttons, the KPI row, the tab strip, the toolbar
// with the filter chips, and 12 table rows (cards on phones), at the same heights as the real page.
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="flex flex-col gap-4 pt-4">
      <span className="sr-only">{t("loading")}</span>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className={`h-9 w-40 sm:h-10 ${bar}`} />
        <div className="flex items-center gap-2">
          <div className={`h-11 w-28 rounded-md ${bar}`} />
          <div className={`h-11 w-36 rounded-md ${bar}`} />
        </div>
      </div>
      <KpiSkeleton />
      <div className={`h-[52px] w-full max-w-[420px] rounded-md sm:h-11 ${bar}`} />
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <div className={`h-11 min-w-0 flex-[1_1_260px] rounded-md sm:h-10 ${bar}`} />
          <div className={`h-11 w-full rounded-md sm:h-10 sm:w-48 ${bar}`} />
          <div className={`h-11 flex-1 rounded-md sm:h-10 sm:w-48 sm:flex-none ${bar}`} />
          <div className={`h-[52px] w-[112px] rounded-md sm:h-11 ${bar}`} />
        </div>
        <div className="flex gap-2 overflow-hidden">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className={`h-11 w-24 shrink-0 rounded-md sm:h-9 ${bar}`} />
          ))}
        </div>
        <div className="flex h-[calc(100dvh-72px-144px-120px)] min-h-[440px] flex-col">
          <StockTableSkeleton />
        </div>
      </div>
    </div>
  );
}
