import { getTranslations } from "next-intl/server";
import { PanelSkeleton } from "@/components/inventory/product-panel";

// Skeleton matching the product page: the back link, then the panel's blocks (title, figures, actions, lists).
export default async function Loading() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="mx-auto flex w-full max-w-[720px] flex-col gap-4 pt-2">
      <span className="sr-only">{t("loading")}</span>
      <div className="h-11 w-24 rounded-md bg-muted motion-safe:animate-pulse" />
      <div className="rounded-lg bg-card p-5">
        <PanelSkeleton />
      </div>
    </div>
  );
}
