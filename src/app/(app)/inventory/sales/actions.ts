"use server";

import { requireSession } from "@/lib/auth";
import { stockError, stockInvalid, type StockResult } from "@/lib/inventory/errors";
import {
  cancelSaleSchema,
  extendHoldSchema,
  logRequestSchema,
  recordSaleSchema,
  requestStatusSchema,
} from "@/lib/sales/schemas";
import type { SaleResult } from "@/lib/sales/types";
import { z } from "zod";

// Day 6d changes (design 6.1 to 6.9): z.strictObject, the aal2 session, ONE RPC with explicit arguments, then
// { ok, data } or a code. The database decides who may sell, the minimum price, the holds used and the stock.

export async function recordSale(input: unknown): Promise<StockResult<SaleResult>> {
  const parsed = recordSaleSchema.safeParse(input);
  if (!parsed.success) return stockInvalid("lines");
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("record_sale", {
    p_company: v.companyId,
    p_fulfilment: v.fulfilment,
    p_lines: v.lines.map((l) => ({
      product_id: l.product_id,
      description: l.description,
      quantity: String(l.quantity),
      unit_price: l.unit_price,
    })),
    p_deal: v.dealId,
    p_note: v.note,
    p_ship_to_country: v.shipToCountry,
    p_stock_request: v.stockRequestId,
    p_allow_below_min: v.allowBelowMin,
    p_request_id: v.requestId,
  });
  if (error) return stockError(error);
  return { ok: true, data: data as SaleResult };
}

export async function undoSale(orderId: unknown): Promise<StockResult<{ holds_restored: number }>> {
  const id = z.uuid().safeParse(orderId);
  if (!id.success) return stockInvalid();
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("undo_sale", { p_order: id.data });
  if (error) return stockError(error);
  return { ok: true, data: { holds_restored: Number((data as { holds_restored: number }).holds_restored) } };
}

export async function cancelSale(input: unknown): Promise<StockResult<null>> {
  const parsed = cancelSaleSchema.safeParse(input);
  if (!parsed.success) return stockInvalid("cancel_reason");
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("cancel_sale", { p_order: parsed.data.orderId, p_reason: parsed.data.reason });
  if (error) return stockError(error);
  return { ok: true, data: null };
}

export async function extendHold(input: unknown): Promise<StockResult<{ hold_until: string }>> {
  const parsed = extendHoldSchema.safeParse(input);
  if (!parsed.success) return stockInvalid("hold_until");
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("extend_reservation", {
    p_id: parsed.data.reservationId,
    p_hold_until: parsed.data.holdUntil,
  });
  if (error) return stockError(error);
  return { ok: true, data: { hold_until: (data as { hold_until: string }).hold_until } };
}

export async function logStockRequest(input: unknown): Promise<StockResult<{ request_id: string }>> {
  const parsed = logRequestSchema.safeParse(input);
  if (!parsed.success) return stockInvalid("lines");
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("log_stock_request", {
    p_company: v.companyId,
    p_lines: v.lines.map((l) => ({
      product_id: l.product_id,
      description: l.description,
      quantity: String(l.quantity),
      unit: l.unit,
    })),
    p_note: v.note,
    p_request_id: v.requestId,
  });
  if (error) return stockError(error);
  return { ok: true, data: data as { request_id: string } };
}

export async function setRequestStatus(input: unknown): Promise<StockResult<null>> {
  const parsed = requestStatusSchema.safeParse(input);
  if (!parsed.success) return stockInvalid("request_status");
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("set_stock_request_status", {
    p_id: parsed.data.requestId,
    p_status: parsed.data.status,
    p_team_note: parsed.data.teamNote,
  });
  if (error) return stockError(error);
  return { ok: true, data: null };
}
