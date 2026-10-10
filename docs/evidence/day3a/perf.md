# Leads list speed at 30k leads: Day 3a, 10 Oct 2026

The advisor asked for proof that the leads list stays fast at Release 1 size (Master Plan: 30k leads). The proof is
`bash scripts/db-perf.sh`, which anyone can re-run:
- it starts a throwaway PostgreSQL 16 (16.15), adds the same auth shim the security tests use, and applies every
  migration;
- it loads 30,000 made-up companies and 10,000 made-up contacts (`supabase/tests/perf_leads.sql`), plus 15 leads that sort
  last in every order, each with one contact (the worst place for a search to find its matches);
- it then calls `list_leads` and `count_leads` as a signed-in rep with two-factor, so row level security is on, exactly as
  the app calls them.

Machine: this cloud session, 4 vCPU Xeon 2.8 GHz. The app asks for the list and the count at the same time, so a page waits
for the slower of the two.

## Timings: inside the database, average of 5 warm runs; range over 3 full runs of the script

| Case | List | Count |
|---|---|---|
| First page, last activity (the default) | 1.6–2.3 ms | 2.6–5.2 ms (no filter) |
| First page, A to Z | 1.1–2.1 ms | |
| First page, newest first | 1.2–1.7 ms | |
| Page 200 (row 10,000), keyset | 11.6–20.0 ms | |
| Status + country filter | 16.9–28.6 ms | 2.7–4.5 ms |
| No activity for 30 days | 2.1–4.3 ms | |
| City filter "lyon" | 26.0–26.2 ms | |
| Search "verdane" (3,000 matches) | 1.3–1.9 ms | 15.1–15.7 ms |
| Search "verdane" + status customer | 6.7–8.9 ms | |
| Search for a contact's name ("benali4") | 23.3–27.7 ms | |
| Search with no match ("zzqx") | 22.8–25.4 ms | 14.3–18.4 ms |
| Search "example.com" (every lead), last activity / A to Z | 1.2–2.0 / 1.3–2.0 ms | 17.3–22.5 ms |
| Search "+33 6" (every lead), A to Z | 1.2–2.0 ms | 14.5–22.8 ms |
| Search "ly" (2 letters, 6,856 matches) | 5.0–8.6 ms | 15.4–25.8 ms |
| Search "éé" (2 letters, no match) | 25.2–32.6 ms | |
| Search "zermatt" (15 leads, all sorting last): last activity / A to Z / newest | 23.4–40.2 / 34.7–51.0 / 28.2–32.0 ms | 14.1–16.2 ms |
| Search "quaxley" (15 contacts, on leads sorting last), A to Z | 37.4–55.2 ms | |

- **Slowest case:** about 25–55 ms. These are searches whose few matches all sort last, plus searches with no match and
  the city filter. A to Z is the slowest order, because its index reads the table in a scattered order.
- **Why that is the worst case:** any search or filter reads each lead of the org at most once. A list with few matches
  walks the whole sort index; a count always reads every lead (about 15–26 ms).
- **Against the plan's 200 ms budget for a route change:** at least 3.5x headroom for Supabase's smaller servers and the
  network hop. It grows roughly in line with the number of leads and contacts.
- **Not covered:** search ignores letter case but not accents ("societe" does not find "Société"). An accent-insensitive
  search is a later item.

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
  matches reads every lead once (about 25–55 ms).
- There is no SECURITY DEFINER code in search, and nothing bypasses row level security. The trigram indexes, which could
  never be used under RLS, are dropped.

## Query plans (auto_explain, actual run)

- The three sort orders each read their own keyset index and stop after 51 rows (`Limit`, `rows=51`), never sorting the
  whole table.
- A search with no match reads the activity index once with the search as a filter. The contacts' matches are collected
  once (`hashed SubPlan`).
- A search matching every lead stops after 51 rows.

### 1. first page, last activity (default): list_leads statement, 1.7 ms

