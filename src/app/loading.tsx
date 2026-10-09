// Skeleton matching the home layout (no spinners).
import { getTranslations } from "next-intl/server";

export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <main aria-busy="true" className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-10 px-4 py-8 sm:px-8">
      <span className="sr-only">{t("loading")}</span>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="h-12 w-[184px] rounded-md bg-muted motion-safe:animate-pulse" />
        <div className="h-11 w-72 rounded-md bg-muted motion-safe:animate-pulse" />
      </div>
      <div className="flex flex-col gap-4 rounded-lg bg-card p-6 sm:p-8">
        <div className="h-5 w-20 rounded-sm bg-muted motion-safe:animate-pulse" />
        <div className="h-12 w-3/4 rounded-sm bg-muted motion-safe:animate-pulse" />
        <div className="h-6 w-full max-w-xl rounded-sm bg-muted motion-safe:animate-pulse" />
      </div>
    </main>
  );
}
