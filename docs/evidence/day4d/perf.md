# Day 4d speed: P11 (begin and finish an upload)

Design 8.6, row P11: `begin_file_upload` / `finish_file_upload` with stand-in objects and 5,000 files, each at most
10 ms of database time.

## Method

- `supabase/tests/perf_files.sql`, added to `scripts/db-perf.sh` (after the Day 3b import cases). The three runs below
  used a copy of `db-perf.sh` on this workflow's port (54371) that runs only the auth and storage shims, the
  migrations, `perf_leads.sql` (30,015 leads) and `perf_files.sql`, so each run took a few minutes instead of the full
  suite. Throwaway PostgreSQL 16, local only.
- Seed: 5,000 ready files with their objects in the storage stand-in (`supabase/tests/storage_shim.sql`, which has the
  real schema's unique `(bucket_id, name)` index and C-collated `name`): 1,000 on one lead, 4,000 over 400 leads;
  inserted with triggers off, then `vacuum analyze`.
- One round, as a signed-in rep with row level security on: `begin_file_upload` on the busiest lead (stale clean-up,
  pre-checks, the insert guard's waiting and hourly counts, the advisory lock and the team-space sum over the 5,000
  objects), the object insert (not timed), `finish_file_upload` (the update guard's object match). Each round rolls
  back, so the hourly limit and the space never fill.
- 10 rounds to settle the plans, then the average of 5. Round 6 runs with `auto_explain` (every inner statement's plan
  logged: the generic-plan check).

## Results (12 Oct 2026, head faa0019 and later; the functions timed are unchanged since)

| Run | `begin_file_upload` | `finish_file_upload` | Budget |
|---|---|---|---|
| 1 | 7.31 ms | 3.23 ms | 10 ms each |
| 2 | 7.90 ms | 3.45 ms | 10 ms each |
| 3 | 7.53 ms | 3.29 ms | 10 ms each |

All within budget.

## What changed to get there

The first measurement (three runs) was **22.0 to 29.2 ms** for `begin_file_upload` (finish 3.5 to 4.7 ms). The plans
showed the team-space sum (`private.org_storage_bytes`) reading 5,000 objects through `private.object_size()`, a SQL
function with a `SET search_path` clause, which PostgreSQL never inlines: one function call and one regular
expression per object (125 ms under `auto_explain`'s timing). Two changes:

1. The metadata key names moved into two argument-less immutable functions (`private.object_size_key()`,
   `private.object_mime_key()`), which the planner folds into constants. They are still the only place the key names
   live (spike S4: one place to change).
2. The sum reads the size typed (`jsonb_typeof(...) = 'number'`, then a numeric cast) instead of a text match per row.

Then 10.9 ms (key functions only), then 7.3 to 7.9 ms (both). Remaining cost of `begin`, from the round-6 plans: the
space sum (an index range scan on `(bucket_id, name)` over the organisation's folder, about 5 ms under `auto_explain`'s
own timing), the insert with its triggers and audit row, the stale-upload update, and the waiting and hourly counts
(index scans, under 0.1 ms each).

## Plans (round 6)

- Space sum: `Index Scan using bucketid_objname on objects` with `Index Cond: bucket_id = 'lead-files' AND name >=
  '<org>/' AND name < '<org>0'` (the C collation keeps the range usable).
- Hourly count: `audit_log_org_created_idx` range on `(org_id, created_at)`, filtered on table, action and actor. With
  a large import in the same hour this scans that hour's audit rows; 1.1 ms after the 30,015-lead seed. Logged as a
  watch item (a partial index on file inserts is the fix if it grows).
- `finish_file_upload`: the update by primary key; the guard's object lookup is an index probe on
  `(bucket_id, name)`, with the bucket's select policy evaluated as a hashed subplan over the caller's visible files
  (about 1 ms at 5,000 files).
- Round 6 is the first execution that may use a generic plan (after 5 custom ones); its plans are the index scans above,
  so no function here needs `plan_cache_mode = force_custom_plan`.