Parameters: `$1 = NULL, $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=1.61..467.14 rows=51 width=240) (actual time=0.466..1.691 rows=51 loops=1)
  ->  Nested Loop Left Join  (cost=0.57..136994.22 rows=15008 width=240) (actual time=0.465..1.647 rows=51 loops=1)
        ->  Index Scan using companies_activity_keyset_idx on companies c  (cost=0.41..3872.93 rows=15008 width=132) (actual time=0.426..0.485 rows=51 loops=1)
              Index Cond: (org_id = $4)
              Filter: $3
        ->  Memoize  (cost=0.16..0.18 rows=1 width=80) (actual time=0.008..0.008 rows=0 loops=51)
              Cache Key: c.owner_id
              Cache Mode: logical
              Hits: 49  Misses: 2  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              ->  Index Scan using profiles_pkey on profiles o  (cost=0.15..0.17 rows=1 width=80) (actual time=0.194..0.194 rows=0 loops=2)
                    Index Cond: (id = c.owner_id)
                    Filter: ($5 AND (org_id = $6))
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (actual time=0.013..0.013 rows=1 loops=51)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (actual time=0.012..0.012 rows=0 loops=51)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 2. first page, A to Z: list_leads statement, 1.3 ms

Parameters: `$1 = NULL, $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=1.61..469.70 rows=51 width=232) (actual time=0.335..1.243 rows=51 loops=1)
  ->  Nested Loop Left Join  (cost=0.57..137748.70 rows=15008 width=232) (actual time=0.334..1.233 rows=51 loops=1)
        ->  Index Scan using companies_name_keyset_idx on companies c  (cost=0.41..4664.93 rows=15008 width=132) (actual time=0.308..0.402 rows=51 loops=1)
              Index Cond: (org_id = $4)
              Filter: $3
        ->  Memoize  (cost=0.16..0.18 rows=1 width=80) (actual time=0.005..0.005 rows=0 loops=51)
              Cache Key: c.owner_id
              Cache Mode: logical
              Hits: 49  Misses: 2  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              ->  Index Scan using profiles_pkey on profiles o  (cost=0.15..0.17 rows=1 width=80) (actual time=0.125..0.125 rows=0 loops=2)
                    Index Cond: (id = c.owner_id)
                    Filter: ($5 AND (org_id = $6))
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (actual time=0.009..0.009 rows=1 loops=51)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (actual time=0.009..0.009 rows=0 loops=51)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 3. first page, newest first: list_leads statement, 1.2 ms

Parameters: `$1 = NULL, $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=1.61..468.02 rows=51 width=232) (actual time=0.599..1.135 rows=51 loops=1)
  ->  Nested Loop Left Join  (cost=0.57..137254.22 rows=15008 width=232) (actual time=0.598..1.127 rows=51 loops=1)
        ->  Index Scan using companies_created_keyset_idx on companies c  (cost=0.41..4132.93 rows=15008 width=132) (actual time=0.350..0.426 rows=51 loops=1)
              Index Cond: (org_id = $4)
              Filter: $3
        ->  Memoize  (cost=0.16..0.18 rows=1 width=80) (actual time=0.005..0.005 rows=1 loops=51)
              Cache Key: c.owner_id
              Cache Mode: logical
              Hits: 49  Misses: 2  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              ->  Index Scan using profiles_pkey on profiles o  (cost=0.15..0.17 rows=1 width=80) (actual time=0.113..0.113 rows=0 loops=2)
                    Index Cond: (id = c.owner_id)
                    Filter: ($5 AND (org_id = $6))
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (actual time=0.007..0.007 rows=1 loops=51)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (actual time=0.007..0.007 rows=0 loops=51)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 4. search with no match, list then count: list_leads statement, 25.0 ms

Parameters: `$1 = '%zzqx%', $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=439.46..918.48 rows=51 width=240) (actual time=25.026..25.035 rows=0 loops=1)
  ->  Nested Loop Left Join  (cost=438.42..71483.39 rows=7564 width=240) (actual time=25.025..25.030 rows=0 loops=1)
        Join Filter: (o.id = c.owner_id)
        ->  Index Scan using companies_activity_keyset_idx on companies c  (cost=434.26..4456.85 rows=7564 width=132) (actual time=25.024..25.026 rows=0 loops=1)
              Index Cond: (org_id = $7)
              Filter: ($6 AND ((search_text ~~ '%zzqx%'::text) OR (hashed SubPlan 6)))
              Rows Removed by Filter: 30015
              SubPlan 6
                ->  Seq Scan on contacts k_1  (cost=0.52..433.75 rows=40 width=16) (actual time=3.485..3.487 rows=0 loops=1)
                      Filter: ($3 AND (org_id = $4) AND (search_text ~~ '%zzqx%'::text))
                      Rows Removed by Filter: 10015
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

