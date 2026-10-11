"use server";

import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { contactInput, leadInput, leadStatuses, savedViewInput } from "@/lib/leads";

// Leads and contacts: every action checks the session (aal2), validates its arguments with Zod and calls one
// database function with only the whitelisted fields. Row level security decides who may change what.
export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: "invalid" | "forbidden" | "unavailable" };

const uuid = z.uuid();
const ids = z.array(uuid).min(1).max(500);

function failure(code: string | undefined): { ok: false; error: "invalid" | "forbidden" | "unavailable" } {
  if (code === "42501") return { ok: false, error: "forbidden" };
  if (code === "23514" || code === "22023" || code === "23502") return { ok: false, error: "invalid" };
  return { ok: false, error: "unavailable" };
}

export async function createLead(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = leadInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { supabase } = await requireSession();
  const v = parsed.data;
  const { data, error } = await supabase.rpc("create_lead", {
    p_name: v.name,
    p_owner: v.owner || null,
    p_status: v.status,
    p_phone: v.phone,
    p_email: v.email,
    p_city: v.city,
    p_country: v.country,
  });
  if (error) return failure(error.code);
  return { ok: true, data: { id: data as string } };
}

export async function updateLead(id: unknown, input: unknown): Promise<ActionResult> {
  const leadId = uuid.safeParse(id);
  const parsed = leadInput.safeParse(input);
  if (!leadId.success || !parsed.success) return { ok: false, error: "invalid" };
  const { supabase } = await requireSession();
  const v = parsed.data;
  const { error } = await supabase.rpc("update_lead", {
    p_id: leadId.data,
    p_name: v.name,
    p_owner: v.owner || null,
    p_status: v.status,
    p_phone: v.phone,
    p_email: v.email,
    p_city: v.city,
    p_country: v.country,
  });
  return error ? failure(error.code) : { ok: true };
}

// Bulk and single changes from the list and the preview. Returns how many leads changed (others are not yours).
// Cool off may carry a return date ("Until when?", Day 4b): at most 2 years ahead (the database's lead guard); without
// one the database brings the lead back in 90 days.
const until = z.iso.datetime({ offset: true }).nullable().optional();

export async function setLeadsStatus(leadIds: unknown, status: unknown, returnAt?: unknown): Promise<ActionResult<{ changed: number }>> {
  const parsedIds = ids.safeParse(leadIds);
  const parsedStatus = z.enum(leadStatuses).safeParse(status);
  const parsedUntil = until.safeParse(returnAt);
  if (!parsedIds.success || !parsedStatus.success || !parsedUntil.success) return { ok: false, error: "invalid" };
  if (parsedUntil.data && parsedStatus.data !== "cool_off") return { ok: false, error: "invalid" };
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("bulk_update_leads", {
    p_ids: parsedIds.data,
    p_status: parsedStatus.data,
    p_next_action_at: parsedUntil.data ?? null,
  });
  if (error) return failure(error.code);
  return { ok: true, data: { changed: Number(data) } };
}

export async function setLeadsOwner(leadIds: unknown, owner: unknown): Promise<ActionResult<{ changed: number }>> {
  const parsedIds = ids.safeParse(leadIds);
  const parsedOwner = z.union([uuid, z.null()]).safeParse(owner);
  if (!parsedIds.success || !parsedOwner.success) return { ok: false, error: "invalid" };
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("bulk_update_leads", {
    p_ids: parsedIds.data,
    p_set_owner: true,
    p_owner: parsedOwner.data,
  });
  if (error) return failure(error.code);
  return { ok: true, data: { changed: Number(data) } };
}

export async function addContact(leadId: unknown, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsedId = uuid.safeParse(leadId);
  const parsed = contactInput.safeParse(input);
  if (!parsedId.success || !parsed.success) return { ok: false, error: "invalid" };
  const { supabase } = await requireSession();
  const v = parsed.data;
  const { data, error } = await supabase.rpc("add_contact", {
    p_company_id: parsedId.data,
    p_first_name: v.first_name,
    p_last_name: v.last_name,
    p_title: v.title,
    p_email: v.email,
    p_phone: v.phone,
  });
  if (error) return failure(error.code);
  return { ok: true, data: { id: data as string } };
}

export async function updateContact(contactId: unknown, input: unknown): Promise<ActionResult> {
  const parsedId = uuid.safeParse(contactId);
  const parsed = contactInput.safeParse(input);
  if (!parsedId.success || !parsed.success) return { ok: false, error: "invalid" };
  const { supabase } = await requireSession();
  const v = parsed.data;
  const { error } = await supabase.rpc("update_contact", {
    p_id: parsedId.data,
    p_first_name: v.first_name,
    p_last_name: v.last_name,
    p_title: v.title,
    p_email: v.email,
    p_phone: v.phone,
  });
  return error ? failure(error.code) : { ok: true };
}

export async function saveView(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = savedViewInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("save_view", {
    p_section: "leads",
    p_name: parsed.data.name,
    p_filters: parsed.data.filters,
  });
  if (error) return failure(error.code);
  return { ok: true, data: { id: data as string } };
}

export async function deleteView(viewId: unknown): Promise<ActionResult> {
  const parsedId = uuid.safeParse(viewId);
  if (!parsedId.success) return { ok: false, error: "invalid" };
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("delete_saved_view", { p_id: parsedId.data });
  return error ? failure(error.code) : { ok: true };
}
