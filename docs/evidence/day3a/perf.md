# Leads list speed at 30k leads: Day 3a, 10 Oct 2026

The advisor asked for proof that the leads list stays fast at Release 1 size (Master Plan: 30k leads). The proof is
`bash scripts/db-perf.sh`, which anyone can re-run. It starts a throwaway PostgreSQL 16 (16.15), adds the same auth shim
the security tests use, applies every migration, and loads 30,000 made-up companies and 10,000 made-up contacts
(`supabase/tests/perf_leads.sql`). It then calls `list_leads` and `count_leads` as a signed-in rep with two-factor,
so row level security is on, exactly as the app calls them. Machine: this cloud session, 4 vCPU Xeon 2.8 GHz.

## Timings (average of 5 warm runs, inside the database)

| Case | Before (first version) | Now |
|---|---|---|
| First page, last activity (the default) | 1.2 ms | 1.1 ms |
| First page, A to Z | 1.1 ms | 1.1 ms |
| First page, newest first | 1.0 ms | 1.1 ms |
| Page 200 (row 10,000), keyset | 10.9 ms | 11.0 ms |
| Total count, no filter | 5.1 ms | 2.5 ms |
| Status + country filter: list / count | 14.7 / 1.9 ms | 13.9 / 1.6 ms |
| No activity for 30 days, list | 2.0 ms | 1.9 ms |
| Search "verdane" (3,000 matches): list / count | 1.3 / 91.0 ms | 15.2 / 12.0 ms |
| Search for a contact's name ("benali4"), list | 110.2 ms | 1.1 ms |
| Search with no match: list / count | 102.0 / 112.3 ms | 1.0 / 0.6 ms |
| Search of 2 letters ("ly", too short for the trigram index): list / count | not measured | 87.8 / 76.8 ms |
| City filter "lyon", list | not measured | 24.5 ms |

Against the plan's budget of 200 ms for a route change, the slowest case is a 2-letter search at about 90 ms. That leaves
about 2x headroom for Supabase's smaller servers and the network hop. Typing a third letter brings it back to the index
(the search box waits until typing pauses, so each pause runs one search).

## What changed after the first measurement

The first version searched with `ILIKE` straight in the list query, and every search read all 30,000 leads (about
100 ms). The reason: row level security runs its own checks before any condition that is not "leakproof", and `ILIKE`
is not, so PostgreSQL may not use the trigram index for it under RLS. Now:

- One trigram index per table covers every searched field: `companies_search_trgm_idx` (name, email, phone and city) and
  `contacts_search_trgm_idx` (full name, email and phone). It replaces the three single-field ones.
