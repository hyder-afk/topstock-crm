# Leads list speed at 30k leads: Day 3a, 10 Oct 2026

The advisor asked for proof that the leads list stays fast at Release 1 size (Master Plan: 30k leads). The proof is
`bash scripts/db-perf.sh`, which anyone can re-run:
- it starts a throwaway PostgreSQL 16 (16.15), adds the same auth shim the security tests use, and applies every
  migration;
- it loads 30,000 made-up companies and 10,000 made-up contacts (`supabase/tests/perf_leads.sql`);
- it then calls `list_leads` and `count_leads` as a signed-in rep with two-factor, so row level security is on, exactly as
  the app calls them.

Machine: this cloud session, 4 vCPU Xeon 2.8 GHz. The app asks for the list and the count at the same time, so a page waits
for the slower of the two.

## Timings: inside the database, average of 5 warm runs; range over 3 full runs of the script

| Case | List | Count |
|---|---|---|
| First page, last activity (the default) | 1.1–1.3 ms | 2.6–3.5 ms (no filter) |
| First page, A to Z | 1.1–1.2 ms | |
| First page, newest first | 1.0–1.1 ms | |
| Page 200 (row 10,000), keyset | 11.5–13.8 ms | |
| Status + country filter | 16.3–20.1 ms | 2.1–4.6 ms |
| No activity for 30 days | 2.2–4.7 ms | |
| City filter "lyon" | 23.4–32.2 ms | |
| Search "verdane" (3,000 matches) | 1.1–1.9 ms | 16.1–21.2 ms |
| Search "verdane" + status customer | 6.0–11.6 ms | |
| Search for a contact's name ("benali4") | 24.5–31.8 ms | |
| Search with no match ("zzqx") | 23.9–31.9 ms | 14.1–14.4 ms |
| Search "example.com" (every lead), last activity / A to Z | 1.2–1.7 / 1.1–1.2 ms | 11.4–12.2 ms |
| Search "+33 6" (every lead), A to Z | 1.2–1.4 ms | 10.9–11.7 ms |
| Search "ly" (2 letters, 6,856 matches) | 4.8–5.3 ms | 15.5–19.6 ms |
| Search "éé" (2 letters, no match) | 23.4–28.5 ms | |

- **Slowest case:** about 32 ms, for a search with few or no matches, or the city filter. One earlier run, while the
  machine was busy, reached 42 ms for the contact-name search.
- **Why that is the worst case:** any search or filter reads each lead of the org at most once. A list with few matches
  walks the whole sort index (about 30 ms); a count always reads every lead (about 12–21 ms).
- **Against the plan's 200 ms budget for a route change:** about 6x headroom for Supabase's smaller servers and the
  network hop. It grows roughly in line with the number of leads and contacts.

## How search works, and why

**Round 1 measurement.** The first version used `ILIKE` on the joined fields. Every search read all 30,000 leads (about
100 ms), because row level security runs its own checks before any condition that is not "leakproof". Neither `ILIKE`
nor `LIKE` is, so PostgreSQL may not use a trigram index for them under RLS.

**Round 2 attempt (not kept).** A SECURITY DEFINER helper used trigram indexes outside RLS and handed back lead ids.
- Narrow searches got fast (1 ms).
- A search matching most leads ("example.com", "+33") got slower: 130–190 ms. All 30,000 ids went into an array and were
  then sorted. The advisor caught this.

**Kept.**
- Each lead and contact has `search_text`, a lowercase copy of its searchable fields, joined by line breaks. The database
  keeps it up to date (a generated column, so nobody can write it). Search is a plain `LIKE` on it with a lowercase
  pattern. This is about 3x cheaper per row than `ILIKE` on the joined fields: a full read of 30k leads takes about
  20 ms instead of 65 ms.
- A search that matches many leads reads the sort index and stops after the first page (about 1 ms). A search with few
  matches reads every lead once (about 25–30 ms).
- There is no SECURITY DEFINER code in search, and nothing bypasses row level security. The trigram indexes, which could
  never be used under RLS, are dropped.

## Query plans (auto_explain, actual run)

- The three sort orders each read their own keyset index and stop after 51 rows (`Limit`, `rows=51`), never sorting the
  whole table.
- A search with no match reads the activity index once with the search as a filter. The contacts' matches are collected
  once (`hashed SubPlan`).
- A search matching every lead stops after 51 rows.

### 1. first page, last activity (default): list_leads statement, 1.2 ms

