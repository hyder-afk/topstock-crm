import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { analyticsRole, runAnalytics, type AnalyticsData, type AnalyticsQuery, type AnalyticsRole } from "@/lib/analytics/fetch";

// The Analytics reads for the page (P2) and GET /api/analytics, with the signed-in person's own Supabase client (row
// level security applies to every row; no service key anywhere). The logic lives in fetch.ts, pure and unit-tested.

/** The caller's role, read from their own profile row (the id comes from the verified token, never from the request). */
export async function fetchAnalyticsRole(supabase: SupabaseClient, userId: string): Promise<AnalyticsRole> {
  const { data, error } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  return analyticsRole(error ? null : data?.role);
}

export async function fetchAnalytics(supabase: SupabaseClient, q: AnalyticsQuery, role: AnalyticsRole): Promise<AnalyticsData | "forbidden" | "invalid"> {
  return runAnalytics((fn, args) => supabase.rpc(fn, args), q, role);
}
