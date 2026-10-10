# /security-review: Day 3a (leads are companies; leads list, preview, contacts), 10 Oct 2026

Reviewed: the full branch diff against main (migration 20261010090000, RPCs, RLS, route handlers, server actions, proxy,
client components, local-only gateway). Method: the /security-review skill (candidate search, then false-positive filter,
report only confidence 8/10 or higher).

**No findings** at confidence 8/10 or higher.

Considered and hardened anyway (below the bar, cheap to close):
- **Activity time chosen by the client (5/10):** `activities.created_at` could be set by the caller, so anyone could push
  another rep's lead "last activity" into the future. Now `private.set_activity_time` sets it to the server's clock for app
  users (imports without a user may keep historical dates) and it never changes afterwards. Attack test added; removing the
  trigger makes it fail.
- **Deal on another rep's contact (6/10):** a deal with no company could point at another rep's contact. Deals now need a
  contact whose lead the caller may change, and the same lead as the deal when both are set. Attack test added; reverting
  the rule makes it fail.
- **Last activity written directly (advisor round 1, 8/10):** see "Column grants" below. Fixed and tested.

Checked:
- **Authorisation:** every API function is SECURITY INVOKER with `search_path = ''`; the restrictive aal2 policy stays on
  every table; leads and contacts are readable org-wide (Haider, 10 Oct) and changeable by the owner, managers and admins;
  deletes need a two-factor code from the last 10 minutes; owners must belong to the caller's org (trigger), only managers
  and admins assign them; org_id is always server-set. Attack test: all checks pass. Deliberate breaks are all caught:
  8 in the first round, plus the column grant and the search helper's two checks.
- **Injection:** `list_leads` and `count_leads` use `EXECUTE format(...) USING ...` so each call is planned with its real
  values (keyset indexes). Every piece of SQL text in them is a constant: the filter (`private.lead_filter_sql()`) and the
  sort key, cursor condition and direction, which are picked from fixed strings by the whitelisted sort name. User values
  only travel as `USING` parameters. Search and city text reach `ilike` only as parameters with LIKE wildcards escaped
  (tested: "%" and "_" match nothing). Route handlers and server actions Zod-parse every argument and pass whitelisted
  fields to one RPC each.
- **Column grants (advisor round 1):** the table-wide INSERT/UPDATE grant from Day 1 let anyone who may edit a lead write
  `last_activity_at`, `created_at` or `import_batch_id` straight through the REST API. Now authenticated may write only
  the form fields: companies (name, website, industry, owner_id, lead_status, phone, email, city, country) and contacts
  (company_id, first_name, last_name, title, email, phone). Attack tests: a rep and an admin get `insufficient_privilege`
  on each server-kept column; removing the revoke makes them fail.
- **The one new SECURITY DEFINER function, `private.search_lead_ids`:** it exists only for speed. Under row level security
  `ILIKE` cannot use the trigram indexes, so a search read all 30k leads; see perf.md. It has `search_path = ''`. It
  applies the read policies' own rule (the caller's org, with two-factor) and returns lead ids only. The list and count
  then read the leads under row level security, so even a wrong id would not show. It lives in the private schema, which
  the API cannot reach, and anon cannot execute it. Attack tests: anon refused, aal1 gets nothing, rep A never gets
  the other org's lead or contact match. Removing the org check or the two-factor check each makes a test fail.
- **Route handlers and proxy:** `/api/leads` and `/api/leads/[id]` require an aal2 session (`apiSession`, JWT verified by
  `getClaims`); signed-out API calls get JSON 401 (tested); responses are `private, no-store`.
- **Data exposure:** list, detail and team return same-org rows only; saved views only the caller's own (tested).
- **Client:** no `dangerouslySetInnerHTML`. `tel:` links keep digits only. `mailto:` links percent-encode the address, so
  a "?" or "&" in a stored or imported address cannot add a subject, a body or more recipients (tested). Saved views
  are checked with the same schema as URL filters when loaded, and a malformed one is left out (tested). The `lead` URL
  value is checked as a UUID before use and again on the server.
- **Local-only gateway (scripts/local-auth, never deployed):** psql runs without a shell, values travel as psql variables
  quoted as literals, names are `%I`-quoted and must match a strict pattern, requests run as the caller's role with the
  caller's claims (RLS applies), HS256 checked with `timingSafeEqual`, listens on 127.0.0.1.
- **Dependencies:** pinned exactly; `npm audit --omit=dev`: 0 vulnerabilities; gitleaks: no leaks.
