import { getTranslations } from "next-intl/server";

const bar = "rounded-sm bg-muted motion-safe:animate-pulse";

// Skeleton matching the settings page: back link, title, then two cards of fields.
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="mx-auto flex w-full max-w-[720px] flex-col gap-4 pt-2">
      <span className="sr-only">{t("loading")}</span>
      <div className={`h-11 w-24 rounded-md ${bar}`} />
      <div className={`h-9 w-56 sm:h-10 ${bar}`} />
      {[3, 2].map((n, i) => (
        <div key={i} className="flex flex-col gap-4 rounded-lg bg-card p-5 sm:p-6">
          <div className={`h-6 w-40 ${bar}`} />
          {Array.from({ length: n }, (_, j) => (
            <div key={j} className="flex flex-col gap-2">
              <div className={`h-5 w-32 ${bar}`} />
              <div className={`h-11 w-full rounded-md ${bar}`} />
            </div>
          ))}
          <div className={`h-11 w-28 self-end rounded-md ${bar}`} />
        </div>
      ))}
    </div>
  );
}