- The search runs in `private.search_lead_ids(pattern)`, which runs as its owner so the indexes can work. It applies the
  same rule as the read policies itself (the caller's organisation, with two-factor). It returns lead ids only, and the
  list and count still read the leads under row level security. It sits in the private schema, which the API cannot
  reach. `supabase/tests/rls_attack.sql` checks it: anon cannot call it, it returns nothing without two-factor, and it
  never returns another organisation's lead.
- The list matches those ids with `c.id = any (array(...))`, which reads them through the primary key (plans below).

## Query plans (auto_explain, actual run)

The three sort orders each read their own keyset index and stop after 51 rows (`Limit`, `rows=51`), never sorting the
whole table. A search reads the two trigram indexes, then fetches only the matching leads by primary key.

### 1. first page, last activity (default): list_leads statement, 1.4 ms

Parameters: `$1 = NULL, $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=1.61..464.89 rows=51 width=240) (actual time=0.740..1.352 rows=51 loops=1)
  ->  Nested Loop Left Join  (cost=0.57..136259.31 rows=15000 width=240) (actual time=0.739..1.343 rows=51 loops=1)
        ->  Index Scan using companies_activity_keyset_idx on companies c  (cost=0.41..3208.97 rows=15000 width=132) (actual time=0.357..0.440 rows=51 loops=1)
              Index Cond: (org_id = $4)
              Filter: $3
        ->  Memoize  (cost=0.16..0.18 rows=1 width=80) (actual time=0.007..0.007 rows=0 loops=51)
              Cache Key: c.owner_id
              Cache Mode: logical
              Hits: 49  Misses: 2  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              ->  Index Scan using profiles_pkey on profiles o  (cost=0.15..0.17 rows=1 width=80) (actual time=0.177..0.177 rows=0 loops=2)
                    Index Cond: (id = c.owner_id)
                    Filter: ($5 AND (org_id = $6))
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (actual time=0.009..0.009 rows=1 loops=51)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (actual time=0.009..0.009 rows=0 loops=51)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 2. first page, A to Z: list_leads statement, 1.1 ms

Parameters: `$1 = NULL, $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=1.61..467.46 rows=51 width=232) (actual time=0.327..1.056 rows=51 loops=1)
  ->  Nested Loop Left Join  (cost=0.57..137013.81 rows=15000 width=232) (actual time=0.326..1.050 rows=51 loops=1)
        ->  Index Scan using companies_name_keyset_idx on companies c  (cost=0.41..4000.97 rows=15000 width=132) (actual time=0.306..0.397 rows=51 loops=1)
              Index Cond: (org_id = $4)
              Filter: $3
        ->  Memoize  (cost=0.16..0.18 rows=1 width=80) (actual time=0.005..0.005 rows=0 loops=51)
              Cache Key: c.owner_id
              Cache Mode: logical
              Hits: 49  Misses: 2  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              ->  Index Scan using profiles_pkey on profiles o  (cost=0.15..0.17 rows=1 width=80) (actual time=0.112..0.112 rows=0 loops=2)
                    Index Cond: (id = c.owner_id)
                    Filter: ($5 AND (org_id = $6))
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (actual time=0.007..0.007 rows=1 loops=51)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (actual time=0.007..0.007 rows=0 loops=51)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 3. first page, newest first: list_leads statement, 1.1 ms

Parameters: `$1 = NULL, $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=1.61..465.77 rows=51 width=232) (actual time=0.531..1.045 rows=51 loops=1)
  ->  Nested Loop Left Join  (cost=0.57..136519.31 rows=15000 width=232) (actual time=0.530..1.039 rows=51 loops=1)
        ->  Index Scan using companies_created_keyset_idx on companies c  (cost=0.41..3468.97 rows=15000 width=132) (actual time=0.285..0.391 rows=51 loops=1)
              Index Cond: (org_id = $4)
              Filter: $3
        ->  Memoize  (cost=0.16..0.18 rows=1 width=80) (actual time=0.005..0.005 rows=1 loops=51)
              Cache Key: c.owner_id
              Cache Mode: logical
              Hits: 49  Misses: 2  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              ->  Index Scan using profiles_pkey on profiles o  (cost=0.15..0.17 rows=1 width=80) (actual time=0.114..0.114 rows=0 loops=2)
                    Index Cond: (id = c.owner_id)
                    Filter: ($5 AND (org_id = $6))
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (actual time=0.007..0.007 rows=1 loops=51)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (actual time=0.007..0.007 rows=0 loops=51)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 4. search with no match, list then count: search helper (private.search_lead_ids), 0.0 ms

```text
HashAggregate  (cost=58.57..58.61 rows=4 width=16) (actual time=0.021..0.022 rows=0 loops=1)
  Group Key: s.id
  Batches: 1  Memory Usage: 24kB
  ->  Append  (cost=21.51..58.56 rows=4 width=16) (actual time=0.020..0.020 rows=0 loops=1)
        ->  Bitmap Heap Scan on companies s  (cost=21.51..33.01 rows=3 width=16) (actual time=0.013..0.013 rows=0 loops=1)
              Recheck Cond: (((((((name || E'\n') || COALESCE(email, ''::text)) || E'\n') || COALESCE(phone, ''::text)) || E'\n') || COALESCE(city, ''::text)) ~~* '%zzqx%'::text)
              Filter: (org_id = '26c53195-4fd3-4088-8b7a-4283126d2db9'::uuid)
              ->  Bitmap Index Scan on companies_search_trgm_idx  (cost=0.00..21.50 rows=3 width=0) (actual time=0.011..0.012 rows=0 loops=1)
                    Index Cond: (((((((name || E'\n') || COALESCE(email, ''::text)) || E'\n') || COALESCE(phone, ''::text)) || E'\n') || COALESCE(city, ''::text)) ~~* '%zzqx%'::text)
        ->  Bitmap Heap Scan on contacts k  (cost=21.50..25.53 rows=1 width=16) (actual time=0.006..0.006 rows=0 loops=1)
              Recheck Cond: (((((((first_name || ' '::text) || last_name) || E'\n') || COALESCE(email, ''::text)) || E'\n') || COALESCE(phone, ''::text)) ~~* '%zzqx%'::text)
              Filter: (org_id = '26c53195-4fd3-4088-8b7a-4283126d2db9'::uuid)
              ->  Bitmap Index Scan on contacts_search_trgm_idx  (cost=0.00..21.49 rows=1 width=0) (actual time=0.006..0.006 rows=0 loops=1)
                    Index Cond: (((((((first_name || ' '::text) || last_name) || E'\n') || COALESCE(email, ''::text)) || E'\n') || COALESCE(phone, ''::text)) ~~* '%zzqx%'::text)
