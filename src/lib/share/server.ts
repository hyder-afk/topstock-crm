import "server-only";
import { createClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";
import { mapShareRequest, mapShareView } from "@/lib/share/map";
import type { ShareRequestAnswer, ShareRequestBody, ShareViewAnswer } from "@/lib/share/schema";

// The public routes' database access (design 8.6): the anon key only, no cookies, no session (a signed-in teammate who
// opens a client link stays anonymous here). One RPC each; every error is "unavailable" (never the database's words).
function createShareClient() {
  return createClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function shareView(token: string, knownVersion?: string): Promise<ShareViewAnswer> {
  const { data, error } = await createShareClient().rpc("share_view", { p_token: token, p_known_version: knownVersion ?? null });
  if (error) return { status: "unavailable" };
  return mapShareView(data);
}

export async function shareRequest(body: ShareRequestBody): Promise<ShareRequestAnswer> {
  const { data, error } = await createShareClient().rpc("share_request", {
    p_token: body.token,
    p_payload: {
      lines: body.lines.map((l) => ({
        product_number: l.productNumber,
        description: l.productNumber !== null ? null : (l.description?.trim() ?? null),
        quantity: String(l.quantity),
        unit: l.unit,
      })),
      note: body.note.trim() || null,
      name: body.name.trim() || null,
      idempotency_key: body.idempotencyKey,
    },
  });
  if (error) return { status: "unavailable" };
  return mapShareRequest(data);
}
