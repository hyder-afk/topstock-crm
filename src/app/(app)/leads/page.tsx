import { LeadsWorkspace } from "@/components/leads/leads-workspace";
import { requireSession } from "@/lib/auth";
import { filtersToParams, parseFilters } from "@/lib/leads";
import { fetchLeadPage, fetchTeam, fetchViews } from "@/lib/leads-server";

// Leads (Master Plan 4, Haider 10 Oct 2026: a lead is a company with its contacts). The first page, the team and
// the saved views render on the server; the list then pages and filters in the browser through /api/leads.
export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { supabase, claims } = await requireSession();
  const filters = parseFilters(await searchParams);
  const [page, team, views] = await Promise.all([fetchLeadPage(supabase, filters, null), fetchTeam(supabase), fetchViews(supabase)]);
  const role = team?.find((m) => m.id === claims.sub)?.role ?? "rep";
  return (
    <LeadsWorkspace
      initialKey={filtersToParams(filters).toString()}
      initialPage={page}
      team={team ?? []}
      initialViews={views ?? []}
      me={{ id: claims.sub, role }}
    />
  );
}
