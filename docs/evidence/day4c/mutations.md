# Day 4c: every protection removed one at a time, 12 Oct 2026

## Full run (44277d3, with reruns on 8192480 and b235bad), 12 Oct 2026

The whole day4c set ran on the final migration (the three commits differ only in the mutation list and the
concurrency scripts; which row ran where is listed below): **75 of 85 caught**, 10 documented two-layer rows not
caught (as listed), **0 not as listed** (script exit code 0 on each final run). The rows of the earlier sets that now
edit the Day 4c migration (Day 4c redefines the audit trigger, `get_lead` and `log_activity`) ran again too: 41 of 41
caught.

How it was run:
- Two throwaway worktrees (`git worktree add <scratchpad>/wt-4c-mut <commit>` and `wt-4c-mut2`),
  never the real checkout, because the script edits migrations in place; the two halves of the set ran side by side, one
  in each, to stay inside the session's two-hour limit for a background job. Removed afterwards (`git worktree remove
  --force`, `git worktree prune`).
- In those worktrees only, `scripts/db-test.sh` was switched from port 54329 to 54363 and 54364 (`sed`), so they could not
  meet each other or another test cluster; the real checkout's script is unchanged. The local auth stack (54321/54330)
  and Next (3100) were not touched. Fake data only; no remote database.
- A baseline `bash scripts/db-test.sh` on each unchanged worktree passed first (all nine suites, advisors with no
  ERROR-level finding), so every "caught" below is the mutation's own failure, not a broken baseline.
- `python3 scripts/db-mutations.py --set day4c 1 … 41` in one worktree and `… 42 … 82` in the other (about 100 s a row:
  each run includes the five concurrency scripts), then the moved rows of the earlier sets by number. After the run
  `git status` in each worktree showed only the port change: every migration was restored.
- Other sessions of this project used the machine at times. The concurrency cases that time a wait (a claim must not
  wait for a lead being saved; a second claim must wait for the first) have wide margins: 1 s against a few
  milliseconds; every baseline passed.
- A dry check applied every row's edits of all four sets to the migrations without running the tests: each anchor is
  found exactly once, and no row of an earlier set still edits a Day 4b definition that Day 4c replaces.

Which commit each row ran on (the migration is the same in all three; later commits change only the mutation list and
the concurrency scripts):
- 44277d3: day4c rows 1 to 82. Three of them proved to be two-layer rows (28, 53, 60: see the table at the end).
- 8192480 (marks those three as two-layer rows, adds rows 83 to 85 removing both layers, drops `set deadlock_timeout`
  from the concurrency scripts): day4c rows 28, 53, 60, 83 to 85, and the moved rows of the earlier sets. One of those,
  Day 4b row 5 (log_activity's lock order reversed), was not caught: Day 4b's deadlock case changes a contact's number,
  which now takes the lead at once through the contact trigger.
- b235bad (adds `queue_concurrency.sh` case 10, the lock order with a contact held by a name change): Day 4b row 5
  again, and day4c rows 39, 40 and 57 again (two of them caught only by concurrency cases), as a check that the new case
  changes nothing else.
Each run started with its own passing baseline; the tables show the latest result of each row.

Rows 1 to 10 follow the design's list (section 8.3, 4c), in order; row 1 removes the scope check from both places it
now lives (claim_next_lead, and queue_candidates for a direct database call). The rest remove every other protection
the migration adds, one at a time. Rows marked "documented: two layers" remove one layer of a protection that has two;
the other layer stops the same thing, so no test can see the removal on its own; each has a row removing both layers
(or all three), which must be caught.


### day4c

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | claim_next_lead and queue_candidates: no scope check (a rep works Team or the unassigned leads; both layers) | caught | FAIL: "select public.claim_next_lead('team', null, '{}', 1, true)" succeeded, expected 42501 |
| 2 | Claims delete policy: no expiry condition (an expired claim stays until its holder lets go) | caught | FAIL: an expired claim must be removable by anyone in the team |
| 3 | Claims: no primary key on company_id (two live claims on one lead) | caught | FAIL: one claim per lead (primary key on company_id) |
| 4 | Claim guard: keeps the client's end time (a claim stretched for a year) | caught | FAIL: a client stretched a claim |
| 5 | Claims insert policy: no editor condition (a rep locks a teammate out of their lead) | caught | FAIL: "insert into private.queue_claims (company_id) values ('4a03faaa-5ccc-4da2-bd7f-a8cb69618d6a')" succeeded, expected 42501 |
| 6 | Queue rank: Do not contact leads ranked | caught | FAIL: queue rank by status |
| 7 | Queue rank: no number-to-dial rule | caught | FAIL: queue_rank_matches_rule |
| 8 | claim_next_lead: no calling-hours filter | caught | FAIL: queue_skips_closed_zones: a lead outside hours was served |
| 9 | Calling hours: a span judged on its eastern zone only | caught | FAIL: calling hours for US at 2026-10-12T15:59:00Z (lunch switch f): expected f |
| 10 | Queue rank: Cool off without a date served | caught | FAIL: Cool off without a date ranks |
| 11 | claim_next_lead: no scope check (queue_candidates still refuses the scope) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 12 | queue_candidates: no scope check (a direct call lists the team's leads for a rep) | caught | FAIL: "select private.queue_candidates(1, 'team', null, '{}', current_date, 'Europe/Paris', 10)" succeeded, expected 42501 |
| 13 | queue_summary: no scope check | caught | FAIL: "select public.queue_summary('team')" succeeded, expected 42501 |
| 14 | list_tasks: Team for anyone | caught | FAIL: "select * from public.list_tasks('today', 'team')" succeeded, expected 42501 |
| 15 | count_tasks: Team for anyone | caught | FAIL: "select public.count_tasks('team')" succeeded, expected 42501 |
| 16 | claim_lead: no editor pre-check (the policy answers without the scope hint) | caught | FAIL: "select public.claim_lead('c4f4a6f1-301c-49bc-ba96-2d2d49998534')" gave 42501 (hint "", new row violates row-level security policy for |
| 17 | Contact trigger: no lead lock before it looks (two contacts changed at once leave a wrong flag) | caught | FAIL: contact_flag_two_edits_at_once: the lead says 'true 3' (expected 'false -': no number left) |
| 18 | Contact trigger: a number marked wrong still counts | caught | FAIL: has_contact_phone_consistent: a lead's contact flag differs from its contacts |
| 19 | Contact trigger: a number without digits counts | caught | FAIL: deleting the only contact number must clear the flag (a number without digits is none) |
| 20 | Contact trigger: the old lead is left as it was when a contact moves | caught | FAIL: deleting the only contact number must clear the flag (a number without digits is none) |
| 21 | Contact trigger: not on delete | caught | FAIL: deleting the only contact number must clear the flag (a number without digits is none) |
| 22 | Contact trigger: not on a wrong-number mark | caught | FAIL: has_contact_phone_consistent: a lead's contact flag differs from its contacts |
| 23 | Contact trigger: SECURITY INVOKER (an editor's contact change fails on the ungranted column) | caught | permission denied for table companies |
| 24 | Queue rank: a main number without digits counts | caught | FAIL: a lead with nothing to dial has a rank |
| 25 | Queue rank: a main number marked wrong still counts | caught | FAIL: a wrong main line still ranks |
| 26 | Claims: no two-factor policy | caught | FAIL: private.queue_claims protections |
| 27 | Claims select policy: every organisation's claims | caught | FAIL: another organisation sees claims |
| 28 | Claims delete policy: no organisation fence (the select policy still hides other organisations' claims from a delete) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 29 | Claims update policy: anyone renews anyone's claim | caught | FAIL: a teammate renewed someone else's claim |
| 30 | Claims: insert grant names the person too | caught | FAIL: private.queue_claims protections |
| 31 | Claim guard: the client's person kept (the grant and the insert policy still stop it) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 32 | Claim guard, grant and insert policy: a claim for someone else (all three layers) | caught | FAIL: private.queue_claims protections |
| 33 | Claim guard: no limit of 3 | caught | FAIL: "insert into private.queue_claims (company_id) values ('a7f95f59-a438-451a-89b9-dca791d5a15b')" succeeded, expected 22023 |
| 34 | Claim guard: expired claims count toward the limit | caught | you are already working on 3 leads |
| 35 | Claim guard: renewing an expired claim passes the limit | caught | FAIL: "update private.queue_claims set expires_at = now() where company_id = '9f2cfb0a-95a9-415f-bda9-9f9dab6632e0'" succeeded, expected 220 |
| 36 | Claim guard trigger dropped | caught | FAIL: sync_contact_phone (AFTER), claim_guard and check_profile_timezone (BEFORE) must be on |
| 37 | Claim guard: other fields may change (the column grants still stop it) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 38 | Claim guard: no per-person lock (claim_lead and the queue still take it) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 39 | Claims: no per-person lock anywhere (two tabs pass the limit) | caught | FAIL: claim_cap_two_tabs: the second tab took a fourth claim |
| 40 | claim_next_lead: an expired claim is not removed first (a closed laptop keeps its leads) | caught | FAIL: claim_next_lead must take over an expired claim: {"kept": [], "cards": [{"id": "2ecd28b9-ee29-4fd2-8d2e-be13875865b1", "city": null, " |
| 41 | claim_next_lead: candidates include leads with a live claim (the primary key still refuses them) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 42 | claim_next_lead: no second look after winning a claim (a lead a teammate just called is served again) | caught | FAIL: second_look: the queue served '978d6435-4635-459d-9d98-15b8f2309e5f,257fc59f-5ce2-444a-a0fe-39ad6acdad3a' (expected only X; L was just |
| 43 | claim_next_lead: the session's skips ignored | caught | FAIL: queue order: got {504e2227-a1c2-449f-9e75-ecc1fc052421,504e2227-a1c2-449f-9e75-ecc1fc052421,504e2227-a1c2-449f-9e75-ecc1fc052421,504e2 |
| 44 | claim_next_lead: the caller's other claims kept (the screen holds more than it shows) | caught | you are already working on 3 leads |
| 45 | claim_next_lead: a reload resumes claims that are no longer eligible | caught | FAIL: reload with a lead no longer due: {58a36571-3a01-482d-99b0-60e9e7a1bc88,7f5c14a1-c570-4aae-9731-9a0ffcd60dda} |
| 46 | claim_next_lead: no limit on kept plus new cards | caught | FAIL: "select public.claim_next_lead('mine', '{c87507ae-4463-4c8b-90e8-46411162bcc3,37017b49-b8a3-45cb-8ea4-144f4c2aca18}'::uuid[], '{}', 2, |
| 47 | claim_next_lead: follow-ups not first (the walk starts at Negotiation) | caught | FAIL: queue order: got {702046de-57cc-47ad-9d7a-e64916c148fd,099c0fba-e51c-4d46-bffd-6831f8a4d838,84079875-215a-4f71-a7d3-686f3a22b384,f7a11 |
| 48 | Queue follow-ups: a task due today is not yet due | caught | FAIL: queue order: got {e3e6d287-0afd-49e7-9358-f6803ab88dc3,8c7bdb8f-ddf6-472a-8e1b-cb94fa1c4e75,641c8fd3-fe21-4c40-96ee-3bb88bc9cfbc,1aec5 |
| 49 | Queue follow-ups: the next call date wins over the task | caught | FAIL: queue order: got {f57547bc-3b52-44f4-b96a-fe44ddd370a7,3466ecf4-b7be-48cd-b1a5-50361e985cfe,690ce1db-b57b-4a57-bc27-bed8f418255b,6bda6 |
| 50 | Queue order: leads called before come first among first calls | caught | FAIL: queue order: got {29ae3171-6a20-4dda-8455-d9338ffe45c8,8b0e9d1c-4565-453c-9ef0-fda9381eab88,e4cacfe7-b92c-4cc4-ac9c-75ac91f88e18,dc8f4 |
| 51 | Queue Mine: anyone's leads (dated part) | caught | FAIL: a rep's queue offered someone else's lead |
| 52 | Queue Mine + unassigned: the second half takes anyone's leads | caught | FAIL: Mine + unassigned |
| 53 | Queue Mine: future dates offered (no stop at now; the second look after the claim still lets them go) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 54 | log_activity: a call from the queue keeps its claim | caught | FAIL: p_from_queue must release the caller's claim, and only then |
| 55 | log_activity: a call from the queue releases anyone's claim (the delete policy still stops it) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 56 | log_activity and the delete policy: a call from the queue releases a teammate's claim (both layers) | caught | FAIL: claim_delete_other_fresh_zero_rows |
| 57 | log_activity: the lead locked FOR UPDATE again (a claim waits for the call) | caught | FAIL: claim_does_not_wait_for_the_lead: the claim waited 1561 ms for the lead |
| 58 | get_lead: worked_by names the caller | caught | FAIL: the caller's own claim is not "worked by" |
| 59 | get_lead: worked_by from an expired claim | caught | FAIL: worked_by for an expired claim |
| 60 | Calling hours: the lunch switch also cuts a span (no span has a European end, so the Europe/* rule still spares them) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 61 | Calling hours: the lunch switch outside Europe | caught | FAIL: calling hours for America/New_York at 2026-10-12T16:30:00Z (lunch switch t): expected t |
| 62 | Calling hours: 18:00 still open | caught | FAIL: calling hours for Europe/Paris at 2026-10-12T16:00:00Z (lunch switch f): expected f |
| 63 | Calling hours: weekends open | caught | FAIL: calling hours for Europe/Paris at 2026-10-10T10:00:00Z (lunch switch f): expected f |
| 64 | Calling zone keys: the zones a person may pick left out | caught | FAIL: open_call_zones for America/New_York at 2026-10-26T13:00:00Z |
| 65 | Audit: call_zone and queue_rank stored | caught | FAIL: a next call or mark change was audited |
| 66 | Audit: the contact flag diffed | caught | FAIL: the contact flag wrote an audit row for the lead |
| 67 | list_tasks: days read in UTC, not the person's zone | caught | FAIL: today in Europe/Paris: {e19e56a5-c47b-42e5-bc45-905d3a8fee5d,ef6190b1-e059-476b-b46e-d11b1f37423e,e1a72fae-d03f-40b5-a808-7da5e76b0d49 |
| 68 | list_tasks: Today includes times already past | caught | FAIL: today in Europe/Paris: {9d51836b-c8e9-4e69-9154-b17d82046781,583cd928-dbad-4e1c-948f-161a60c764ab,26d7b4b3-f4f7-4f85-8482-08744fe51804 |
| 69 | list_tasks: undated tasks missing from Upcoming | caught | FAIL: upcoming in Europe/Paris: {8feecc97-fc01-4855-98ad-b86983ec507b,6cf2ed27-9e71-42d4-93cd-79f1dec03f5d} |
| 70 | list_tasks: dismissed tasks listed in Today | caught | FAIL: today in Europe/Paris: {15bc93d7-cc2b-4a53-928b-e9edc621d845,44e2bd23-de96-45a4-84e9-0792e4d93849,9ddea4e5-8c54-4859-a191-37e7b4cdb6e1 |
| 71 | list_tasks: Done keyset <= (a task repeated across pages) | caught | FAIL: done pages {f1a7beef-f6f1-4241-8eb0-a5ff81efd2fa,d1e8c4fb-28df-4362-9836-d90f0cf1ee0e,d1e8c4fb-28df-4362-9836-d90f0cf1ee0e,70372495-f5 |
| 72 | list_tasks: Upcoming undated cursor >= (a task repeated across pages) | caught | FAIL: upcoming pages {144bb4fb-ba3b-4b6c-b529-9d3d96931100,3d935011-71fc-46cb-999b-81bbb4dbec09,825d0b9d-76ba-4082-b803-022c7da23a23,93e6b03 |
| 73 | update_task: no contact pre-check (the policy answers 42501 instead of P0002) | caught | FAIL: "select public.update_task('70055cfe-a3c3-4e54-a1fb-ef02bf5dbd13', 'x', null, null, null, 'e83c3fd4-ec35-4818-9ada-967d17f37029')" gav |
| 74 | update_task: no person given leaves the task with nobody | caught | only managers and admins can change the owner |
| 75 | delete_task: no fresh-code pre-check (no step_up hint) | caught | FAIL: "select public.delete_task('1e05d943-3d83-4ccf-ab91-db5dfcc09f8e')" gave 42501 (hint "", task not yours to delete), expected 42501 (hi |
| 76 | Profile zone check trigger dropped | caught | FAIL: sync_contact_phone (AFTER), claim_guard and check_profile_timezone (BEFORE) must be on |
| 77 | set_my_timezone: no pre-check (the profile trigger still refuses it) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 78 | set_my_timezone and the profile trigger: any zone stored (both layers) | caught | FAIL: sync_contact_phone (AFTER), claim_guard and check_profile_timezone (BEFORE) must be on |
| 79 | Claims: a lead delete is refused while it has a claim (claims must go with their lead) | caught | update or delete on table "companies" violates foreign key constraint "queue_claims_company_id_fkey" on table "queue_claims" |
| 80 | renew_claims: brings back expired claims | caught | FAIL: renew_claims brought back an expired claim |
| 81 | queue_summary: customers counted as having no number | caught | FAIL: queue_summary {"no_number": 2, "later_today": 1, "callable_now": 1, "follow_ups_due": 1, "waiting_by_zone": [{"key": "Europe/Andorra", |
| 82 | claim_next_lead: null in the skips accepted (every lead skipped) | caught | FAIL: "select public.claim_next_lead('mine', null, array[null]::uuid[], 1, true)" succeeded, expected 22023 |
| 83 | Queue Mine: future dates served (no stop at now, and no second look after the claim; both layers) | caught | FAIL: queue order: got {84800c7d-24fa-4793-b9f7-89f23775ea82,299deb79-c54f-458e-bcb7-5c3ef0c456b8,9f8ad91f-e071-4cd5-9ef8-a4710c9ad4e9,c470a |
| 84 | Calling hours: the lunch switch cuts every zone, spans included (both layers) | caught | FAIL: calling hours for America/New_York at 2026-10-12T16:30:00Z (lunch switch t): expected t |
| 85 | Claims delete and select policies: no organisation fence (another organisation clears expired claims; both layers) | caught | FAIL: another organisation sees claims |

day4c: 85 rows: 75 caught, 10 documented two-layer rows not caught, 0 not as listed

### Verifier round (511df9c, 12 Oct 2026)

The verifier's nit "Wrong number's other working number uses `phone is not null`" was fixed in 881585a (a number with
at least one digit, as everywhere else in the queue; test `queue_attack.sql` 5b). Two rows were added and run in a
throwaway worktree (`<scratchpad>/wt-4c-mut` at 511df9c, its `db-test.sh` on port 54348; removed afterwards):
`python3 scripts/db-mutations.py --set day4c 86 87`, then `--set day4b 65` (that row's anchor is the line the fix
changed, so it now names the Day 4c text). Script exit code 0 on both.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 86 | Wrong number: a contact number without a digit counts as another working number (no find-the-number task) | caught | FAIL: wrong main line with only a digitless contact number: task <NULL> rank <NULL> |
| 87 | Wrong number: a main line without a digit counts as another working number (no find-the-number task) | caught | FAIL: wrong contact number with a digitless main line: task <NULL> rank <NULL> |
| day4b 65 | Tasks: 'find the right number' although another number works (Day 4c text) | caught | FAIL: wrong main line with a working contact {"task_id": ...} |

day4c now: **87 rows: 77 caught, 10 documented two-layer rows, 0 not as listed** (rows 1 to 85 as above; the fix
touches no other row's anchor: every anchor of every set still matches exactly once, dry check).


### Review round 3 (68723f4, 12 Oct 2026)

Two database findings of the review were fixed in 7b3fa92 (case 11's threshold settled in 68723f4):
- **A claim renewed after its lead was reassigned** (finding 1): the claim guard now refuses renewing a claim on a lead
  the caller may no longer claim (owner, manager, admin), and `renew_claims` and `claim_next_lead`'s keep path let such
  a claim go first. Test: `queue_attack.sql` 9b.
- **`claim_next_lead` deadlock when two admins' orders cross** (finding 2): a lead's claim row changes only under that
  lead's advisory lock; the walk only tries it (`pg_try_advisory_xact_lock`) and skips a lead someone else is claiming;
  the functions that change the caller's own claims, `claim_lead` and `log_activity` wait for it. Test:
  `queue_concurrency.sh` case 11 (20 rounds of two admins pressing Start together with crossing follow-ups; at least 5
  rounds must really cross), and a held lead lock is skipped at once. Case 9 (`second_look`) now holds X with a claim
  row written by the superuser (no lead lock), since a claim taken through the functions is skipped instead of waited
  for.

Five rows were added (88 to 92). They ran, with every earlier day4c row whose anchor lies in a function this round
changed (claim guard, `claim_next_lead`, `claim_lead`, `renew_claims`, `release_claims`, `log_activity`), in a throwaway
worktree (`<scratchpad>/wt-4c-mut4` at 68723f4, its `db-test.sh` on port 54352; removed afterwards, `git status` there
showed only the port change). Its baseline passed first (all nine suites, advisors no ERROR). Command:
`python3 scripts/db-mutations.py --set day4c 1 4 8 11 16 31 32 33 34 35 37 38 39 40 42 43 44 45 46 47 54 55 56 57 80 82
83 86 87 88 89 90 91 92`. Script exit code 0: **34 rows: 29 caught, 5 documented two-layer rows, 0 not as listed.**
A first attempt on 7b3fa92 was stopped: case 11 then also required each admin's own follow-up first, which a fair race
does not always give (one walk can reach the other's lead first), so three two-layer rows read as caught; the check now
counts the rounds that crossed instead.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | claim_next_lead and queue_candidates: no scope check (a rep works Team or the unassigned leads; both layers) | caught | FAIL: "select public.claim_next_lead('team', null, '{}', 1, true)" succeeded, expected 42501 |
| 4 | Claim guard: keeps the client's end time (a claim stretched for a year) | caught | FAIL: a client stretched a claim |
| 8 | claim_next_lead: no calling-hours filter | caught | FAIL: queue_skips_closed_zones: a lead outside hours was served |
| 11 | claim_next_lead: no scope check (queue_candidates still refuses the scope) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 16 | claim_lead: no editor pre-check (the policy answers without the scope hint) | caught | FAIL: "select public.claim_lead('07eaf2af-e8b9-43ea-a4de-c8afb381d1be')" gave 42501 (hint "", new row violates row-level security policy for |
| 31 | Claim guard: the client's person kept (the grant and the insert policy still stop it) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 32 | Claim guard, grant and insert policy: a claim for someone else (all three layers) | caught | FAIL: private.queue_claims protections |
| 33 | Claim guard: no limit of 3 | caught | FAIL: "insert into private.queue_claims (company_id) values ('31193861-1e38-41df-8ca6-412bd9388b0b')" succeeded, expected 22023 |
| 34 | Claim guard: expired claims count toward the limit | caught | you are already working on 3 leads |
| 35 | Claim guard: renewing an expired claim passes the limit | caught | FAIL: "update private.queue_claims set expires_at = now() where company_id = 'bc7d4bc8-5ab0-4cdf-a54e-f6ac25867548'" succeeded, expected 220 |
| 37 | Claim guard: other fields may change (the column grants still stop it) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 38 | Claim guard: no per-person lock (claim_lead and the queue still take it) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 39 | Claims: no per-person lock anywhere (two tabs pass the limit) | caught | FAIL: claim_cap_two_tabs: the second tab took a fourth claim |
| 40 | claim_next_lead: an expired claim is not removed first (a closed laptop keeps its leads) | caught | FAIL: claim_next_lead must take over an expired claim: {"kept": [], "cards": [{"id": "268cfae0-6802-44ad-873d-afaa9bdd2426", "city": null, " |
| 42 | claim_next_lead: no second look after winning a claim (a lead a teammate just called is served again) | caught | FAIL: second_look: the queue served '929a8f49-817c-4388-a7e6-ab647c8e3af7,4530360d-5080-41dd-882c-568fa3a76edd' (expected only X; L was just |
| 43 | claim_next_lead: the session's skips ignored | caught | FAIL: queue order: got {9a81d5a5-b071-4341-b130-969ec35dab11,9a81d5a5-b071-4341-b130-969ec35dab11,9a81d5a5-b071-4341-b130-969ec35dab11,9a81d |
| 44 | claim_next_lead: the caller's other claims kept (the screen holds more than it shows) | caught | you are already working on 3 leads |
| 45 | claim_next_lead: a reload resumes claims that are no longer eligible | caught | FAIL: reload with a lead no longer due: {930d1358-bdb6-4a45-892d-c8a6ca12624b,b9cda188-3e64-4ac5-8a14-72bdec3d6980} |
| 46 | claim_next_lead: no limit on kept plus new cards | caught | FAIL: "select public.claim_next_lead('mine', '{650da8e3-cea1-44ac-a606-5bb2e297e22b,1edf2cdd-4491-447e-bb33-c07ad1d20f83}'::uuid[], '{}', 2, |
| 47 | claim_next_lead: follow-ups not first (the walk starts at Negotiation) | caught | FAIL: queue order: got {f727f472-3f7f-4bc5-b317-9ede151d9558,367186b1-270d-4eca-922e-11eaae7d82a6,1da6de77-cdca-467e-b821-66ff554c26d3,cc68c |
| 54 | log_activity: a call from the queue keeps its claim | caught | FAIL: p_from_queue must release the caller's claim, and only then |
| 55 | log_activity: a call from the queue releases anyone's claim (the delete policy still stops it) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 56 | log_activity and the delete policy: a call from the queue releases a teammate's claim (both layers) | caught | FAIL: claim_delete_other_fresh_zero_rows |
| 57 | log_activity: the lead locked FOR UPDATE again (a claim waits for the call) | caught | FAIL: claim_does_not_wait_for_the_lead: the claim waited 1563 ms for the lead |
| 80 | renew_claims: brings back expired claims | caught | FAIL: renew_claims brought back an expired claim |
| 82 | claim_next_lead: null in the skips accepted (every lead skipped) | caught | FAIL: "select public.claim_next_lead('mine', null, array[null]::uuid[], 1, true)" succeeded, expected 22023 |
| 83 | Queue Mine: future dates served (no stop at now, and no second look after the claim; both layers) | caught | FAIL: queue order: got {7b91b649-f6e1-45f9-bb2f-9ef80511e83e,53d53771-ba63-45a4-b7f3-ddf64c399462,6caac78e-77ec-48d3-8aee-a673402f6ce5,217db |
| 86 | Wrong number: a contact number without a digit counts as another working number (no find-the-number task) | caught | FAIL: wrong main line with only a digitless contact number: task <NULL> rank <NULL> |
| 87 | Wrong number: a main line without a digit counts as another working number (no find-the-number task) | caught | FAIL: wrong contact number with a digitless main line: task <NULL> rank <NULL> |
| 88 | Claim guard: a renewal of a lead that changed hands passes (renew_claims and the keep path still let it go) | caught | FAIL: "update private.queue_claims set expires_at = now() where company_id = '00ef3e59-6673-499d-9166-fcde32d1c78d'" succeeded, expected 425 |
| 89 | renew_claims: a reassigned lead's claim is renewed, not let go (the claim guard then refuses the renewal) | caught | only a lead the caller may change can stay claimed |
| 90 | claim_next_lead keep: a reassigned lead's claim is kept (the claim guard then refuses the renewal) | caught | only a lead the caller may change can stay claimed |
| 91 | Renewals of a reassigned lead: the guard, renew_claims and the keep path all let it pass (all three layers) | caught | FAIL: "update private.queue_claims set expires_at = now() where company_id = 'b1acd2fe-50b3-4798-8855-8d8d0afbaf97'" succeeded, expected 425 |
| 92 | claim_next_lead walk: no lead lock tried (waits on a teammate's claim; two crossing walks deadlock) | caught | deadlock detected |

Row 92 (the walk without the lead lock) fails with "deadlock detected" in case 11, the deadlock the review reproduced.
The lead locks in the functions that change the caller's own claims have no row of their own: they close the remaining
ways a walk could wait in a circle (two people's expired claims picked up by each other's walk at the same instant),
which no test can make happen on demand; row 92 removes the part the crossing case can see.

day4c now: **92 rows** (rows 1 to 87 as above, 88 to 92 here); every anchor of every set still matches exactly once
(dry check after the change).

## Earlier rows moved to the Day 4c migration (runs on 8192480 and b235bad)

`REDEFINED_IN_4C` in `scripts/db-mutations.py`: these rows edited the Day 4b definitions of the audit trigger,
`get_lead` and `log_activity`, which Day 4c replaces (create or replace, Day 4b's text kept, except the lead lock in
step 3 and the audit's no-diff list, whose rows got the Day 4c text). Each was run again on the Day 4c copy. The other
rows of those sets edit definitions Day 4c leaves alone: their anchors still match exactly once (dry check), so their
last full results stand (Day 4b: 94 of 94 on f2c900b; Day 4a: 102 caught and 2 documented two-layer rows; Day 3b: 36
caught and 1 documented).

### day3b

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 28 | Audit: full copy of imported leads | caught | FAIL: imported leads should each have one small audit row |
| 29 | Audit: search and key columns kept | caught | FAIL: search_text copied into the audit log |

day3b: 2 rows: 2 caught, 0 documented two-layer rows not caught, 0 not as listed

### day4a

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 9 | Audit: a deleted entry keeps its text | caught | FAIL: a deleted entry should be audited without its text, with its length: {"id": "37a66986-6d00-4b4c-bab2-8319fa2b4afc", "body": "AUDIT-MAR |
| 32 | Audit: an edit keeps the text | caught | FAIL: an edit should be audited as the text's lengths and edited_at: {"body": {"new": "AUDIT-MARKER second, longer words", "old": "AUDIT-MAR |
| 33 | Audit: new entries copied | caught | FAIL: an activity insert was copied into the audit log |
| 83 | Audit: a deleted entry without its length (D8) | caught | FAIL: a deleted entry should be audited without its text, with its length: {"id": "25bf723a-c4e6-4b2c-8246-0ef08d31f5b6", "type": "note", "o |

day4a: 4 rows: 4 caught, 0 documented two-layer rows not caught, 0 not as listed

### day4b

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 4 | Outcome decisions applied for people who may not change the lead | caught | FAIL: a rep took or changed an unassigned lead {"task_id": "0ae89234-8488-4a4c-8920-6e26d8a93bb2", "editable": true, "replayed": false, "cre |
| 5 | Lock order reversed in log_activity: lead, then contact (deadlock test) | caught | deadlock detected |
| 11 | Wrong number: the dialled contact marked without the editor's lock (code claims a mark) | caught | FAIL: a rep marked a colleague's contact, or got no task {"task_id": null, "editable": false, "replayed": false, "created_at": "2026-10-12T0 |
| 12 | log_activity runs as its owner (marks and decisions for anyone, as a definer trigger would) | caught | FAIL: RPC rules broken by {"log_activity(uuid,text,text,text,uuid,text,date,timestamp with time zone,text,uuid,boolean)"} |
| 31 | log_activity: no second replay check after the lock, and no unique-violation answer (both layers) | caught | duplicate key value violates unique constraint "activities_author_request_idx" |
| 32 | log_activity: no unique-violation answer (a concurrent duplicate fails) | caught | duplicate key value violates unique constraint "activities_author_request_idx" |
| 47 | Audit: next call and marks diffed | caught | FAIL: audit of an outcome |
| 49 | Outcomes: the 6th try counts from 7 (>= 6) | caught | FAIL: after {no_answer,voicemail,no_answer,no_answer,voicemail} then no_answer: (cold, 2026-10-13 07:00:00+00), expected (cool_off, 2026-11- |
| 50 | Outcomes: the 6th try sends any status to Cool off | caught | FAIL: after {no_answer,no_answer,no_answer,no_answer,no_answer} then no_answer: (cool_off, 2026-11-11 00:38:56.789903+00), expected (negotia |
| 51 | Outcomes: voicemail waits one working day like no answer | caught | FAIL: voicemail on cold: lead (cold, 2026-10-13 07:00:00+00), answer {"task_id": null, "editable": true, "replayed": false, "created_at": "2 |
| 52 | Outcomes: Not interested moves Negotiation to Cool off | caught | FAIL: not_interested on negotiation: lead (cool_off, 2027-01-10 00:27:34.913719+00), answer {"task_id": null, "editable": true, "replayed":  |
| 53 | Outcomes: Interested moves a lead down (Negotiation to Warm) | caught | FAIL: interested on negotiation: lead (warm, 2026-10-15 07:00:00+00), answer {"task_id": "b9c956b6-996b-4a61-a071-e261193754c0", "editable": |
| 54 | Outcomes: Book meeting moves Negotiation to Warm | caught | FAIL: meeting_booked on negotiation: lead (warm, 2026-10-16 02:28:00+00), answer {"task_id": "d4de8f3b-d650-428b-a821-3a34f30fd98c", "editab |
| 55 | Outcomes: Do not contact keeps the next call | caught | FAIL: do_not_contact on cold: lead (do_not_contact, 2026-10-15 00:28:56+00), answer {"task_id": null, "editable": true, "replayed": false, " |
| 56 | Outcomes: Spoke without a follow-up keeps the next call (no 30 days) | caught | FAIL: connected on cold: lead (cold, 2026-10-15 00:29:23+00), answer {"task_id": null, "editable": true, "replayed": false, "created_at": "2 |
| 57 | Outcomes: back on the follow-up day itself, not the day after | caught | FAIL: meeting_booked on cold: lead (warm, 2026-10-15 02:29:00+00), answer {"task_id": "7148b44c-2508-4aed-8d75-b7258e919257", "editable": tr |
| 58 | Outcomes: a follow-up date read in Paris for every lead (not its zone) | caught | FAIL: interested on a US lead (zone <NULL>): {"task_id": "70c73523-6bfd-4684-82fc-e8489d4f450f", "editable": true, "replayed": false, "creat |
| 59 | Outcomes: an owned lead taken over too | caught | FAIL: interested on cold: lead (warm, 2026-10-15 07:00:00+00), answer {"task_id": "23b4659f-478e-48bb-b118-e7cfe2d3dc16", "editable": true,  |
| 60 | Outcomes: Spoke takes over an unassigned lead too | caught | FAIL: connected on a lead owned by <NULL>: owner 00000000-0000-0000-0000-00000000000a, answer {"task_id": null, "editable": true, "replayed" |
| 61 | Tasks: a call completes every open call task, due or not | caught | FAIL: no_answer on cold: the future call task (done 2026-10-12 00:31:39.804811+00, dismissed <NULL>) |
| 62 | Tasks: a call completes to-dos too | caught | FAIL: a call completed ["187d073b-dc5e-4e7f-af17-14273959f656", "2439fbdd-4a2b-41e6-af6d-bd4b4955e63c", "2d297b2d-219e-4ccd-a31c-941150d4984 |
| 63 | Tasks: a call completes a colleague's call tasks | caught | FAIL: a call completed ["431dba6e-fc26-4573-8289-a369104d9cf2", "75fcc939-0271-4d34-90c1-bc8e3c87af8e", "a5603796-90a9-487d-b007-8ab5800f6c7 |
| 64 | Tasks: Do not contact dismisses nothing | caught | FAIL: do_not_contact on cold: the future call task (done <NULL>, dismissed <NULL>) |
| 65 | Tasks: 'find the right number' although another number works | caught | FAIL: wrong main line with a working contact {"task_id": "d8cfb18e-a7db-4ddf-85c5-e5ea7327723b", "editable": true, "replayed": false, "creat |
| 66 | Tasks: 'find the right number' always for the caller (not the owner) | caught | FAIL: wrong_number on cold: the task made {"id":"ad3cee17-a591-4d71-8863-745bd26ad94c","org_id":"96b004f9-494b-4f2d-bd88-59477e68f3df","cont |
| 67 | Input: Interested without a follow-up | caught | FAIL: "select public.log_activity('30c91575-6e40-4790-85a1-f85fd9b7c26d', 'call', 'interested', NULL, NULL, null, NULL, NULL, 'Follow up')"  |
| 68 | Input: follow-up dates and times not bounded | caught | FAIL: "select public.log_activity('c6a9e967-0ae3-4850-94c1-46567f874a7c', 'call', 'interested', NULL, NULL, null, '2026-10-10', NULL, 'F')"  |
| 69 | Input: a follow-up on an outcome that takes none | caught | FAIL: "select public.log_activity('4be79ed3-080b-4ba4-b7b0-813ccd1c637a', 'call', 'no_answer', NULL, NULL, null, '2026-10-13', NULL, 'F')" s |
| 70 | Input: Wrong number without a title up front | caught | FAIL: "select public.log_activity('d02ad66b-79eb-43b3-83e8-4499aca8d908', 'call', 'wrong_number', null, null, 'lead')" succeeded, expected 2 |
| 71 | Input: a note without text | caught | FAIL: "select public.log_activity('30c89408-b7f6-4b6a-ba42-6f3812a8f4c7', 'note', NULL, ' |
| 72 | Input: no check of the dialled number | caught | FAIL: "select public.log_activity('805eb869-0b6e-4da9-a343-cbe1793b4af9', 'call', 'wrong_number', null, null, null, null, null, 'Find')" gav |
| 73 | Input: an empty dialled number accepted | caught | FAIL: "select public.log_activity('bd80f2e8-d338-4704-9682-0a10265c95bb', 'call', 'wrong_number', null, null, 'lead', null, null, 'Find')" s |
| 74 | Input: a contact of another lead (the policy answers 42501 instead of P0002) | caught | FAIL: "select public.log_activity('3196a582-4b21-4e31-928f-978352388a53', 'note', NULL, 'x', '00785324-8dce-47f3-b836-d0a098dc3d2d', null, N |
| 79 | get_lead: anyone may set the zone | caught | FAIL: a non-editor may set the zone |
| 87 | log_activity: a call naming a contact it does not mark takes the lead first (deadlock test) | caught | deadlock detected |

day4b: 35 rows: 35 caught, 0 documented two-layer rows not caught, 0 not as listed


## The documented two-layer rows

| Row | Layer removed alone | Why no test can see it | The other layer, and the row that removes it |
|---|---|---|---|
| 11 | claim_next_lead's scope check | queue_candidates refuses a scope beyond Mine for a rep with the same 42501 `scope` | row 1 removes both: caught |
| 28 | the organisation fence of the claims delete policy | a DELETE also applies the select policy, which shows a person only their organisation's claims | row 85 removes both: caught |
| 31 | claim guard: the client's person kept | no insert grant on `user_id`, and the insert policy wants `user_id = auth.uid()` | row 32 removes all three: caught |
| 37 | claim guard: other fields may change | the update grant names only `expires_at` | `queue_attack.sql` section 0 pins the grants column by column (row 30, a widened insert grant, is caught that way) |
| 38 | claim guard: no per-person lock | `claim_lead`, `claim_next_lead` and `renew_claims` take the same lock first | row 39 removes it everywhere: caught by `claim_cap_two_tabs` |
| 41 | candidates include leads with a live claim | the primary key on `company_id`: the claim insert does nothing, and the next candidate is tried | row 3 (no primary key): caught |
| 53 | Mine offers leads whose next call is still ahead | the second look after each won claim lets a lead that is not due go again | row 83 removes both: caught |
| 55 | log_activity releases anyone's claim | the delete policy lets a person delete only their own claim (or an expired one) | row 56 removes both: caught |
| 60 | the lunch switch no longer spares a span | it applies only to Europe/* zones, and no span has a European end (AU, BR, CA, ID, MX, US) | row 84 removes both: caught |
| 77 | set_my_timezone's pre-check | the profile trigger refuses the same value with the same 22023 `timezone` | row 78 removes both: caught |

## What the first passes found (fixed before this run)

- **The mutation run's own baseline failed once:** `three_workers_distinct` served one lead twice. `claim_next_lead`
  reads its candidates in one statement and claims them one by one; between the two, a teammate's whole claim, call and
  release could commit, so the insert met no claim and succeeded on a lead no longer due. Fixed with a second look after
  each won claim; race test 9 (`second_look`) reproduces the case every time (it fails without the fix, checked by hand
  and by the row "no second look after winning a claim").
- **A probe pass on 5e162c7 found row 1 not caught:** at night every calling zone was closed, so a rep's Team walk found
  nothing and `queue_summary`'s own scope check (called for the empty answer) refused with the same 42501. The rep
  probes now run "outside calling hours too", so the rep's own leads would be served and only the scope check can
  refuse; `queue_candidates` gained the same check for a direct database call (two layers, rows 1 and the documented
  row above).

## Not a mutation

- The `has_contact_phone` backfill is a one-time data step (it changes no row locally or in CI, where the migration runs
  on an empty database). Its correctness is the `has_contact_phone_consistent` query in `queue_attack.sql` (every lead's
  flag against its contacts), also a Gate 1 check on dev.
- The zone-map change procedure is a comment; `call_zone_matches_map` (in `queue_attack.sql` and Gate 1) is its check.

