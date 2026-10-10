// The shapes the stageRows server action accepts (design 3.7): Zod checks shapes only; SQL stays the authority. Must
// match the payload contract of stage_lead_import_rows(p_batch uuid, p_rows jsonb) exactly.
import { z } from "zod";
import { countryCodes } from "../countries";
import { FIX_CODES, LIMITS, PROBLEM_CODES, leadStatuses } from "./rules";
import { codePointLength, isCleanString } from "./text";

// Same rule as the browser's email check (stricter than the companies CHECK, never looser).
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;
export const PHONE_PATTERN = /^[0-9+(). /-]+$/;
export const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** True for a real calendar date and time in the canonical "YYYY-MM-DDTHH:MM:SS" form. */
export function isLocalDateTime(s: string): boolean {
  const m = LOCAL_DATETIME_PATTERN.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo) && h <= 23 && mi <= 59 && sec <= 59;
}

// Text that is free of control, zero-width and bidi characters and lone surrogates, between min and max characters
// (code points, as Postgres counts them).
function text(min: number, max: number) {
  return z
    .string()
    .refine(isCleanString, { error: "control_characters" })
    .refine((s) => {
      const n = codePointLength(s);
      return n >= min && n <= max;
    }, { error: "length" });
}

const rowNo = z.int().min(LIMITS.minRowNo).max(LIMITS.maxRowNo);

export const rejectedRowSchema = z.strictObject({
  row_no: rowNo,
  problems: z.array(z.enum(PROBLEM_CODES)).min(1).max(LIMITS.maxCodes),
});

export const stagedRowSchema = z.strictObject({
  row_no: rowNo,
  name: text(1, LIMITS.maxNameChars),
  owner_id: z.uuid().nullable(),
  lead_status: z.enum(leadStatuses),
  phone: text(1, LIMITS.maxPhoneChars).regex(PHONE_PATTERN).nullable(),
  email: text(1, LIMITS.maxEmailChars).regex(EMAIL_PATTERN).nullable(),
  city: text(1, LIMITS.maxCityChars).nullable(),
  country: z.enum(countryCodes as [string, ...string[]]).nullable(),
  last_activity: z.string().refine(isLocalDateTime, { error: "datetime" }).nullable(),
  fixes: z.array(z.enum(FIX_CODES)).max(LIMITS.maxCodes),
});

export const importRowSchema = z.union([rejectedRowSchema, stagedRowSchema]);

const utf8 = new TextEncoder();

/** UTF-8 bytes of the JSON text of a value (what one stage call carries). */
export function jsonByteLength(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).length;
}

export const importChunkSchema = z
  .array(importRowSchema)
  .min(1)
  .max(LIMITS.chunkRows)
  .superRefine((rows, ctx) => {
    const seen = new Set<number>();
    for (const row of rows) {
      if (seen.has(row.row_no)) {
        ctx.addIssue({ code: "custom", message: "duplicate_row_no" });
        return;
      }
      seen.add(row.row_no);
    }
    if (jsonByteLength(rows) > LIMITS.chunkBytes) ctx.addIssue({ code: "custom", message: "too_big" });
  });

export type RejectedRow = z.infer<typeof rejectedRowSchema>;
export type StagedRow = z.infer<typeof stagedRowSchema>;
export type ImportRow = z.infer<typeof importRowSchema>;
export type ImportChunk = z.infer<typeof importChunkSchema>;
