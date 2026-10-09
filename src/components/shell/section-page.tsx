import { getTranslations } from "next-intl/server";
import { EmptyState, EmptyStateSkeleton } from "@/components/shell/empty-state";
import { sections, type SectionId } from "@/lib/nav";

type PlaceholderSection = Exclude<SectionId, "home" | "more">;

// Shared frame for sections that are not built yet: title, then an empty state saying what will appear.
export async function SectionPlaceholder({ id }: { id: PlaceholderSection }) {
  const [nav, t] = await Promise.all([getTranslations("Nav"), getTranslations(`Sections.${id}`)]);
  const icon = sections.find((s) => s.id === id)!.icon;
  return (
    <div className="flex flex-col gap-8 pt-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{nav(id)}</h1>
      <EmptyState icon={icon} title={t("emptyTitle")} body={t("emptyBody")} />
    </div>
  );
}

export async function SectionSkeleton() {
  const t = await getTranslations("Common");
  return (
    <div aria-busy="true" className="flex flex-col gap-8 pt-4">
      <span className="sr-only">{t("loading")}</span>
      <div className="h-10 w-40 rounded-sm bg-muted motion-safe:animate-pulse sm:h-11" />
      <EmptyStateSkeleton />
    </div>
  );
}
