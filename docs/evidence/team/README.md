# Team screen: admins change roles (More > Team), 12 to 14 Oct 2026

Why: go-live parts A and K (`docs/go-live.md`) say admins change roles on a screen, never with SQL. Haider's decision
(12 Oct): Henri and Kais get hand-made accounts with a temporary password, sign in, enrol TOTP, choose their own
password at `/set-password`; the auth trigger makes them `rep`; Haider then makes them admin here.

Local branch `team-local`, cut from `origin/main` a7aa89e. Self-contained: one migration (verifier round: it replaces
`set_user_role` so two admins cannot demote each other to none), no new database function, no new dependency, no
change to shared components beyond one new body key in the step-up dialog and a small `ArrivalFocus` helper in
`src/components/shell`. Days 4c/4d/5/6 are not
in it. `docs/go-live.md` is not on `main` yet: 92cf4b3 adds it exactly as on the go-live kit branch (59a231d), so the
Team clicks on top of it (5be4799) rebase cleanly whichever merges first.

## What changed

- **Rules** (`src/lib/team.ts`): `roleChangeInput` = Zod `strictObject({ userId: uuid, role: enum(admin, manager,
  rep) })`; `roleChangeError` turns a refusal of `set_user_role` into a code (SQLSTATE and hint only, never the
  database's message); `errorMessageKey`; `sortPeople` (you first, names A to Z by the locale's collation, then people
  without a name, oldest first); `toPeople` (rows checked with Zod before they reach the screen).
- **Server action** (`src/app/(app)/more/team/actions.ts`): Zod first, `requireSession()` (aal2), a pre-check that the
  code is fresher than 10 minutes minus 30 s (it can only refuse earlier than the database, never allow), then
  `rpc("set_user_role", { target_user, new_role })` with named args. Answers are codes only (`step_up`, `last_admin`,
  `forbidden`, `not_found`, `invalid`, `unavailable`). `set_user_role` answers 42501 without a hint for three causes;
  after such a refusal the action reads the caller's own role once more to tell "not an admin" from "last admin".
