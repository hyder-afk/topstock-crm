# Day 6 pre-PR review: the independent items, 15 Oct 2026

The advisor's Day 6 pre-PR review (on `day6a-local` at 400ff4e) split its findings into items that depend on the Team
merge (handled after it) and four that do not. This file records those four. Branch `day6a-local`, local only, fake
data only; nothing pushed.

| Commit | What |
|---|---|
| 7b84c8a | Item 1: no raw invisible characters in source (45 lines, 15 files) |
| b98270d | Item 4: the Day 6d `task_guard` rebase note names Day 5a; item 3's pg_cron half (`docs/evidence/day6d/README.md`) |
| a7a9a71 | Item 2: Master Plan section 9, Day 6, as a plan change for Haider to approve at merge |
| this commit | Item 3's `share_reader` half (`docs/evidence/day6e/README.md`), this README, `bidi/`, log rows |

## 1. Raw bidi and zero-width characters (Trojan Source)

Day 5a's `tests/unit/sql-bidi.spec.ts` (arrives with the merge) fails on any raw U+202A to U+202E, U+2066 to U+2069,
U+200E, U+200F or U+061C in a source file. The Day 6 migrations, schemas, tests and the fake-stock script held such
characters inside their "refuse these characters" classes and test strings.

**Scan** (`bidi/scan.py`: every git-tracked and untracked file, `.csv` exempt, for U+061C, U+180E, U+200B to U+200F,
U+202A to U+202E, U+2060 to U+2064, U+2066 to U+2069, U+FEFF, U+FFF9 to U+FFFB, U+E0000 to U+E007F):

| | Lines | Files |
|---|---|---|
| Before, at 400ff4e (`bidi/scan-before-400ff4e.txt`) | 45 | 15 |
| After, on this branch | **0** | **0** |

The advisor counted 42 lines in 14 files with Day 5a's narrower set; the 3 extra lines are a lone U+FEFF (byte order
mark) in `scripts/make-fake-stock.mjs:32` and `tests/auth/stock-import.spec.ts:47,155`. Day 5a's spec itself, copied
in temporarily and removed: "no raw bidirectional control characters" passed; its first test failed only because it
names files that arrive with the merge (`20261015090000_deals_pipeline.sql`, its own name).

**How each was rewritten**

- SQL (29 lines in `20261017090000_inventory_reads.sql`, `20261018090000_stock_import.sql`,
  `20261019090000_sales_requests.sql`, `20261020090000_client_share.sql`): the regex escape inside a plain `'…'`
  string, `'[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'`, exactly the convention of
  Day 4a's `20261011120000_activity_hardening.sql` and Day 4d's `20261014090000_lead_files.sql` (the regex engine
  reads `\uXXXX`; `standard_conforming_strings` keeps the backslash).
- TS regex literals (`src/lib/inventory/schemas.ts`, `src/lib/sales/schemas.ts`, `src/lib/share/schema.ts`) and
  `scripts/make-fake-stock.mjs`: `\uXXXX` escapes.
- Test strings (`tests/unit/{inventory,sales,share,stock-normalise,stock-schema}.spec.ts`,
  `tests/auth/stock-import.spec.ts`): built with `String.fromCodePoint(0x202e)` / `String.fromCodePoint(0xfeff)`; the
  BOM strip regex is `/^\uFEFF/`.
- `supabase/tests/sales_attack.sql:290` (a JSON literal inside `$q$…$q$`): the JSON escape `"Secret \u202e item"`;
  `jsonb` (and `json ->>`) decode it to U+202E (checked: equal to `'Secret ' || chr(8238) || ' item'`).

**Equivalence proof**

