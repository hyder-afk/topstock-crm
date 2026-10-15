import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FILES_PAGE_SIZE, type FilesPage, type LeadFile } from "@/lib/files/types";

/** One page of a lead's files (list_lead_files, keyset), with the team's usage for managers and admins on the first
 *  page (file_usage; null for everyone else). Null when the database refused or failed. */
export async function fetchFilesPage(
  supabase: SupabaseClient,
  leadId: string,
  before: { at: string; id: string } | null,
): Promise<FilesPage | null> {
  const [list, usage] = await Promise.all([
    supabase.rpc("list_lead_files", {
      p_company: leadId,
      p_before_at: before?.at ?? null,
      p_before_id: before?.id ?? null,
      p_limit: FILES_PAGE_SIZE + 1,
    }),
    before ? Promise.resolve({ data: null, error: null }) : supabase.rpc("file_usage"),
  ]);
  if (list.error || usage.error) return null;
  const rows = (list.data ?? []) as LeadFile[];
  const files = rows.slice(0, FILES_PAGE_SIZE);
  const last = files[files.length - 1];
  return {
    files,
    next: rows.length > FILES_PAGE_SIZE && last ? { at: last.created_at, id: last.id } : null,
    usage: typeof usage.data === "number" ? usage.data : null,
  };
}
