import { getTranslations } from "next-intl/server";

// Skeleton matching More (title, settings card, status card). No spinners.
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="flex flex-col gap-8 pt-4">
      <span className="sr-only">{t("loading")}</span>
      <div className="h-10 w-32 rounded-sm bg-muted motion-safe:animate-pulse sm:h-11" />
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-3">
          <div className="h-7 w-28 rounded-sm bg-muted motion-safe:animate-pulse" />
          <div className="h-20 w-full rounded-lg bg-card" />
        </div>
      ))}
    </div>
  );
}
