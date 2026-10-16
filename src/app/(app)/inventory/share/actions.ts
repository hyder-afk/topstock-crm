"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { stockError, stockInvalid, type StockResult } from "@/lib/inventory/errors";
import { createLinkSchema, extendLinkSchema, sharingSchema, type MadeLink } from "@/lib/share/team";
import { shareUrl } from "@/lib/share/token";

// Client links (design 5.5 and 8.3): z.strictObject, the aal2 session, ONE RPC with explicit arguments, then { ok, data }
// or a code. The token comes back once, inside the address this action builds from its own validated origin; it is
// never logged, cached or stored.

async function ownOrigin(): Promise<string | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
  const proto = h.get("x-forwarded-proto") === "https" || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "https" : "http";
  return `${proto}://${host}`;
}

export async function createShareLink(input: unknown): Promise<StockResult<MadeLink>> {
  const parsed = createLinkSchema.safeParse(input);
  if (!parsed.success) return stockInvalid("bounds");
  const v = parsed.data;
  const origin = await ownOrigin();
  if (!origin) return { ok: false, error: "unavailable" };
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("create_share_link", {
    p_company: v.companyId,
    p_language: v.language,
    p_label: v.label?.trim() || null,
    p_expires_days: v.days,
    p_show_in_transit: v.showInTransit,
    p_allow_requests: v.allowRequests,
    p_replace: v.replace,
  });
  if (error) return stockError(error);
  const made = data as { id: string; token: string; expires_at: string };
  const url = shareUrl(origin, v.language, made.token);
  if (!url) return { ok: false, error: "unavailable" };
  return { ok: true, data: { id: made.id, url, expires_at: made.expires_at, language: v.language } };
}

export async function revokeShareLink(id: unknown): Promise<StockResult<null>> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return stockInvalid();
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("revoke_share_link", { p_id: parsed.data });
  if (error) return stockError(error);
  return { ok: true, data: null };
}

export async function extendShareLink(input: unknown): Promise<StockResult<{ expires_at: string }>> {
  const parsed = extendLinkSchema.safeParse(input);
  if (!parsed.success) return stockInvalid("expiry");
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("extend_share_link", { p_id: parsed.data.id, p_days: parsed.data.days });
  if (error) return stockError(error);
  return { ok: true, data: { expires_at: (data as { expires_at: string }).expires_at } };
}

export async function setSharingEnabled(input: unknown): Promise<StockResult<{ sharing_enabled: boolean }>> {
  const parsed = sharingSchema.safeParse(input);
  if (!parsed.success) return stockInvalid("sharing");
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("set_sharing_enabled", { p_on: parsed.data.on });
  if (error) return stockError(error);
  return { ok: true, data: { sharing_enabled: Boolean((data as { sharing_enabled: boolean }).sharing_enabled) } };
}
