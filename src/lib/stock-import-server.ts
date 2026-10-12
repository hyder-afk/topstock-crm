import "server-only";
import { importError, type ImportErrorCode } from "@/lib/import-server";

// The stock sheet import's database answers as short codes (design 7.5 error contract, the Day 3b importError pattern).
// A lock wait past the commit's 3 s lock_timeout (55P03) is "busy": someone is moving the same products.
export function stockImportError(error: { code?: string; hint?: string | null } | null | undefined): ImportErrorCode {
  if (error?.code === "55P03") return "busy";
  return importError(error);
}
