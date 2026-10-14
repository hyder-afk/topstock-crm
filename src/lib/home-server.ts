import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ATTENTION_SHOWN,
  RECENT_SHOWN,
  TODAY_SHOWN,
  attentionPart,
  lowStockPart,
  queueSummary,
  recentPart,
  summaryPart,
  todayPart,
  toPart,
  type HomeData,
  type HomeScope,
  type QueueSummary,
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
  const [summary, attention, recent, today, lowStock] = await Promise.allSettled([
    supabase.rpc("home_summary", { p_scope: scope }),
    supabase.rpc("home_attention", { p_scope: scope, p_limit: ATTENTION_SHOWN }),
    supabase.rpc("home_recent_activity", { p_scope: scope, p_limit: RECENT_SHOWN }),
    // REBASE: re-copy after 4c/4d merge. Day 4c's list_tasks('overdue' / 'today', 'mine', 6) replaces this stand-in.
    supabase.rpc("home_today_tasks", { p_limit: TODAY_SHOWN }),
    supabase.rpc("home_low_stock", { p_limit: 5 }),
  ]);
  if (summary.status === "fulfilled" && (summary.value.error as { code?: string } | null)?.code === "42501" && scope === "team") {
    return "forbidden";
  }
  return {
    scope,
    summary: toPart(summaryPart, summary),
    attention: toPart(attentionPart, attention),
    recent: toPart(recentPart, recent),
    today: toPart(todayPart, today),
    lowStock: toPart(lowStockPart, lowStock),
    at: Date.now(),
  };
}

/** The work queue's counts for the Work queue card (Day 4c's queue_summary, the caller's own leads), or null. */
export async function fetchQueueSummary(supabase: SupabaseClient): Promise<QueueSummary | null> {
  const { data, error } = await supabase.rpc("queue_summary", { p_scope: "mine", p_skip_lunch: false });
  if (error) return null;
  const parsed = queueSummary.safeParse(data);
  return parsed.success ? parsed.data : null;
}