### 4. search with no match, list then count: count_leads statement, 14.8 ms

Parameters: `$1 = '%zzqx%', $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL`

```text
Aggregate  (cost=1975.54..1975.55 rows=1 width=8) (actual time=14.808..14.815 rows=1 loops=1)
  ->  Seq Scan on companies c  (cost=433.85..1956.11 rows=7564 width=0) (actual time=14.804..14.806 rows=0 loops=1)
        Filter: ($3 AND (org_id = $4) AND ((search_text ~~ '%zzqx%'::text) OR (hashed SubPlan 3)))
        Rows Removed by Filter: 30015
        SubPlan 3
          ->  Seq Scan on contacts k  (cost=0.52..433.75 rows=40 width=16) (actual time=3.472..3.473 rows=0 loops=1)
                Filter: ($0 AND (org_id = $1) AND (search_text ~~ '%zzqx%'::text))
                Rows Removed by Filter: 10015
```

### 5. search matching every lead, list (A to Z) then count: list_leads statement, 1.3 ms

Parameters: `$1 = '%example.com%', $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL, $8 = NULL, $9 = NULL, $10 = '51'`

```text
Limit  (cost=439.36..923.85 rows=51 width=232) (actual time=0.648..1.272 rows=51 loops=1)
  ->  Nested Loop Left Join  (cost=438.32..71733.79 rows=7505 width=232) (actual time=0.647..1.263 rows=51 loops=1)
        Join Filter: (o.id = c.owner_id)
        Rows Removed by Join Filter: 35
        ->  Index Scan using companies_name_keyset_idx on companies c  (cost=434.16..5248.75 rows=7505 width=132) (actual time=0.364..0.462 rows=51 loops=1)
              Index Cond: (org_id = $7)
              Filter: ($6 AND ((search_text ~~ '%example.com%'::text) OR (hashed SubPlan 6)))
              SubPlan 6
                ->  Seq Scan on contacts k_1  (cost=0.52..433.75 rows=1 width=16) (never executed)
                      Filter: ($3 AND (org_id = $4) AND (search_text ~~ '%example.com%'::text))
        ->  Materialize  (cost=4.16..9.51 rows=1 width=80) (actual time=0.005..0.005 rows=1 loops=51)
              ->  Bitmap Heap Scan on profiles o  (cost=4.16..9.50 rows=1 width=80) (actual time=0.255..0.257 rows=1 loops=1)
                    Recheck Cond: (org_id = $9)
                    Filter: $8
                    Heap Blocks: exact=1
                    ->  Bitmap Index Scan on profiles_org_id_idx  (cost=0.00..4.16 rows=2 width=0) (actual time=0.157..0.157 rows=1 loops=1)
                          Index Cond: (org_id = $9)
        SubPlan 3
          ->  Aggregate  (cost=8.83..8.84 rows=1 width=4) (actual time=0.009..0.009 rows=1 loops=51)
                ->  Index Scan using contacts_company_idx on contacts k  (cost=0.29..8.30 rows=1 width=0) (actual time=0.009..0.009 rows=0 loops=51)
                      Index Cond: (company_id = c.id)
                      Filter: ($1 AND (org_id = $2))
```

### 5. search matching every lead, list (A to Z) then count: count_leads statement, 20.2 ms

Parameters: `$1 = '%example.com%', $2 = NULL, $3 = NULL, $4 = 'f', $5 = NULL, $6 = NULL, $7 = NULL`

```text
Aggregate  (cost=1975.29..1975.30 rows=1 width=8) (actual time=20.162..20.168 rows=1 loops=1)
  ->  Seq Scan on companies c  (cost=433.75..1956.01 rows=7505 width=0) (actual time=0.271..18.767 rows=30000 loops=1)
        Filter: ($3 AND (org_id = $4) AND ((search_text ~~ '%example.com%'::text) OR (hashed SubPlan 3)))
        Rows Removed by Filter: 15
        SubPlan 3
          ->  Seq Scan on contacts k  (cost=0.52..433.75 rows=1 width=16) (actual time=0.506..4.918 rows=10000 loops=1)
                Filter: ($0 AND (org_id = $1) AND (search_text ~~ '%example.com%'::text))
                Rows Removed by Filter: 15
```

