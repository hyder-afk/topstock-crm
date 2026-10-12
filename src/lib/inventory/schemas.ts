import { z } from "zod";

// Inputs of the inventory server actions (CLAUDE.md: Zod strictObject, whitelisted fields, explicit RPC arguments). The
// database re-checks every rule with a constant message; these only refuse what can never be right before a call.

const SAFE_TEXT = /^[^\u0001-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]*$/;
const safe = (max: number) => z.string().max(max).regex(SAFE_TEXT);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(SAFE_TEXT)
    .transform((s) => (s === "" ? null : s))
    .nullable();
// At most `n` decimals, read from the number's own shortest text (multipleOf with floats is not exact).
export function decimals(v: number, n: number) {
  const s = String(v);
  if (s.includes("e")) return false;
  const i = s.indexOf(".");
  return i < 0 || s.length - i - 1 <= n;
}
const price = z
  .number()
  .min(0)
  .max(1_000_000)
  .refine((v) => decimals(v, 4))
  .nullable();
export const costInput = z
  .number()
  .min(0)
  .max(1_000_000)
  .refine((v) => decimals(v, 6));
const isoDate = z.iso.date();

export const productInput = z
  .strictObject({
    name: z.string().trim().min(1).max(200).regex(SAFE_TEXT),
    category: optionalText(80),
    piecesPerCarton: z.int().min(1).max(1_000_000),
    cartonsPerPallet: z.int().min(1).max(10_000).nullable(),
    reorderPoint: z.int().min(0).max(50_000_000).nullable(),
    priceMin: price,
    priceMax: price,
    transitEta: isoDate.nullable(),
    shareVisible: z.boolean(),
  })
  .refine((v) => v.priceMin === null || v.priceMax === null || v.priceMin <= v.priceMax, { path: ["priceMin"] });
export type ProductInput = z.infer<typeof productInput>;

export const newProductInput = z.strictObject({
  product: productInput,
  costPerPiece: costInput.nullable(),
  openingQty: z.int().min(0).max(50_000_000).nullable(),
  openingPlace: z.enum(["warehouse", "transit"]),
  requestId: z.uuid(),
});

export const CORRECTION_REASONS = ["count", "damaged", "lost", "found", "sample", "correction", "other"] as const;
export const RECEIVE_REASONS = ["received", "found", "correction", "other"] as const;

// "Correct stock" (design 6.5): set the counted quantity, add or remove, at one place, with a reason (a note for Other).
export const correctionInput = z
  .strictObject({
    productId: z.uuid(),
    mode: z.enum(["set", "add", "remove"]),
    place: z.enum(["warehouse", "transit"]),
    pieces: z.int().min(0).max(50_000_000),
    reason: z.enum(CORRECTION_REASONS),
    note: optionalText(500),
    requestId: z.uuid(),
  })
  .refine((v) => v.mode === "set" || v.pieces >= 1, { path: ["pieces"] })
  .refine((v) => v.mode !== "set" || v.reason === "count", { path: ["reason"] })
  .refine((v) => v.reason !== "other" || !!v.note, { path: ["note"] });

export const receiveInput = z
  .strictObject({
    productId: z.uuid(),
    place: z.enum(["warehouse", "transit"]),
    pieces: z.int().min(1).max(50_000_000),
    reason: z.enum(RECEIVE_REASONS),
    note: optionalText(500),
    requestId: z.uuid(),
  })
  .refine((v) => v.reason !== "other" || !!v.note, { path: ["note"] });

export const arrivedInput = z.strictObject({
  productId: z.uuid(),
  pieces: z.int().min(1).max(50_000_000),
  note: optionalText(500),
  requestId: z.uuid(),
});

export const releaseInput = z.strictObject({
  productId: z.uuid(),
  reservationId: z.uuid(),
  pieces: z.int().min(1).max(50_000_000).nullable(),
  requestId: z.uuid(),
});

// A hold (design 6.3): for a lead, and for one of its open from-stock deals when there is one; warehouse or transit.
export const reserveInput = z.strictObject({
  productId: z.uuid(),
  companyId: z.uuid(),
  dealId: z.uuid().nullable(),
  place: z.enum(["warehouse", "transit"]),
  pieces: z.int().min(1).max(50_000_000),
  holdUntil: isoDate.nullable(),
  note: optionalText(300),
  requestId: z.uuid(),
});

export const etaInput = z.strictObject({ productId: z.uuid(), eta: isoDate.nullable() });
export const visibilityInput = z.strictObject({ productId: z.uuid(), visible: z.boolean() });

export const settingsInput = z.strictObject({
  alertAssignee: z.uuid().nullable(),
  holdDays: z.int().min(1).max(90),
});
export const locationNameInput = z.strictObject({
  kind: z.enum(["warehouse", "transit"]),
  name: safe(80).trim().min(1),
});
