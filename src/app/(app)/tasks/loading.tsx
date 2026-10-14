import { getTranslations } from "next-intl/server";
import { TaskRowsSkeleton } from "@/components/tasks/tasks-workspace";

const bar = "rounded-sm bg-muted motion-safe:animate-pulse";

// Skeleton matching the Tasks page block for block at every width: the title and the Mine / Team switch (all three
// people are admins), quick add (title field and Add, the date chips, time, kind and lead), the tabs, then 56 px rows.
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="mx-auto flex w-full max-w-[880px] min-w-0 flex-col gap-5 pt-4">
      <span className="sr-only">{t("loading")}</span>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className={`h-9 w-32 sm:h-10 ${bar}`} />
        <div className={`h-[52px] w-40 rounded-md sm:h-11 ${bar}`} />
      </div>
      <div className="flex flex-col gap-3 rounded-lg bg-card p-4 sm:p-5">
        <div className="flex gap-2">
          <div className="h-11 min-w-0 flex-1 rounded-md border border-border bg-background" />
          <div className={`h-11 w-20 rounded-md ${bar}`} />
        </div>
        <div className="flex gap-1.5 overflow-hidden">
          {["w-24", "w-24", "w-40", "w-36"].map((w, i) => (
            <div key={i} className={`h-11 shrink-0 rounded-md sm:h-9 ${w} ${bar}`} />
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <div className={`h-5 w-24 ${bar}`} />
            <div className="h-11 w-32 rounded-md border border-border bg-background sm:h-9" />
          </div>
          <div className={`h-[52px] w-72 max-w-full rounded-md sm:h-9 ${bar}`} />
          <div className="h-11 min-w-0 flex-[1_1_220px] rounded-md border border-border bg-background sm:h-9 sm:max-w-[320px]" />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <div className={`h-[52px] w-full max-w-[420px] rounded-md sm:h-11 ${bar}`} />
        <div className="overflow-hidden rounded-lg bg-card">
          <TaskRowsSkeleton />
        </div>
      </div>
    </div>
  );
}
