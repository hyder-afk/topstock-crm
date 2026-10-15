import { getTranslations } from "next-intl/server";

const bar = "rounded-sm bg-muted motion-safe:animate-pulse";

// The unavailable page's shape: title, one sentence, the button.
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="flex max-w-xl flex-col items-start gap-4 pt-4">
      <span className="sr-only">{t("loading")}</span>
      <div className={`h-9 w-72 sm:h-10 sm:w-96 ${bar}`} />
      <div className={`h-6 w-full max-w-md ${bar}`} />
      <div className="h-11 w-36 rounded-md bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
