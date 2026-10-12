import { getTranslations } from "next-intl/server";

const bar = "rounded-sm bg-muted motion-safe:animate-pulse";

// Skeleton matching the queue's start screen block for block (the page always opens on it: claims start on Start):
// the back link and title, then the card with the intro, the scope switch (all three people are admins), the counts,
// the lunch switch and Start.
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-6 pt-2">
      <span className="sr-only">{t("loading")}</span>
      <div className="flex flex-col gap-1">
        <div className={`h-11 w-24 ${bar} bg-transparent`}>
          <div className={`mt-3 h-5 w-20 ${bar}`} />
        </div>
        <div className={`h-9 w-56 sm:h-10 ${bar}`} />
      </div>
      <div className="flex max-w-[720px] min-w-0 flex-col gap-5 rounded-lg bg-card p-5 sm:p-6">
        <div className="flex flex-col gap-2">
          <div className={`h-5 w-full ${bar}`} />
          <div className={`h-5 w-11/12 ${bar}`} />
          <div className={`h-5 w-2/3 ${bar}`} />
        </div>
        <div className={`h-[52px] w-[420px] max-w-full rounded-md sm:h-11 ${bar}`} />
        <div className="flex flex-col gap-2">
          <div className={`h-5 w-24 ${bar}`} />
          <div className={`h-7 w-48 ${bar}`} />
          <div className={`h-6 w-40 ${bar}`} />
        </div>
        <div className="flex min-h-11 items-center gap-3">
          <div className="h-7 w-12 rounded-full bg-muted" />
          <div className={`h-5 w-72 max-w-full ${bar}`} />
        </div>
        <div className={`h-11 w-32 rounded-md ${bar}`} />
      </div>
    </div>
  );
}
