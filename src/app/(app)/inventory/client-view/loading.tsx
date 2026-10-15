import { getTranslations } from "next-intl/server";
import { ShareSkeleton } from "@/components/share/share-page";

// Skeleton matching What clients see: back link, banner, title, then the client list.
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="mx-auto flex w-full max-w-[720px] flex-col gap-4 pt-2">
      <div className="h-11 w-24 rounded-md bg-muted motion-safe:animate-pulse" />
      <div className="h-16 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="h-8 w-64 rounded-sm bg-muted motion-safe:animate-pulse" />
      <ShareSkeleton label={t("loading")} />
    </div>
  );
}
