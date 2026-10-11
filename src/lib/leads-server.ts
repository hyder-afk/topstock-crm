import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { TIMELINE_PAGE_SIZE, type ActivityType, type TimelineEntry, type TimelinePage } from "@/lib/activities";
import type { LeadTask } from "@/lib/tasks";
import {
  filterParams,
  pageSize,
  rpcFilterArgs,
  type LeadFilters,
  type LeadPage,
  type LeadRow,
  type TeamMember,
} from "@/lib/leads";

// One page of leads for these filters (keyset). Shared by the leads page (first page, server-rendered) and
// GET /api/leads (next pages and filter changes). Returns "invalid" when the database refuses the request itself
// (a cursor that does not fit the sort), null when it could not answer.
export async function fetchLeadPage(
  supabase: SupabaseClient,
  filters: LeadFilters,
  cursor: { after_value: string; after_id: string } | null,
): Promise<LeadPage | "invalid" | null> {
  const args = rpcFilterArgs(filters);
  const [list, count] = await Promise.all([
    supabase.rpc("list_leads", {
      ...args,
      p_sort: filters.sort ?? "activity",
      p_after_value: cursor?.after_value ?? null,
      p_after_id: cursor?.after_id ?? null,
      p_limit: pageSize + 1,
    }),
    cursor ? Promise.resolve(null) : supabase.rpc("count_leads", args),
  ]);
  if (list.error?.code === "22023") return "invalid";
  if (list.error || count?.error) return null;
  const rows = (list.data ?? []) as LeadRow[];
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    next: hasMore && last ? { after_value: last.sort_value, after_id: last.id } : null,
    total: count ? Number(count.data) : null,
  };
}

export async function fetchTeam(supabase: SupabaseClient): Promise<TeamMember[] | null> {
  const { data, error } = await supabase.rpc("list_team");
  return error ? null : ((data ?? []) as TeamMember[]);
}

export type SavedView = { id: string; name: string; filters: LeadFilters; created_at: string };

// Saved filters come back as stored JSON: each view is checked like filters from the URL (bad values dropped), and a
// view that is not even an object of filters is left out.
const savedView = z.object({ id: z.uuid(), name: z.string(), filters: filterParams, created_at: z.string() });

export async function fetchViews(supabase: SupabaseClient): Promise<SavedView[] | null> {
  const { data, error } = await supabase.rpc("list_saved_views", { p_section: "leads" });
  if (error) return null;
  return ((data ?? []) as unknown[]).flatMap((row) => {
    const view = savedView.safeParse(row);
    return view.success ? [view.data] : [];
  });
}

// One page of a lead's timeline (keyset, newest first). Shared by the lead page (first page, server-rendered) and
// GET /api/leads/<id>/activities. Asks for one row more than a page to know whether there is another page. Returns
// "invalid" when the database refuses the request itself (a bad cursor or filter), null when it could not answer.
export async function fetchTimelinePage(
  supabase: SupabaseClient,
  leadId: string,
  type: ActivityType | null,
  cursor: { before_at: string; before_id: string } | null,
): Promise<TimelinePage | "invalid" | null> {
  const { data, error } = await supabase.rpc("list_lead_activities", {
    p_company: leadId,
    p_types: type ? [type] : null,
    p_before_at: cursor?.before_at ?? null,
    p_before_id: cursor?.before_id ?? null,
    p_limit: TIMELINE_PAGE_SIZE + 1,
  });
  if (error?.code === "22023") return "invalid";
  if (error) return null;
  const rows = (data ?? []) as TimelineEntry[];
  const hasMore = rows.length > TIMELINE_PAGE_SIZE;
  const entries = hasMore ? rows.slice(0, TIMELINE_PAGE_SIZE) : rows;
  const last = entries[entries.length - 1];
  return { entries, next: hasMore && last ? { before_at: last.created_at, before_id: last.id } : null };
}

// A lead's open tasks the caller can see (list_lead_tasks: due first, undated last).
export async function fetchLeadTasks(supabase: SupabaseClient, leadId: string): Promise<LeadTask[] | null> {
  const { data, error } = await supabase.rpc("list_lead_tasks", { p_company: leadId, p_include_done: false, p_limit: 20 });
  return error ? null : ((data ?? []) as LeadTask[]);
}
