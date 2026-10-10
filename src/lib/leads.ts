import { z } from "zod";

// A lead is a company (Haider, 10 Oct 2026). Statuses in his order; the database check constraint holds the same list.
export const leadStatuses = [
  "cold",
  "warm",
  "negotiation",
  "customer",
  "cool_off",
  "do_not_contact",
  "disqualified",
] as const;
export type LeadStatus = (typeof leadStatuses)[number];

// Status colour is a small dot next to the word (DESIGN.md: never colour alone, never the accent).
export const statusTone: Record<LeadStatus, "neutral" | "amber" | "green" | "red"> = {
  cold: "neutral",
  warm: "amber",
  negotiation: "amber",
  customer: "green",
  cool_off: "neutral",
  do_not_contact: "red",
  disqualified: "red",
};

export const leadSorts = ["activity", "name", "created"] as const;
export type LeadSort = (typeof leadSorts)[number];
export const inactivityOptions = [7, 30, 90] as const;

export const optionalColumns = ["owner", "status", "phone", "email", "last_activity", "city", "country"] as const;
export type OptionalColumn = (typeof optionalColumns)[number];

const uuid = z.uuid();
const country = z.string().regex(/^[A-Z]{2}$/);
// "a,b,c" in the URL becomes ["a","b","c"], each item checked; more than 50 items or 4000 characters is refused.
function csv<T extends z.ZodType>(item: T) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.length <= 4000 ? v.split(",").filter(Boolean) : v),
    z.array(item).max(50),
  );
}

// Filters live in the URL (shareable, survive reload, work with Back). Unknown or bad values are dropped, never sent.
export const filterParams = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: csv(z.enum(leadStatuses)).optional().catch(undefined),
  owner: csv(z.union([uuid, z.literal("none")])).optional().catch(undefined),
  country: csv(country).optional().catch(undefined),
  city: z.string().trim().max(120).optional().catch(undefined),
  inactive: z.coerce
    .number()
    .refine((n) => (inactivityOptions as readonly number[]).includes(n))
    .optional()
    .catch(undefined),
  sort: z.enum(leadSorts).optional().catch(undefined),
  // Leads added by one import (the link from an import's result and from Past imports).
  batch: uuid.optional().catch(undefined),
});
export type LeadFilters = z.infer<typeof filterParams>;

export function parseFilters(params: URLSearchParams | Record<string, string | string[] | undefined>): LeadFilters {
  const get = (k: string) => {
    const v = params instanceof URLSearchParams ? params.get(k) : params[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s === null || s === "" ? undefined : s;
  };
  return filterParams.parse({
    q: get("q"),
    status: get("status"),
    owner: get("owner"),
    country: get("country"),
    city: get("city"),
    inactive: get("inactive"),
    sort: get("sort"),
    batch: get("batch"),
  });
}

export function filtersToParams(f: LeadFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.status?.length) p.set("status", f.status.join(","));
  if (f.owner?.length) p.set("owner", f.owner.join(","));
  if (f.country?.length) p.set("country", f.country.join(","));
  if (f.city) p.set("city", f.city);
  if (f.inactive) p.set("inactive", String(f.inactive));
  if (f.sort && f.sort !== "activity") p.set("sort", f.sort);
  if (f.batch) p.set("batch", f.batch);
  return p;
}

export function activeFilterCount(f: LeadFilters) {
  return [f.status?.length, f.owner?.length, f.country?.length, f.city, f.inactive, f.batch].filter(Boolean).length;
}

// Arguments for the list_leads / count_leads database functions (all values travel as parameters).
export function rpcFilterArgs(f: LeadFilters) {
  const owners = f.owner?.filter((o: string) => o !== "none");
  return {
    p_search: f.q ?? null,
    p_statuses: f.status?.length ? f.status : null,
    p_owners: owners?.length ? owners : null,
    p_unowned: f.owner?.includes("none") ?? false,
    p_countries: f.country?.length ? f.country : null,
    p_city: f.city ?? null,
    p_inactive_days: f.inactive ?? null,
    p_import_batch: f.batch ?? null,
  };
}

export const cursorParams = z.object({
  // A lead name is up to 200 characters, which can be 400 UTF-16 units (what Zod counts).
  after_value: z.string().max(400),
  after_id: uuid,
});

export type LeadRow = {
  id: string;
  name: string;
  owner_id: string | null;
  owner_first_name: string | null;
  owner_last_name: string | null;
  phone: string | null;
  email: string | null;
  lead_status: LeadStatus;
  last_activity_at: string | null;
  city: string | null;
  country: string | null;
  contact_count: number;
  created_at: string;
  sort_value: string;
};

export type LeadPage = { rows: LeadRow[]; next: { after_value: string; after_id: string } | null; total: number | null };

export type Contact = {
  id: string;
  first_name: string;
  last_name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
};

export type LeadDetail = {
  id: string;
  name: string;
  lead_status: LeadStatus;
  phone: string | null;
  email: string | null;
  city: string | null;
  country: string | null;
  last_activity_at: string | null;
  created_at: string;
  owner: { id: string; first_name: string; last_name: string } | null;
  can_edit: boolean;
  contacts: Contact[];
};

export type TeamMember = { id: string; first_name: string; last_name: string; role: "admin" | "manager" | "rep" };

export const pageSize = 50;

// Form input (server actions validate again; the database checks once more).
const phone = z
  .string()
  .trim()
  .max(40)
  .regex(/^[0-9+(). /-]*$/, "phone");
const email = z.union([z.literal(""), z.email().max(254)]);

export const leadInput = z.object({
  name: z.string().trim().min(1).max(200),
  owner: z.union([uuid, z.literal("")]),
  status: z.enum(leadStatuses),
  phone,
  email,
  city: z.string().trim().max(120),
  country: z.union([country, z.literal("")]),
});

export const contactInput = z
  .object({
    first_name: z.string().trim().max(120),
    last_name: z.string().trim().max(120),
    title: z.string().trim().max(120),
    email,
    phone,
  })
  .refine((c) => c.first_name !== "" || c.last_name !== "", { path: ["first_name"], message: "name" });

export const savedViewInput = z.object({
  name: z.string().trim().min(1).max(80),
  filters: filterParams,
});

export function personName(p: { first_name: string | null; last_name: string | null } | null | undefined) {
  if (!p) return "";
  return [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
}

// mailto: links with the address percent-encoded, so a "?", "&" or "," in a stored address cannot add a subject, a body
// or more recipients.
export function mailHref(address: string) {
  const at = address.lastIndexOf("@");
  const local = at < 0 ? address : address.slice(0, at);
  return at < 0
    ? `mailto:${encodeURIComponent(local)}`
    : `mailto:${encodeURIComponent(local)}@${encodeURIComponent(address.slice(at + 1))}`;
}

// tel: links keep only digits and a leading plus.
export function telHref(phoneNumber: string) {
  const trimmed = phoneNumber.trim();
  return `tel:${trimmed.startsWith("+") ? "+" : ""}${trimmed.replace(/[^0-9]/g, "")}`;
}
