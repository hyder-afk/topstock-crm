# Day 7a (part 1): security review, 15 Oct 2026

Scope: branch `day7a-local` against e038d65: migration `20261021100000_day7a_security.sql` (sign-in audit rows,
same-organisation owner keys), `rls_attack.sql` section 1 (catalog-driven anon sweep), `src/lib/rate-limit.ts` and the
five list routes, `src/lib/supabase/cookie-options.ts` with the three Supabase clients and `src/proxy.ts`,
`signOutEverywhere` (`src/app/(auth)/actions.ts`) and its sheet, `src/lib/auth-events.ts` and its three callers.

Method: `/security-review` (threat rows, report only findings at 80 % confidence or more, the skill's exclusions).

## Result: NO FINDINGS at 80 % confidence or more

What was checked:

| Area | Checked | Holds because |
|---|---|---|
| Sign-in rows writer | `public.record_auth_event` | SECURITY INVOKER, `search_path = ''`; the caller's own insert under RLS; revoked from PUBLIC and anon |
| Sign-in rows policy | insert policy on `public.audit_log` | pins `actor_id = auth.uid()`, `org_id = current_org_id()`, action in (`sign_in`, `mfa_verify`), table `auth`, no record id, no details; column grant on exactly 4 columns (`org_id, actor_id, action, table_name`), so no `diff_json`, `created_at` or `record_id`; the table's restrictive aal2 policy also applies |
| Flood guard | `private.auth_event_guard` | DEFINER trigger function, not callable (revoked from PUBLIC, anon, authenticated), `search_path = ''` |
| Same-org owner keys | composite FKs `companies/deals/tasks (owner, org_id) → profiles (id, org_id)` | `profiles_id_org_key` unique; MATCH SIMPLE (a null owner passes, as before); `ON DELETE SET NULL (owner column)` keeps `org_id` |
| Anon sweep | `rls_attack.sql` section 1 | relkinds r, p, v, m, f, S; every `pg_proc` row in `public` and `private`; schema USAGE and CREATE; function allowlist by full signature (Day 6's two share functions only) |
| Rate limiter | `src/lib/rate-limit.ts`, five routes (19 after the merge: last section) | keyed on the verified `claims.sub`, checked after the aal2 session check; no counts in the 429 answer. Not scrape protection (README decisions and residual R1) |
| Sign out everywhere | `signOutEverywhere` | requires an aal2 session (server-checked); a server action (POST, Next's Origin check); cookies SameSite=Lax |
| Cookie flags | `authCookieOptions` | Secure from the request URL or `x-forwarded-proto`: a forged header can only add Secure (tightens), never remove it |
| Secrets | the diff | none; no keys, no service-role use in client code, nothing logged |

## Informational note (below the bar) and fix applied

The flood guard counted the rows of `new.actor_id` before RLS checked the row. A signed-in person forging a row about
someone else was refused either way, but the code of the refusal differed: `22023 rate_limited` when the victim had 30
or more rows in the last hour, `42501` otherwise. That told the caller whether a colleague had signed in 30 times this
hour (a weak oracle; admins can read the rows anyway).

Applied: `private.auth_event_guard` now starts with

```sql
if new.actor_id is distinct from auth.uid() then
  return new;
end if;
```

so a forged row goes straight on to RLS, which refuses it with 42501 before any count can be observed. Proof:
`day7a_attack.sql` block B5 (the victim has 30 rows; the forger gets 42501, not 22023; the victim's own 31st row is still
held), and `db-mutations.py` day7a row 15 (removing the early return is caught by B5).

## Accepted residual

- A signed-in person can write up to 30 fake `sign_in` rows an hour about themselves (only about themselves, no
  details, own organisation). README residual R3.

## Merge with Day 6 (08b0ae7) and the fixes after it

Delta reviewed: the merge of `day6a-local` 9bbbf1c and the commits after it.

| Change | Checked | Holds because |
|---|---|---|
| 14 more rate-limited routes (19 in all): Day 6's `/api/inventory/stock`, `/movements`, `/sales`, `/requests`, `/reservations`, `/share-links`, `/api/leads/[id]/stock`, `/api/stock-imports/[id]/changes` and `/issues`; the lead page's `/api/leads/[id]/activities`, `/deals`, `/files`, `/tasks`; the lead import's `/api/imports/[id]/issues` | each GET handler | `listRateLimited(session.claims.sub)` straight after `apiSession()`: keyed on the verified user id, never on request input, before any parsing or database call; the same generic 429 (no counts). A unit scan pins the order on all 19 and makes every GET route under `src/app/api` either limited or named as not a list (one record, counts, a file download, the client whitelist). Still a speed bump, not scrape protection (README residual R1) |
| `src/proxy.ts` imports `./lib/supabase/cookie-options` instead of `@/lib/supabase/cookie-options` | the proxy's cookie options | the same file and module at runtime (`@/*` maps to `./src/*`); the proxy still passes `authCookieOptions(isHttps(request))` and the auth-cookies unit scan still checks it. Changed only because Playwright's loader does not map `@/` inside the proxy when Day 6's `proxy-share` test imports it dynamically |

Result: NO FINDINGS at 80 % confidence or more on the delta.