| Check | Result |
|---|---|
| SQL: the 3 distinct classes on the 29 changed lines, old against new, in PostgreSQL 16.15 (scratch cluster, port 54493), every code point 1..0x10FFFF except the surrogates (1,112,063), alone and inside `'ab' … 'cd'` (`bidi/eq-sql.py`, `bidi/eq-sql-output.txt`) | 0 differences; 78, 79 and 73 code points match, the same above U+009F as listed |
| SQL: the rest of each changed line is identical apart from the class | asserted by `eq-sql.py` |
| JS: the 7 changed regex literals over every code point 0..0x10FFFF (and inside a longer string) (`bidi/eq-js.mjs`, `bidi/eq-js-output.txt`) | 0 differences |
| JS: the 8 changed strings by value | all equal |
| `node scripts/make-fake-stock.mjs --check` | exit 0: committed stock fixtures byte-identical |
| `sales_attack` still plants U+202E: a manual mutation dropping `\u202A-\u202E` from `record_sale`'s description pre-check (line 1378), scratch copy | caught by exactly that case (`sales_attack.sql:313: FAIL … "Secret \u202e item"`) |

## 2. Master Plan section 9, Day 6

`docs/TopStock_CRM_Master_Plan.md` section 9 still said "Inventory basics" (log, 11 Oct: Haider's in-depth scope;
the Day 4a advisor round 1 row carried "update Master Plan section 9 for Haider's in-depth inventory scope" to Day 6). The Day 6 entry now describes 6a to 6e as built, under a quoted
note: **plan change (15 Oct 2026), for Haider to approve when Day 6 merges**. Section 10 (Release 2) is unchanged; the
entry ends with what Release 2 keeps.

## 3. Hosted dev pre-check

Read-only, through the Supabase MCP scoped to the DEV project. `share_reader` preconditions:
`docs/evidence/day6e/README.md` "Hosted dev pre-check (15 Oct 2026)"; pg_cron: `docs/evidence/day6d/README.md`, same
heading. In short: PostgreSQL 17.11; `postgres` has CREATEROLE and is not a superuser; `share_reader` does not exist
yet; pg_cron is available (1.6.4) but not installed. **No blocker** for the `share_reader` block (the migration
already lends CREATE on `public` around the ownership hand-over, which a non-superuser needs; simulated locally).
**One decision for Haider:** enable pg_cron on dev before Day 6 merges, or the dev deploy schedules no nightly job.

## 4. Day 6d docs fix

`docs/evidence/day6d/README.md` (rebase points) and two comments in `20261019090000_sales_requests.sql` said "Day 4c
may redefine" `private.task_guard`. Day 4c left it as it was; Day 5a's `20261015090000_deals_pipeline.sql` redefines
it (`deal_id` joins the referential exception). Corrected (comments only).

## Checks (head after these commits)

| Check | Result |
|---|---|
| Bidi scan (`bidi/scan.py`) | 0 lines, 0 files |
| `npm run lint` | 0 errors (3 warnings, as before: TanStack Virtual and the React Compiler) |
| `npm run typecheck` | exit 0 |
| `npm run test:unit` | 402 passed |
| `db-test.sh`, scratch copy on port 54493 (all migrations as they stand after the comment fix) | exit 0: all 16 suites passed (`rls_attack` to `share_concurrency`); advisors 0 ERROR (WARN `anon_security_definer_function_executable` for `share_view` / `share_request` by design, `set_user_role` as before; INFO unindexed FKs 2, unused indexes 10) |
| Mutation anchors (`scripts/db-mutations.py`, all 7 sets, 365 rows): how often each edit's text, mirrored ones included, occurs before and after | identical; every row applies exactly once. Only day4a row 67 ("Task guard: C1 controls pass the title pre-check") touches a changed line (its mirror in `sales_requests.sql:775`; the anchor is the unchanged prefix, so it edits the same logic): re-run on a scratch copy, **caught**. No app-mutation row touches a changed line |
| gitleaks (`git --log-opts=400ff4e..HEAD`, and `dir docs/evidence/day6`) | no leaks found |
| Not run | Playwright e2e (the shared local stack is in use by another agent; no UI change); Semgrep (CI only); hosted advisors (Day 6 is not deployed on dev) |
