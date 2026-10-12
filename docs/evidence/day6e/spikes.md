# Day 6e spikes (design 2.4: S1, S4, S5)

## S1: a role that owns the two definer functions

Repeated in 6e's migration itself (b326afb) on the local PostgreSQL 16 shim, after 6a's throwaway script
(`docs/evidence/day6a/spikes/s1-output.txt`):

- `create role share_reader nologin noinherit`, `grant share_reader to postgres with set true`, a temporary
  `grant create on schema public to share_reader` around `alter function … owner to share_reader`: the migration
  applies cleanly in every `db-test.sh` run.
- Column grants and `TO share_reader` policies apply inside the definer: `share_attack.sql` sections 1 to 8 call the
  functions as `anon` and read as `share_reader` directly (`share_reader_column_privileges`,
  `share_reader_cannot_read_cost`, `share_rls_org_setting_scoping`).
- Nothing on its path needs `auth`: the two guards it fires branch on `current_user` first; the task trigger and the
  audit triggers are definers owned by postgres.
- The local gateway (`scripts/local-auth`) calls `share_view` and `share_request` as the anon role through its RPC path,
  as PostgREST does (e2e `share.spec.ts`).
- Splinter (pinned rules, `scripts/db-advisors.sh`): two WARNs, `anon_security_definer_function_executable` on
  `share_view` and `share_request`, accepted (threat model, accepted residuals); no ERROR.

Not checked here (no remote database by instruction): the CI image (the `db` job runs the same migration and
`share_attack.sql` on the real Supabase Postgres image) and the dev project. Gate 1 restore runbook: create the role
before `pg_restore` (a dump writes `OWNER TO share_reader`), as 6a's spike found.

## S4: Next 16.4 and next-intl 4.14.9 on the share surface

| Question | Result | Proof |
|---|---|---|
| A request-config locale and message subset chosen from a proxy-set header | Works (`src/i18n/request.ts`); the cookie is ignored on `/s` | e2e: `/s/fr` in French and `/s/en` in English for the same browser; `share_html_has_no_internal_strings`; unit `share_messages_subset_exact` |
| `NextIntlClientProvider` passing only that subset | Works: the root layout's provider passes what the request config returns | `bundle-scan.txt` (no CRM words in the HTML) |
| `<html lang>` follows | `lang="fr"` / `lang="en"` | e2e toggle test |
| The last `headers()` entry wins for `Referrer-Policy` | Yes: `no-referrer` on `/s` and `/api/share`, `strict-origin-when-cross-origin` elsewhere | `headers.txt` |
| No `Set-Cookie` when the proxy returns early | None on `/s/fr`, `/s/en` or `/api/share/*`, also for a signed-in teammate | e2e `share_public_signed_in_teammate_still_anon`, `share_public_headers_and_robots`; unit (proxy) |
| A route handler reading at most N bytes | `readJsonCapped` (declared length, then a streaming count) | unit request guards; e2e 413 |

The fallback (a separate root layout for the share group) was not needed.

## S5: Vercel

Cannot be checked from this session (no deployment): whether the platform overwrites `x-forwarded-for`, whether a
Firewall rate-limit rule is free on Hobby or Pro, whether POST bodies stay out of runtime logs. The build follows the
decision rule's safe side: the per-IP limiter keys on the first `x-forwarded-for` address and falls back to one shared
key (`unknown`); the database limits stand alone either way. For Haider's preview check (Day 8) and the Gate 1 list.
