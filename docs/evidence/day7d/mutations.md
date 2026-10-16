# Day 7d: Day 5a mutation rows 64 to 73 re-run (plan section 2 item 20, scope A 7d)

Harness: `scripts/db-mutations.py --set day5a 58 64 65 66 67 68 69 70 71 72 73` in a throwaway copy of this branch
(`/tmp/day7d-builder/mut`, `git ls-files` copy), `db-test.sh` on port 54669. For each row the migration is changed in
place, every database suite runs (all attack files, the concurrency scripts, `gate1_attack.sql`, the advisors), and the
migration is restored. A baseline `db-test.sh` passed on the same copy first.

Why now: on 15 Oct rows 64 to 73 were not re-run (deadline), and row 58, a documented two-layer row that must stay NOT
CAUGHT, was caught for the wrong reason: `deal_links_attack.sql` block 3 met 31 deals opened by r1 in the last hour (28
committed by `deal_concurrency.sh`, 3 from block 2's DECLARE section, which runs before the block's TS001 savepoint).

## Round 1 (after the first fix: fixtures out of DECLARE, commit 35c58bd)

Rows 64 to 73: 10 of 10 caught. Row 58: still "caught, but listed as NOT CAUGHT", first failure `too many deals opened
in an hour` at `deal_links_attack.sql` block 3 (reproduced with the full output: every suite before it passed). Cause:
`deal_concurrency.sh`'s 28 committed deals plus block 3's own opens reach 30 under the mutated guard (live deals), while
the real guard counts `private.deal_opens`, which the file's setup already clears.

## Round 2 (final: the setup also deletes r1's deals from the earlier files, commit 97470a3)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 58 | Guard: the open flood guard counts live deals only (since verifier round 2 the statement-level recount counts the open records) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 64 | update_deal: no owner pre-check, and the guard lets the owner be emptied (both layers) | caught | FAIL: "select public.update_deal('7a42f4e3-a44d-46cf-a3a1-2c1934a50fae', 0, '{owner_id}', p_owner => null)" succeeded, expected 22023 |
| 65 | delete_deal: the creator's window ignores the call's undo record (a refused delete answers P0002) | caught | FAIL: "select public.delete_deal('c104be63-8fce-4245-8f5a-6b87a86eb095')" gave P0002 (hint "", deal not found), expected 42501 (hint "step_u |
| 66 | Open flood: no statement-level recount (a bulk insert passes the 30-an-hour limit) | caught | FAIL: "insert into public.deals (company_id) select 'c0df26d8-dc4a-4f7f-a6cf-d8c4cf1c47a8'::uuid from generate_series(1, 31)" succeeded, exp |
| 67 | Open flood: the statement-level recount allows 31 an hour | caught | FAIL: "insert into public.deals (company_id) select 'aecaf401-3337-47fd-952d-a66501e83d4b'::uuid from generate_series(1, 31)" succeeded, exp |
| 68 | Stage flood: no statement-level recount (a bulk PATCH passes the 120-a-minute limit) | caught | FAIL: "update public.deals set stage_id = private.stage_id('qualified') where id = 'f2f1a4c6-7f04-4acf-8ef0-1a4c5b219043'" succeeded, expect |
| 69 | Stage flood: the statement-level recount is INVOKER (history on a deal handed on is not counted) | caught | FAIL: flood trigger function private.deal_move_flood() must be DEFINER, search_path empty, revoked from everyone |
| 70 | Stage flood: the statement-level recount runs for edits that change no stage | caught | too many stage changes in a minute |
| 71 | Open flood: no guard and no statement-level recount (both layers of row 27) | caught | FAIL: "select public.open_deal('be4e0baf-329f-453a-9b42-9dd25b03c783')" succeeded, expected 22023 |
| 72 | Stage flood: no guard and no statement-level recount (both layers of row 28) | caught | FAIL: "update public.deals set stage_id = private.stage_id('qualified') where id = 'eaf1f325-c61d-4b6f-8549-e0cc39232570'" succeeded, expect |
| 73 | Open flood: the guard counts live deals only, and no statement-level recount (both layers of row 58) | caught | FAIL: "select public.open_deal('eeb61087-d7b8-4e58-b412-65341a85267b')" succeeded, expected 22023 |

day5a: 11 rows run: 10 caught, 1 documented two-layer rows not caught, 0 not as listed

**Result: rows 64 to 73, 10 of 10 caught; row 58 NOT CAUGHT as documented (its second layer, the statement-level
recount, is what rows 66 to 73 test; row 73 removes both layers and is caught).** Each first failure is the protection's
own test.

## Anchors of every set

`python3 scripts/db-mutations.py --anchors` on this branch: 660 rows in 15 sets apply and land in the live definition.
Before this commit one row was dead on the base (`day7f-local`): day6e row 10 ("share_take writes a count when it
refuses"), because Day 7f's `20261022130000_share_take_paris_day.sql` redefines `private.share_take` and the harness
did not know it. `REDEFINERS` now includes that migration, so the edit is mirrored into the live copy; the row's real
run is below.

| Set, row | Protection removed | Result | First failure |
|---|---|---|---|
| day6e 10 | share_take writes a count when it refuses (edit now mirrored into the Day 7f redefinition) | caught | FAIL: share_view_over_limit_writes_nothing / share_unknown_token_writes_nothing: 62 counter steps |
