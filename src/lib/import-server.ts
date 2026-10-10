import "server-only";

// Shared by the import server actions and the import API route: how a database answer becomes a short code for the
// screen (design section 2.7, error contract). Raw messages never leave the server.
export const importErrorCodes = [
  "step_up",
  "forbidden",
  "incomplete",
  "not_staged",
  "not_ready",
  "too_many_open",
  "bad_transition",
  "busy",
  "invalid",
  "not_found",
  "timeout",
  "unavailable",
] as const;
export type ImportErrorCode = (typeof importErrorCodes)[number];

const hinted: ReadonlySet<string> = new Set(["incomplete", "not_staged", "not_ready", "too_many_open", "bad_transition", "busy"]);

export function importError(error: { code?: string; hint?: string | null } | null | undefined): ImportErrorCode {
  const hint = error?.hint ?? "";
  switch (error?.code) {
    case "42501":
      return hint === "step_up" ? "step_up" : "forbidden";
    case "22023":
      return hinted.has(hint) ? (hint as ImportErrorCode) : "invalid";
    case "23505":
      return "busy";
    case "P0002":
      return "not_found";
    case "57014":
      return "timeout";
    default:
      return "unavailable";
  }
}

// One past import as the history list and the review screen use it (public.list_lead_imports).
export type ImportBatch = {
  id: string;
  filename: string;
  file_sha256: string | null;
  status: "staged" | "dry_run" | "committing" | "imported" | "rolling_back" | "rolled_back" | "discarded";
  row_count: number;
  last_row_no: number;
  imported: number;
  duplicates: number;
  rejected: number;
  kept: number;
  issue_counts: Record<string, number>;
  source_timezone: string;
  created_at: string;
  updated_at: string;
  checked_at: string | null;
  imported_at: string | null;
  rolled_back_at: string | null;
  uploaded_by: string | null;
  uploader_first_name: string | null;
  uploader_last_name: string | null;
  undone_by_first_name: string | null;
};

// A row the check did not mark plainly ready (public.list_lead_import_issues). No lead values: the browser has them.
export type ImportIssue = {
  row_no: number;
  outcome: "ready" | "rejected" | "duplicate_file" | "duplicate_existing" | "imported";
  problems: string[];
  fixes: string[];
  reason: string | null;
  match_key: "email" | "phone" | "name" | null;
  match_row_no: number | null;
  match_company_id: string | null;
  match_company_name: string | null;
};
