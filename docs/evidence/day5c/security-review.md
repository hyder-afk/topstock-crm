# Day 5c security review

Scope: every Day 5c commit on `day5a-local` after 397cee8 (the migration `20261015150000_home_dashboard.sql`, the Home
libraries and routes, the Home UI, messages, tests). Reviewed by hand against CLAUDE.md's SECURITY list and the design's
threat table (section 6), because the `/security-review` skill reads the main checkout's branch, not this worktree (as
noted for Day 5b). Result: **no open findings**. Two issues found while building were fixed (below).

## The figures (threats 1, 2, 18, 24)

| Threat | Control | Proof |
|---|---|---|
| 1 Stolen aal1 session | every Home RPC refuses a caller without aal2 (42501) before reading anything; anon has no EXECUTE | `home_attack.sql` block 2 (aal1 and anon, every function) |
| 2 Another org's figures | INVOKER functions; every row passes RLS; Team filters on `private.current_org_id()`, Mine on the caller | block 4 (exact figures in a separate org), block 6 (hand counts in the TopStock org with Home Org rows planted, and Home Org seeing none of TopStock's), mutation 6 (DEFINER) |
| 18 Figures leaking rows | no view, no materialised view, no DEFINER; scope checked first (Team for managers and admins: 42501 `scope`; other values 22023 `bad_scope`); the feed's return type has no `body` and no `lost_note` | block 0 (function rules, the feed's column list in `pg_proc`, no `body`/`lost_note` in its source, no views in `public`/`private`), block 3, block 8 (planted note text absent, undo pairs hidden), mutations 1, 5, 11, 14, 15 |
| 24 Browser clock or zone for "today" / "this month" | the server's `now()` and the profile zone (`private.caller_zone`, unknown zones fall back to Paris); `private.home_window` is the only place the bounds are computed | block 1 (fixed instants: Karachi vs Paris on 31 Oct, the 25 Oct and 29 Mar clock changes), block 5 (calls and won deals at each zone's boundary), e2e `karachi_today_boundary`, mutations 2, 3, 9 |
| 28 SQL or filter injection | static SQL; scope and limits whitelisted in SQL and Zod; no user text reaches a filter | block 3 (`'mine; drop table deals'` → 22023), unit `home-schema.spec.ts`, route tests (400 on unknown parameters) |

Tasks due and Today's tasks are always the caller's own, whatever the scope (mutations 7 and 16, checked as an admin
who may read every task). Win rate leaves out "Opened by mistake" and shows only from 5 closed deals (mutations 4, 10).

## The app

- `GET /api/home?scope=`: `apiSession()` (aal2), `z.strictObject` query (unknown parameters 400), `Cache-Control:
  private, no-store`, read-only; a rep's Team answers 403 from the database's own 42501. Each part is parsed with Zod on
  the server; unknown keys are dropped (unit test: a `pp` purchase cost in the Day 6 low-stock payload never reaches the
  browser), and a wrong shape is that card's error, never raw data.
- `GET /api/queue/summary`: since the 4c rebase this is Day 4c's route (its `summaryParams` strictObject, `apiSession`,
  403 for a scope reserved to managers, `no-store`); 5c's stand-in and its `{ready:false}` branch are gone.
- Today reads Day 4c's `list_tasks` and `count_tasks` with `p_scope: 'mine'` written in the server code (never from the
  client), so an admin's Team view still shows only her own tasks (home_attack block 9: Team counts 0 of a rep's tasks).
  Rows are parsed with Zod (unknown columns dropped).
- The scope cookie `topstock.home.scope` is a preference, not a permission: the server keeps only `team`/`mine`, reps
  always get Mine (`effectiveScope`, unit-tested), and the database checks the scope on every call. `SameSite=Lax`,
  `Secure` on HTTPS, no secret in it.
- Ticking a task uses the lead page's existing `setTaskDone` server action (strictObject, `set_task_done` RPC, RLS); the
  deal sheet over Home reuses Day 5b's sheet and flows unchanged (step-up for reopening a won deal or deleting).
- No `dangerouslySetInnerHTML`; every text (lead names, task titles, first names) is React text. No hardcoded strings
  (EN/FR messages). No raw errors: cards say "Couldn't load · Retry".
- No new dependency; `npm audit --omit=dev` 0; gitleaks on the branch (64 commits): no leaks.

## Found and fixed while building

1. A scope switch tapped while the cards were still hydrating made React discard the server HTML (recoverable error
   418, seen in the screenshot run). Not a data leak, but an error path; the switch now updates in a transition
   (6bd5a7d).
2. `/api/queue/summary` answered 502 on this branch on every Home visit, which logged a console error in every spec that
   opens Home. It answered `{ready:false}` while the function was missing (4d1e571); superseded at the 4c rebase by 4c's
   own route.
3. Verifier round 1 (15 Oct): focus no longer drops to `<body>` when a Needs attention row leaves under the deal sheet
   (not a security issue; keyboard users kept their place). No new route, action, RPC or dependency.

## Residual risks (accepted, as in the design)

- An admin or manager sees the org's figures in Team, by design (D28). A stolen aal2 session reads the same figures the
  person could read on the board and the lead pages; nothing new is exposed.
- Recent activity shows colleagues' first names and lead names (never entry text), the same as the timeline shows.
- The Day 6 contract (`home_low_stock`) is enforced on the app side by Zod; Day 6's own function must keep PP out of its
  payload (design section 10).
