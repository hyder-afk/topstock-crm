import { z } from "zod";
import type { InvalidHint } from "@/lib/db-errors";

// Files on a lead (Day 4 design 3.4, 5.7; Haider, open question 6): PDF, PNG, JPG, Word and Excel only, 10 MB a file,
// 800 MB for the team. Shared by the browser, the server and the tests (tests/unit/day4-parity.spec.ts holds them
// against the Day 4d migration).
export const FILE_TYPES = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
} as const;
export type FileMime = keyof typeof FILE_TYPES;
export const FILE_MIMES = Object.keys(FILE_TYPES) as FileMime[];

/** Extensions a chosen file may have, and the type each means (a browser can leave `File.type` empty for Office files). */
export const EXTENSION_TYPES: Record<string, FileMime> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
/** For the file input's `accept` (iPhone Safari then offers photos as JPEG, not HEIC). */
export const ACCEPT = [...FILE_MIMES, ".pdf", ".png", ".jpg", ".jpeg", ".docx", ".xlsx"].join(",");

export const MAX_FILE_BYTES = 10_485_760; // 10 MiB: the bucket limit and files_size_check
export const TEAM_QUOTA_BYTES = 838_860_800; // 800 MiB: private.file_quota_bytes()
export const FILE_NAME_MAX = 180;
export const FILES_PER_DROP = 5;
export const FILES_PAGE_SIZE = 50;
export const BUCKET = "lead-files";

/** PDF and images open in the browser's own viewer; Word and Excel always download. */
export function opensInline(mime: string) {
  return mime === "application/pdf" || mime === "image/png" || mime === "image/jpeg";
}

export type FileKind = "pdf" | "image" | "word" | "excel";
export function fileKind(mime: string): FileKind {
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.includes("spreadsheet")) return "excel";
  return "word";
}

/** One row of list_lead_files. */
export type LeadFile = {
  id: string;
  name: string;
  mime: FileMime;
  size: number;
  status: "ready" | "deleting";
  uploaded_by: string | null;
  uploader_first_name: string | null;
  uploader_last_name: string | null;
  created_at: string;
  is_mine: boolean;
  can_delete: boolean;
};
export type FilesPage = { files: LeadFile[]; next: { at: string; id: string } | null; usage: number | null };

// Server action inputs (strict: nothing unknown passes). Names and sizes are checked again by the database.
export const beginUploadInput = z.strictObject({
  leadId: z.uuid(),
  name: z.string().min(1).max(400),
  mime: z.enum(FILE_MIMES as [FileMime, ...FileMime[]]),
  size: z.int().min(1).max(MAX_FILE_BYTES),
});
export const fileIdInput = z.strictObject({ id: z.uuid() });

/** Which field a refused beginUpload input failed, as the database's own hints (verifier 4d round 3 finding 2): a long
 *  or empty name is "file_name" (shown as unavailable), never "file_type". An unknown field has no hint. */
export function beginUploadHint(error: z.ZodError): InvalidHint | undefined {
  const field = error.issues[0]?.path[0];
  return field === "name" ? "file_name" : field === "size" ? "file_size" : field === "mime" ? "file_type" : field === "leadId" ? "file_lead" : undefined;
}
