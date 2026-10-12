"use server";

import type { UndoneActivity } from "@/lib/activities";
import { requireSession } from "@/lib/auth";
import { invalid, toActionFailure, type ActionResult } from "@/lib/db-errors";
import { releaseInput, startQueueInput, undoOutcomeInput, type ClaimAnswer } from "@/lib/queue";

// The work queue's writes that are not on the key-press path (Day 4 design 4.2): Start, Undo, renewal and release. Each
// action: Zod strictObject first, then requireSession() (two-factor sessions only), then the database functions with
// their arguments named one by one. The outcome-and-next-card call and the next-card call are POST route handlers
// (/api/queue/outcome, /api/queue/next: design D3's switch rule, measured). Answers carry codes only, never database
// text. The database decides scope, claims and who may change a lead.

/** Start or a reload: the caller's own claims still eligible come back first (renewed), then up to 2 cards in all. */
export async function startQueue(input: unknown): Promise<ActionResult<ClaimAnswer>> {
  const parsed = startQueueInput.safeParse(input);
  if (!parsed.success) return invalid("bounds");
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("claim_next_lead", {
    p_scope: v.scope,
    p_keep: null,
    p_exclude: v.exclude,
    p_count: 2,
    p_any_hours: v.anyHours,
    p_skip_lunch: v.skipLunch,
  });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as ClaimAnswer };
}

/** Undo in the queue: the outcome is taken back (undo_activity), then the lead is claimed again to show it once more. */
export async function undoOutcome(input: unknown): Promise<ActionResult<{ undone: UndoneActivity; claimed: boolean }>> {
  const parsed = undoOutcomeInput.safeParse(input);
  if (!parsed.success) return invalid();
  const { supabase } = await requireSession();
  const undone = await supabase.rpc("undo_activity", { p_id: parsed.data.activityId });
  if (undone.error) return toActionFailure(undone.error);
  const claim = await supabase.rpc("claim_lead", { p_company: parsed.data.leadId });
  return { ok: true, data: { undone: undone.data as UndoneActivity, claimed: !claim.error && claim.data === true } };
}

/** Keeps the caller's live claims 10 more minutes (every 4 minutes while the page is visible and in use). */
export async function renewClaims(): Promise<ActionResult<{ until: string | null }>> {
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("renew_claims");
  if (error) return toActionFailure(error);
  return { ok: true, data: { until: (data as string | null) ?? null } };
}

/** Lets go of these claims (leaving the queue through the app), or all of the caller's (null). */
export async function releaseClaims(input: unknown): Promise<ActionResult<{ released: number }>> {
  const parsed = releaseInput.safeParse(input);
  if (!parsed.success) return invalid("bounds");
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("release_claims", { p_ids: parsed.data.ids });
  if (error) return toActionFailure(error);
  return { ok: true, data: { released: Number(data ?? 0) } };
}
