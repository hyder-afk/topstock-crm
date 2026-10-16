# Day 7d: dev project checks (security items 15 and 16, Gate 1 items 7, 29, 30)

16 Oct 2026, through the Supabase MCP configured in `.mcp.json`: project `swhkafqlmfhvgpsgdqjp` (the dev project,
`get_project_url` answered `https://swhkafqlmfhvgpsgdqjp.supabase.co`), `read_only=true`; the queries ran as
`supabase_read_only_user`. Only SELECTs; answers are counts, sizes and address domains, no names or row contents.
Production was not touched (it is in another Supabase account this session cannot reach). The SQL is
`dev-checks.sql`.

**What dev holds.** Migrations up to `20261015200000_role_change_lock` (main after PR #17: Days 1 to 5 and Team).
Day 6 (PR #18) and Day 7a to 7f are not merged, so their tables, functions and advisor lints are not on dev yet.
Every row below is re-read after those PRs merge and `deploy-dev-db` runs (main session; plan precondition).

## Security item 15: stored lead facts (each must be 0)

| Check | Result |
|---|---|
| `has_contact_phone_consistent` (every lead's contact flag against its contacts) | **0** wrong |
| `queue_rank_matches_rule` | **0** wrong |
| `call_zone_matches_map` (`call_zone` = `private.lead_call_zone(timezone, country)`) | **not runnable by the read-only role** (`permission denied for function call_zone_keys`; the private functions are revoked from everyone but their owner, as designed). Read by hand instead: dev has 1 lead, country and time zone empty, stored `call_zone` `Europe/Paris`, which is the zone map's fallback for an empty country (Day 4 design 3.3: "a picked zone, the country's zone or span, Europe/Paris"), so **0** wrong. The full query runs in the SQL editor as the owner (Haider, 1 minute) once the 30k import is in, or on the next restore test |

## Fake data only, accounts (items 29 and 30)

| Read | Result |
|---|---|
| Auth users | 1 (on the company's own domain: Haider's account); no test or default accounts |
| Leads | 1, no e-mail address; contacts 0; deals 0; tasks 0; files 0; entries 1; audit rows 10 |
| Extensions | `pg_cron` 1.6.4 (question 3, on), `pgcrypto` 1.3 |

## Security item 16: Gate 1 size query (500 MB on the Free plan)

| Relation | Size |
|---|---|
| database `postgres` (all) | 14 MB |
| `public.companies` | 208 kB |
| `public.deals` | 104 kB |
| `public.activities` | 104 kB |
| `public.tasks` | 96 kB |
| `public.files` | 72 kB |
| `public.audit_log` | 64 kB |
| `public.contacts` | 32 kB |
| `private.stock_movements`, `private.orders`, `private.order_lines` | not on dev yet (Day 6 not deployed) |

Projection from the designs: ~255 MB a year with 30k leads (Day 4 design line 544), ~300 to 365 MB with inventory
(Day 6 design lines 757 to 758), 60 to 73% of 500 MB. Re-run after the import; Supabase Pro before production anyway
(backups). Egress is read weekly in the dashboard (Haider, Day 8 list).

## Advisors on dev (`get_advisors`)

| Advisor | ERROR | WARN | INFO |
|---|---|---|---|
| Security | 0 | 2: `authenticated_security_definer_function_executable` on `public.set_user_role` (accepted Day 1: admin-only, fresh code, same org, last-admin guard; `gate1_attack.sql` G4 lists it); `auth_leaked_password_protection` (**accepted**: paid plan only, Haider question 4, 15 Oct 2026, log line 356) | 0 |
| Performance | 0 | 0 | `unindexed_foreign_keys` 5 (the `org_id` keys of `activity_undo`, `deal_moves`, `queue_claims`, `activities`, `tasks`: one organisation, accepted Day 4b, log line 168); `unused_index` 48 (an empty database uses no index) |

Local splinter (pinned rules, `scripts/db-advisors.sh`) on all 20 migrations of this branch, in today's `db-test.sh`:
0 ERROR; WARN `share_view`, `share_request` (anon SECURITY DEFINER, Day 6e by design) and `set_user_role`; INFO
`unindexed_foreign_keys` 8, `unused_index` 10 to 12. These are what dev will show once Day 6 and 7 deploy.

## Re-read after Day 6 and Day 7 reached dev (Gate 1 condition b)

16 Oct 2026, about 19:27 UTC (after the deploy finished at 19:26:37). PR #19 merged as `d12a4a9`; `deploy-dev-db` run 38954829775 succeeded (auth settings, sign-ups
closed, REST API public schema only, migrations). Same project, MCP `read_only=true`, SELECTs only.

| Read | Result |
|---|---|
| Migrations on dev | up to `20261022130000_share_take_paris_day` (all of Day 6 and Day 7a to 7f) |
| `has_contact_phone_consistent` | **0** wrong |
| `queue_rank_matches_rule` | **0** wrong |
| `call_zone_matches_map` | still not runnable by the read-only role (private function, by design). Haider's owner run returned 0 rows (log line 438), but that was before this deploy. Re-read by hand after it: the 1 lead has no country and no time zone and its stored zone is `Europe/Paris` (the map's fallback), so **0** wrong |
| Auth users | 1, on the company's own domain; no test or default accounts |
| Rows | companies 1 (no e-mail), contacts 0, activities 1, tasks 0, deals 0, files 0, products 0, stock movements 0, orders 0, audit rows 10 |
| Database size | 16.6 MB of 500 MB |
| `pg_cron` | installed |

| Advisor | ERROR | WARN | INFO |
|---|---|---|---|
| Security | **0** | 4, all accepted: `anon_security_definer_function_executable` on `share_view` and `share_request` (Day 6e client share by design: token-gated, rate-limited), `authenticated_security_definer_function_executable` on `set_user_role` (Day 1), `auth_leaked_password_protection` (paid plan only, Haider question 4) | 0 |
| Performance | **0** | 0 | `unindexed_foreign_keys` 8 (the `org_id` and same-org owner keys predicted by the local splinter run above; one organisation, accepted Day 4b); `unused_index` 98 (dev is empty, no index has been used) |

Same ERROR and WARN lints as the local splinter run predicted, plus leaked-password protection, which only the hosted project can show. The `unused_index` count is higher than locally because dev has more indexes and an empty database. Condition (b) is met.
