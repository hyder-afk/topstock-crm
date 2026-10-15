"use client";

import { useInfiniteQuery, type QueryClient } from "@tanstack/react-query";
import type { FilesPage } from "@/lib/files/types";

// A lead's files in the query cache: ["files", leadId], pages from /api/leads/<id>/files (keyset). The first page comes
// with the lead page (server-rendered), so the tab opens drawn.
export const filesKey = (leadId: string) => ["files", leadId] as const;
type Cursor = FilesPage["next"];

export async function fetchFiles(leadId: string, cursor: Cursor): Promise<FilesPage> {
  const params = new URLSearchParams();
  if (cursor) {
    params.set("before_at", cursor.at);
    params.set("before_id", cursor.id);
  }
  const qs = params.toString();
  const res = await fetch(`/api/leads/${leadId}/files${qs ? `?${qs}` : ""}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as FilesPage;
}

export function useFiles(leadId: string, initial?: FilesPage | null) {
  return useInfiniteQuery({
    queryKey: filesKey(leadId),
    queryFn: ({ pageParam }) => fetchFiles(leadId, pageParam),
    initialPageParam: null as Cursor,
    getNextPageParam: (last) => last.next,
    initialData: initial ? { pages: [initial], pageParams: [null] } : undefined,
  });
}

export function prefetchFiles(queryClient: QueryClient, leadId: string) {
  return queryClient.prefetchInfiniteQuery({
    queryKey: filesKey(leadId),
    queryFn: ({ pageParam }) => fetchFiles(leadId, pageParam as Cursor),
    initialPageParam: null as Cursor,
    staleTime: 30_000,
  });
}

/** "312 kB", "4.2 MB", "10 MB" in the reader's language (binary units, as the limits: 10 MB is 10 MiB); anything under
 *  1 kB reads "1 kB" (Intl's short "byte" unit reads "10 byte" in English). */
export function sizeParts(bytes: number): { value: number; unit: "kilobyte" | "megabyte"; digits: number } {
  if (bytes < 1024 * 1024) return { value: Math.max(1, Math.round(bytes / 1024)), unit: "kilobyte", digits: 0 };
  const mb = bytes / (1024 * 1024);
  return { value: mb, unit: "megabyte", digits: mb >= 100 || Number.isInteger(Math.round(mb * 10) / 10) ? 0 : 1 };
}
