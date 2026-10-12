"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getTranslations } from "next-intl/server";
import type { LoggedActivity, UndoneActivity } from "@/lib/activities";
import { requireSession } from "@/lib/auth";
import { invalid, toActionFailure, type ActionResult, type AppError } from "@/lib/db-errors";
import {
  claimCount,
  claimNextInput,
  queueOutcomeInput,
  releaseInput,
  skipInput,
  startQueueInput,
  undoOutcomeInput,
  type ClaimAnswer,
  type ClaimNextInput,
} from "@/lib/queue";

// The work queue's writes (Day 4 design 4.2 and D3). Each action: Zod strictObject first, then requireSession()
// (two-factor sessions only), then the database functions with their arguments named one by one. A key press is ONE
// dispatch (logOutcomeAndClaim: the outcome, then the next card), because Next.js runs a client's server actions one at
// a time. Answers carry codes only, never database text. The database decides scope, claims and who may change a lead.

async function claimNext(supabase: SupabaseClient, next: ClaimNextInput): Promise<ActionResult<ClaimAnswer>> {
  const count = claimCount(next.keep.length);
  if (count === 0) return invalid("bounds");
  const { data, error } = await supabase.rpc("claim_next_lead", {
    p_scope: next.scope,
    p_keep: next.keep,
    p_exclude: next.exclude,
    p_count: count,
    p_any_hours: next.anyHours,
    p_skip_lunch: next.skipLunch,
  });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as ClaimAnswer };
}

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

export type QueueOutcomeResult = { logged: LoggedActivity; claim: ClaimAnswer | null; claimError: AppError | null };

/**
 * Saves an outcome from the queue (log_activity with p_from_queue: the caller's claim on that lead goes), then claims
 * the next card when the screen asks for one. A replayed request id saves nothing twice. When the outcome cannot be
 * saved, no card is claimed (the screen keeps the outcome and tries again).
 */
export async function logOutcomeAndClaim(input: unknown): Promise<ActionResult<QueueOutcomeResult>> {
  const parsed = queueOutcomeInput.safeParse(input);
  if (!parsed.success) return invalid("outcome");
  const { log: v, next } = parsed.data;
  const { supabase } = await requireSession();
  const t = await getTranslations("Outcomes.taskTitle");
  const taskTitle =
    v.outcome === "wrong_number" ? t("rightNumber", { lead: v.leadName }) : v.outcome === "meeting_booked" ? t("meeting", { lead: v.leadName }) : t("followUp", { lead: v.leadName });
  const { data, error } = await supabase.rpc("log_activity", {
    p_company: v.leadId,
    p_type: "call",
    p_outcome: v.outcome,
    p_body: v.body.trim() === "" ? null : v.body,
    p_contact: v.contactId,
    p_dialled: v.dialled,
    p_follow_up_date: v.followUpDate,
    p_follow_up_at: v.followUpAt,
    p_task_title: taskTitle,
    p_request_id: v.requestId,
    p_from_queue: true,
  });
  if (error) return toActionFailure(error);
  const logged = data as LoggedActivity;
  if (!next) return { ok: true, data: { logged, claim: null, claimError: null } };
  const claimed = await claimNext(supabase, next);
  return { ok: true, data: { logged, claim: claimed.ok ? claimed.data : null, claimError: claimed.ok ? null : claimed.error } };
}

/** Skip: nothing is written; the skipped lead's claim goes (it is not in `keep`) and the next card is claimed. */
export async function skipAndClaim(input: unknown): Promise<ActionResult<ClaimAnswer>> {
  const parsed = skipInput.safeParse(input);
  if (!parsed.success) return invalid("bounds");
  const { supabase } = await requireSession();
  return claimNext(supabase, parsed.data.next);
}

/** Claims the next card(s) without an outcome (the buffer ran dry, or a retried outcome left the screen short). */
export async function claimMore(input: unknown): Promise<ActionResult<ClaimAnswer>> {
  const parsed = claimNextInput.safeParse(input);
  if (!parsed.success) return invalid("bounds");
  const { supabase } = await requireSession();
  return claimNext(supabase, parsed.data);
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
