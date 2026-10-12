// Inputs of the Day 6d actions (Zod strictObject): shapes only; the database decides (design 6.1, 6.6, 6.9).
import { z } from "zod";

const uuid = z.uuid();
const safe = /^[^\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]*$/;
const safeLines = /^[^\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]*$/;

export const saleLineSchema = z.strictObject({
  product_id: uuid.nullable(),
  description: z.string().trim().min(1).max(200).regex(safe).nullable(),
  quantity: z.int().min(1).max(50_000_000),
  unit_price: z.string().regex(/^[0-9]{1,7}(\.[0-9]{1,4})?$/),
});

export const recordSaleSchema = z.strictObject({
  companyId: uuid,
  fulfilment: z.enum(["from_stock", "direct_from_source"]),
  lines: z.array(saleLineSchema).min(1).max(50),
  dealId: uuid.nullable(),
  note: z.string().trim().max(1000).regex(safeLines).nullable(),
  shipToCountry: z.string().regex(/^[A-Z]{2}$/).nullable(),
  stockRequestId: uuid.nullable(),
  allowBelowMin: z.boolean(),
  requestId: uuid,
});
export type RecordSaleInput = z.infer<typeof recordSaleSchema>;

export const requestLineSchema = z.strictObject({
  product_id: uuid.nullable(),
  description: z.string().trim().min(1).max(200).regex(safe).nullable(),
  quantity: z.int().min(1).max(10_000_000),
  unit: z.enum(["piece", "carton"]),
});
export const logRequestSchema = z.strictObject({
  companyId: uuid,
  lines: z.array(requestLineSchema).min(1).max(20),
  note: z.string().trim().max(1000).regex(safeLines).nullable(),
  requestId: uuid,
});

export const cancelSaleSchema = z.strictObject({ orderId: uuid, reason: z.string().trim().min(3).max(300).regex(safe) });
export const extendHoldSchema = z.strictObject({ reservationId: uuid, holdUntil: z.iso.date() });
export const requestStatusSchema = z.strictObject({
  requestId: uuid,
  status: z.enum(["new", "in_progress", "done", "declined"]),
  teamNote: z.string().trim().max(300).regex(safe).nullable(),
});

export const saleListParams = z.strictObject({
  company: uuid.optional(),
  fulfilment: z.enum(["from_stock", "direct_from_source"]).optional(),
  before_created: z.iso.datetime({ offset: true }).optional(),
  before_id: uuid.optional(),
});
export const requestListParams = z.strictObject({
  status: z.enum(["open", "new", "in_progress", "done", "declined", "all"]).optional(),
  before_created: z.iso.datetime({ offset: true }).optional(),
  before_id: uuid.optional(),
});
