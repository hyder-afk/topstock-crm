import { getTranslations } from "next-intl/server";

const bar = "rounded-sm bg-muted motion-safe:animate-pulse";

// Skeleton matching the queue's start screen block for block (the page always opens on it: claims start on Start):
// the back link and title, then the card with the intro, the scope switch (all three people are admins), the counts,
// the lunch switch and Start. The intro, the switch and the lunch line carry the page's own words, invisible on grey
// bars, so they wrap exactly as the real ones in either language and at any width (French takes a line more on phones
// and its switch wraps to two rows): nothing moves when the page replaces the skeleton.
export default async function Loading() {
  const t = await getTranslations("Common");
  const q = await getTranslations("Queue");
  const ghost = "rounded-sm bg-muted text-transparent [box-decoration-break:clone] motion-safe:animate-pulse";
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
        <p aria-hidden="true" className="max-w-[65ch] select-none">
          <span className={ghost}>{q("intro")}</span>
        </p>
        <div
          aria-hidden="true"
          className="flex max-w-full flex-wrap gap-0.5 self-start rounded-md bg-muted p-1 select-none motion-safe:animate-pulse max-sm:grid max-sm:w-full max-sm:grid-cols-[auto_minmax(0,1fr)_auto]"
        >
          {(["mine", "mineUnassigned", "team"] as const).map((s) => (
            <span
              key={s}
              className="flex min-h-11 shrink-0 items-center justify-center px-3.5 text-center text-sm whitespace-nowrap text-transparent max-sm:py-1 max-sm:leading-tight max-sm:text-balance max-sm:whitespace-normal sm:min-h-9"
            >
              {q(`scope.${s}`)}
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <div className={`h-5 w-24 ${bar}`} />
          <div className={`h-7 w-48 ${bar}`} />
          <div className={`h-6 w-40 ${bar}`} />
        </div>
        <div className="flex min-h-11 items-center gap-3">
          <div className="h-7 w-12 rounded-full bg-muted" />
          <span aria-hidden="true" className="text-sm select-none">
            <span className={ghost}>{q("skipLunch")}</span>
          </span>
        </div>
        <div className={`h-11 w-24 rounded-md sm:w-32 ${bar}`} />
      </div>
    </div>
  );
}
