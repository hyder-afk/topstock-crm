import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTranslations } from "next-intl/server";
import type { LoggedActivity } from "@/lib/activities";
import { invalid, toActionFailure, type ActionResult, type AppError } from "@/lib/db-errors";
import type { z } from "zod";
import { claimCount, type ClaimAnswer, type ClaimNextInput, type queueOutcomeInput } from "@/lib/queue";

// The queue's two hot calls (Day 4 design 5.4 and D3), shared by the server actions and the POST route handlers:
// the next card(s), and an outcome followed by the next card. Arguments are named one by one (never a spread of client
// input); answers carry codes only.

export async function claimNext(supabase: SupabaseClient, next: ClaimNextInput): Promise<ActionResult<ClaimAnswer>> {
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

export type QueueOutcomeResult = { logged: LoggedActivity; claim: ClaimAnswer | null; claimError: AppError | null };

/**
 * Saves an outcome from the queue (log_activity with p_from_queue: the caller's claim on that lead goes), then claims
 * the next card when the screen asks for one. A replayed request id saves nothing twice. When the outcome cannot be
 * saved, no card is claimed (the screen keeps the outcome and tries again).
 */
export async function logOutcome(supabase: SupabaseClient, input: z.output<typeof queueOutcomeInput>): Promise<ActionResult<QueueOutcomeResult>> {
  const { log: v, next } = input;
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
