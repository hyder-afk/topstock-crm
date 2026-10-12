import { notFound } from "next/navigation";
import { z } from "zod";
import { LeadPage } from "@/components/lead/lead-page";
import { TIMELINE_FILTERS, type TimelineFilter } from "@/lib/activities";
import { requireSession, stepUpSecondsLeft } from "@/lib/auth";
import { LEAD_TABS, type LeadDetail, type LeadTab } from "@/lib/leads";
import { fetchLeadTasks, fetchTeam, fetchTimelinePage } from "@/lib/leads-server";
import { fetchFilesPage } from "@/lib/files/files-server";

// The lead page (Day 4 design 7.1). Two-factor session first; a malformed id and a lead that is missing or not visible
// both get the same 404. The lead, its first timeline page, its open tasks, its files and the team are read in parallel; a
// database failure shows the app's error screen (shell kept, Retry), never database text.
export default async function LeadRoute({ params, searchParams }: PageProps<"/leads/[id]">) {
  const { supabase, claims } = await requireSession();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const query = await searchParams;
  const tabParam = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const tab: LeadTab = (LEAD_TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as LeadTab) : "summary";
  const filterParam = Array.isArray(query.filter) ? query.filter[0] : query.filter;
  const filter: TimelineFilter = (TIMELINE_FILTERS as readonly string[]).includes(filterParam ?? "") ? (filterParam as TimelineFilter) : "all";
  const [lead, timeline, tasks, files, team] = await Promise.all([
    supabase.rpc("get_lead", { p_id: id.data }),
    fetchTimelinePage(supabase, id.data, null, null),
    fetchLeadTasks(supabase, id.data),
    fetchFilesPage(supabase, id.data, null),
    fetchTeam(supabase),
  ]);
  if (lead.error) throw new Error("lead unavailable");
  if (!lead.data) notFound();
  const role = team?.find((m) => m.id === claims.sub)?.role ?? "rep";
  return (
    <LeadPage
      key={id.data}
      initialLead={lead.data as LeadDetail}
      initialTimeline={timeline === "invalid" ? null : timeline}
      initialTasks={tasks}
      initialFiles={files}
      team={team ?? []}
      me={{ id: claims.sub, role }}
      stepUpSeconds={stepUpSecondsLeft(claims)}
      initialTab={tab}
      initialFilter={filter}
    />
  );
}
