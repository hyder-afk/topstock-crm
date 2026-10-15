import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";
import { checkStoredFile, signedLink } from "@/lib/files/stored";
import { opensInline, type FileMime } from "@/lib/files/types";

// GET /api/files/<id>?disposition=inline|attachment : opens a file (Day 4 design 5.7, threats 22 and 23).
//  1. A two-factor session; the id a UUID; a same-origin click or a typed address (Sec-Fetch-Site same-origin or
//     none), so another site cannot make the browser open files.
//  2. open_file: the caller can see the file and it is ready (row level security); writes the file_access audit row.
//  3. The stored bytes are checked again, every time (sniffFile): a file stored by a direct API call that skipped the
//     check at upload is refused here.
//  4. A 60-second signed link (a download with the file's name; PDF and images may open in the browser's viewer),
//     checked to point at our own Supabase origin.
//  5. 303 to that link, never cached, no referrer. Anything else: 303 to /files/unavailable (one answer for missing,
//     not yours, not ready and refused). The link exists only in this one Location header: never in the page, the
//     query cache, logs or storage.
const query = z.strictObject({ disposition: z.enum(["inline", "attachment"]).default("attachment") });
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

function unavailable(request: NextRequest) {
  return NextResponse.redirect(new URL("/files/unavailable", request.url), { status: 303, headers });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site !== "same-origin" && site !== "none") return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  const session = await apiSession();
  if (!session) return unavailable(request);
  const id = z.uuid().safeParse((await params).id);
  const q = query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!id.success || !q.success) return unavailable(request);
  const opened = await session.supabase.rpc("open_file", { p_id: id.data });
  if (opened.error || !opened.data) return unavailable(request);
  // The size is the stored object's: the database matched them when the file became ready.
  const file = opened.data as { path: string; name: string; mime: FileMime; size: number };
  const stored = await checkStoredFile(session.supabase, file.path, file.mime, file.size);
  if (!stored.ok) return unavailable(request);
  const inline = q.data.disposition === "inline" && opensInline(file.mime);
  const link = await signedLink(session.supabase, file.path, 60, inline ? undefined : file.name);
  if (!link) return unavailable(request);
  return NextResponse.redirect(link, { status: 303, headers });
}