```

### 4. search with no match, list then count: list_leads statement, 1.9 ms

Parameters: `$1 = '%zzqx%', $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=90.59..134.88 rows=5 width=240) (actual time=1.846..1.850 rows=0 loops=1)
  InitPlan 4 (returns $3)
    ->  ProjectSet  (cost=0.00..0.77 rows=100 width=16) (actual time=1.833..1.833 rows=0 loops=1)
          ->  Result  (cost=0.00..0.01 rows=1 width=0) (actual time=0.000..0.001 rows=1 loops=1)
  ->  Result  (cost=88.79..133.07 rows=5 width=240) (actual time=1.846..1.848 rows=0 loops=1)
        ->  Sort  (cost=88.79..88.80 rows=5 width=236) (actual time=1.845..1.846 rows=0 loops=1)
              Sort Key: (COALESCE(c.last_activity_at, '-infinity'::timestamp with time zone)) DESC, c.id DESC
              Sort Method: quicksort  Memory: 25kB
              ->  Nested Loop Left Join  (cost=43.11..88.73 rows=5 width=236) (actual time=1.841..1.842 rows=0 loops=1)
                    ->  Bitmap Heap Scan on companies c  (cost=42.95..79.64 rows=5 width=132) (actual time=1.840..1.841 rows=0 loops=1)
                          Recheck Cond: (id = ANY ($3))
                          Filter: ($4 AND (org_id = $5))
                          ->  Bitmap Index Scan on companies_pkey  (cost=0.00..42.95 rows=10 width=0) (actual time=1.838..1.839 rows=0 loops=1)
                                Index Cond: (id = ANY ($3))
                    ->  Memoize  (cost=0.16..4.98 rows=1 width=80) (never executed)
                          Cache Key: c.owner_id
                          Cache Mode: logical
                          ->  Index Scan using profiles_pkey on profiles o  (cost=0.15..4.97 rows=1 width=80) (never executed)
                                Index Cond: (id = c.owner_id)
                                Filter: ($6 AND (org_id = $7))
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (never executed)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (never executed)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 4. search with no match, list then count: count_leads statement, 1.0 ms

Parameters: `$1 = '%zzqx%', $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL`

```text
Aggregate  (cost=80.94..80.95 rows=1 width=8) (actual time=0.959..0.960 rows=1 loops=1)
  InitPlan 1 (returns $0)
    ->  ProjectSet  (cost=0.00..0.77 rows=100 width=16) (actual time=0.951..0.951 rows=0 loops=1)
          ->  Result  (cost=0.00..0.01 rows=1 width=0) (actual time=0.000..0.001 rows=1 loops=1)
  ->  Bitmap Heap Scan on companies c  (cost=42.95..79.64 rows=5 width=0) (actual time=0.957..0.957 rows=0 loops=1)
        Recheck Cond: (id = ANY ($0))
        Filter: ($1 AND (org_id = $2))
        ->  Bitmap Index Scan on companies_pkey  (cost=0.00..42.95 rows=10 width=0) (actual time=0.956..0.956 rows=0 loops=1)
              Index Cond: (id = ANY ($0))
```

