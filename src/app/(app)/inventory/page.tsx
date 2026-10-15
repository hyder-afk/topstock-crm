import { InventoryWorkspace } from "@/components/inventory/inventory-workspace";
import { requireSession, stepUpSecondsLeft } from "@/lib/auth";
import { parseStockFilters, stockFiltersToParams } from "@/lib/inventory/filters";
import { fetchStockPage, fetchSummary, sweepEndedHolds } from "@/lib/inventory-server";
import { fetchTeam } from "@/lib/leads-server";

// Inventory (design 6b, section 10.1). Two-factor session first; ended holds are released (the page-load sweep, at most
// once a minute per organisation), then the first stock page, the KPIs and the team render on the server; the browser
// pages, filters and refetches through /api/inventory.
export default async function InventoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { supabase, claims } = await requireSession();
  const filters = parseStockFilters(await searchParams);
  await sweepEndedHolds(supabase);
  const [page, summary, team] = await Promise.all([fetchStockPage(supabase, filters, null), fetchSummary(supabase), fetchTeam(supabase)]);
  const role = team?.find((m) => m.id === claims.sub)?.role ?? "rep";
  return (
    <InventoryWorkspace
      initialKey={stockFiltersToParams(filters).toString()}
      initialPage={page === "invalid" ? null : page}
      initialSummary={summary}
      role={role}
      me={claims.sub}
      team={(team ?? []).map((m) => ({ id: m.id, first_name: m.first_name, last_name: m.last_name }))}
      stepUpSeconds={stepUpSecondsLeft(claims)}
    />
  );
}
