import { getTranslations } from "next-intl/server";

const bar = "rounded-sm bg-muted motion-safe:animate-pulse";

// Skeleton matching Team block for block: back link, title, the sentence under it, the people list (three rows, the
// team's usual size) with each row's role button, and the roles card. No spinners.
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="flex flex-col gap-8 pt-4">
      <span className="sr-only">{t("loading")}</span>
      <div className="flex flex-col gap-2">
        <div className="flex min-h-11 items-center">
          <div className={`h-5 w-16 ${bar}`} />
        </div>
        <div className={`h-9 w-32 sm:h-10 ${bar}`} />
        {/* The sentence: three lines on phones, two on tablets, one line and a bit from 1280. */}
        <div className="flex max-w-[65ch] flex-col gap-1">
          <div className={`h-5 w-full ${bar}`} />
          <div className={`h-5 w-2/3 ${bar}`} />
          <div className={`h-5 w-1/2 sm:hidden ${bar}`} />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className={`h-7 w-28 ${bar}`} />
        <div className="flex flex-col overflow-hidden rounded-lg bg-card">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-b border-border last:border-b-0">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
                <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
                  <div className={`h-6 w-40 ${bar}`} />
                  <div className={`h-5 w-48 ${bar}`} />
                </div>
                <div className="hidden w-[36ch] flex-col gap-1 xl:flex">
                  <div className={`h-5 w-full ${bar}`} />
                  <div className={`h-5 w-1/2 ${bar}`} />
                </div>
                <div className={`h-11 w-36 rounded-md ${bar}`} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className={`h-7 w-20 ${bar}`} />
        <div className="grid gap-4 rounded-lg bg-card p-4 sm:p-6 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className={`h-6 w-24 ${bar}`} />
              <div className={`h-5 w-full ${bar}`} />
              <div className={`h-5 w-2/3 ${bar}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
