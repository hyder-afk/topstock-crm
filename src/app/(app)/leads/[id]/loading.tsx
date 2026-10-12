import { getTranslations } from "next-intl/server";

const bar = "rounded-sm bg-muted motion-safe:animate-pulse";

// Skeleton matching the lead page block for block (design 7.1): back link, header (tile, name, status and owner, place
// and local time), the action row (five equal actions on phones, a row of buttons from tablet width; under the header
// below 1280, beside it from 1280, as on the page), the tab strip, then the body (the tab's cards; from desktop width,
// 1024, the rail beside it).
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-5 pt-2">
      <span className="sr-only">{t("loading")}</span>
      <div className="flex min-h-11 items-center">
        <div className={`h-5 w-24 ${bar}`} />
      </div>
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex items-start gap-3">
          <div className="size-11 shrink-0 rounded-md bg-card" />
          <div className="flex flex-col gap-2">
            <div className={`h-7 w-56 sm:h-9 sm:w-80 ${bar}`} />
            <div className={`h-6 w-44 ${bar}`} />
            <div className={`h-5 w-64 sm:w-96 ${bar}`} />
            <div className={`h-5 w-52 ${bar}`} />
          </div>
        </div>
        <div className="flex gap-2 xl:shrink-0">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1.5 sm:flex-none">
              <div className="size-12 rounded-full bg-muted motion-safe:animate-pulse sm:h-11 sm:w-24 sm:rounded-md" />
              <div className={`h-3 w-10 sm:hidden ${bar}`} />
            </div>
          ))}
        </div>
      </div>
      <div className="h-[52px] w-full rounded-md bg-muted motion-safe:animate-pulse sm:h-11 sm:w-[440px]" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          <div className="h-32 rounded-lg bg-card" />
          <div className="h-64 rounded-lg bg-card" />
        </div>
        <div className="hidden flex-col gap-4 lg:flex">
          <div className="h-80 rounded-lg bg-card" />
          <div className="h-32 rounded-lg bg-card" />
        </div>
      </div>
    </div>
  );
}
