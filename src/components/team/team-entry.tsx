import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ChevronRight, UserCog } from "lucide-react";
import type { createClient } from "@/lib/supabase/server";

// More's way into Team, for admins only (the page and the database check again). Reads the signed-in person's own role.
export async function TeamEntry({ supabase, userId }: { supabase: Awaited<ReturnType<typeof createClient>>; userId: string }) {
  const [t, me] = await Promise.all([
    getTranslations("Team"),
    supabase.from("profiles").select("role").eq("id", userId).maybeSingle(),
  ]);
  if (me.error || me.data?.role !== "admin") return null;
  return (
    <section aria-labelledby="more-admin" className="flex flex-col gap-3">
      <h2 id="more-admin" className="text-lg font-bold">
        {t("moreSection")}
      </h2>
      <Link
        href="/more/team"
        className="flex min-h-14 items-center gap-3 rounded-lg bg-card px-4 py-3 transition-colors duration-150 hover:bg-muted active:bg-muted sm:px-6"
      >
        <UserCog aria-hidden="true" strokeWidth={1.75} className="size-[22px] shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span>{t("moreRow")}</span>
          <span className="text-sm text-muted-foreground">{t("moreRowHint")}</span>
        </span>
        <ChevronRight aria-hidden="true" strokeWidth={1.75} className="size-5 shrink-0 text-muted-foreground" />
      </Link>
    </section>
  );
}
