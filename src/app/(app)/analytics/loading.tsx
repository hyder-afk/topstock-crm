import { getTranslations } from "next-intl/server";
import { AnalyticsBodySkeleton, AnalyticsHeaderSkeleton } from "@/components/analytics/skeleton";

// Analytics' skeleton (design 4.7): the title, the range line and the filter row's places, then "This period" block for
// block at its final size, so the page never jumps when it lands. No spinners.
export default async function Loading() {
  const t = await getTranslations("Analytics");
  return (
    <div aria-busy="true" className="flex flex-col gap-3 pt-4">
      <span className="sr-only">{t("loading")}</span>
      <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
      <AnalyticsHeaderSkeleton />
      <AnalyticsBodySkeleton />
    </div>
  );
}
