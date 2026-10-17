import { z } from "zod";
import { lostReasons, openStageKeys } from "@/lib/deals";
import { DAY_BUCKET_MAX_DAYS, MAX_WEEK_BUCKETS, MIN_HEAT_CALLS, idleOptions, speedBuckets } from "@/lib/analytics/params";

// What each Analytics function answers (design 3.3 and 3.5), parsed on the server with strictObject at every level: an
// unknown key (a cost column, say) fails that block instead of reaching the browser, and so does a negative count, an
// over-long list, a malformed sum or an unknown stage or reason. A block that fails its parse shows its own error; the
// rest of the page stands (Part<T>, as Home).

const count = z.number().int().nonnegative();
/** Sums as the database writes them: numeric(16,2) as text (Home's `total`). */
export const TOTAL_PATTERN = /^\d{1,16}(\.\d{1,2})?$/;
const total = z.string().regex(TOTAL_PATTERN);
const isoDate = z.iso.date();
const instant = z.iso.datetime({ offset: true });
const rate = z.number().min(0).max(1).nullable();
const days = z.number().nonnegative().nullable();
/** Person rows: the team is a handful of people; the cap only bounds a broken answer. */
export const MAX_PEOPLE = 100;
const userId = z.uuid().nullable();
const bucketKind = z.enum(["day", "week"]);

/** A list of buckets fits its size: at most 31 days, or 54 weeks (design 3.5: a 366-day range can touch 54 ISO weeks). */
function bucketCap(part: { bucket: "day" | "week"; buckets: unknown[] }, ctx: z.RefinementCtx) {
  const max = part.bucket === "day" ? DAY_BUCKET_MAX_DAYS : MAX_WEEK_BUCKETS;
  if (part.buckets.length > max) ctx.addIssue({ code: "custom", message: `more than ${max} buckets`, input: part.buckets.length });
}

const activityCounts = { calls: count, reached: count, emails: count, whatsapp: count, meetings: count };
export const activityPart = z
  .strictObject({
    scope: z.enum(["team", "person"]),
    owner_id: userId,
    bucket: bucketKind,
    buckets: z.array(z.strictObject({ start: isoDate, partial: z.boolean(), ...activityCounts })).max(MAX_WEEK_BUCKETS),
    totals: z.strictObject({ ...activityCounts, meetings_held: count }),
    by_person: z.array(z.strictObject({ user_id: userId, ...activityCounts })).max(MAX_PEOPLE).optional(),
  })
  .superRefine((p, ctx) => {
    bucketCap(p, ctx);
    // The team view carries one row per person; a person's view never does (C2: no colleague rows).
    const team = p.scope === "team";
    if (team !== (p.owner_id === null) || team !== (p.by_person !== undefined)) {
      ctx.addIssue({ code: "custom", message: "scope, owner and by_person disagree", input: p.scope });
    }
  });
export type ActivityPart = z.infer<typeof activityPart>;

export const pipelinePart = z.strictObject({
  opened: z.strictObject({ count, value: total, no_value: count }),
  won: z.strictObject({ count, value: total }),
  lost: z.strictObject({ count, mistake: count }),
  win_rate: z.strictObject({ won: count, lost: count, rate }),
  cycle: z.strictObject({ n: count, median_days: days, mean_days: days }),
  funnel: z.strictObject({
    cohort: count,
    lead: count,
    qualified: count,
    negotiations: count,
    won: count,
    still_open: count,
    lost: count,
    mistake: count,
  }),
  stage_days: z.array(z.strictObject({ key: z.enum(openStageKeys), n: count, median_days: days })).max(openStageKeys.length),
  lost_reasons: z.array(z.strictObject({ code: z.enum(lostReasons), count })).max(lostReasons.length),
  by_person: z
    .array(z.strictObject({ user_id: userId, opened: count, won: count, won_value: total, lost: count, rate }))
    .max(MAX_PEOPLE)
    .optional(),
});
export type PipelinePart = z.infer<typeof pipelinePart>;

export const speedPart = z.strictObject({
  leads: count,
  touched: count,
  median_minutes: count.nullable(),
  within_1h: count,
  within_24h: count,
  buckets: z.array(z.strictObject({ key: z.enum(speedBuckets), count })).length(speedBuckets.length),
});
export type SpeedPart = z.infer<typeof speedPart>;

export const callTimesPart = z.strictObject({
  min_calls: z.literal(MIN_HEAT_CALLS),
  cells: z
    .array(
      z.strictObject({
        dow: z.number().int().min(1).max(7),
        hour: z.number().int().min(0).max(23),
        calls: z.number().int().positive(),
        reached: count,
      }),
    )
    .max(7 * 24),
});
export type CallTimesPart = z.infer<typeof callTimesPart>;

export const salesPart = z
  .strictObject({
    bucket: bucketKind,
    buckets: z.array(z.strictObject({ start: isoDate, partial: z.boolean(), revenue: total, sales: count })).max(MAX_WEEK_BUCKETS),
    totals: z.strictObject({ revenue: total, sales: count, from_stock: total, direct: total }),
    top_products: z.array(z.strictObject({ name: z.string().min(1).max(200), revenue: total, pieces: count })).max(10),
  })
  .superRefine(bucketCap);
export type SalesPart = z.infer<typeof salesPart>;

export const coveragePart = z.strictObject({
  idle_days: z.number().refine((n) => (idleOptions as readonly number[]).includes(n)),
  untouched: count,
  never_contacted: count,
  no_next_step: count,
  overdue_tasks: count,
  as_of: instant,
});
export type CoveragePart = z.infer<typeof coveragePart>;

/** List quality: at most 50 imports (analytics_batches' p_limit). The file name is untrusted text, shown as React text. */
export const MAX_BATCHES = 50;
export const DEFAULT_BATCHES = 20;
export const batchesPart = z
  .array(
    z.strictObject({
      id: z.uuid(),
      filename: z.string().min(1).max(255),
      created_at: instant,
      leads: count,
      contacted: count,
      reached: count,
      with_deal: count,
      won: count,
    }),
  )
  .max(MAX_BATCHES);
export type BatchesPart = z.infer<typeof batchesPart>;
