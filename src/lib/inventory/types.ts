// Shapes of what the inventory RPCs return (migration 20261017090000_inventory_reads.sql). Pieces only (Haider, 11 Oct
// 2026); prices are EUR per piece excluding VAT. A rep reads null costs.

export const STOCK_STATUSES = ["in_stock", "low", "arriving", "sold_out", "archived"] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];
export type Place = "warehouse" | "transit";

export type StockRow = {
  id: string;
  number: number;
  name: string;
  category: string | null;
  pieces_per_carton: number;
  cartons_per_pallet: number | null;
  wh_on_hand: number;
  wh_reserved: number;
  wh_available: number;
  tr_on_hand: number;
  tr_reserved: number;
  tr_available: number;
  transit_eta: string | null;
  price_min: number | null;
  price_max: number | null;
  reorder_point: number | null;
  status_key: StockStatus;
  share_visible: boolean;
  archived: boolean;
  cost_per_piece: number | null;
  touched_at: string;
  sort_value: string;
};

export type StockCursor = { after_value: string; after_id: string } | null;
export type StockPage = { rows: StockRow[]; next: StockCursor; total: number | null };

export type StockSummary = {
  products: number;
  wh_pieces: number;
  wh_available: number;
  tr_pieces: number;
  held_pieces: number;
  low: number;
  sold_out: number;
  arriving: number;
  held: number;
  hidden: number;
  archived: number;
  categories: string[];
};

export type ProductHold = {
  id: string;
  location: Place;
  company_id: string;
  company_name: string | null;
  deal_id: string | null;
  quantity: number;
  remaining: number;
  hold_until: string;
  ended: boolean;
  note: string | null;
  created_by: string;
  created_by_first_name: string | null;
  created_by_last_name: string | null;
  created_at: string;
};

export const MOVEMENT_KINDS = [
  "receive",
  "adjust_in",
  "adjust_out",
  "transfer_out",
  "transfer_in",
  "reserve",
  "release",
  "expire",
  "ship",
  "return",
  "import_in",
  "import_out",
  "undo_in",
  "undo_out",
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export type Movement = {
  id: number;
  group_id: string;
  kind: MovementKind;
  product_id: string;
  product_name?: string;
  product_number?: number;
  location: Place;
  qty: number | null;
  d_on_hand: number;
  d_reserved: number;
  on_hand_after: number;
  reserved_after: number;
  reason: string | null;
  note: string | null;
  company_id: string | null;
  company_name: string | null;
  user_id: string | null;
  user_first_name: string | null;
  user_last_name: string | null;
  created_at: string;
  pair_id: number | null;
  import_batch_id: string | null;
};
export type MovementPage = { rows: Movement[]; next: number | null };

export type ProductDetail = Omit<StockRow, "archived" | "sort_value" | "status_key"> & {
  archived: boolean;
  status_key: StockStatus;
  created_at: string;
  holds: ProductHold[];
  movements: Movement[];
};

export type Reservation = {
  id: string;
  product_id: string;
  product_name: string;
  product_number: number;
  pieces_per_carton: number;
  location: Place;
  company_id: string;
  company_name: string | null;
  deal_id: string | null;
  quantity: number;
  remaining: number;
  status: "active" | "released" | "fulfilled" | "expired";
  hold_until: string;
  ended: boolean;
  note: string | null;
  created_by: string;
  created_by_first_name: string | null;
  created_by_last_name: string | null;
  created_at: string;
  closed_at: string | null;
  close_reason: string | null;
};
export type ReservationCursor = { before_created: string; before_id: string } | null;
export type ReservationPage = { rows: Reservation[]; next: ReservationCursor };

export type InventorySettings = {
  hold_days: number;
  alert_assignee_id: string | null;
  warehouse_name: string;
  transit_name: string;
  can_edit: boolean;
};

/** The levels a stock RPC returns after a change (post_stock_movement). */
export type LevelsAfter = { location: Place; on_hand: number; reserved: number; available: number }[];
