import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BOARD_PAGE, type Board, type BoardOrder, type BoardSummary, type Cursor, type DealCard, type DealDetail, type StageKey } from "@/lib/deals";

// The deal reads shared by the pipeline page (first paint, server-rendered as a promise: design D32) and the GET routes
// (design 4.5). Each answers the database's rows, "invalid" when the database refused the request itself (a bad cursor,
// scope or order: 22023), "forbidden" for a scope the caller may not ask for (42501), or null when it could not answer.

export type ReadFailure = "invalid" | "forbidden" | null;
function failure(error: { code?: string | null } | null): ReadFailure {
  if (error?.code === "22023") return "invalid";
  if (error?.code === "42501") return "forbidden";
  return null;
}

/**
 * The board's first paint in one call (pipeline_board): a rep asking for the team silently gets their own deals. "oldest"
 * starts each open column with the deals longest in their stage.
 */
export async function fetchBoard(supabase: SupabaseClient, scope: "team" | "mine", owner: string | null, order: BoardOrder = "recent"): Promise<Board | ReadFailure> {
  const { data, error } = await supabase.rpc("pipeline_board", { p_scope: scope, p_owner: owner, p_per_stage: BOARD_PAGE, p_order: order });
  if (error) return failure(error);
  return data as Board;
}

/** One page of a column (list_stage_deals): asks one more than a page to know whether another page exists. */
export async function fetchStagePage(
  supabase: SupabaseClient,
  args: { stage: StageKey; scope: "team" | "mine"; owner: string | null; stalled: boolean; order: "recent" | "oldest"; cursor: Cursor },
): Promise<{ cards: DealCard[]; next: Cursor } | ReadFailure> {
  const { data, error } = await supabase.rpc("list_stage_deals", {
    p_stage: args.stage,
    p_scope: args.scope,
    p_owner: args.owner,
    p_stalled_only: args.stalled,
    p_order: args.order,
    p_after_at: args.cursor?.after_at ?? null,
    p_after_id: args.cursor?.after_id ?? null,
    p_limit: BOARD_PAGE + 1,
  });
  if (error) return failure(error);
  const rows = (data ?? []) as DealCard[];
  const more = rows.length > BOARD_PAGE;
  const cards = more ? rows.slice(0, BOARD_PAGE) : rows;
  const last = cards[cards.length - 1];
  const closed = args.stage === "won" || args.stage === "lost";
  return {
    cards,
    next: more && last ? { after_at: (closed ? last.closed_at : last.stage_entered_at) ?? last.stage_entered_at, after_id: last.id } : null,
  };
}

/** The summary part (pipeline_summary), for the 30 s refresh of the counts. */
export async function fetchSummary(supabase: SupabaseClient, scope: "team" | "mine", owner: string | null): Promise<BoardSummary | ReadFailure> {
  const { data, error } = await supabase.rpc("pipeline_summary", { p_scope: scope, p_owner: owner });
  if (error) return failure(error);
  return data as BoardSummary;
}

/** One deal for the deal sheet (get_deal): null when missing or not visible (the same answer for both). */
export async function fetchDeal(supabase: SupabaseClient, id: string): Promise<DealDetail | null | "error"> {
  const { data, error } = await supabase.rpc("get_deal", { p_id: id });
  if (error) return "error";
  return (data as DealDetail | null) ?? null;
}

/** A lead's deals for its Deals tab (list_lead_deals): open first, then closed. */
export async function fetchLeadDeals(supabase: SupabaseClient, leadId: string): Promise<DealCard[] | ReadFailure> {
  const { data, error } = await supabase.rpc("list_lead_deals", { p_company: leadId, p_limit: 50 });
  if (error) return failure(error);
  return (data ?? []) as DealCard[];
}
