# Day 0 checks: dev connection and tool 4 (9 Oct 2026, TopStock session)

Session in the TopStock environment, branch `claude/epic-galileo-6exs8p` (fast-forwarded to `claude/busy-darwin-xech8m` at 790173a).
No key, token or password was printed or stored; values below are masked or public.

## 1. Environment variables

```
SUPABASE_DEV_PROJECT_REF   = swhkafqlmfhvgpsgdqjp            (matches Haider's reference)
NEXT_PUBLIC_SUPABASE_URL   = https://swhkafqlmfhvgpsgdqjp.supabase.co (matches)
NEXT_PUBLIC_SUPABASE_ANON_KEY = sb_publishable... (a publishable key, not a secret key)
```

## 2. Dev project connection (public key only)

```
GET /auth/v1/health                       -> 200 (0.8 s)
GET /rest/v1/                             -> 401 (expected: publishable keys may not read the API schema)
GET /rest/v1/_probe_does_not_exist        -> 404 PGRST205 "Could not find the table" (key accepted, database answering, schema empty)
GET /auth/v1/settings                     -> disable_signup: False, mailer_autoconfirm: False, providers on: ['email']
```

Open sign-ups are still on. Cloud Workflow section 6 already requires them off before any app screen ships to production;
they will be set from code (`supabase/config.toml`, Day 1).

## 3. Tool 4: Supabase MCP (dev, read-only)

The `supabase` server did not load as an MCP tool in this session: the session started from `main`, which does not have
the `.mcp.json` entry yet (it is on this branch). So the exact URL from `.mcp.json` was checked over the MCP protocol with
`docs/evidence/day0/mcp_probe.py` (`python3 -I docs/evidence/day0/mcp_probe.py .mcp.json`). The token is added by the
session proxy from the network secret `Supabase dev MCP`; it never appears in the session. (First attempt was blocked by
Cloudflare for Python's default user agent, error 1010; the script now sends its own user agent.)

```
URL: https://mcp.supabase.com/mcp?project_ref=swhkafqlmfhvgpsgdqjp&read_only=true&features=database,debugging,development,docs
server: {'name': 'supabase', 'title': 'Supabase', 'version': '0.13.0'}
tools (10): execute_sql, generate_typescript_types, get_advisors, get_project_url, get_publishable_keys, list_extensions, list_migrations, list_tables, query_logs, search_docs
  absent list_projects        True
  absent list_organizations   True
  absent create_project       True
  absent get_organization     True
  absent apply_migration      True
  absent deploy_edge_function True
  absent create_branch        True
(a) list_tables: {"tables":[]}
    get_project_url: {"url":"https://swhkafqlmfhvgpsgdqjp.supabase.co"}
    select: [{"current_database":"postgres","ro":"on"}]
(c) write: isError=True: {"error":{"name":"HttpException","message":"Failed to run sql query: ERROR:  25006: cannot execute CREATE TABLE in a read-only transaction\n"}}
    after: [{"probe_table":null}]
```

- (a) pass: `list_tables` works; the only project reachable is the dev project (URL above). Empty schema, as expected before Day 1.
- (b) pass: no account tools (`list_projects`, `list_organizations`, `create_project`, `get_organization`), so no other project can be listed or reached through this server; no `apply_migration`.
- (c) pass: a write is refused as read-only (`transaction_read_only = on`), and the probe table does not exist afterwards.

## 4. Supabase advisors (dev, baseline)

```
security advisors:    {"lints":[]}
performance advisors: {"lints":[]}
migrations:           []
```

Clean, because there is no schema yet. They run again after every migration from Day 1.

## 5. Context7 (tool 3) in this session

The repo's `context7` server loaded, but the first query returned:
`Monthly quota exceeded. Create a free API key at https://context7.com/dashboard for more requests.`
`mcp.context7.com` itself is reachable. A second copy from an account plugin (`plugin:context7:context7`) failed to
connect because it calls `clerk.context7.com`, which is not on the TopStock network list; the repo's copy does not need it.
Context7 is mandatory before writing library code (Day 1), so this needs a free API key (Haider's decision; see Gate 0).
