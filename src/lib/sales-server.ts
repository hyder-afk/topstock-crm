import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  LeadDealOption,
  LeadStock,
  RequestPage,
  RequestRow,
  SaleCursor,
  SaleDetail,
  SalePage,
  SaleRow,
  StockAlerts,
  StockRequest,
} from "@/lib/sales/types";

// Server reads for Day 6d (design 5.4): one RPC each, explicit arguments, codes only out. Pages of 50, newest first.
const PAGE = 50;

export async function fetchSales(
  supabase: SupabaseClient,
  f: { company?: string; fulfilment?: "from_stock" | "direct_from_source" },
  cursor: SaleCursor,
): Promise<SalePage | null> {
  const { data, error } = await supabase.rpc("list_sales", {
    p_company: f.company ?? null,
    p_fulfilment: f.fulfilment ?? null,
    p_user: null,
    p_from: null,
    p_to: null,
    p_before_created: cursor?.before_created ?? null,
    p_before_id: cursor?.before_id ?? null,
    p_limit: PAGE,
  });
  if (error) return null;
  const rows = (data ?? []) as SaleRow[];
  const last = rows.at(-1);
  return { rows, next: rows.length === PAGE && last ? { before_created: last.created_at, before_id: last.id } : null };
}

const STATUS_SETS: Record<string, string[] | null> = {
  open: ["new", "in_progress"],
  new: ["new"],
  in_progress: ["in_progress"],
  done: ["done"],
  declined: ["declined"],
  all: null,
};

export async function fetchRequests(supabase: SupabaseClient, status: string, cursor: SaleCursor): Promise<RequestPage | null> {
  const { data, error } = await supabase.rpc("list_stock_requests", {
    p_status: STATUS_SETS[status] ?? null,
    p_before_created: cursor?.before_created ?? null,
    p_before_id: cursor?.before_id ?? null,
    p_limit: PAGE,
  });
  if (error) return null;
  const rows = (data ?? []) as RequestRow[];
  const last = rows.at(-1);
  return { rows, next: rows.length === PAGE && last ? { before_created: last.created_at, before_id: last.id } : null };
}

export async function fetchLeadStock(supabase: SupabaseClient, companyId: string): Promise<LeadStock | "missing" | null> {
  const [stock, deals] = await Promise.all([
    supabase.rpc("get_lead_stock", { p_company: companyId }),
    supabase.rpc("list_lead_deals_for_stock", { p_company: companyId }),
  ]);
  if (stock.error?.code === "P0002") return "missing";
  if (stock.error || deals.error) return null;
  return { ...(stock.data as Omit<LeadStock, "deals">), deals: (deals.data ?? []) as LeadDealOption[] };
}

/** One sale with its lines (null cost for reps), or "missing". */
export async function fetchSale(supabase: SupabaseClient, id: string): Promise<SaleDetail | "missing" | null> {
  const { data, error } = await supabase.rpc("get_sale", { p_id: id });
  if (error?.code === "P0002") return "missing";
  if (error) return null;
  return data as SaleDetail;
}

/** One request with its lines and live availability, or "missing". */
export async function fetchRequest(supabase: SupabaseClient, id: string): Promise<StockRequest | "missing" | null> {
  const { data, error } = await supabase.rpc("get_stock_request", { p_id: id });
  if (error?.code === "P0002") return "missing";
  if (error) return null;
  return data as StockRequest;
}

/** The counts for the Requests badge and Home (stock_alerts). */
export async function fetchAlerts(supabase: SupabaseClient): Promise<StockAlerts | null> {
  const { data, error } = await supabase.rpc("stock_alerts");
  if (error) return null;
  return data as StockAlerts;
}
