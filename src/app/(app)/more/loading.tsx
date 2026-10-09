import { getTranslations } from "next-intl/server";

const bar = "rounded-sm bg-muted motion-safe:animate-pulse";

// Skeleton matching More block for block and at the same heights: title, the phone-only sections list, the name form,
// settings, system status and sign out. No spinners.
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="flex flex-col gap-8 pt-4">
      <span className="sr-only">{t("loading")}</span>
      <div className={`h-9 w-32 sm:h-10 ${bar}`} />

      <div className="flex flex-col gap-3 lg:hidden">
        <div className={`h-7 w-40 ${bar}`} />
        <div className="flex flex-col overflow-hidden rounded-lg bg-card">
          {[0, 1].map((i) => (
            <div key={i} className="border-b border-border last:border-b-0">
              <div className="flex min-h-14 items-center gap-3 px-4">
                <div className={`size-[22px] ${bar}`} />
                <div className={`h-5 w-24 ${bar}`} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className={`h-7 w-28 ${bar}`} />
        <div className="flex flex-col gap-4 rounded-lg bg-card p-4 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <div className={`h-5 w-20 ${bar}`} />
                <div className="h-11 rounded-md border border-border bg-background" />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-4">
            <div className={`h-11 w-32 rounded-md ${bar}`} />
            <div className="min-h-6" />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className={`h-7 w-24 ${bar}`} />
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-card p-4 sm:p-6">
          {/* Language and appearance switches (measured: 91 px and 188-211 px wide, 52 px tall on phones). */}
          <div className={`h-[52px] w-[91px] rounded-md sm:h-11 ${bar}`} />
          <div className={`h-[52px] w-[200px] max-w-full rounded-md sm:h-11 ${bar}`} />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className={`h-7 w-24 ${bar}`} />
        <div className="flex items-center gap-2 rounded-lg bg-card p-4 sm:p-6">
          <div className={`h-5 w-56 ${bar}`} />
        </div>
      </div>

      <div className={`h-11 w-32 rounded-md ${bar}`} />
    </div>
  );
}
