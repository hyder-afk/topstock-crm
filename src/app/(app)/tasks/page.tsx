import { TasksWorkspace } from "@/components/tasks/tasks-workspace";
import { requireSession, stepUpSecondsLeft } from "@/lib/auth";
import { fetchTeam } from "@/lib/leads-server";
import { TASK_BUCKETS, type TaskBucket, type TaskScope } from "@/lib/tasks";
import { fetchTaskCounts, fetchTaskPage } from "@/lib/tasks-server";

// The Tasks page (Day 4 design 7.5). Two-factor session first; the person's role and time zone are read from their own
// profile (the database works out the buckets in the same zone); the selected tab's first page and the counts are read
// in parallel. Team is offered to managers and admins only (the database refuses it to everyone else too). A failed
// read shows the tab's own error state with Try again.
export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  const { supabase, claims } = await requireSession();
  const query = await searchParams;
  const tabParam = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const scopeParam = Array.isArray(query.scope) ? query.scope[0] : query.scope;
  const tab: TaskBucket = (TASK_BUCKETS as readonly string[]).includes(tabParam ?? "") ? (tabParam as TaskBucket) : "today";
  const { data: profile } = await supabase.from("profiles").select("role, timezone").eq("id", claims.sub).maybeSingle();
  const canTeam = profile?.role === "admin" || profile?.role === "manager";
  const scope: TaskScope = canTeam && scopeParam === "team" ? "team" : "mine";
  const zone = typeof profile?.timezone === "string" && profile.timezone ? profile.timezone : "Europe/Paris";
  const [page, counts, team] = await Promise.all([
    fetchTaskPage(supabase, tab, scope, null),
    fetchTaskCounts(supabase, scope),
    canTeam ? fetchTeam(supabase) : Promise.resolve([]),
  ]);
  const initialPage = page && typeof page === "object" && counts ? { ...page, counts } : null;
  return (
    <TasksWorkspace
      initialTab={tab}
      initialScope={scope}
      initialPage={initialPage}
      zone={zone}
      canTeam={canTeam}
      team={team ?? []}
      stepUpSeconds={stepUpSecondsLeft(claims)}
    />
  );
}