Parameters: `$1 = NULL, $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=1.61..467.19 rows=51 width=240) (actual time=0.698..1.163 rows=51 loops=1)
  ->  Nested Loop Left Join  (cost=0.57..136935.00 rows=15000 width=240) (actual time=0.698..1.156 rows=51 loops=1)
        ->  Index Scan using companies_activity_keyset_idx on companies c  (cost=0.41..3884.66 rows=15000 width=132) (actual time=0.429..0.464 rows=51 loops=1)
              Index Cond: (org_id = $4)
              Filter: $3
        ->  Memoize  (cost=0.16..0.18 rows=1 width=80) (actual time=0.005..0.005 rows=0 loops=51)
              Cache Key: c.owner_id
              Cache Mode: logical
              Hits: 49  Misses: 2  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              ->  Index Scan using profiles_pkey on profiles o  (cost=0.15..0.17 rows=1 width=80) (actual time=0.122..0.122 rows=0 loops=2)
                    Index Cond: (id = c.owner_id)
                    Filter: ($5 AND (org_id = $6))
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (actual time=0.007..0.007 rows=1 loops=51)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (actual time=0.007..0.007 rows=0 loops=51)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 2. first page, A to Z: list_leads statement, 1.1 ms

Parameters: `$1 = NULL, $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=1.61..469.71 rows=51 width=232) (actual time=0.287..1.102 rows=51 loops=1)
  ->  Nested Loop Left Join  (cost=0.57..137677.50 rows=15000 width=232) (actual time=0.286..1.095 rows=51 loops=1)
        ->  Index Scan using companies_name_keyset_idx on companies c  (cost=0.41..4664.66 rows=15000 width=132) (actual time=0.265..0.324 rows=51 loops=1)
              Index Cond: (org_id = $4)
              Filter: $3
        ->  Memoize  (cost=0.16..0.18 rows=1 width=80) (actual time=0.006..0.006 rows=0 loops=51)
              Cache Key: c.owner_id
              Cache Mode: logical
              Hits: 49  Misses: 2  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              ->  Index Scan using profiles_pkey on profiles o  (cost=0.15..0.17 rows=1 width=80) (actual time=0.136..0.136 rows=0 loops=2)
                    Index Cond: (id = c.owner_id)
                    Filter: ($5 AND (org_id = $6))
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (actual time=0.007..0.007 rows=1 loops=51)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (actual time=0.007..0.007 rows=0 loops=51)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 3. first page, newest first: list_leads statement, 1.0 ms

Parameters: `$1 = NULL, $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=1.61..468.03 rows=51 width=232) (actual time=0.525..0.982 rows=51 loops=1)
  ->  Nested Loop Left Join  (cost=0.57..137183.00 rows=15000 width=232) (actual time=0.525..0.976 rows=51 loops=1)
        ->  Index Scan using companies_created_keyset_idx on companies c  (cost=0.41..4132.66 rows=15000 width=132) (actual time=0.255..0.314 rows=51 loops=1)
              Index Cond: (org_id = $4)
              Filter: $3
        ->  Memoize  (cost=0.16..0.18 rows=1 width=80) (actual time=0.005..0.005 rows=1 loops=51)
              Cache Key: c.owner_id
              Cache Mode: logical
              Hits: 49  Misses: 2  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              ->  Index Scan using profiles_pkey on profiles o  (cost=0.15..0.17 rows=1 width=80) (actual time=0.126..0.127 rows=0 loops=2)
                    Index Cond: (id = c.owner_id)
                    Filter: ($5 AND (org_id = $6))
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (actual time=0.007..0.007 rows=1 loops=51)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (actual time=0.006..0.006 rows=0 loops=51)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 4. search with no match, list then count: list_leads statement, 23.1 ms

Parameters: `$1 = '%zzqx%', $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=439.24..918.35 rows=51 width=240) (actual time=23.102..23.111 rows=0 loops=1)
  ->  Nested Loop Left Join  (cost=438.20..71459.39 rows=7560 width=240) (actual time=23.101..23.106 rows=0 loops=1)
        Join Filter: (o.id = c.owner_id)
        ->  Index Scan using companies_activity_keyset_idx on companies c  (cost=434.03..4468.28 rows=7560 width=132) (actual time=23.100..23.102 rows=0 loops=1)
              Index Cond: (org_id = $7)
              Filter: ($6 AND ((search_text ~~ '%zzqx%'::text) OR (hashed SubPlan 6)))
              Rows Removed by Filter: 30000
              SubPlan 6
                ->  Seq Scan on contacts k_1  (cost=0.52..433.52 rows=40 width=16) (actual time=3.223..3.225 rows=0 loops=1)
                      Filter: ($3 AND (org_id = $4) AND (search_text ~~ '%zzqx%'::text))
                      Rows Removed by Filter: 10000
        ->  Materialize  (cost=4.16..9.51 rows=1 width=80) (never executed)
              ->  Bitmap Heap Scan on profiles o  (cost=4.16..9.50 rows=1 width=80) (never executed)
                    Recheck Cond: (org_id = $9)
                    Filter: $8
                    ->  Bitmap Index Scan on profiles_org_id_idx  (cost=0.00..4.16 rows=2 width=0) (never executed)
                          Index Cond: (org_id = $9)
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (never executed)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (never executed)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 4. search with no match, list then count: count_leads statement, 14.3 ms

