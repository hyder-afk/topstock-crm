import { getTranslations } from "next-intl/server";
import { TableSkeleton } from "@/components/leads/leads-workspace";

const bar = "rounded-sm bg-muted motion-safe:animate-pulse";

// Skeleton matching the leads screen: title and Add button, toolbar, table and (desktop) the preview panel.
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="flex flex-col gap-4 pt-4 lg:h-[calc(100dvh-72px-144px)] lg:min-h-[560px]">
      <span className="sr-only">{t("loading")}</span>
      <div className="flex items-center justify-between gap-3">
        <div className={`h-9 w-40 sm:h-10 ${bar}`} />
        <div className={`h-11 w-36 rounded-md ${bar}`} />
      </div>
      <div className="flex flex-wrap gap-2">
        <div className={`h-11 min-w-0 flex-[1_1_280px] rounded-md sm:h-10 ${bar}`} />
        <div className={`h-11 w-28 rounded-md sm:h-10 ${bar}`} />
        <div className={`h-11 w-24 rounded-md sm:h-10 ${bar}`} />
        <div className={`h-11 w-28 rounded-md sm:h-10 ${bar}`} />
        <div className={`h-11 w-44 rounded-md sm:h-10 ${bar}`} />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)]">
        <div className="flex h-[calc(100dvh-72px-144px-180px)] min-h-[420px] flex-col lg:h-auto">
          <TableSkeleton />
        </div>
        <div className="hidden rounded-lg bg-card lg:block" />
      </div>
    </div>
  );
}
