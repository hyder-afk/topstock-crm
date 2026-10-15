"use server";

import { z } from "zod";
import {
  dealIdInput,
  loseInput,
  moveInput,
  openDealInput,
  reopenInput,
  undoInput,
  updateDealInput,
  winInput,
  type MoveResult,
  type OpenResult,
  type UpdateResult,
} from "@/lib/deals";
import { requireSession } from "@/lib/auth";
import { INVALID_HINTS, invalid, toActionFailure, type ActionResult, type InvalidHint } from "@/lib/db-errors";

// The pipeline's writes (Day 5 design 4.4). Each action: Zod strictObject first (nothing unknown passes), then
// requireSession() (two-factor sessions only), then exactly one database function with its arguments named one by one
// (never a spread of client input). The database decides every rule (deal_guard, policies, move_deal); a version that
// moved is a result ({ result: "conflict" }), not an error. Answers carry codes only, never database text.
// winDeal, loseDeal, reopenDeal and undoDealMove all call move_deal; money travels as a decimal string (design D10).

function zodHint(error: z.ZodError): InvalidHint | undefined {
  for (const issue of error.issues) {
    if ((INVALID_HINTS as readonly string[]).includes(issue.message)) return issue.message as InvalidHint;
  }
  return undefined;
}

export async function openDeal(input: unknown): Promise<ActionResult<OpenResult>> {
  const parsed = openDealInput.safeParse(input);
  if (!parsed.success) return invalid(zodHint(parsed.error));
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("open_deal", {
    p_company: v.leadId,
    p_title: v.title,
    p_value: v.value,
    p_expected_close: v.expectedClose,
    p_fulfilment: v.fulfilment,
    p_contact: v.contactId,
    p_owner: v.ownerId,
    p_request_id: v.requestId,
  });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as OpenResult };
}

export async function moveDeal(input: unknown): Promise<ActionResult<MoveResult>> {
  const parsed = moveInput.safeParse(input);
  if (!parsed.success) return invalid(zodHint(parsed.error));
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("move_deal", {
    p_id: v.id,
    p_stage: v.stage,
    p_expected_version: v.version,
    p_request_id: v.requestId,
  });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as MoveResult };
}

export async function winDeal(input: unknown): Promise<ActionResult<MoveResult>> {
  const parsed = winInput.safeParse(input);
  if (!parsed.success) return invalid(zodHint(parsed.error) ?? "value_required");
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("move_deal", {
    p_id: v.id,
    p_stage: "won",
    p_expected_version: v.version,
    p_value: v.value,
    p_fulfilment: v.fulfilment,
    p_request_id: v.requestId,
  });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as MoveResult };
}

export async function loseDeal(input: unknown): Promise<ActionResult<MoveResult>> {
  const parsed = loseInput.safeParse(input);
  if (!parsed.success) return invalid(zodHint(parsed.error) ?? "lost_reason_required");
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("move_deal", {
    p_id: v.id,
    p_stage: "lost",
    p_expected_version: v.version,
    p_lost_reason: v.reason,
    p_lost_note: v.note,
    p_request_id: v.requestId,
  });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as MoveResult };
}

export async function reopenDeal(input: unknown): Promise<ActionResult<MoveResult>> {
  const parsed = reopenInput.safeParse(input);
  if (!parsed.success) return invalid(zodHint(parsed.error));
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("move_deal", {
    p_id: v.id,
    p_stage: v.stage,
    p_expected_version: v.version,
    p_request_id: v.requestId,
  });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as MoveResult };
}

export async function undoDealMove(input: unknown): Promise<ActionResult<MoveResult>> {
  const parsed = undoInput.safeParse(input);
  if (!parsed.success) return invalid(zodHint(parsed.error));
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("move_deal", {
    p_id: v.id,
    p_stage: v.toStage,
    p_expected_version: v.version,
    p_undo_of: v.historyId,
    p_request_id: v.requestId,
  });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as MoveResult };
}

export async function updateDeal(input: unknown): Promise<ActionResult<UpdateResult>> {
  const parsed = updateDealInput.safeParse(input);
  if (!parsed.success) return invalid(zodHint(parsed.error) ?? "fields");
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("update_deal", {
    p_id: v.id,
    p_expected_version: v.version,
    p_fields: v.fields,
    p_title: v.title ?? null,
    p_value: v.value ?? null,
    p_expected_close: v.expectedClose ?? null,
    p_fulfilment: v.fulfilment ?? null,
    p_contact: v.contactId ?? null,
    p_owner: v.ownerId ?? null,
  });
  if (error) return toActionFailure(error);
  return { ok: true, data: data as UpdateResult };
}

export async function deleteDeal(input: unknown): Promise<ActionResult<null>> {
  const parsed = dealIdInput.safeParse(input);
  if (!parsed.success) return invalid();
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("delete_deal", { p_id: parsed.data.id });
  if (error) return toActionFailure(error);
  return { ok: true, data: null };
}
