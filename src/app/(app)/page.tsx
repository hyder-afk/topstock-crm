import Link from "next/link";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { z } from "zod";
import { getFormatter, getTranslations } from "next-intl/server";
import { HomeScopeProvider, HomeScopeSwitch } from "@/components/home/home-scope";
import { HomeBodySkeleton } from "@/components/home/home-skeleton";
import { HomeView } from "@/components/home/home-view";
import { Greeting } from "@/components/shell/greeting";
import { requireSession, stepUpSecondsLeft } from "@/lib/auth";
import { HOME_SCOPE_COOKIE, effectiveScope, type HomeData } from "@/lib/home";
import { fetchHome } from "@/lib/home-server";
import { fetchTeam } from "@/lib/leads-server";

// Home (Day 5 design 7.10; Master Plan 4 "Dashboard greeting"): the date line, "Hello {first name}" ("Bonjour"), then
// the dashboard. The greeting is the likely largest paint, so the profile is awaited and the greeting renders at once;
// the figures start here as a promise (D32) and stream under the cards' skeleton, unless the dock already warmed them
// in the query cache. Managers and admins see the Team by default (D28) and the scope this device remembers; reps see
// their own figures. ?deal=<id> opens that deal's sheet over Home. A profile read that fails keeps the greeting without a name (the add-name link is hidden then).
export default async function Home({ searchParams }: PageProps<"/">) {
  const { supabase, claims } = await requireSession();
  const query = await searchParams;
  const deal = z.uuid().safeParse(Array.isArray(query.deal) ? query.deal[0] : query.deal); // ?deal= opens the deal sheet
  const store = await cookies();
  const [t, format, profile] = await Promise.all([
    getTranslations("Home"),
    getFormatter(),
    // RLS lets each person read profiles in their own org; this reads their own row only.
    supabase.from("profiles").select("first_name, role").eq("id", claims.sub).maybeSingle(),
  ]);
  const firstName = profile.data?.first_name?.trim() || undefined;
  const role = typeof profile.data?.role === "string" ? profile.data.role : "rep";
  const scope = effectiveScope(role, store.get(HOME_SCOPE_COOKIE)?.value);
  const canSwitch = role === "admin" || role === "manager";
  const homePromise: Promise<HomeData | null> = fetchHome(supabase, scope)
    .then((h) => (h === "forbidden" ? null : h))
    .catch(() => null);
  // Only the deal sheet (opened from Needs attention) needs the team; it reads this promise when it opens.
  const teamPromise = fetchTeam(supabase).then((team) => team ?? []).catch(() => []);
  const today = format.dateTime(new Date(), { weekday: "long", day: "numeric", month: "long" });
  return (
    <HomeScopeProvider initialScope={scope} canSwitch={canSwitch} promise={homePromise}>
      <div className="flex flex-col gap-2 pt-4">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-sm text-muted-foreground first-letter:uppercase">{today}</p>
            <Greeting hello={t("hello")} name={firstName} />
          </div>
          <HomeScopeSwitch />
        </div>
        {firstName || profile.error ? null : (
          <Link
            href="/more#profile"
            className="inline-flex min-h-11 w-fit items-center text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {t("addName")}
          </Link>
        )}
        <Suspense fallback={<HomeBodySkeleton />}>
          <HomeView initialDeal={deal.success ? deal.data : null} teamPromise={teamPromise} canAssign={canSwitch} stepUpSeconds={stepUpSecondsLeft(claims)} />
        </Suspense>
        <p className="mt-6 text-sm text-muted-foreground" lang="en" translate="no">
          {t("tagline")}
        </p>
      </div>
    </HomeScopeProvider>
  );
}
