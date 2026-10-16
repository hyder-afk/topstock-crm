// What the stock import RPCs return (design 7.5 to 7.8), shared by the server actions, the routes and the screens.
import type { StockKeptReason, StockOutcome, StockReason } from "./rules";

export type StockBatchStatus = "staged" | "dry_run" | "committing" | "imported" | "rolling_back" | "rolled_back" | "discarded";

/** validate_stock_import: counts per outcome and code (issue_counts), pieces before and after per place. */
export type StockCheckSummary = {
  status: StockBatchStatus;
  row_count: number;
  rejected: number;
  repeated: number;
  issue_counts: Record<string, number>;
  not_in_sheet: number;
  use_sheet: boolean;
  wh_before: number;
  tr_before: number;
  wh_after: number;
  tr_after: number;
};

export type StockCommitStep = {
  status: "committing" | "imported";
  done_now: number;
  created_now: number;
  remaining: number;
  products_total: number;
};

export type StockUndoPreview = {
  products: number;
  qty_reverse: number;
  qty_kept: number;
  archive: number;
  archive_kept: number;
  fields_restore: number;
  fields_kept: number;
};

export type StockUndoStep = { status: "rolling_back" | "rolled_back"; done_now: number; kept: number | null };

/** list_stock_import_issues: codes only (the browser still holds the file's values). */
export type StockIssue = {
  row_no: number;
  outcome: StockOutcome;
  problems: string[];
  fixes: string[];
  db_warnings: string[];
  reason: StockReason | null;
  match_row_no: number | null;
};

/** list_stock_import_changes: one line per product (by its first row before the import, by product number after). */
export type StockChange = {
  row_no: number;
  product_id: string | null;
  product_name: string;
  outcome: StockOutcome | "undone";
  reason: StockReason | StockKeptReason | null;
  wh_before: number | null;
  wh_after: number | null;
  tr_before: number | null;
  tr_after: number | null;
  price_min_before: number | null;
  price_max_before: number | null;
  price_min_after: number | null;
  price_max_after: number | null;
  created: boolean;
};

export type StockImportBatch = {
  id: string;
  filename: string;
  file_sha256: string | null;
  status: StockBatchStatus;
  row_count: number;
  last_row_no: number;
  imported: number;
  duplicates: number;
  rejected: number;
  kept: number;
  issue_counts: Record<string, number>;
  created_at: string;
  checked_at: string | null;
  imported_at: string | null;
  rolled_back_at: string | null;
  uploaded_by: string | null;
  uploader_first_name: string | null;
  uploader_last_name: string | null;
  undone_by_first_name: string | null;
};