Parameters: `$1 = '%zzqx%', $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL`

```text
Aggregate  (cost=1975.04..1975.05 rows=1 width=8) (actual time=14.245..14.252 rows=1 loops=1)
  ->  Seq Scan on companies c  (cost=433.62..1955.62 rows=7560 width=0) (actual time=14.239..14.242 rows=0 loops=1)
        Filter: ($3 AND (org_id = $4) AND ((search_text ~~ '%zzqx%'::text) OR (hashed SubPlan 3)))
        Rows Removed by Filter: 30000
        SubPlan 3
          ->  Seq Scan on contacts k  (cost=0.52..433.52 rows=40 width=16) (actual time=3.499..3.501 rows=0 loops=1)
                Filter: ($0 AND (org_id = $1) AND (search_text ~~ '%zzqx%'::text))
                Rows Removed by Filter: 10000
```

### 5. search matching every lead, list (A to Z) then count: list_leads statement, 1.2 ms

Parameters: `$1 = '%example.com%', $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=439.14..923.64 rows=51 width=232) (actual time=0.650..1.154 rows=51 loops=1)
  ->  Nested Loop Left Join  (cost=438.10..71697.80 rows=7501 width=232) (actual time=0.650..1.146 rows=51 loops=1)
        Join Filter: (o.id = c.owner_id)
        Rows Removed by Join Filter: 35
        ->  Index Scan using companies_name_keyset_idx on companies c  (cost=433.94..5248.19 rows=7501 width=132) (actual time=0.377..0.455 rows=51 loops=1)
              Index Cond: (org_id = $7)
              Filter: ($6 AND ((search_text ~~ '%example.com%'::text) OR (hashed SubPlan 6)))
              SubPlan 6
                ->  Seq Scan on contacts k_1  (cost=0.52..433.52 rows=1 width=16) (never executed)
                      Filter: ($3 AND (org_id = $4) AND (search_text ~~ '%example.com%'::text))
        ->  Materialize  (cost=4.16..9.51 rows=1 width=80) (actual time=0.005..0.005 rows=1 loops=51)
              ->  Bitmap Heap Scan on profiles o  (cost=4.16..9.50 rows=1 width=80) (actual time=0.248..0.249 rows=1 loops=1)
                    Recheck Cond: (org_id = $9)
                    Filter: $8
                    Heap Blocks: exact=1
                    ->  Bitmap Index Scan on profiles_org_id_idx  (cost=0.00..4.16 rows=2 width=0) (actual time=0.150..0.151 rows=1 loops=1)
                          Index Cond: (org_id = $9)
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (actual time=0.007..0.007 rows=1 loops=51)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (actual time=0.007..0.007 rows=0 loops=51)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 5. search matching every lead, list (A to Z) then count: count_leads statement, 12.1 ms

Parameters: `$1 = '%example.com%', $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL`

```text
Aggregate  (cost=1974.80..1974.81 rows=1 width=8) (actual time=12.131..12.135 rows=1 loops=1)
  ->  Seq Scan on companies c  (cost=433.52..1955.52 rows=7501 width=0) (actual time=0.323..10.860 rows=30000 loops=1)
        Filter: ($3 AND (org_id = $4) AND ((search_text ~~ '%example.com%'::text) OR (hashed SubPlan 3)))
        SubPlan 3
          ->  Seq Scan on contacts k  (cost=0.52..433.52 rows=1 width=16) (never executed)
                Filter: ($0 AND (org_id = $1) AND (search_text ~~ '%example.com%'::text))
```

