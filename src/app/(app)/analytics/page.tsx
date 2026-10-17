import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { AnalyticsProvider } from "@/components/analytics/analytics-context";
import { AnalyticsBody, AnalyticsStatus, RangeLine } from "@/components/analytics/analytics-view";
import { AnalyticsFiltersRow } from "@/components/analytics/filters";
import { AnalyticsBodySkeleton } from "@/components/analytics/skeleton";
import { requireSession } from "@/lib/auth";
import type { AnalyticsData } from "@/lib/analytics/fetch";
import { DEFAULT_IDLE, parisToday, parsePageParams, resolveRange } from "@/lib/analytics/params";
import { fetchAnalytics, fetchAnalyticsRole } from "@/lib/analytics/server";
import { toFilters } from "@/lib/analytics/view";
import { fetchTeam } from "@/lib/leads-server";

// Analytics (design docs/evidence/analytics/design.md 2, 3.6 and 4): the title, the range line and the filter row at
// once, then "This period" streamed under its skeleton (Home's D32 pattern: the figures start here as a promise, unless
// a prefetch already warmed them in the query cache). The URL is parsed leniently: a bad value is dropped, a custom range
// out of bounds falls back to the default preset, and the range is resolved on the server from the Paris date today.
// A rep's ?rep= is dropped (they always see their own figures; the API answers 403 and the database refuses it too);
// a manager's or admin's ?rep= for someone outside their team is dropped. Two-factor sign-in (aal2) is required.
export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  const { supabase, claims } = await requireSession();
  const [query, t, role] = await Promise.all([searchParams, getTranslations("Analytics"), fetchAnalyticsRole(supabase, claims.sub)]);
  const today = parisToday();
  const seesTeam = role !== "rep";
  const team = seesTeam ? ((await fetchTeam(supabase).catch(() => null)) ?? []) : null;
  const parsed = parsePageParams(query);
  const rep = team && parsed.rep && team.some((m) => m.id === parsed.rep) ? parsed.rep : undefined;
  let params = { ...parsed, rep };
  let range = resolveRange(params, today);
  if (!range) {
    params = { ...params, range: undefined, from: undefined, to: undefined };
    range = resolveRange(params, today)!;
  }
  const promise: Promise<AnalyticsData | null> = fetchAnalytics(supabase, { range, rep: rep ?? null, idle: params.idle ?? DEFAULT_IDLE }, role)
    .then((d) => (typeof d === "string" ? null : d))
    .catch(() => null);
  return (
    <AnalyticsProvider initialFilters={toFilters(params)} promise={promise} role={role} today={today}>
      <div className="flex flex-col gap-3 pt-4">
        <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
        <Suspense fallback={<RangeLine from={range.from} to={range.to} />}>
          <AnalyticsStatus />
        </Suspense>
        <AnalyticsFiltersRow team={team} />
        <Suspense fallback={<AnalyticsBodySkeleton team={seesTeam && !rep} />}>
          <AnalyticsBody />
        </Suspense>
      </div>
    </AnalyticsProvider>
  );
}
