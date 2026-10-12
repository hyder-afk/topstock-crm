import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";
import { readAndSniff, type StoredCheck } from "@/lib/files/stored-bytes";
import { BUCKET, type FileMime } from "@/lib/files/types";

// The server's look at stored bytes (Day 4 design 5.7): after an upload (before the file is ready) and on every open.
// It asks Storage, as the signed-in person, for a 30-second link, checks that the link points at our own Supabase origin
// (from the environment, never from a request: no SSRF), then reads the bytes sniffFile needs within 3 seconds
// (src/lib/files/stored-bytes.ts: works whether Storage honours Range or not, spike S3). The link is never logged or
// returned.

const origin = new URL(publicEnv.NEXT_PUBLIC_SUPABASE_URL).origin;

/** A signed link, only when it points at our Supabase project. */
export async function signedLink(supabase: SupabaseClient, path: string, seconds: number, download?: string) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds, download ? { download } : undefined);
  if (error || !data?.signedUrl) return null;
  try {
    const url = new URL(data.signedUrl);
    return url.origin === origin ? url : null;
  } catch {
    return null;
  }
}

/** Re-reads the stored object and runs sniffFile. False on any failure (missing, timeout, other origin, odd bytes). */
export async function checkStoredFile(supabase: SupabaseClient, path: string, mime: FileMime, size: number): Promise<StoredCheck> {
  const url = await signedLink(supabase, path, 30);
  if (!url) return { ok: false, rangeHonoured: null };
  return readAndSniff(
    (range, timeoutMs) => fetch(url, { headers: { Range: range }, signal: AbortSignal.timeout(timeoutMs), cache: "no-store", redirect: "error" }),
    mime,
    size,
  );
}
