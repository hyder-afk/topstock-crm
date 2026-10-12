import { QueueWorkspace } from "@/components/queue/queue-workspace";
import { requireSession } from "@/lib/auth";
import type { QueueSummary } from "@/lib/queue";

// The work queue (Day 4 design 4.2, 5.4, 7.4). Two-factor session first. No side effect on GET or render: this page
// only reads the start screen's counts (queue_summary, Mine) and whether the person owns any lead; claims start on an
// explicit Start. Mine + unassigned and Team are offered to managers and admins (the database refuses everyone else).
export default async function QueuePage() {
  const { supabase, claims } = await requireSession();
  const [profile, summary, mine] = await Promise.all([
    supabase.from("profiles").select("role, first_name").eq("id", claims.sub).maybeSingle(),
    supabase.rpc("queue_summary", { p_scope: "mine", p_skip_lunch: false }),
    supabase.rpc("count_leads", { p_owners: [claims.sub] }),
  ]);
  const role = profile.data?.role;
  return (
    <QueueWorkspace
      initialSummary={summary.error ? null : (summary.data as QueueSummary)}
      canWide={role === "admin" || role === "manager"}
      mineCount={mine.error ? 1 : Number(mine.data ?? 0)}
      me={typeof profile.data?.first_name === "string" && profile.data.first_name ? profile.data.first_name : "TopStock"}
    />
  );
}
