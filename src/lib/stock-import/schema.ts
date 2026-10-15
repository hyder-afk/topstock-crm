// The shapes the stock import server actions accept (design 7.4): Zod checks shapes only; SQL stays the authority.
// Decimals travel as canonical text in exactly the forms stage_stock_import_rows pre-checks.
import { z } from "zod";
import { codePointLength, isCleanString } from "../import/text";
import { LOCATION_KINDS, STOCK_FIX_CODES, STOCK_LIMITS, STOCK_PROBLEM_CODES } from "./rules";

export const WHOLE_PATTERN = /^[0-9]{1,9}$/;
export const PRICE_PATTERN = /^[0-9]{1,8}(\.[0-9]{1,4})?$/;
export const COST_PATTERN = /^[0-9]{1,13}(\.[0-9]{1,4})?$/;

const rowNo = z.int().min(STOCK_LIMITS.minRowNo).max(STOCK_LIMITS.maxRowNo);
const name = z
  .string()
  .refine(isCleanString, { error: "control_characters" })
  .refine((s) => s.trim() === s && codePointLength(s) >= 1 && codePointLength(s) <= STOCK_LIMITS.maxNameChars, { error: "length" });

export const rejectedStockRowSchema = z.strictObject({
  row_no: rowNo,
  problems: z.array(z.enum(STOCK_PROBLEM_CODES)).min(1).max(STOCK_LIMITS.maxCodes),
});

export const stagedStockRowSchema = z.strictObject({
  row_no: rowNo,
  name,
  location_kind: z.enum(LOCATION_KINDS),
  quantity: z.string().regex(WHOLE_PATTERN),
  pieces_per_carton: z.string().regex(WHOLE_PATTERN).nullable(),
  price_min: z.string().regex(PRICE_PATTERN).nullable(),
  price_max: z.string().regex(PRICE_PATTERN).nullable(),
  total_cost: z.string().regex(COST_PATTERN).nullable(),
  fixes: z.array(z.enum(STOCK_FIX_CODES)).max(STOCK_LIMITS.maxCodes),
});

export const stockRowSchema = z.union([rejectedStockRowSchema, stagedStockRowSchema]);

const utf8 = new TextEncoder();

export const stockChunkSchema = z
  .array(stockRowSchema)
  .min(1)
  .max(STOCK_LIMITS.chunkRows)
  .superRefine((rows, ctx) => {
    const seen = new Set<number>();
    for (const row of rows) {
      if (seen.has(row.row_no)) {
        ctx.addIssue({ code: "custom", message: "duplicate_row_no" });
        return;
      }
      seen.add(row.row_no);
    }
    if (utf8.encode(JSON.stringify(rows)).length > STOCK_LIMITS.chunkBytes) ctx.addIssue({ code: "custom", message: "too_big" });
  });

export type RejectedStockRow = z.infer<typeof rejectedStockRowSchema>;
export type StagedStockRow = z.infer<typeof stagedStockRowSchema>;
export type StockRow = z.infer<typeof stockRowSchema>;
