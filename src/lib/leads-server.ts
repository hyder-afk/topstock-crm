import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
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
// GET /api/leads (next pages and filter changes). Returns null when the database could not answer.
export async function fetchLeadPage(
  supabase: SupabaseClient,
  filters: LeadFilters,
  cursor: { after_value: string; after_id: string } | null,
): Promise<LeadPage | null> {
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
