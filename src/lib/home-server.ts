import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ATTENTION_SHOWN,
  RECENT_SHOWN,
  TODAY_SHOWN,
  attentionPart,
  buildToday,
  listTaskRows,
  lowStockPart,
  recentPart,
  summaryPart,
  taskCounts,
  toPart,
  type HomeData,
  type HomeScope,
  type HomeToday,
  type Part,
} from "@/lib/home";

// The Home reads (Day 5 design 4.5 and D26), shared by the Home page (its first paint, handed to the client as a
// promise: D32) and GET /api/home. The parts run in parallel and settle on their own (allSettled), so one failing
// function (a Day 6 stock fault, say) leaves every other card standing. Every value reaches the database as a function
// argument; nothing is built from text.

/**
 * Every Home part for one scope. Never throws: a part that failed or answered a wrong shape is {ok:false}. "forbidden"
 * when the database refused the scope itself (a rep asking for the team: 42501 on the figures).
 */
export async function fetchHome(supabase: SupabaseClient, scope: HomeScope): Promise<HomeData | "forbidden"> {
  const [summary, attention, recent, overdue, today, counts, lowStock] = await Promise.allSettled([
    supabase.rpc("home_summary", { p_scope: scope }),
    supabase.rpc("home_attention", { p_scope: scope, p_limit: ATTENTION_SHOWN }),
    supabase.rpc("home_recent_activity", { p_scope: scope, p_limit: RECENT_SHOWN }),
    // Today (always the caller's own tasks): Day 4c's list_tasks and count_tasks, with its buckets in the profile zone.
    supabase.rpc("list_tasks", { p_bucket: "overdue", p_scope: "mine", p_after_sort: null, p_after_id: null, p_limit: TODAY_SHOWN }),
    supabase.rpc("list_tasks", { p_bucket: "today", p_scope: "mine", p_after_sort: null, p_after_id: null, p_limit: TODAY_SHOWN }),
    supabase.rpc("count_tasks", { p_scope: "mine" }),
    // Low stock: Day 6's stock_alerts() (decision B); the Day 5c stub answers null until inventory is set up.
    supabase.rpc("stock_alerts"),
  ]);
  if (summary.status === "fulfilled" && (summary.value.error as { code?: string } | null)?.code === "42501" && scope === "team") {
    return "forbidden";
  }
  const summaryData = toPart(summaryPart, summary);
  return {
    scope,
    summary: summaryData,
    attention: toPart(attentionPart, attention),
    recent: toPart(recentPart, recent),
    today: todayFrom(overdue, today, counts, summaryData.ok ? { today: summaryData.data.today, zone: summaryData.data.zone } : null),
    lowStock: toPart(lowStockPart, lowStock),
    at: Date.now(),
  };
}

type Settled = PromiseSettledResult<{ data: unknown; error: unknown }>;

/** The Today part: both lists and the counts must answer in shape, or the card shows its own error. */
function todayFrom(overdue: Settled, today: Settled, counts: Settled, day: { today: string; zone: string } | null): Part<HomeToday> {
  const o = toPart(listTaskRows, overdue);
  const t = toPart(listTaskRows, today);
  const c = toPart(taskCounts, counts);
  if (!o.ok || !t.ok || !c.ok) return { ok: false };
  return { ok: true, data: buildToday(o.data, t.data, c.data, day) };
}
