// What the Day 6d sale, hold and request RPCs return (design 5.4), shared by the actions, routes and screens.
import type { StageKey } from "@/lib/deals";

export type Fulfilment = "from_stock" | "direct_from_source";
export type SaleStatus = "confirmed" | "cancelled";
export type RequestStatus = "new" | "in_progress" | "done" | "declined";

export type SaleResult = {
  order_id: string;
  number: number;
  fulfilment: Fulfilment;
  total: number;
  line_count: number;
  lines: { product_id: string; pieces: number; used_held: number; available_after: number }[];
  became_customer: boolean;
};

export type SaleRow = {
  id: string;
  number: number;
  company_id: string;
  company_name: string;
  deal_id: string | null;
  fulfilment: Fulfilment;
  status: SaleStatus;
  total: number;
  line_count: number;
  items: string | null;
  created_at: string;
  created_by: string;
  created_by_first_name: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
};
export type SaleCursor = { before_created: string; before_id: string } | null;
export type SalePage = { rows: SaleRow[]; next: SaleCursor };

export type Availability = {
  warehouse_available: number;
  transit_on_hand: number;
  transit_eta: string | null;
  archived: boolean;
};

export type RequestLine = {
  position: number;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit: "piece" | "carton";
  pieces: number;
  price_shown: number | null;
  price_max: number | null;
  pieces_per_carton: number | null;
  availability_then: "in_warehouse" | "in_transit" | "not_listed";
  now: Availability | null;
};
export type StockRequest = {
  id: string;
  company_id: string;
  company_name: string;
  source: "team" | "share_link";
  status: RequestStatus;
  note: string | null;
  requester_name: string | null;
  created_at: string;
  created_by: string | null;
  handled_at: string | null;
  team_note: string | null;
  lines: RequestLine[];
};
export type RequestRow = {
  id: string;
  company_id: string;
  company_name: string;
  source: "team" | "share_link";
  status: RequestStatus;
  note: string | null;
  requester_name: string | null;
  line_count: number;
  items: string | null;
  created_at: string;
  created_by: string | null;
  created_by_first_name: string | null;
  handled_at: string | null;
};
export type RequestPage = { rows: RequestRow[]; next: SaleCursor };

export type LeadHold = {
  id: string;
  product_id: string;
  product_name: string;
  location: "warehouse" | "transit";
  quantity: number;
  remaining: number;
  hold_until: string;
  ended: boolean;
  deal_id: string | null;
  created_by: string;
  created_at: string;
  pieces_per_carton: number;
  price_max: number | null;
};
/**
 * An open deal of the lead, for the hold and sale pickers (list_lead_deals_for_stock). Day 5's deal schema: a deal may
 * have no title and no value yet ("not estimated", never shown as €0), its fulfilment is chosen at Win (null while
 * open: either kind of sale may use it), and its stage is the stage key (translated with Day 5's Stages words).
 */
export type LeadDealOption = {
  id: string;
  title: string | null;
  value: number | null;
  currency: string;
  expected_close: string | null;
  stage: StageKey | null;
  fulfilment: Fulfilment | null;
  held: number;
};
export type LeadStock = {
  company_id: string;
  can_edit: boolean;
  owner_first_name: string | null;
  requests: StockRequest[];
  requests_count: number;
  holds: LeadHold[];
  sales: SaleRow[];
  sales_count: number;
  bought_total: number;
  deals: LeadDealOption[];
};

export type SaleDetail = {
  id: string;
  number: number;
  company_id: string;
  company_name: string;
  deal_id: string | null;
  fulfilment: Fulfilment;
  status: SaleStatus;
  ship_to_country: string | null;
  note: string | null;
  created_at: string;
  created_by: string;
  created_by_first_name: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  can_undo: boolean;
  total: number;
  lines: {
    position: number;
    product_id: string | null;
    product_name: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    below_min: boolean;
    /** null for reps (the database hides it). */
    cost_per_piece: number | null;
  }[];
};

export type StockAlerts = {
  low: number;
  sold_out: number;
  arriving_late: number;
  requests_new: number;
  holds_ending_soon: number;
};