- **Page** (`src/app/(app)/more/team/page.tsx`): `requireAdmin()` (404 for everyone else), reads `public.profiles`
  (RLS keeps it to the caller's organisation), dates written once on the server with Intl in the person's time zone;
  error block with Try again (focus goes to the title, never to `<body>`), empty state, the Roles card with plain
  EN/FR descriptions.
- **List** (`src/components/team/team-list.tsx`): each person's name (or **No name yet**), a **You** marker, the
  account date, the role button (44 px) with a menu of the three roles and what each may do; the confirmation names the
  person and the new role and warns when you step yourself down ("You will lose the admin screens…"); then
  `useStepUp` ("Confirm it’s you") if the code is older than 10 minutes; the row shows the new role at once and goes
  back if the database refuses, with the reason under the row (also the button's `aria-describedby`); one polite live
  region says saving, saved, refused and cancelled; the focus returns to that row's role button after confirm, cancel,
  Escape, a refusal and "Confirm it’s you". Stepping yourself down lands you on More, drawn again without the Team row,
  with the focus on More's title (`ArrivalFocus`; the role button is gone with the page). Each row has its own save
  (a number and a busy state; an older call's answer is ignored); a role set here stays shown until the page draws a
  list read after the database answered (the page passes the server's time it read the list, the action returns the
  server's time of the answer), whatever role that list shows; a lost answer puts the row back and reads the list
  again, since the database may have saved it ("Couldn’t confirm the change just now…").
- **More** (`src/app/(app)/more/page.tsx`, `src/components/team/team-entry.tsx`): an Administration > Team row for
  admins only (server component; others never get it in the HTML). `more/loading.tsx` keeps its place.
- **Skeleton** (`src/app/(app)/more/team/loading.tsx`): back link, title, sentence (3 lines on phones), three rows with
  the 44 px button (and the description column from 1280), the Roles card. No spinner.
- **Words**: `messages/en.json` and `messages/fr.json` (`Team.*`, `StepUp.bodyRole`), French with narrow no-break
  spaces before `: ; ? !` and typographic apostrophes (unit test).
- **Go-live**: part A asks Claude to confirm that More > Team is live in the go-live commit; part K has the exact
  clicks (More > Team > the person > Role > Admin > Confirm > code).

### What identifies someone without a name

`public.profiles` holds `id`, `org_id`, `first_name`, `last_name`, `role`, `language`, `timezone`, `created_at`,
`updated_at`. No email: that is in `auth.users`, which would need the service key or a new SECURITY DEFINER function
(both ruled out). Chosen: **No name yet**, the first 8 characters of the user id (`User ID c9b5074f`, the start of the
UID the Supabase dashboard lists under Authentication > Users, which is where Haider creates the accounts) and the day
the account was created, plus a hint that the name appears once they add it under More > Your name. Language and time
zone were left out (they do not tell people apart).

### Database

Reading: admins (all three users) already read their organisation's `profiles` (`profiles_select`, plus the
restrictive `require_mfa`); no change. `set_user_role` (core schema) already checked admin and
`has_recent_aal2(600)`, same organisation, never the last admin, and wrote an audit row; those cases live in
`supabase/tests/rls_attack.sql` (rep promoting self, aal1, code 660 s old, no code time, applied, last admin, other
organisation, audit row).

Verifier round: `supabase/migrations/20261021090000_role_change_lock.sql` replaces `set_user_role` (same signature,
SECURITY DEFINER, `search_path = ''`, constant messages, grants re-stated). It locked only the target's row before
counting admins, so two admins demoting each other at the same moment both counted two and both committed (the new
test failed exactly that way on the old function: "both demotions committed (admins left: '')"). Now, after the admin
and fresh-code check, it locks every admin row of the organisation in id order, checks again that the caller is an
admin (one demoted while the call waited is refused), then locks the target and counts. The timestamp is after every
migration on the other open branches (up to 20261020090000); none of them touches this function.
`supabase/tests/team_concurrency.sh` (in `scripts/db-test.sh` and the CI `db` job): `demote_each_other_keeps_an_admin`,
`demoted_admin_cannot_demote` (a deadlock answer 40P01 also fails it), `demoted_admin_cannot_promote`. Mutation set
`team` in `scripts/db-mutations.py` (run in a throwaway worktree, db-test copy on port 54416):

| # | Protection removed | Result |
|---|---|---|
| 1 | The organisation's admin rows not locked (two admins demote each other and none is left) | caught (`demote_each_other_keeps_an_admin`) |
| 2 | The target locked first and the caller checked before the admin rows (a demoted admin still acts) | caught (`demoted_admin_cannot_demote`) |
| 3 | The caller not checked again after the wait | caught (`demoted_admin_cannot_demote`) |
| 4 | No last-admin count | caught (`rls_attack.sql` "removed the last admin") |

The id order of the admin locks is by design: each call takes all of them at its start, so no test can interleave two
calls between those locks (dropping `order by id` would not be seen by a test, so it is not listed as a row).

## Merge of main (5f1a966), 15 Oct 2026

`origin/main` at 5f1a966 (Day 4c tasks and work queue, plus the go-live kit docs) merged into this branch with a merge
commit (cbfb1f8, no rebase). Ten files conflicted; each keeps both sides:

| File | Resolution |
|---|---|
| `.github/workflows/db.yml` | main's queue attack and queue concurrency steps, then the Team role-change step; header lists both |
| `scripts/db-test.sh` | `queue_attack.sql`, `queue_concurrency.sh`, then `team_concurrency.sh`, then the advisors |
| `playwright.auth.config.ts` | WebKit runs `shell, leads, import, lead-page, queue, queue-multi, tasks, team`; comment names both |
| `scripts/db-mutations.py` | `MIG_4C` and `MIG_TEAM`; the day4c set, then the team set; `--set day3b, day4a, day4b, day4c, team, all` |
| `src/components/auth/step-up-dialog.tsx` | body key union `body, bodyDelete, bodyDeleteTask, bodyRole` |
| `src/app/(app)/more/page.tsx` | both imports: main's time zone section and the Team entry with `ArrivalFocus` on the title |
| `messages/en.json`, `messages/fr.json` | `StepUp.bodyDeleteTask` and `StepUp.bodyRole`; key union checked against both parents (1015 keys, EN = FR, no duplicates) |
| `docs/go-live.md` | main's text, with this branch's paragraphs in part A (decision 3, the part A check) and part K (More > Team steps) |
| `docs/log.md` | every row from both sides, in date order |

`src/app/(app)/more/loading.tsx` merged on its own (Team block and main's time zone block); its comment now names the time
zone. The migration `20261021090000_role_change_lock.sql` is unchanged: main's migrations (up to
`20261013090000_tasks_queue.sql`) never redefine `set_user_role` after the core schema, so the lock still sits on main's
latest version. `tests/auth/helpers.ts`, the shell and `next.config.ts` did not conflict (no `turbopack.root` committed).

Checks on the merge (npm ci, lint, typecheck and unit in a scratch copy, because this worktree's `node_modules` links to the
main checkout):

```
npm ci              scratch copy                           exit 0 (lockfile unchanged by either side)
lint                npm run lint                           exit 0 (0 errors; the 2 existing TanStack Virtual warnings)
typecheck           npm run typecheck                      exit 0
unit                npm run test:unit                      366 passed
db                  scripts/db-test.sh copy, port 54495,   all ten suites pass: rls, import (+ concurrency), activity
                    ROOT = this worktree                   (+ concurrency), outcome (+ concurrency), queue_attack,
                                                           queue_concurrency, team_concurrency; advisors: no ERROR
                                                           (WARN set_user_role SECURITY DEFINER, accepted Day 1;
                                                           INFO unindexed_foreign_keys 4 (2 from 4c, accepted), unused_index 2)
mutations           db-mutations.py --set team (scratch)   4 rows run, 4 caught; every row of all five sets still applies once
gitleaks            git --log-opts=origin/main..HEAD       no leaks found (14 commits)
e2e                 team.spec.ts, team-screens.spec.ts     not run: the shared local auth stack on 3100 was busy with
                                                           another builder's Playwright run (Day 5a); run before the PR
```

## Check results after the verifier round (14 Oct 2026, code head 6d07187)

```text
lint        npm run lint                                   exit 0 (0 errors; 2 warnings, pre-existing, import/leads virtualizers)
typecheck   npm run typecheck                              exit 0
unit        playwright -c playwright.unit.config.ts        exit 0, 342 passed (tests/unit/team.spec.ts: 21; the 9 new
                                                           "local roles" tests failed 6 of 9 first on stubs with the
                                                           old rules, then passed)
db          copy of scripts/db-test.sh on port 54415       before the migration: exit 1, "FAIL: demote_each_other_keeps_an_admin:
                                                           both demotions committed (admins left: '')"; after: exit 0,
                                                           rls_attack, import_attack, import_concurrency, activity_attack,
                                                           activity_concurrency, outcome_attack, outcome_concurrency,
                                                           team_concurrency all passed; advisors: no ERROR (WARN
                                                           set_user_role SECURITY DEFINER, accepted Day 1; INFO
                                                           unindexed_foreign_keys 2, unused_index 2)
mutations   db-mutations.py --set team (worktree, 54416)   exit 0, 4 of 4 caught
e2e         team.spec.ts (Chromium, local auth stack)      before the focus fix: exit 1, 4 passed, demoting_yourself failed
                                                           at toBeFocused (More's title "inactive"); after: exit 0, 5 passed
e2e         team-screens.spec.ts + shell.spec.ts +         exit 0, 25 passed, 1 skipped (as on main); 50 shots, no console
            day4-chunks.spec.ts (Chromium)                 error, no sideways scroll
gitleaks    git --log-opts=origin/main..HEAD               exit 0, no leaks found (13 commits to f9a92bb)
npm audit   --omit=dev                                     exit 0, found 0 vulnerabilities
```

The local build needs `turbopack.root` set to `/home/user` because this worktree's `node_modules` is a symlink to the
main checkout's; it was added for the build only and reverted (not committed).

## Check results (14 Oct 2026, head ed2ad60 plus the evidence commit; before the verifier round)

```text
lint        npm run lint                                   exit 0 (0 errors; 2 warnings, pre-existing, import/leads virtualizers)
typecheck   npm run typecheck                              exit 0
unit        playwright -c playwright.unit.config.ts        exit 0, 333 passed (tests/unit/team.spec.ts: 12)
db          copy of scripts/db-test.sh on port 54401       exit 0: rls_attack, import_attack, import_concurrency,
                                                           activity_attack, activity_concurrency, outcome_attack,
                                                           outcome_concurrency all passed; advisors: no ERROR
                                                           (WARN set_user_role SECURITY DEFINER, accepted Day 1;
                                                           INFO unindexed_foreign_keys 2, unused_index 2)
e2e         team.spec.ts (Chromium, local auth stack)      exit 0, 5 passed (twice, after the fix)
e2e         team-screens.spec.ts (Chromium)                exit 0, 4 passed, 50 shots, no console error, no sideways scroll
e2e         shell.spec.ts + day4-chunks.spec.ts (More)     exit 0, 21 passed, 1 skipped (as on main)
gitleaks    git --log-opts=origin/main..HEAD               exit 0, no leaks found
npm audit   --omit=dev                                     exit 0, found 0 vulnerabilities
```

Not run locally (CI only): WebKit (`team.spec.ts` is in the WebKit project's `testMatch`), Semgrep, `journey.spec.ts`
(needs Mailpit).

E2E tests (`tests/auth/team.spec.ts`, people in an organisation made for the run, titles with a run id):
`admin_promotes_rep_with_fresh_code` (the More > Team path, keyboard into the menu, confirmation text, no step-up,
focus back on the row, announcement, role and audit row in the database), `rep_cannot_see_or_reach_team` (no row on
More, 404 on the page, the admin's own server-action request replayed with the rep's session answers `forbidden`, role
and audit log unchanged; with `org_id` added it answers `invalid`), `stale_code_asks_for_a_code` (Cancel keeps the
role and focus; a fresh code saves it; the row keeps the new role after the page is drawn again),
`last_admin_refused` (row goes back, says why, button described by it, focus back), `demoting_yourself` (at 390:
44 px confirmation buttons, lands on More without Team, the focus on More's title).

Found and fixed in this round (ed2ad60): after "Confirm it’s you" the saved role was shown as the old one. The code
check renews the session cookies, Next.js draws the page again, and that drawing (read before the change) replaced the
row. The database was right. A role set on the screen now stays until the server's list shows it, and the list is
refreshed after a save.

Evidence: `security-review.md`, `apple-design-audit.md`, `web-design-guidelines.md`, `screens/` (50 shots, see its
README).

## Docs used

Context7 pages consulted in the verifier round (14 Oct):
- **Next.js** (`/vercel/next.js`): `docs/01-app/03-api-reference/04-functions/use-router.mdx` (`router.replace`,
  `router.refresh` keeps client state) and `docs/03-architecture/accessibility.mdx` (the route announcer reads the
  title or the h1; nothing moves the focus on a client navigation, hence `ArrivalFocus`).
- **PostgreSQL 16** (`/websites/postgresql_16`): `transaction-iso.html` 13.2.1 (under Read Committed a `SELECT FOR
  UPDATE` that waited re-checks its WHERE on the updated row: a demoted admin's row drops out of the lock set, and a
  new statement sees the committed role) and `explicit-locking.html` (deadlocks from rows locked in opposite orders;
  hence one id order).

Context7 pages consulted (14 Oct, first round):
- **next-intl** (`/amannn/next-intl`): `docs/usage/translations.mdx`, rich text with `t.rich` and tag functions (the
  monospace user id inside the translated "User ID <mono>{id}</mono>").
- **Next.js** (`/vercel/next.js`): `docs/01-app/02-guides/data-security.mdx` (a page's check does not protect its
  Server Actions; re-check authn and authz inside the action), `forms.mdx`, and `action-handler.ts` (Origin vs Host
  check on every Server Action request).
- **supabase-js** (`/supabase/supabase-js`): `PostgrestClient.rpc` (object args sent as a POST body, so named args),
  `PostgrestError` (`code`, `hint`, `details`, `message`; an aborted request has an empty code, which maps to
  `unavailable`).
- **Radix Primitives** (`/websites/radix-ui_primitives`): `dropdown-menu.md` (`RadioGroup` `value` /
  `onValueChange`, `RadioItem`), `dialog.md` and `alert-dialog.md` (controlled `open` / `onOpenChange`,
  `onCloseAutoFocus`, Escape returns focus).

## Deviations and choices

- No role badge colours: roles are words on a quiet button (DESIGN.md keeps status colours for dots and labelled
  badges; a role is not a status).
- Confirm is the neutral button, not Signal Red: a role change is not the page's primary action.
- The profiles read has no `.order()` or `.limit()`: the organisation is a handful of people, `sortPeople` orders it,
  and the local REST stand-in (`scripts/local-auth/gateway.mjs`) serves only `select` plus `eq` filters.
- `/security-review` was applied by hand to this branch's diff (the skill reads the primary checkout, which is on
  another branch); see `security-review.md`.

## Open risks

- ~~Two admins demoting each other at the same instant~~: fixed in the verifier round by the migration above. Haider
  decides whether it ships with this screen (builder recommends yes, before go-live): it changes a core-schema function.
- More's skeleton always draws the Administration block (verifier note 7): kept while every user is an admin; when
  roles diverge, non-admins will see that block's place close once More loads.
- The role button's name for someone without a name says "Account c9b5074f" while the row shows "User ID c9b5074f"
  (same characters; kept).
- ~~`docs/go-live.md` comes from the unmerged go-live kit branch~~: merged with main on 15 Oct (main's text, this
  branch's part A and K paragraphs).
- The Team e2e specs have not run on the merged code yet (local auth stack busy); the Day 4d and Day 5 merges are still
  to come.
- WebKit and Semgrep run only in CI.
