"use server";

import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { stockError, stockInvalid, type StockResult } from "@/lib/inventory/errors";
import {
  arrivedInput,
  costInput,
  correctionInput,
  etaInput,
  newProductInput,
  productInput,
  receiveInput,
  releaseInput,
  reserveInput,
  visibilityInput,
} from "@/lib/inventory/schemas";
import type { LevelsAfter } from "@/lib/inventory/types";

// Inventory changes (design 5: z.strictObject, then requireSession, then ONE RPC, then { ok, data } or a code). Stock
// changes only through post_stock_movement (CLAUDE.md); the database checks who may do what, the fresh code (step-up)
// and every rule under the lock, and answers with a constant hint that stockError() turns into a screen code.

type MovementAnswer = { group_id: string; unchanged: boolean; levels: LevelsAfter; moved?: number; held_moved?: number };

export async function createProduct(input: unknown): Promise<StockResult<{ id: string }>> {
  const parsed = newProductInput.safeParse(input);
  if (!parsed.success) return stockInvalid();
  const { product: p, costPerPiece, openingQty, openingPlace, requestId } = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("create_product", {
    p_name: p.name,
    p_pieces_per_carton: p.piecesPerCarton,
    p_price_min: p.priceMin,
    p_price_max: p.priceMax,
    p_category: p.category,
    p_cartons_per_pallet: p.cartonsPerPallet,
    p_reorder_point: p.reorderPoint,
    p_transit_eta: p.transitEta,
    p_share_visible: p.shareVisible,
    p_cost_per_piece: costPerPiece,
    p_opening_qty: openingQty,
    p_opening_location: openingPlace,
    p_request_id: requestId,
  });
  if (error) return stockError(error);
  return { ok: true, data: { id: data as string } };
}

export async function updateProduct(id: unknown, input: unknown, cost?: unknown): Promise<StockResult<null>> {
  const productId = z.uuid().safeParse(id);
  const parsed = productInput.safeParse(input);
  const parsedCost = costInput.nullable().optional().safeParse(cost);
  if (!productId.success || !parsed.success || !parsedCost.success) return stockInvalid();
  const p = parsed.data;
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("update_product", {
    p_id: productId.data,
    p_name: p.name,
    p_pieces_per_carton: p.piecesPerCarton,
    p_price_min: p.priceMin,
    p_price_max: p.priceMax,
    p_category: p.category,
    p_cartons_per_pallet: p.cartonsPerPallet,
    p_reorder_point: p.reorderPoint,
    p_transit_eta: p.transitEta,
    p_share_visible: p.shareVisible,
  });
  if (error) return stockError(error);
  // A cost given with the edit (managers and admins see the field): its own RPC, after the product saved.
  if (typeof parsedCost.data === "number") {
    const res = await supabase.rpc("set_product_cost", { p_id: productId.data, p_cost: parsedCost.data });
    if (res.error) return stockError(res.error);
  }
  return { ok: true, data: null };
}

export async function archiveProduct(id: unknown): Promise<StockResult<null>> {
  const productId = z.uuid().safeParse(id);
  if (!productId.success) return stockInvalid();
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("archive_product", { p_id: productId.data });
  return error ? stockError(error) : { ok: true, data: null };
}

export async function restoreProduct(id: unknown): Promise<StockResult<null>> {
  const productId = z.uuid().safeParse(id);
  if (!productId.success) return stockInvalid();
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("restore_product", { p_id: productId.data });
  return error ? stockError(error) : { ok: true, data: null };
}

// Correct stock (design 6.5): "Set counted quantity" is a count (worked out under the lock), Add and Remove are
// adjustments. Fresh code; managers and admins.
export async function correctStock(input: unknown): Promise<StockResult<MovementAnswer>> {
  const parsed = correctionInput.safeParse(input);
  if (!parsed.success) return stockInvalid();
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("post_stock_movement", {
    p_product: v.productId,
    p_kind: v.mode === "set" ? "count" : v.mode === "add" ? "adjust_in" : "adjust_out",
    p_qty: v.mode === "set" ? null : v.pieces,
    p_target: v.mode === "set" ? v.pieces : null,
    p_location: v.place,
    p_reason: v.reason,
    p_note: v.note,
    p_request_id: v.requestId,
  });
  if (error) return stockError(error);
  return { ok: true, data: data as MovementAnswer };
}

export async function receiveStock(input: unknown): Promise<StockResult<MovementAnswer>> {
  const parsed = receiveInput.safeParse(input);
  if (!parsed.success) return stockInvalid();
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("post_stock_movement", {
    p_product: v.productId,
    p_kind: "receive",
    p_qty: v.pieces,
    p_location: v.place,
    p_reason: v.reason,
    p_note: v.note,
    p_request_id: v.requestId,
  });
  if (error) return stockError(error);
  return { ok: true, data: data as MovementAnswer };
}

// Arrived (design 6.4): transit to the warehouse; holds on the arriving stock move with it. Managers and admins; no code.
export async function markArrived(input: unknown): Promise<StockResult<MovementAnswer>> {
  const parsed = arrivedInput.safeParse(input);
  if (!parsed.success) return stockInvalid();
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("post_stock_movement", {
    p_product: v.productId,
    p_kind: "transfer",
    p_qty: v.pieces,
    p_note: v.note,
    p_request_id: v.requestId,
  });
  if (error) return stockError(error);
  return { ok: true, data: data as MovementAnswer };
}

// Release a hold, whole (pieces null) or in part. The hold's creator or an editor of its lead; no code.
export async function releaseHold(input: unknown): Promise<StockResult<MovementAnswer>> {
  const parsed = releaseInput.safeParse(input);
  if (!parsed.success) return stockInvalid();
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("post_stock_movement", {
    p_product: v.productId,
    p_kind: "release",
    p_qty: v.pieces,
    p_reservation: v.reservationId,
    p_request_id: v.requestId,
  });
  if (error) return stockError(error);
  return { ok: true, data: data as MovementAnswer };
}

// Hold stock for a lead (and a deal). Whoever may change the lead; no code. Also the Undo of a release.
export async function reserveStock(input: unknown): Promise<StockResult<MovementAnswer & { reservation_id: string }>> {
  const parsed = reserveInput.safeParse(input);
  if (!parsed.success) return stockInvalid();
  const v = parsed.data;
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("post_stock_movement", {
    p_product: v.productId,
    p_kind: "reserve",
    p_qty: v.pieces,
    p_location: v.place,
    p_company: v.companyId,
    p_deal: v.dealId,
    p_hold_until: v.holdUntil,
    p_note: v.note,
    p_request_id: v.requestId,
  });
  if (error) return stockError(error);
  return { ok: true, data: data as MovementAnswer & { reservation_id: string } };
}

export async function setProductEta(input: unknown): Promise<StockResult<null>> {
  const parsed = etaInput.safeParse(input);
  if (!parsed.success) return stockInvalid("eta");
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("set_product_eta", { p_id: parsed.data.productId, p_eta: parsed.data.eta });
  return error ? stockError(error) : { ok: true, data: null };
}

export async function setProductVisibility(input: unknown): Promise<StockResult<null>> {
  const parsed = visibilityInput.safeParse(input);
  if (!parsed.success) return stockInvalid();
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("set_product_share_visible", { p_id: parsed.data.productId, p_visible: parsed.data.visible });
  return error ? stockError(error) : { ok: true, data: null };
}
