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

Checked:
- **Authorisation:** every API function is SECURITY INVOKER with `search_path = ''`; the restrictive aal2 policy stays on
  every table; leads and contacts are readable org-wide (Haider, 10 Oct) and changeable by the owner, managers and admins;
  deletes need a two-factor code from the last 10 minutes; owners must belong to the caller's org (trigger), only managers
  and admins assign them; org_id is always server-set. Attack test: all checks pass, 8 deliberate breaks all caught.
- **Injection:** no dynamic SQL in the app functions; sort is whitelisted; search and city text reach `ilike` only as
  parameters with LIKE wildcards escaped (tested: "%" and "_" match nothing); route handlers and server actions Zod-parse
  every argument and pass whitelisted fields to one RPC each.
- **Route handlers and proxy:** `/api/leads` and `/api/leads/[id]` require an aal2 session (`apiSession`, JWT verified by
  `getClaims`); signed-out API calls get JSON 401 (tested); responses are `private, no-store`.
- **Data exposure:** list, detail and team return same-org rows only; saved views only the caller's own (tested).
- **Client:** no `dangerouslySetInnerHTML`; `tel:` links keep digits only; the `lead` URL value is checked as a UUID
  before use and again on the server.
- **Local-only gateway (scripts/local-auth, never deployed):** psql runs without a shell, values travel as psql variables
  quoted as literals, names are `%I`-quoted and must match a strict pattern, requests run as the caller's role with the
  caller's claims (RLS applies), HS256 checked with `timingSafeEqual`, listens on 127.0.0.1.
- **Dependencies:** pinned exactly; `npm audit --omit=dev`: 0 vulnerabilities; gitleaks: no leaks.
