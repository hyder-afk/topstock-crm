import { getTranslations } from "next-intl/server";
import { HomeBodySkeleton, HomeHeaderSkeleton } from "@/components/home/home-skeleton";

// Home's skeleton, block for block (Day 5 design 7.10): date line and greeting, the calm line, the KPI row and the six
// cards in the page's own grid at every width, then the tagline. The add-your-name link only shows until a first name is
// saved, and the Team · Mine switch only for managers and admins, so neither has a placeholder. No spinners.
export default async function Loading() {
  const t = await getTranslations("Home");
  return (
    <div aria-busy="true" className="flex flex-col gap-2 pt-4">
      <span className="sr-only">{t("loading")}</span>
      <HomeHeaderSkeleton />
      <HomeBodySkeleton />
      <div className="mt-6 h-5 w-72 max-w-full rounded-sm bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
