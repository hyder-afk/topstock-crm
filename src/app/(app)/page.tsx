import { getFormatter, getTranslations } from "next-intl/server";
import { LayoutDashboard } from "lucide-react";
import { EmptyState } from "@/components/shell/empty-state";
import { Greeting } from "@/components/shell/greeting";
import { requireSession } from "@/lib/auth";

// Home: date line, then "Hello {first name}" (Master Plan 4, "Dashboard greeting"). The dashboard cards arrive with
// tasks, deals and stock; until then one calm empty state says so.
export default async function Home() {
  const { supabase, claims } = await requireSession();
  const [t, format, profile] = await Promise.all([
    getTranslations("Home"),
    getFormatter(),
    // RLS lets each person read profiles in their own org; this reads their own row only.
    supabase.from("profiles").select("first_name").eq("id", claims.sub).maybeSingle(),
  ]);
  const firstName = profile.data?.first_name?.trim() || undefined;
  const today = format.dateTime(new Date(), { weekday: "long", day: "numeric", month: "long" });
  return (
    <div className="flex flex-col gap-8 pt-4">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground first-letter:uppercase">{today}</p>
        <Greeting hello={t("hello")} name={firstName} />
      </div>
      <EmptyState icon={LayoutDashboard} title={t("emptyTitle")} body={t("emptyBody")} />
      <p className="text-sm text-muted-foreground" translate="no">
        {t("tagline")}
      </p>
    </div>
  );
}
