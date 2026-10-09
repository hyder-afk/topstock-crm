import { getTranslations } from "next-intl/server";
import { EmptyStateSkeleton } from "@/components/shell/empty-state";

// Skeleton matching Home (date line, greeting, dashboard card). No spinners.
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="flex flex-col gap-8 pt-4">
      <span className="sr-only">{t("loading")}</span>
      <div className="flex flex-col gap-2">
        <div className="h-5 w-40 rounded-sm bg-muted motion-safe:animate-pulse" />
        <div className="h-10 w-56 rounded-sm bg-muted motion-safe:animate-pulse sm:h-12" />
      </div>
      <EmptyStateSkeleton />
    </div>
  );
}
