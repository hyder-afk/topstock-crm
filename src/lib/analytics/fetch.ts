import { z } from "zod";
import { DEFAULT_BATCHES, activityPart, batchesPart, callTimesPart, coveragePart, pipelinePart, salesPart, speedPart } from "@/lib/analytics/parts";
import type { ActivityPart, BatchesPart, CallTimesPart, CoveragePart, PipelinePart, SalesPart, SpeedPart } from "@/lib/analytics/parts";
import type { ResolvedRange } from "@/lib/analytics/params";
import { toPart, type Part } from "@/lib/home";

// The Analytics reads (design 3.1 and 3.6), as a pure function of an `rpc` caller so the unit tests drive it with a
// fake: the seven block functions run in parallel and settle on their own (allSettled), each answer parsed strictly into
// Part<T> (a failing or misshapen block is {ok:false}, the rest stand). list_team (names for the Team table and the
// person picker) runs for managers and admins only; list quality for admins only (import batches are admin-only under
// row level security). Every value reaches the database as a typed function argument: dates, a uuid and integers,
// never text built into a filter. The database's own message never leaves this module: only the SQLSTATE and the hint
// are read, to tell a refused scope (403) and an unknown team member (400) from a block that failed.

type RpcError = { code?: string | null; hint?: string | null } | null;
export type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError }>;
export type AnalyticsRole = "admin" | "manager" | "rep";
export type AnalyticsQuery = { range: ResolvedRange; rep: string | null; idle: number };

const teamMember = z.object({
  id: z.uuid(),
  first_name: z.string().max(80),
  last_name: z.string().max(80),
  role: z.enum(["admin", "manager", "rep"]),
});
export const teamPart = z.array(teamMember).max(100);
export type AnalyticsTeamMember = z.infer<typeof teamMember>;

export type AnalyticsData = {
  from: string;
  to: string;
  bucket: ResolvedRange["bucket"];
  rep: string | null;
  idle: number;
  activity: Part<ActivityPart>;
  pipeline: Part<PipelinePart>;
  speed: Part<SpeedPart>;
  callTimes: Part<CallTimesPart>;
  sales: Part<SalesPart>;
  coverage: Part<CoveragePart>;
  /** null: not for this role (list quality is admin-only). */
  batches: Part<BatchesPart> | null;
  /** null: not for this role (reps have no person picker and no Team table). */
  team: Part<AnalyticsTeamMember[]> | null;
  /** When the server answered (ms since the epoch), for "Updated 14:32". */
  at: number;
};

/** The role the server acts on: anything it cannot read is a rep (the least it may see). */
export function analyticsRole(value: unknown): AnalyticsRole {
  return value === "admin" || value === "manager" ? value : "rep";
}

const skipped = Promise.resolve({ data: null, error: null });

/**
 * Every Analytics block for one range and person. Never throws. "forbidden": the database refused the person filter
 * (42501 'scope': a rep asking for a colleague); "invalid": the person is not a member of the caller's organisation
 * (P0002 'rep'). The role may still be on its way (P1 condition C4): the six blocks every role reads start at once, in
 * parallel with the role read; list quality (admins) and list_team (managers and admins) start as soon as the role is
 * known. The role only decides which extra reads run; the database checks every scope itself.
 */
export async function runAnalytics(
  rpc: Rpc,
  q: AnalyticsQuery,
  roleOrPromise: AnalyticsRole | PromiseLike<AnalyticsRole>,
): Promise<AnalyticsData | "forbidden" | "invalid"> {
  const span = { p_from: q.range.from, p_to: q.range.to, p_user: q.rep };
  // allSettled at once, so a block that fails while the role is still loading is already handled.
  const blocks = Promise.allSettled([
    rpc("analytics_activity", span),
    rpc("analytics_pipeline", span),
    rpc("analytics_speed", span),
    rpc("analytics_call_times", span),
    rpc("analytics_sales", span),
    rpc("analytics_coverage", { p_user: q.rep, p_idle_days: q.idle }),
  ]);
  // A role read that fails counts as a rep (the least it may see), so the blocks above still settle on their own.
  const role = await Promise.resolve(roleOrPromise).then(analyticsRole, () => "rep" as const);
  const isAdmin = role === "admin";
  const seesTeam = role === "admin" || role === "manager";
  const extras = Promise.allSettled([
    isAdmin ? rpc("analytics_batches", { p_user: q.rep, p_limit: DEFAULT_BATCHES }) : skipped,
    seesTeam ? rpc("list_team") : skipped,
  ]);
  const settled = [...(await blocks), ...(await extras)];
  const errors = settled.map((s) => (s.status === "fulfilled" ? s.value.error : null));
  if (errors.some((e) => e?.code === "42501" && e.hint === "scope")) return "forbidden";
  if (errors.some((e) => e?.code === "P0002" && e.hint === "rep")) return "invalid";
  const [activity, pipeline, speed, callTimes, sales, coverage, batches, team] = settled;
  return {
    from: q.range.from,
    to: q.range.to,
    bucket: q.range.bucket,
    rep: q.rep,
    idle: q.idle,
    activity: toPart(activityPart, activity),
    pipeline: toPart(pipelinePart, pipeline),
    speed: toPart(speedPart, speed),
    callTimes: toPart(callTimesPart, callTimes),
    sales: toPart(salesPart, sales),
    coverage: toPart(coveragePart, coverage),
    batches: isAdmin ? toPart(batchesPart, batches) : null,
    team: seesTeam ? toPart(teamPart, team) : null,
    at: Date.now(),
  };
}
