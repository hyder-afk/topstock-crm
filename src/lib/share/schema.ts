import { z } from "zod";

// What the two public routes accept and what they return (design 8.6). Strict objects: an unknown key is refused on the
// way in and dropped on the way out, so a database bug can never add a field (a cost, a minimum price) to the page.

const UNSAFE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/;
const UNSAFE_LINE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Text a client may type: at most `max` code points, no control or direction characters (new lines only if `lines`). */
export function cleanText(min: number, max: number, lines = false) {
  return z
    .string()
    .refine((s) => !LONE_SURROGATE.test(s), "text")
    .refine((s) => !(lines ? UNSAFE : UNSAFE_LINE).test(s), "text")
    .refine((s) => {
      const n = [...s.trim()].length;
      return n >= min && n <= max;
    }, "length");
}

export const tokenSchema = z.string().regex(/^tss_[A-Za-z0-9_-]{43}$/);

export const viewBodySchema = z.strictObject({
  token: tokenSchema,
  knownVersion: z.string().regex(/^[0-9a-f]{16}$/).optional(),
});

export const requestLineSchema = z.strictObject({
  productNumber: z.int().min(1).max(999_999_999).nullable(),
  description: cleanText(1, 200).nullable(),
  quantity: z.int().min(1).max(10_000_000),
  unit: z.enum(["piece", "carton"]),
});

export const requestBodySchema = z
  .strictObject({
    token: tokenSchema,
    lines: z.array(requestLineSchema).max(20),
    note: cleanText(0, 1000, true),
    name: cleanText(0, 80),
    idempotencyKey: z.uuid(),
    website: z.string().max(200), // the honeypot: people never see it
    t: z.int().min(0).max(86_400_000), // milliseconds since the page loaded
  })
  .refine((b) => b.lines.length > 0 || [...b.note.trim()].length >= 3, "empty")
  .refine((b) => b.lines.every((l) => (l.productNumber === null) === (l.description !== null)), "line")
  .refine((b) => b.lines.every((l) => l.productNumber !== null || l.unit === "piece"), "unit")
  .refine((b) => {
    const named = b.lines.filter((l) => l.productNumber !== null).map((l) => l.productNumber);
    return new Set(named).size === named.length;
  }, "duplicate");

export type ShareRequestBody = z.infer<typeof requestBodySchema>;

// A product on the client page, named by its number (P-0042): no internal id leaves the database.
export const shareItemSchema = z.strictObject({
  number: z.int().min(1),
  name: z.string().min(1).max(200),
  category: z.string().max(80).nullable(),
  priceMax: z.string().regex(/^\d{1,7}(\.\d{1,4})?$/).nullable(),
  piecesPerCarton: z.int().min(1),
  warehouse: z.int().min(0),
  transit: z.int().min(0),
  etaWeek: z.iso.date().nullable(),
});
export type ShareItem = z.infer<typeof shareItemSchema>;

export const shareSnapshotSchema = z.strictObject({
  status: z.literal("ok"),
  version: z.string().regex(/^[0-9a-f]{16}$/),
  language: z.enum(["en", "fr"]),
  currency: z.literal("EUR"),
  showInTransit: z.boolean(),
  allowRequests: z.boolean(),
  signature: z.string().max(60).nullable(),
  generatedAt: z.string().max(40),
  items: z.array(shareItemSchema).max(2000),
});
export type ShareSnapshot = z.infer<typeof shareSnapshotSchema>;

export const shareUnchangedSchema = z.strictObject({
  status: z.literal("ok"),
  unchanged: z.literal(true),
  version: z.string().regex(/^[0-9a-f]{16}$/),
});

export type ShareViewAnswer =
  | ShareSnapshot
  | z.infer<typeof shareUnchangedSchema>
  | { status: "inactive" | "slow_down" | "unavailable" };

export type ShareRequestAnswer =
  | { status: "received"; signature: string | null }
  | { status: "inactive" | "closed" | "invalid" | "slow_down" | "too_many_open" | "unavailable" };
