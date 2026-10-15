import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapShareItems } from "@/lib/share/map";
import type { ShareItem } from "@/lib/share/schema";
import type { ShareLinkList, ShareLinkRow } from "@/lib/share/team";

// Server reads for the team's side of client links (design 5.5): one RPC each, explicit arguments, codes only out.

export async function fetchShareLinks(supabase: SupabaseClient, company: string | null): Promise<ShareLinkList | null> {
  const [links, settings] = await Promise.all([
    supabase.rpc("list_share_links", { p_company: company, p_active_only: true, p_before_created: null, p_before_id: null, p_limit: 100 }),
    supabase.rpc("get_inventory_settings"),
  ]);
  if (links.error || settings.error) return null;
  return { sharing_enabled: Boolean((settings.data as { sharing_enabled?: boolean }).sharing_enabled), links: (links.data ?? []) as ShareLinkRow[] };
}

export type SharePreview = { sharing_enabled: boolean; signature: string | null; generated_at: string; items: ShareItem[] };

/** "What clients see": the same whitelist as the client page, read as the signed-in teammate. */
export async function fetchSharePreview(supabase: SupabaseClient): Promise<SharePreview | null> {
  const { data, error } = await supabase.rpc("share_preview");
  if (error || !data) return null;
  const raw = data as { sharing_enabled: boolean; signature: string | null; generated_at: string; items: unknown };
  const items = mapShareItems(raw.items);
  if (!items) return null;
  return { sharing_enabled: Boolean(raw.sharing_enabled), signature: raw.signature ?? null, generated_at: String(raw.generated_at), items };
}
