import { z } from "zod";
import { cleanText } from "@/lib/share/schema";

// The team side of client links (design 5.5): action schemas (strict) and the shapes the screens read. Pure.

export const createLinkSchema = z.strictObject({
  companyId: z.uuid(),
  language: z.enum(["en", "fr"]),
  label: cleanText(0, 80).nullable(),
  days: z.int().min(1).max(366),
  showInTransit: z.boolean(),
  allowRequests: z.boolean(),
  replace: z.boolean(),
});
export const extendLinkSchema = z.strictObject({ id: z.uuid(), days: z.int().min(1).max(366) });
export const sharingSchema = z.strictObject({ on: z.boolean() });
export const linkListParams = z.strictObject({ company: z.uuid().optional(), all: z.enum(["1"]).optional() });

export type ShareLinkRow = {
  id: string;
  company_id: string;
  company_name: string;
  label: string | null;
  language: "en" | "fr";
  show_in_transit: boolean;
  allow_requests: boolean;
  signature: string | null;
  token_hint: string;
  expires_at: string;
  revoked_at: string | null;
  created_by: string;
  created_by_first_name: string | null;
  created_at: string;
  open_count: number;
  last_opened_at: string | null;
  request_count: number;
  last_request_at: string | null;
  active: boolean;
};
export type ShareLinkList = { sharing_enabled: boolean; links: ShareLinkRow[] };
export type MadeLink = { id: string; url: string; expires_at: string; language: "en" | "fr" };

/** The page language a new link gets: French for leads in France, Belgium, Luxembourg and Monaco (design 10.4). */
export function defaultLinkLanguage(country: string | null | undefined, uiLocale: string): "en" | "fr" {
  if (country && ["FR", "BE", "LU", "MC"].includes(country.toUpperCase())) return "fr";
  if (country) return "en";
  return uiLocale === "fr" ? "fr" : "en";
}
