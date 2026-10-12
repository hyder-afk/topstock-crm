# Day 4b: every protection removed one at a time, 11 Oct 2026

## Full re-run on f2c900b (after review round) (11 Oct 2026)

After the review round (22 confirmed findings fixed in five groups, merged as groups a to e; log at **f2c900b**), the
whole day4b set ran once on the final migration: **94 of 94 caught**, 0 documented two-layer rows not caught, **0 not
as listed** (script exit code 0).

How it was run:
- A throwaway worktree at f2c900b (`git worktree add <scratchpad>/mut4b f2c900b`), never the real checkout, because
  the script edits migrations in place. Removed afterwards (`git worktree remove --force`, `git worktree prune`).
- In that worktree only, `scripts/db-test.sh` was switched from port 54329 to 54347 (`sed`), so it could not meet
  another test cluster; the real checkout's script is unchanged. The local auth stack (54321/54330) and Next (3100)
  were not touched. Fake data only; no remote database.
- A baseline `bash scripts/db-test.sh` on the unchanged worktree passed first (exit 0; advisors: no ERROR-level
  findings), so every "caught" below is the mutation's own failure, not a broken baseline.
- `python3 scripts/db-mutations.py --set day4b` (all 94 rows, about 48 s each). After the run `git status` in the
  worktree showed only the port change: every migration was restored.

Day 4a and Day 3b: every anchor of both sets still matches the migrations at f2c900b exactly once (a dry check that
applies each row's edits without running the tests: day4a 104 rows, day3b 37 rows, 0 anchor problems; day4b 94 rows,
0). No row reported "not as listed" or a missing anchor, so the Day 4a set was not re-run; its last full result stays
the one below (c4fb0b9: 102 caught, 2 documented two-layer rows not caught, 0 not as listed). No row of
`scripts/db-mutations.py` was changed.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Undo: no compare before restoring the status (a colleague's change overwritten) | caught | FAIL: undo overwrote a colleague's status {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "cold", "next_action_ |
| 2 | Entry delete without a code: no 'no undo record' condition (an outcome deleted around undo) | caught | FAIL: a fresh outcome was deleted without a code (around undo) |
| 3 | Undo: no 2-minute window in undo_activity | caught | FAIL: "select public.undo_activity('a1ed14c0-7215-48cc-9a65-10821589fac4')" succeeded, expected 22023 |
| 4 | Outcome decisions applied for people who may not change the lead | caught | FAIL: a rep took or changed an unassigned lead {"task_id": "a0b96193-6833-4522-8460-969cce0c72a1", "editable": true, "replayed": false, "cre |
| 5 | Lock order reversed in log_activity: lead, then contact (deadlock test) | caught | deadlock detected |
| 6 | Lead guard: a country change keeps the picked zone | caught | new row for relation "companies" violates check constraint "companies_timezone_fits" |
| 7 | Lead guard: next call bound checked even when unchanged (overdue or far leads stuck) | caught | the next call date is too far ahead |
| 8 | Lead guard: no Cool off default | caught | FAIL: undo into Cool off with no date: (cool_off, <NULL>), answer {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status |
| 9 | Activities: request id index not unique (Day 4a migration) | caught | FAIL: the request indexes must be unique per author |
| 10 | Timeline keyset: <= instead of < (an entry repeated across pages) | caught | FAIL: the timeline repeated an entry across pages |
| 11 | Wrong number: the dialled contact marked without the editor's lock (code claims a mark) | caught | FAIL: a rep marked a colleague's contact, or got no task {"task_id": null, "editable": false, "replayed": false, "created_at": "2026-10-11T2 |
| 12 | log_activity runs as its owner (marks and decisions for anyone, as a definer trigger would) | caught | FAIL: RPC rules broken by {"log_activity(uuid,text,text,text,uuid,text,date,timestamp with time zone,text,uuid,boolean)"} |
| 13 | Undo: no compare before restoring the next call | caught | FAIL: undo overwrote a colleague's next call {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "cold", "next_acti |
| 14 | Undo: no compare before restoring the owner | caught | FAIL: undo overwrote a colleague's owner {"lead": {"owner_id": null, "lead_status": "cold", "next_action_at": null, "last_activity_at": null |
| 15 | Undo: clears the lead's mark whatever its time | caught | FAIL: undo cleared a mark made at another time {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "cold", "next_ac |
| 16 | Undo: clears the contact's mark whatever its time | caught | FAIL: undo cleared a mark twice |
| 17 | Undo: deletes the follow-up even when touched or done (a fresh code passes the policy) | caught | FAIL: undo deleted a completed task |
| 18 | Undo: reopens completed tasks whatever their time | caught | FAIL: undo reopened a task completed at another time {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "cold", "n |
| 19 | Undo: reopens dismissed tasks whatever their time | caught | FAIL: undo reopened a task dismissed at another time {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "warm", "n |
| 20 | Undo: the record is not consumed (a second undo runs again) | caught | this can no longer be undone |
| 21 | Entry delete without a code: no 2-minute bound in the policy | caught | FAIL: an entry deleted with no code |
| 22 | Entry delete without a code: anyone's entry | caught | FAIL: a colleague deleted a fresh entry without a code |
| 23 | Task delete without a code: touched tasks too | caught | FAIL: a touched task was deleted without a code |
| 24 | Task delete without a code: anyone's task (both layers: the creator, and the source entry's author, who is the creator by the task guard) | caught | FAIL: an admin removed a colleague's fresh task without a code |
| 25 | Task delete without a code: while the undo record still exists | caught | FAIL: the task of a fresh outcome was deleted without a code |
| 26 | Task delete without a code: from an entry of any age | caught | FAIL: a task from an entry older than 2 minutes was deleted without a code |
| 27 | Undo records: no two-factor policy | caught | FAIL: private.activity_undo protections |
| 28 | Undo records: everyone in the org sees and deletes them | caught | FAIL: a person sees someone else's undo records |
| 29 | Undo records: a record may name a colleague's entry | caught | FAIL: "insert into private.activity_undo (activity_id, org_id, user_id) values ('65a34207-054f-476c-993a-c353404cc750', 'a1b7662f-5792-4674- |
| 30 | Undo records: update granted | caught | FAIL: private.activity_undo protections |
| 31 | log_activity: no second replay check after the lock, and no unique-violation answer (both layers) | caught | duplicate key value violates unique constraint "activities_author_request_idx" |
| 32 | log_activity: no unique-violation answer (a concurrent duplicate fails) | caught | duplicate key value violates unique constraint "activities_author_request_idx" |
| 33 | Lead guard: no zone pre-check (the CHECK answers with the row) | caught | FAIL: "update public.companies set timezone = 'America/Toronto' where id = 'be029507-6b34-4135-9842-d9e33d87422b'" gave 23514 (hint "", new  |
| 34 | Leads: no time zone CHECK (backstop) | caught | FAIL: "update public.companies set timezone = 'Europe/Paris' where id = 'f112210c-331e-485e-91e8-f51e9c4da6e6'" succeeded, expected 23514 |
| 35 | set_lead_timezone and the lead guard: no zone check at all (both layers) | caught | FAIL: "select public.set_lead_timezone('e6dc8f18-669e-47f7-bea3-5a93c16e3c45', 'Europe/Paris')" succeeded, expected 22023 |
| 36 | Lead guard: a country change always clears the zone (a zone picked with the new country lost) | caught | FAIL: "update public.companies set country = 'CA', timezone = 'America/Chicago' where id = '9c85f5d7-762f-4c94-9138-14923c1041c5'" succeeded |
| 37 | Lead guard: no next call bound | caught | FAIL: "select public.set_lead_next_action('c59590d7-d861-43dc-b8a0-574ff8a5eb55', '2028-10-12 21:04:25.659309+00')" succeeded, expected 2202 |
| 38 | Lead guard: next call bound for maintenance sessions too | caught | the next call date is too far ahead |
| 39 | Lead guard: a new phone keeps the wrong-number mark | caught | FAIL: a new main number kept the mark |
| 40 | Lead guard: a mark keeps the client's time | caught | FAIL: a client chose the time of a wrong-number mark |
| 41 | Lead guard: a mark's time can be changed | caught | FAIL: a mark's time changed |
| 42 | Contact guard: a new phone keeps the mark | caught | FAIL: a new contact number kept the wrong-number mark |
| 43 | Contact guard: a mark keeps the client's time | caught | FAIL: a client chose the time of a wrong-number mark |
| 44 | Contact guard trigger dropped | caught | FAIL: lead_guard, contact_guard (BEFORE) and the time zone CHECK must exist |
| 45 | Lead guard: Cool off default only without a date (a past retry date brings the lead back at once: the design's literal rule) | caught | FAIL: Cool off with a past retry date would come back at once |
| 46 | Lead guard: Cool off default on every update of a Cool off lead (its date cannot be cleared) | caught | FAIL: undo of interested on a due Cool off lead: (cool_off, 2027-01-09 21:08:34.172116+00), answer {"lead": {"owner_id": "00000000-0000-0000 |
| 47 | Audit: next call and marks diffed | caught | FAIL: audit of an outcome |
| 48 | Lead columns: insert granted on the next call | caught | FAIL: grants on the new lead and contact columns |
| 49 | Outcomes: the 6th try counts from 7 (>= 6) | caught | FAIL: after {no_answer,voicemail,no_answer,no_answer,voicemail} then no_answer: (cold, 2026-10-12 07:00:00+00), expected (cool_off, 2026-11- |
| 50 | Outcomes: the 6th try sends any status to Cool off | caught | FAIL: after {no_answer,no_answer,no_answer,no_answer,no_answer} then no_answer: (cool_off, 2026-11-10 21:10:24.936873+00), expected (negotia |
| 51 | Outcomes: voicemail waits one working day like no answer | caught | FAIL: voicemail on cold: lead (cold, 2026-10-12 07:00:00+00), answer {"task_id": null, "editable": true, "replayed": false, "created_at": "2 |
| 52 | Outcomes: Not interested moves Negotiation to Cool off | caught | FAIL: not_interested on negotiation: lead (cool_off, 2027-01-09 21:11:18.722663+00), answer {"task_id": null, "editable": true, "replayed":  |
| 53 | Outcomes: Interested moves a lead down (Negotiation to Warm) | caught | FAIL: interested on negotiation: lead (warm, 2026-10-14 07:00:00+00), answer {"task_id": "3cfcb1c7-38c1-4eec-b95f-dc48c635ff43", "editable": |
| 54 | Outcomes: Book meeting moves Negotiation to Warm | caught | FAIL: meeting_booked on negotiation: lead (warm, 2026-10-15 23:12:00+00), answer {"task_id": "49ad258d-08ad-4be6-a9bb-465820423f14", "editab |
| 55 | Outcomes: Do not contact keeps the next call | caught | FAIL: do_not_contact on cold: lead (do_not_contact, 2026-10-14 21:12:39+00), answer {"task_id": null, "editable": true, "replayed": false, " |
| 56 | Outcomes: Spoke without a follow-up keeps the next call (no 30 days) | caught | FAIL: connected on cold: lead (cold, 2026-10-14 21:13:07+00), answer {"task_id": null, "editable": true, "replayed": false, "created_at": "2 |
| 57 | Outcomes: back on the follow-up day itself, not the day after | caught | FAIL: meeting_booked on cold: lead (warm, 2026-10-14 23:13:00+00), answer {"task_id": "cfe762bd-a68d-40b6-83a1-d4570460e9a7", "editable": tr |
| 58 | Outcomes: a follow-up date read in Paris for every lead (not its zone) | caught | FAIL: interested on a US lead (zone <NULL>): {"task_id": "0c54048f-9f3d-424b-88c3-e66b88f057cd", "editable": true, "replayed": false, "creat |
| 59 | Outcomes: an owned lead taken over too | caught | FAIL: interested on cold: lead (warm, 2026-10-14 07:00:00+00), answer {"task_id": "4b871291-33c1-4c29-8001-505681898f50", "editable": true,  |
| 60 | Outcomes: Spoke takes over an unassigned lead too | caught | FAIL: connected on a lead owned by <NULL>: owner 00000000-0000-0000-0000-00000000000a, answer {"task_id": null, "editable": true, "replayed" |
| 61 | Tasks: a call completes every open call task, due or not | caught | FAIL: no_answer on cold: the future call task (done 2026-10-11 21:15:25.338856+00, dismissed <NULL>) |
| 62 | Tasks: a call completes to-dos too | caught | FAIL: a call completed ["b5c75a16-b324-4eee-995a-12554f5b1270", "e2f29347-167b-48e5-80af-7d3c51f791e8", "e92f83df-f8f9-4725-925a-879891516e1 |
| 63 | Tasks: a call completes a colleague's call tasks | caught | FAIL: a call completed ["1d6d06f5-8afd-4de0-9a48-c94226abc975", "39558cd8-362b-4309-959e-8095b25c00b4", "be6d7cf6-fc58-4d05-b8f3-ea83e12cb2c |
| 64 | Tasks: Do not contact dismisses nothing | caught | FAIL: do_not_contact on cold: the future call task (done <NULL>, dismissed <NULL>) |
| 65 | Tasks: 'find the right number' although another number works | caught | FAIL: wrong main line with a working contact {"task_id": "ace70b82-5d8c-453b-9248-adc27ae81039", "editable": true, "replayed": false, "creat |
| 66 | Tasks: 'find the right number' always for the caller (not the owner) | caught | FAIL: wrong_number on cold: the task made {"id":"3f808c39-d2ad-408a-b97b-967deffdd00a","org_id":"1f34c41c-d5c6-4490-9a3f-dc018165dfe2","cont |
| 67 | Input: Interested without a follow-up | caught | FAIL: "select public.log_activity('25da4968-0629-4a50-9217-e979904e1475', 'call', 'interested', NULL, NULL, null, NULL, NULL, 'Follow up')"  |
| 68 | Input: follow-up dates and times not bounded | caught | FAIL: "select public.log_activity('272197db-c72b-4de8-acce-07a5cf707c4c', 'call', 'interested', NULL, NULL, null, '2026-10-10', NULL, 'F')"  |
| 69 | Input: a follow-up on an outcome that takes none | caught | FAIL: "select public.log_activity('2ecb3304-fde1-42d2-bfd5-e6d66675561d', 'call', 'no_answer', NULL, NULL, null, '2026-10-13', NULL, 'F')" s |
| 70 | Input: Wrong number without a title up front | caught | FAIL: "select public.log_activity('6bece9df-0a08-441c-b7be-28a042d41a6d', 'call', 'wrong_number', null, null, 'lead')" succeeded, expected 2 |
| 71 | Input: a note without text | caught | FAIL: "select public.log_activity('9d576ce8-dcbb-4d57-8064-3e1bbe9ef283', 'note', NULL, ' |
| 72 | Input: no check of the dialled number | caught | FAIL: "select public.log_activity('8c32e75a-03d7-4a27-9c22-c1ec2cd91be4', 'call', 'wrong_number', null, null, null, null, null, 'Find')" gav |
| 73 | Input: an empty dialled number accepted | caught | FAIL: "select public.log_activity('c49bda5d-0315-41d7-8d62-e4c5fd8613fb', 'call', 'wrong_number', null, null, 'lead', null, null, 'Find')" s |
| 74 | Input: a contact of another lead (the policy answers 42501 instead of P0002) | caught | FAIL: "select public.log_activity('31895fcb-da1c-4211-9f6b-6c7fc3f1940c', 'note', NULL, 'x', '7e2b544e-7693-4274-b151-e07cd95e1cce', null, N |
| 75 | Timeline: unknown kinds accepted | caught | FAIL: "select * from public.list_lead_activities('5e40b761-4419-43d8-8854-e3b7a183a50a', '{call,fax}')" succeeded, expected 22023 |
| 76 | Timeline: half a cursor accepted | caught | FAIL: "select * from public.list_lead_activities('5d2eee16-af99-4fef-8cc7-4d2973192bcb', null, now(), null)" succeeded, expected 22023 |
| 77 | Timeline: any page size | caught | FAIL: "select * from public.list_lead_activities('fa44423e-43f0-4ebe-8844-693bdbf5c2f5', null, null, null, 0)" succeeded, expected 22023 |
| 78 | delete_activity: no fresh-code pre-check (no step_up hint) | caught | FAIL: "select public.delete_activity('8a444b93-a652-4c4c-abb6-0d64bbf2e99d')" gave 42501 (hint "", only the author, a manager or an admin ca |
| 79 | get_lead: anyone may set the zone | caught | FAIL: a non-editor may set the zone |
| 80 | bulk_update_leads: a return date with any status | caught | FAIL: "select public.bulk_update_leads(array['a39e413d-d0fe-4900-86f2-eacdb1c04776']::uuid[], 'warm', false, null, '2026-11-25 00:00:00+00') |
| 81 | next_working_day: weekends count | caught | FAIL: next_working_day(2026-10-09 15:30:00+00, 1, Europe/Paris) = 2026-10-10 07:00:00+00, expected 2026-10-12 07:00:00+00 |
| 82 | next_working_day: a span on its western end | caught | FAIL: next_working_day(2026-10-28 15:00:00+00, 1, US) = 2026-10-29 16:00:00+00, expected 2026-10-29 13:00:00+00 |
| 83 | call_attempts: a Spoke does not break the run | caught | FAIL: call_attempts after {no_answer,no_answer,connected,no_answer,no_answer} is 4, expected 2 |
| 84 | call_attempts: the 7 latest calls | caught | FAIL: call_attempts after {voicemail,no_answer,no_answer,no_answer,no_answer,no_answer,voicemail} is 7, expected 6 |
| 85 | Zone map: France on London time | caught | FAIL: country_call_zone |
| 86 | Zone map: a US zone allowed for Canada | caught | FAIL: "update public.companies set country = 'CA', timezone = 'America/Chicago' where id = '73e9a74a-6bbc-4cd6-80d1-6e9667590853'" succeeded |
| 87 | log_activity: a call naming a contact it does not mark takes the lead first (deadlock test) | caught | deadlock detected |
| 88 | Insert lock: locks for a signed-in session without two-factor (holds a lead while being refused) | caught | FAIL: insert_lock_skips_refused_callers (no two-factor): the refusal took 2659 ms (it waited for a lock) |
| 89 | Insert lock: locks a lead of another organisation (holds it while being refused) | caught | FAIL: insert_lock_skips_refused_callers (a lead of another organisation): the refusal took 2647 ms (it waited for a lock) |
| 90 | Insert lock: locks a contact of another organisation (holds it while being refused) | caught | FAIL: insert_lock_skips_refused_callers (a contact of another organisation): the refusal took 2647 ms (it waited for a lock) |
| 91 | Lead guard: a past date the statement writes is replaced on entering Cool off (undo of a due Cool off lead: +90 days) | caught | FAIL: undo of interested on a due Cool off lead: (cool_off, 2027-01-09 21:30:21.795868+00), answer {"lead": {"owner_id": "00000000-0000-0000 |
| 92 | bulk_update_leads: a return date that is not in the future accepted | caught | FAIL: "select public.bulk_update_leads(array['f88b3931-4abf-45dd-ad84-e44173e29ca3']::uuid[], 'cool_off', false, null, '2026-10-10 21:30:49. |
| 93 | Lead guard: a new Cool off lead keeps a past date (an imported old retry date brings it back at once) | caught | FAIL: a new Cool off lead with a past date would come back at once |
| 94 | undo_activity: restored.next_action_at claimed when lead_guard gave the empty Cool off date +90 days | caught | FAIL: undo into Cool off with no date: (cool_off, 2027-01-09 21:31:46.112003+00), answer {"lead": {"owner_id": "00000000-0000-0000-0000-0000 |

Script summary: `day4b: 94 rows run: 94 caught, 0 documented two-layer rows not caught, 0 not as listed`

## Review round: undo into a due Cool off lead (finding 1, 11 Oct)

Undo of an outcome on a Cool off lead whose return date had come put the lead back in Cool off for 90 more days:
`lead_guard` rule 5 treated the restored past date like an old retry date. Rule 5 now replaces, on an update, only an
empty date or a past date the statement leaves unchanged; a past date the statement writes (undo) is kept, and
`bulk_update_leads` refuses a return date that is not in the future (hint `bounds`). Tests: `outcome_attack.sql` 6b
(Interested, Book meeting and Do not contact on a due Cool off lead, then undo: same status and date), section 12 (bulk
with a past date and with now(); a new Cool off lead with a past date still gets 90 days).

The day4b set now has 93 rows. Rows 8 and 45 edit the new condition; 91 to 93 are new. Run in a throwaway worktree on
**fd6be15** (rows 8, 45, 46, 91, 92, 93 only): **6 of 6 caught**, 0 not as listed.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 8 | Lead guard: no Cool off default | caught | FAIL: Cool off with a past retry date would come back at once |
| 45 | Lead guard: Cool off default only without a date (a past retry date brings the lead back at once: the design's literal rule) | caught | FAIL: Cool off with a past retry date would come back at once |
| 46 | Lead guard: Cool off default on every update of a Cool off lead (its date cannot be cleared) | caught | FAIL: undo of interested on a due Cool off lead |
| 91 | Lead guard: a past date the statement writes is replaced on entering Cool off (undo of a due Cool off lead: +90 days) | caught | FAIL: undo of interested on a due Cool off lead |
| 92 | bulk_update_leads: a return date that is not in the future accepted | caught | FAIL: "select public.bulk_update_leads(..., 'cool_off', false, null, <yesterday>)" succeeded, expected 22023 |
| 93 | Lead guard: a new Cool off lead keeps a past date (an imported old retry date brings it back at once) | caught | FAIL: a new Cool off lead with a past date would come back at once |

## Review round 2: the undo answer after Cool off's default (verifier note 3, 11 Oct)

`undo_activity` worked out `restored.next_action_at` before its update. On a Cool off lead whose date had been cleared,
an outcome then Undo puts back Cool off with an empty date, `lead_guard` rule 5 gives it +90 days, and the answer still
said the date was restored. The update now returns the stored date, and the flag is true only when that date is the one
put back. Test: `outcome_attack.sql` 6c (status Cool off, date now()+90 days, `restored.status` true,
`restored.next_action_at` false, `lead.next_action_at` the stored date). With the line removed, 6c fails with
`restored.next_action_at: true` and a +90-day date.

The day4b set now has 94 rows; 94 is new. Run in a throwaway worktree on **44d90e6** (rows 8, 45, 46, 91 to 94):
**7 of 7 caught**, 0 not as listed.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 8 | Lead guard: no Cool off default | caught | FAIL: undo into Cool off with no date: (cool_off, <NULL>), answer {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status |
| 45 | Lead guard: Cool off default only without a date (a past retry date brings the lead back at once: the design's literal rule) | caught | FAIL: Cool off with a past retry date would come back at once |
| 46 | Lead guard: Cool off default on every update of a Cool off lead (its date cannot be cleared) | caught | FAIL: undo of interested on a due Cool off lead: (cool_off, 2027-01-09 20:10:01.909746+00), answer {"lead": {"owner_id": "00000000-0000-0000 |
| 91 | Lead guard: a past date the statement writes is replaced on entering Cool off (undo of a due Cool off lead: +90 days) | caught | FAIL: undo of interested on a due Cool off lead: (cool_off, 2027-01-09 20:10:29.628342+00), answer {"lead": {"owner_id": "00000000-0000-0000 |
| 92 | bulk_update_leads: a return date that is not in the future accepted | caught | FAIL: "select public.bulk_update_leads(array['ac825915-1444-4b7e-8f66-089eb5f6bc2e']::uuid[], 'cool_off', false, null, '2026-10-10 20:10:57. |
| 93 | Lead guard: a new Cool off lead keeps a past date (an imported old retry date brings it back at once) | caught | FAIL: a new Cool off lead with a past date would come back at once |
| 94 | undo_activity: restored.next_action_at claimed when lead_guard gave the empty Cool off date +90 days | caught | FAIL: undo into Cool off with no date: (cool_off, 2027-01-09 20:11:53.579115+00), answer {"lead": {"owner_id": "00000000-0000-0000-0000-0000 |

## Re-run after merging `main` (PR #13) and the lock changes (11 Oct, evening)

After `origin/main` (Day 4a as merged, 1004fa5) was merged into this branch (2585163), and `log_activity` and the insert
lock were changed (3770528), every set ran again in a throwaway worktree: Day 4a and Day 3b on **c4fb0b9**, Day 4b on
**c4fb0b9**, then rows 87 to 90 again on **8d4ff18** (the case-5 test fix below).

| Set | Rows | Result |
|---|---|---|
| Day 4b | 90 | **90 of 90 caught** (row 90 first survived on c4fb0b9, caught on 8d4ff18) |
| Day 4a (as merged, 104 rows) | 104 | 102 caught, 2 documented two-layer rows not caught (96, 100), 0 not as listed |
| Day 3b | 37 | 36 caught, 1 documented two-layer row not caught (4), 0 not as listed |

What changed in the list:
- Day 4b redefines `private.lock_activity_lead` (the Day 4a advisor's carry-over: a signed-in session without two-factor,
  or naming a lead or contact of another organisation, locks nothing), `audit_row` and `tasks_delete`, so Day 4a rows 70,
  71 and 102 (the insert lock), 83 (audit body length) and 84 (task delete role) now edit the Day 4b migration, where the
  live definition is.
- New Day 4b rows: 87, `log_activity` takes the lead before a contact it does not mark (deadlock, caught by
  `outcome_concurrency.sh` case 4, which deadlocked on the code before the fix); 88 to 90, the insert lock locks for a
  session without two-factor, a lead of another organisation, a contact of another organisation (case 5: a refused
  insert must answer at once while another session holds that row). Row 5's lock block (`LOG_LOCKS`) includes the new
  contact FOR KEY SHARE.
- Row 90 survived the first run: case 5 held the contact FOR NO KEY UPDATE, which does not conflict with FOR KEY SHARE.
  It now holds rows FOR UPDATE (8d4ff18) and row 90 is caught; rows 87 to 89 were caught on both commits.

Full tables of this re-run are at the end of this file. The sections below are the first run (86 rows, on b226622).

## First run (86 rows, b226622)

`python3 scripts/db-mutations.py --set day4b` changes the migrations in place for one mutation, runs the whole database
suite (`scripts/db-test.sh`: migrations, the RLS attack test, the import attack and two-session tests, the activity
attack test, the new outcome attack test and outcome two-session test, advisors) and restores the migrations; "caught"
means the suite failed. Run on commit b226622 (the final migration and the final tests of this part; later commits
change one comparison in `outcome_attack.sql` to avoid a gitleaks false positive, perf scripts and documents), in a
separate copy of the code (`git worktree`), so nothing else read a mutated file.

Result: **86 of 86 caught.** Rows 1 to 11 are the design's list (section 8.3, 4b), in its order; row 11 is "mark the wrong
number for non-editors" written as the code claiming a mark it could not make, and row 12 is the same threat as a
definer function would carry it (the design's rejected "definer activity trigger"). Rows 13 to 86 remove every other
protection the migration adds, one at a time: each guard rule and pre-check, each CHECK behind a pre-check, each
compare in undo, each clause of the two no-code delete branches, the undo record's policies and grants, each outcome
rule of design 5.5, the follow-up and input rules, the timeline's keyset and input checks, the audit exclusions, the
zone map, `next_working_day` and `call_attempts`. What makes this possible (see `supabase/tests/outcome_attack.sql` and
`outcome_concurrency.sh`):

- probes through the API role (grants, row level security and triggers all apply), each case on its own fresh lead in a
  block that is rolled back, so the outcome table can log and undo 32 times without touching the flood guards;
- the outcome table undoes with **no** fresh code, the usual case, so the no-code delete branches are on its path (with
  a fresh code, the code branch would hide a broken undo: row 20);
- the superuser with one guard off, to prove a CHECK backstop on its own (row 34), and to give a mark, a completed
  task or a dismissed task "another time" than the entry's (rows 15, 16, 18, 19);
- three-transaction cases where "touched since" matters (a task edit in the same transaction carries the same time as
  its insert: rows 17, 23);
- two sessions at once for the lead lock, the lock order and concurrent replays (rows 5, 31, 32, and row 9 for the
  note replay that takes no lock).

Three rows remove a protection together with its second layer, and say so:

- row 24: the no-code task branch requires the creator **and** the source entry's author to be the caller; the task
  guard makes the creator the source's author, so each condition alone is covered by the other;
- row 31: a concurrent replay is caught by the second replay check after the lock **and** by the unique-violation
  answer; row 32 removes the answer alone and is caught (the note replay takes no lock);
- row 35: `set_lead_timezone`'s pre-check gives the same constant error as `lead_guard` rule 2, with the CHECK behind
  both; the guard's pre-check alone is row 33 and the CHECK alone row 34, each caught; the RPC's pre-check alone is not
  a row (it only answers before the guard would, with the same words).

A first pass on b144b85 (54 rows before it was stopped to move to the final commit) found two survivors, both fixed
before this run: row 20 (every undo in the tests ran with a fresh code; the outcome table now undoes without one) and
row 24 (written then as one layer; now both). The undo record's insert check on the caller's own entry (row 29) was
added after that pass.

| # | Protection removed | Result | First failure |
| 1 | Undo: no compare before restoring the status (a colleague's change overwritten) | caught | FAIL: undo overwrote a colleague's status {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "cold", "next_action_ |
| 2 | Entry delete without a code: no 'no undo record' condition (an outcome deleted around undo) | caught | FAIL: a fresh outcome was deleted without a code (around undo) |
| 3 | Undo: no 2-minute window in undo_activity | caught | FAIL: "select public.undo_activity('64f1b2d6-df5c-469e-a957-424a0f47605e')" succeeded, expected 22023 |
| 4 | Outcome decisions applied for people who may not change the lead | caught | FAIL: a rep took or changed an unassigned lead {"task_id": "5a55638b-d481-49e2-b30f-c137b1cf6497", "editable": true, "replayed": false, "cre |
| 5 | Lock order reversed in log_activity: lead, then contact (deadlock test) | caught | deadlock detected |
| 6 | Lead guard: a country change keeps the picked zone | caught | new row for relation "companies" violates check constraint "companies_timezone_fits" |
| 7 | Lead guard: next call bound checked even when unchanged (overdue or far leads stuck) | caught | the next call date is too far ahead |
| 8 | Lead guard: no Cool off default | caught | FAIL: Cool off with a past retry date would come back at once |
| 9 | Activities: request id index not unique (Day 4a migration) | caught | FAIL: the request indexes must be unique per author |
| 10 | Timeline keyset: <= instead of < (an entry repeated across pages) | caught | FAIL: the timeline repeated an entry across pages |
| 11 | Wrong number: the dialled contact marked without the editor's lock (code claims a mark) | caught | FAIL: a rep marked a colleague's contact, or got no task {"task_id": null, "editable": false, "replayed": false, "created_at": "2026-10-11T1 |
| 12 | log_activity runs as its owner (marks and decisions for anyone, as a definer trigger would) | caught | FAIL: RPC rules broken by {"log_activity(uuid,text,text,text,uuid,text,date,timestamp with time zone,text,uuid,boolean)"} |
| 13 | Undo: no compare before restoring the next call | caught | FAIL: undo overwrote a colleague's next call {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "cold", "next_acti |
| 14 | Undo: no compare before restoring the owner | caught | FAIL: undo overwrote a colleague's owner {"lead": {"owner_id": null, "lead_status": "cold", "next_action_at": null, "last_activity_at": null |
| 15 | Undo: clears the lead's mark whatever its time | caught | FAIL: undo cleared a mark made at another time {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "cold", "next_ac |
| 16 | Undo: clears the contact's mark whatever its time | caught | FAIL: undo cleared a mark twice |
| 17 | Undo: deletes the follow-up even when touched or done (a fresh code passes the policy) | caught | FAIL: undo deleted a completed task |
| 18 | Undo: reopens completed tasks whatever their time | caught | FAIL: undo reopened a task completed at another time {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "cold", "n |
| 19 | Undo: reopens dismissed tasks whatever their time | caught | FAIL: undo reopened a task dismissed at another time {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "warm", "n |
| 20 | Undo: the record is not consumed (a second undo runs again) | caught | this can no longer be undone |
| 21 | Entry delete without a code: no 2-minute bound in the policy | caught | FAIL: an entry deleted with no code |
| 22 | Entry delete without a code: anyone's entry | caught | FAIL: a colleague deleted a fresh entry without a code |
| 23 | Task delete without a code: touched tasks too | caught | FAIL: a touched task was deleted without a code |
| 24 | Task delete without a code: anyone's task (both layers: the creator, and the source entry's author, who is the creator by the task guard) | caught | FAIL: an admin removed a colleague's fresh task without a code |
| 25 | Task delete without a code: while the undo record still exists | caught | FAIL: the task of a fresh outcome was deleted without a code |
| 26 | Task delete without a code: from an entry of any age | caught | FAIL: a task from an entry older than 2 minutes was deleted without a code |
| 27 | Undo records: no two-factor policy | caught | FAIL: private.activity_undo protections |
| 28 | Undo records: everyone in the org sees and deletes them | caught | FAIL: a person sees someone else's undo records |
| 29 | Undo records: a record may name a colleague's entry | caught | FAIL: "insert into private.activity_undo (activity_id, org_id, user_id) values ('9c1995fb-ecd9-4fe9-8c00-c4bfe4f54476', '2bfa524d-d47a-40a6- |
| 30 | Undo records: update granted | caught | FAIL: private.activity_undo protections |
| 31 | log_activity: no second replay check after the lock, and no unique-violation answer (both layers) | caught | duplicate key value violates unique constraint "activities_author_request_idx" |
| 32 | log_activity: no unique-violation answer (a concurrent duplicate fails) | caught | duplicate key value violates unique constraint "activities_author_request_idx" |
| 33 | Lead guard: no zone pre-check (the CHECK answers with the row) | caught | FAIL: "update public.companies set timezone = 'America/Toronto' where id = '74ae5cf1-7d66-4748-a3f0-0f83c1744455'" gave 23514 (hint "", new  |
| 34 | Leads: no time zone CHECK (backstop) | caught | FAIL: "update public.companies set timezone = 'Europe/Paris' where id = 'dc230c61-9d4f-4da4-aa3a-716b7a0be9d2'" succeeded, expected 23514 |
| 35 | set_lead_timezone and the lead guard: no zone check at all (both layers) | caught | FAIL: "select public.set_lead_timezone('622430d4-5011-4bc8-b531-508131d6ada6', 'Europe/Paris')" succeeded, expected 22023 |
| 36 | Lead guard: a country change always clears the zone (a zone picked with the new country lost) | caught | FAIL: "update public.companies set country = 'CA', timezone = 'America/Chicago' where id = 'dafc2787-23b0-4600-85b3-674076a7a79a'" succeeded |
| 37 | Lead guard: no next call bound | caught | FAIL: "select public.set_lead_next_action('1add7a90-7e3c-4c3d-9171-55172bb6b5d0', '2028-10-12 11:40:09.49293+00')" succeeded, expected 22023 |
| 38 | Lead guard: next call bound for maintenance sessions too | caught | the next call date is too far ahead |
| 39 | Lead guard: a new phone keeps the wrong-number mark | caught | FAIL: a new main number kept the mark |
| 40 | Lead guard: a mark keeps the client's time | caught | FAIL: a client chose the time of a wrong-number mark |
| 41 | Lead guard: a mark's time can be changed | caught | FAIL: a mark's time changed |
| 42 | Contact guard: a new phone keeps the mark | caught | FAIL: a new contact number kept the wrong-number mark |
| 43 | Contact guard: a mark keeps the client's time | caught | FAIL: a client chose the time of a wrong-number mark |
| 44 | Contact guard trigger dropped | caught | FAIL: lead_guard, contact_guard (BEFORE) and the time zone CHECK must exist |
| 45 | Lead guard: Cool off default only without a date (a past retry date brings the lead back at once: the design's literal rule) | caught | FAIL: Cool off with a past retry date would come back at once |
| 46 | Lead guard: Cool off default on every update of a Cool off lead (its date cannot be cleared) | caught | FAIL: clearing a Cool off lead's date put a default back |
| 47 | Audit: next call and marks diffed | caught | FAIL: audit of an outcome |
| 48 | Lead columns: insert granted on the next call | caught | FAIL: grants on the new lead and contact columns |
| 49 | Outcomes: the 6th try counts from 7 (>= 6) | caught | FAIL: after {no_answer,voicemail,no_answer,no_answer,voicemail} then no_answer: (cold, 2026-10-12 07:00:00+00), expected (cool_off, 2026-11- |
| 50 | Outcomes: the 6th try sends any status to Cool off | caught | FAIL: after {no_answer,no_answer,no_answer,no_answer,no_answer} then no_answer: (cool_off, 2026-11-10 11:42:59.902826+00), expected (negotia |
| 51 | Outcomes: voicemail waits one working day like no answer | caught | FAIL: voicemail on cold: lead (cold, 2026-10-12 07:00:00+00), answer {"task_id": null, "editable": true, "replayed": false, "created_at": "2 |
| 52 | Outcomes: Not interested moves Negotiation to Cool off | caught | FAIL: not_interested on negotiation: lead (cool_off, 2027-01-09 11:43:25.895656+00), answer {"task_id": null, "editable": true, "replayed":  |
| 53 | Outcomes: Interested moves a lead down (Negotiation to Warm) | caught | FAIL: interested on negotiation: lead (warm, 2026-10-14 07:00:00+00), answer {"task_id": "b2f8afa0-a762-4b36-bc84-13ba6f9442ac", "editable": |
| 54 | Outcomes: Book meeting moves Negotiation to Warm | caught | FAIL: meeting_booked on negotiation: lead (warm, 2026-10-15 13:43:00+00), answer {"task_id": "fa6917b1-06e2-47df-aedc-a20144db8b38", "editab |
| 55 | Outcomes: Do not contact keeps the next call | caught | FAIL: do_not_contact on cold: lead (do_not_contact, 2026-10-14 11:44:02+00), answer {"task_id": null, "editable": true, "replayed": false, " |
| 56 | Outcomes: Spoke without a follow-up keeps the next call (no 30 days) | caught | FAIL: connected on cold: lead (cold, 2026-10-14 11:44:15+00), answer {"task_id": null, "editable": true, "replayed": false, "created_at": "2 |
| 57 | Outcomes: back on the follow-up day itself, not the day after | caught | FAIL: meeting_booked on cold: lead (warm, 2026-10-14 13:44:00+00), answer {"task_id": "40cd48a3-42fb-4485-a02a-1ea65af4a8b2", "editable": tr |
| 58 | Outcomes: a follow-up date read in Paris for every lead (not its zone) | caught | FAIL: interested on a US lead (zone <NULL>): {"task_id": "e7428e27-4c58-454b-ab18-7917d1434589", "editable": true, "replayed": false, "creat |
| 59 | Outcomes: an owned lead taken over too | caught | FAIL: interested on cold: lead (warm, 2026-10-14 07:00:00+00), answer {"task_id": "6bfda471-d70f-4122-9286-551ea75fe1f2", "editable": true,  |
| 60 | Outcomes: Spoke takes over an unassigned lead too | caught | FAIL: connected on a lead owned by <NULL>: owner 00000000-0000-0000-0000-00000000000a, answer {"task_id": null, "editable": true, "replayed" |
| 61 | Tasks: a call completes every open call task, due or not | caught | FAIL: no_answer on cold: the future call task (done 2026-10-11 11:45:19.377652+00, dismissed <NULL>) |
| 62 | Tasks: a call completes to-dos too | caught | FAIL: a call completed ["1496e72f-bef2-4243-ab93-bd2b4547ea04", "361eaea5-6307-461d-8f00-a0b901dfad2d", "8dfa7151-2031-4583-a74c-45c8f4eef3c |
| 63 | Tasks: a call completes a colleague's call tasks | caught | FAIL: a call completed ["56fb99a1-50e0-43f3-a8e8-fcd2e0256344", "a59aa14c-29d9-45cb-9bf7-e22aae4828b1", "ee261e55-18ea-4728-ac86-d4dba167524 |
| 64 | Tasks: Do not contact dismisses nothing | caught | FAIL: do_not_contact on cold: the future call task (done <NULL>, dismissed <NULL>) |
| 65 | Tasks: 'find the right number' although another number works | caught | FAIL: wrong main line with a working contact {"task_id": "1fe51eba-2076-4f6b-9b2a-5f1427b29709", "editable": true, "replayed": false, "creat |
| 66 | Tasks: 'find the right number' always for the caller (not the owner) | caught | FAIL: wrong_number on cold: the task made {"id":"a03652e0-9a76-4bb7-ad2a-901fe9e261b2","org_id":"1674c94a-94f8-4bb7-a56a-0599e8ecba57","cont |
| 67 | Input: Interested without a follow-up | caught | FAIL: "select public.log_activity('fd021130-4395-4348-9925-56708d96ae9c', 'call', 'interested', NULL, NULL, null, NULL, NULL, 'Follow up')"  |
| 68 | Input: follow-up dates and times not bounded | caught | FAIL: "select public.log_activity('8d974709-c7c8-4414-ac7c-735d6dbae6c7', 'call', 'interested', NULL, NULL, null, '2026-10-09', NULL, 'F')"  |
| 69 | Input: a follow-up on an outcome that takes none | caught | FAIL: "select public.log_activity('9ece1700-6917-4f40-9fb3-625363620f47', 'call', 'no_answer', NULL, NULL, null, '2026-10-13', NULL, 'F')" s |
| 70 | Input: Wrong number without a title up front | caught | FAIL: "select public.log_activity('d4ec33f5-a5de-410b-b9fb-d55a01d07b2b', 'call', 'wrong_number', null, null, 'lead')" succeeded, expected 2 |
| 71 | Input: a note without text | caught | FAIL: "select public.log_activity('bc1ec63d-0c18-41e1-b583-b266b0ae7183', 'note', NULL, ' |
| 72 | Input: no check of the dialled number | caught | FAIL: "select public.log_activity('e533d726-2d2a-4c2a-9465-885ef3c89a52', 'call', 'wrong_number', null, null, null, null, null, 'Find')" gav |
| 73 | Input: an empty dialled number accepted | caught | FAIL: "select public.log_activity('2aec7c7d-f4b2-4d9a-88d8-38a7b07fb0f8', 'call', 'wrong_number', null, null, 'lead', null, null, 'Find')" s |
| 74 | Input: a contact of another lead (the policy answers 42501 instead of P0002) | caught | FAIL: "select public.log_activity('0abf50e0-88ad-42f5-9ec9-63081f1f5071', 'note', NULL, 'x', '058845a4-198d-4a72-90f4-0d3e499baac7', null, N |
| 75 | Timeline: unknown kinds accepted | caught | FAIL: "select * from public.list_lead_activities('6181c930-e07b-41e0-9e17-157e8c60ee79', '{call,fax}')" succeeded, expected 22023 |
| 76 | Timeline: half a cursor accepted | caught | FAIL: "select * from public.list_lead_activities('0505bf4f-13c2-41df-9147-b9ec25c176c3', null, now(), null)" succeeded, expected 22023 |
| 77 | Timeline: any page size | caught | FAIL: "select * from public.list_lead_activities('3b6ebe4b-3fab-4485-ae4e-15568311a21f', null, null, null, 0)" succeeded, expected 22023 |
| 78 | delete_activity: no fresh-code pre-check (no step_up hint) | caught | FAIL: "select public.delete_activity('bf0fb943-dac6-4fe0-a58a-ff54d2568343')" gave 42501 (hint "", only the author, a manager or an admin ca |
| 79 | get_lead: anyone may set the zone | caught | FAIL: a non-editor may set the zone |
| 80 | bulk_update_leads: a return date with any status | caught | FAIL: "select public.bulk_update_leads(array['84c96e54-2038-4a4e-b765-ec6c323dbb7d']::uuid[], 'warm', false, null, '2026-11-25 00:00:00+00') |
| 81 | next_working_day: weekends count | caught | FAIL: next_working_day(2026-10-09 15:30:00+00, 1, Europe/Paris) = 2026-10-10 07:00:00+00, expected 2026-10-12 07:00:00+00 |
| 82 | next_working_day: a span on its western end | caught | FAIL: next_working_day(2026-10-28 15:00:00+00, 1, US) = 2026-10-29 16:00:00+00, expected 2026-10-29 13:00:00+00 |
| 83 | call_attempts: a Spoke does not break the run | caught | FAIL: call_attempts after {no_answer,no_answer,connected,no_answer,no_answer} is 4, expected 2 |
| 84 | call_attempts: the 7 latest calls | caught | FAIL: call_attempts after {voicemail,no_answer,no_answer,no_answer,no_answer,no_answer,voicemail} is 7, expected 6 |
| 85 | Zone map: France on London time | caught | FAIL: country_call_zone |
| 86 | Zone map: a US zone allowed for Canada | caught | FAIL: "update public.companies set country = 'CA', timezone = 'America/Chicago' where id = '06c82d07-9ba9-4b49-beb2-1ef53b3a864d'" succeeded |

## Day 4a and Day 3b protections after Day 4b

Day 4b redefines the audit trigger and the activity and task delete policies, so the Day 3b and Day 4a mutations of
those now edit the Day 4b migration, where the live definitions are (`scripts/db-mutations.py`, its docstring). Both
lists were re-run after Day 4b, on commit b144b85 (the Day 4b migration and tests then; the later Day 4b commits change
`get_lead`'s zone fence, the undo record's insert check and one Day 4b test, none of which these rows touch), in a
separate copy of the code:

- `--set day4a`: **64 of 64 caught**, as on 11 Oct before Day 4b. The retargeted rows:

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 6 | Activities delete: no fresh code (the policy as Day 4b redefines it) | caught | FAIL: an entry deleted with no code |
| 9 | Audit: a deleted entry keeps its text | caught | FAIL: a deleted entry should be audited without its text, with its length: {"id": "7f41dd1e-efd8-4a57-a22d-62ed093310e9", "body": "AUDIT-MAR |
| 32 | Audit: an edit keeps the text | caught | FAIL: an edit should be audited as the text's lengths and edited_at: {"body": {"new": "AUDIT-MARKER second, longer words", "old": "AUDIT-MAR |
| 33 | Audit: new entries copied | caught | FAIL: an activity insert was copied into the audit log |
| 57 | Tasks delete: no fresh code (the policy as Day 4b redefines it) | caught | FAIL: a task deleted without a code |

- `--set day3b`: **36 of 37 caught**, the same documented two-layer row 4 as before (the admin check in the tagging rule
  is backed by the admin-only rule for seeing imports; removing both, row 5, is caught). Row 4 and the retargeted rows:

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 4 | Tagging leads: no admin check | **NOT CAUGHT** | advisors: no ERROR-level findings |
| 28 | Audit: full copy of imported leads | caught | FAIL: imported leads should each have one small audit row |
| 29 | Audit: search and key columns kept | caught | FAIL: search_text copied into the audit log |

## Full tables of the re-run (11 Oct, evening)

### Day 4b (c4fb0b9; row 90 from 8d4ff18)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Undo: no compare before restoring the status (a colleague's change overwritten) | caught | FAIL: undo overwrote a colleague's status {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "cold", "next_action_ |
| 2 | Entry delete without a code: no 'no undo record' condition (an outcome deleted around undo) | caught | FAIL: a fresh outcome was deleted without a code (around undo) |
| 3 | Undo: no 2-minute window in undo_activity | caught | FAIL: "select public.undo_activity('4f70a907-312d-4fc8-af5c-e10671b10d3c')" succeeded, expected 22023 |
| 4 | Outcome decisions applied for people who may not change the lead | caught | FAIL: a rep took or changed an unassigned lead {"task_id": "5e438983-e588-42ea-a93e-dfd9bd0fdcae", "editable": true, "replayed": false, "cre |
| 5 | Lock order reversed in log_activity: lead, then contact (deadlock test) | caught | deadlock detected |
| 6 | Lead guard: a country change keeps the picked zone | caught | new row for relation "companies" violates check constraint "companies_timezone_fits" |
| 7 | Lead guard: next call bound checked even when unchanged (overdue or far leads stuck) | caught | the next call date is too far ahead |
| 8 | Lead guard: no Cool off default | caught | FAIL: Cool off with a past retry date would come back at once |
| 9 | Activities: request id index not unique (Day 4a migration) | caught | FAIL: the request indexes must be unique per author |
| 10 | Timeline keyset: <= instead of < (an entry repeated across pages) | caught | FAIL: the timeline repeated an entry across pages |
| 11 | Wrong number: the dialled contact marked without the editor's lock (code claims a mark) | caught | FAIL: a rep marked a colleague's contact, or got no task {"task_id": null, "editable": false, "replayed": false, "created_at": "2026-10-11T1 |
| 12 | log_activity runs as its owner (marks and decisions for anyone, as a definer trigger would) | caught | FAIL: RPC rules broken by {"log_activity(uuid,text,text,text,uuid,text,date,timestamp with time zone,text,uuid,boolean)"} |
| 13 | Undo: no compare before restoring the next call | caught | FAIL: undo overwrote a colleague's next call {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "cold", "next_acti |
| 14 | Undo: no compare before restoring the owner | caught | FAIL: undo overwrote a colleague's owner {"lead": {"owner_id": null, "lead_status": "cold", "next_action_at": null, "last_activity_at": null |
| 15 | Undo: clears the lead's mark whatever its time | caught | FAIL: undo cleared a mark made at another time {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "cold", "next_ac |
| 16 | Undo: clears the contact's mark whatever its time | caught | FAIL: undo cleared a mark twice |
| 17 | Undo: deletes the follow-up even when touched or done (a fresh code passes the policy) | caught | FAIL: undo deleted a completed task |
| 18 | Undo: reopens completed tasks whatever their time | caught | FAIL: undo reopened a task completed at another time {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "cold", "n |
| 19 | Undo: reopens dismissed tasks whatever their time | caught | FAIL: undo reopened a task dismissed at another time {"lead": {"owner_id": "00000000-0000-0000-0000-0000000000d1", "lead_status": "warm", "n |
| 20 | Undo: the record is not consumed (a second undo runs again) | caught | this can no longer be undone |
| 21 | Entry delete without a code: no 2-minute bound in the policy | caught | FAIL: an entry deleted with no code |
| 22 | Entry delete without a code: anyone's entry | caught | FAIL: a colleague deleted a fresh entry without a code |
| 23 | Task delete without a code: touched tasks too | caught | FAIL: a touched task was deleted without a code |
| 24 | Task delete without a code: anyone's task (both layers: the creator, and the source entry's author, who is the creator by the task guard) | caught | FAIL: an admin removed a colleague's fresh task without a code |
| 25 | Task delete without a code: while the undo record still exists | caught | FAIL: the task of a fresh outcome was deleted without a code |
| 26 | Task delete without a code: from an entry of any age | caught | FAIL: a task from an entry older than 2 minutes was deleted without a code |
| 27 | Undo records: no two-factor policy | caught | FAIL: private.activity_undo protections |
| 28 | Undo records: everyone in the org sees and deletes them | caught | FAIL: a person sees someone else's undo records |
| 29 | Undo records: a record may name a colleague's entry | caught | FAIL: "insert into private.activity_undo (activity_id, org_id, user_id) values ('aa5f19b3-00cd-4fd5-accd-be3f63e9dc3f', 'eae50dba-4750-42e5- |
| 30 | Undo records: update granted | caught | FAIL: private.activity_undo protections |
| 31 | log_activity: no second replay check after the lock, and no unique-violation answer (both layers) | caught | duplicate key value violates unique constraint "activities_author_request_idx" |
| 32 | log_activity: no unique-violation answer (a concurrent duplicate fails) | caught | duplicate key value violates unique constraint "activities_author_request_idx" |
| 33 | Lead guard: no zone pre-check (the CHECK answers with the row) | caught | FAIL: "update public.companies set timezone = 'America/Toronto' where id = '0b32e0d8-3038-4bac-a242-75747e7134e5'" gave 23514 (hint "", new  |
| 34 | Leads: no time zone CHECK (backstop) | caught | FAIL: "update public.companies set timezone = 'Europe/Paris' where id = '3ba85104-2037-4c7a-92cc-ddcd42e6d3e7'" succeeded, expected 23514 |
| 35 | set_lead_timezone and the lead guard: no zone check at all (both layers) | caught | FAIL: "select public.set_lead_timezone('30c891b5-4f43-4e33-8e15-b26b12e55335', 'Europe/Paris')" succeeded, expected 22023 |
| 36 | Lead guard: a country change always clears the zone (a zone picked with the new country lost) | caught | FAIL: "update public.companies set country = 'CA', timezone = 'America/Chicago' where id = '9660da67-f13f-4f8d-9d8f-2e891b9dc7c9'" succeeded |
| 37 | Lead guard: no next call bound | caught | FAIL: "select public.set_lead_next_action('35ea9dfa-219d-4eb7-9ba7-a517ede70d9d', '2028-10-12 17:32:41.411047+00')" succeeded, expected 2202 |
| 38 | Lead guard: next call bound for maintenance sessions too | caught | the next call date is too far ahead |
| 39 | Lead guard: a new phone keeps the wrong-number mark | caught | FAIL: a new main number kept the mark |
| 40 | Lead guard: a mark keeps the client's time | caught | FAIL: a client chose the time of a wrong-number mark |
| 41 | Lead guard: a mark's time can be changed | caught | FAIL: a mark's time changed |
| 42 | Contact guard: a new phone keeps the mark | caught | FAIL: a new contact number kept the wrong-number mark |
| 43 | Contact guard: a mark keeps the client's time | caught | FAIL: a client chose the time of a wrong-number mark |
| 44 | Contact guard trigger dropped | caught | FAIL: lead_guard, contact_guard (BEFORE) and the time zone CHECK must exist |
| 45 | Lead guard: Cool off default only without a date (a past retry date brings the lead back at once: the design's literal rule) | caught | FAIL: Cool off with a past retry date would come back at once |
| 46 | Lead guard: Cool off default on every update of a Cool off lead (its date cannot be cleared) | caught | FAIL: clearing a Cool off lead's date put a default back |
| 47 | Audit: next call and marks diffed | caught | FAIL: audit of an outcome |
| 48 | Lead columns: insert granted on the next call | caught | FAIL: grants on the new lead and contact columns |
| 49 | Outcomes: the 6th try counts from 7 (>= 6) | caught | FAIL: after {no_answer,voicemail,no_answer,no_answer,voicemail} then no_answer: (cold, 2026-10-12 07:00:00+00), expected (cool_off, 2026-11- |
| 50 | Outcomes: the 6th try sends any status to Cool off | caught | FAIL: after {no_answer,no_answer,no_answer,no_answer,no_answer} then no_answer: (cool_off, 2026-11-10 17:38:49.044524+00), expected (negotia |
| 51 | Outcomes: voicemail waits one working day like no answer | caught | FAIL: voicemail on cold: lead (cold, 2026-10-12 07:00:00+00), answer {"task_id": null, "editable": true, "replayed": false, "created_at": "2 |
| 52 | Outcomes: Not interested moves Negotiation to Cool off | caught | FAIL: not_interested on negotiation: lead (cool_off, 2027-01-09 17:39:43.931519+00), answer {"task_id": null, "editable": true, "replayed":  |
| 53 | Outcomes: Interested moves a lead down (Negotiation to Warm) | caught | FAIL: interested on negotiation: lead (warm, 2026-10-14 07:00:00+00), answer {"task_id": "d474ec15-2e21-4315-aa3c-3b27bda04f19", "editable": |
| 54 | Outcomes: Book meeting moves Negotiation to Warm | caught | FAIL: meeting_booked on negotiation: lead (warm, 2026-10-15 19:40:00+00), answer {"task_id": "2cd64b59-e2c3-4201-a341-ab73fdc453e5", "editab |
| 55 | Outcomes: Do not contact keeps the next call | caught | FAIL: do_not_contact on cold: lead (do_not_contact, 2026-10-14 17:41:07+00), answer {"task_id": null, "editable": true, "replayed": false, " |
| 56 | Outcomes: Spoke without a follow-up keeps the next call (no 30 days) | caught | FAIL: connected on cold: lead (cold, 2026-10-14 17:41:35+00), answer {"task_id": null, "editable": true, "replayed": false, "created_at": "2 |
| 57 | Outcomes: back on the follow-up day itself, not the day after | caught | FAIL: meeting_booked on cold: lead (warm, 2026-10-14 19:42:00+00), answer {"task_id": "1ac1c5b1-75eb-4eaf-a4d6-d82951513644", "editable": tr |
| 58 | Outcomes: a follow-up date read in Paris for every lead (not its zone) | caught | FAIL: interested on a US lead (zone <NULL>): {"task_id": "45508d25-c705-4767-b8dc-3fdd866039f9", "editable": true, "replayed": false, "creat |
| 59 | Outcomes: an owned lead taken over too | caught | FAIL: interested on cold: lead (warm, 2026-10-14 07:00:00+00), answer {"task_id": "4700de7c-2735-439e-b787-386439476b3e", "editable": true,  |
| 60 | Outcomes: Spoke takes over an unassigned lead too | caught | FAIL: connected on a lead owned by <NULL>: owner 00000000-0000-0000-0000-00000000000a, answer {"task_id": null, "editable": true, "replayed" |
| 61 | Tasks: a call completes every open call task, due or not | caught | FAIL: no_answer on cold: the future call task (done 2026-10-11 17:43:53.008496+00, dismissed <NULL>) |
| 62 | Tasks: a call completes to-dos too | caught | FAIL: a call completed ["6fc7a74a-5faf-4c81-ace6-f3b2f79c662c", "9a3fb1bb-15cd-412b-920e-9b249e7301e7", "a2e5bfd5-555d-47b0-bfdf-a438ff60b7d |
| 63 | Tasks: a call completes a colleague's call tasks | caught | FAIL: a call completed ["1e95a891-9e0c-48d7-b4dc-a142f6892544", "219dd0ba-2864-4ea1-ac91-c888eb14c13e", "4f4f4f9b-9536-470b-8706-8740ed6a3a8 |
| 64 | Tasks: Do not contact dismisses nothing | caught | FAIL: do_not_contact on cold: the future call task (done <NULL>, dismissed <NULL>) |
| 65 | Tasks: 'find the right number' although another number works | caught | FAIL: wrong main line with a working contact {"task_id": "2a28fec7-3507-4aa2-a401-26c3f85e3d80", "editable": true, "replayed": false, "creat |
| 66 | Tasks: 'find the right number' always for the caller (not the owner) | caught | FAIL: wrong_number on cold: the task made {"id":"40df1e21-39af-4674-a889-34c412157e49","org_id":"9826c349-4954-40b2-a6db-b73a4227be20","cont |
| 67 | Input: Interested without a follow-up | caught | FAIL: "select public.log_activity('7e9248e6-487d-4626-b0b7-ee16b425a343', 'call', 'interested', NULL, NULL, null, NULL, NULL, 'Follow up')"  |
| 68 | Input: follow-up dates and times not bounded | caught | FAIL: "select public.log_activity('d3cc477f-f867-4a40-8c84-4ffbc28c7715', 'call', 'interested', NULL, NULL, null, '2026-10-10', NULL, 'F')"  |
| 69 | Input: a follow-up on an outcome that takes none | caught | FAIL: "select public.log_activity('f56f785b-66f3-47bb-b92f-3db6f9e00338', 'call', 'no_answer', NULL, NULL, null, '2026-10-13', NULL, 'F')" s |
| 70 | Input: Wrong number without a title up front | caught | FAIL: "select public.log_activity('3433bb41-8463-4302-9b03-27d3f7a26dbb', 'call', 'wrong_number', null, null, 'lead')" succeeded, expected 2 |
| 71 | Input: a note without text | caught | FAIL: "select public.log_activity('72500a7b-32b6-47c5-a01b-9729d9fc11a7', 'note', NULL, ' |
| 72 | Input: no check of the dialled number | caught | FAIL: "select public.log_activity('ad3ac2cb-6ba6-40af-9be4-3ae96ae8b786', 'call', 'wrong_number', null, null, null, null, null, 'Find')" gav |
| 73 | Input: an empty dialled number accepted | caught | FAIL: "select public.log_activity('d8958ddb-a05d-4763-a0e6-6258a83efc6d', 'call', 'wrong_number', null, null, 'lead', null, null, 'Find')" s |
| 74 | Input: a contact of another lead (the policy answers 42501 instead of P0002) | caught | FAIL: "select public.log_activity('d483e068-41fb-4819-a01d-92f748bb3cfe', 'note', NULL, 'x', '2136e58d-e479-418c-b562-b568b52df11e', null, N |
| 75 | Timeline: unknown kinds accepted | caught | FAIL: "select * from public.list_lead_activities('d386855c-79d8-431d-9447-d3c81c9622af', '{call,fax}')" succeeded, expected 22023 |
| 76 | Timeline: half a cursor accepted | caught | FAIL: "select * from public.list_lead_activities('c7ecf529-3997-49c1-8add-e77e3337466a', null, now(), null)" succeeded, expected 22023 |
| 77 | Timeline: any page size | caught | FAIL: "select * from public.list_lead_activities('342deff6-532a-441a-a4a6-20d950a35ec7', null, null, null, 0)" succeeded, expected 22023 |
| 78 | delete_activity: no fresh-code pre-check (no step_up hint) | caught | FAIL: "select public.delete_activity('1443d6b3-1054-456a-a586-953e44efa2ab')" gave 42501 (hint "", only the author, a manager or an admin ca |
| 79 | get_lead: anyone may set the zone | caught | FAIL: a non-editor may set the zone |
| 80 | bulk_update_leads: a return date with any status | caught | FAIL: "select public.bulk_update_leads(array['c5347671-2365-4033-ba8c-c3f9892ceef1']::uuid[], 'warm', false, null, '2026-11-25 00:00:00+00') |
| 81 | next_working_day: weekends count | caught | FAIL: next_working_day(2026-10-09 15:30:00+00, 1, Europe/Paris) = 2026-10-10 07:00:00+00, expected 2026-10-12 07:00:00+00 |
| 82 | next_working_day: a span on its western end | caught | FAIL: next_working_day(2026-10-28 15:00:00+00, 1, US) = 2026-10-29 16:00:00+00, expected 2026-10-29 13:00:00+00 |
| 83 | call_attempts: a Spoke does not break the run | caught | FAIL: call_attempts after {no_answer,no_answer,connected,no_answer,no_answer} is 4, expected 2 |
| 84 | call_attempts: the 7 latest calls | caught | FAIL: call_attempts after {voicemail,no_answer,no_answer,no_answer,no_answer,no_answer,voicemail} is 7, expected 6 |
| 85 | Zone map: France on London time | caught | FAIL: country_call_zone |
| 86 | Zone map: a US zone allowed for Canada | caught | FAIL: "update public.companies set country = 'CA', timezone = 'America/Chicago' where id = '6062efc9-8313-4b3e-805a-14d3bf55cb30'" succeeded |
| 87 | log_activity: a call naming a contact it does not mark takes the lead first (deadlock test) | caught | deadlock detected |
| 88 | Insert lock: locks for a signed-in session without two-factor (holds a lead while being refused) | caught | FAIL: insert_lock_skips_refused_callers (no two-factor): the refusal took 2656 ms (it waited for a lock) |
| 89 | Insert lock: locks a lead of another organisation (holds it while being refused) | caught | FAIL: insert_lock_skips_refused_callers (a lead of another organisation): the refusal took 2659 ms (it waited for a lock) |
| 90 | Insert lock: locks a contact of another organisation (holds it while being refused) | caught | FAIL: insert_lock_skips_refused_callers (a contact of another organisation): the refusal took 2672 ms (it waited for a lock) |

### Day 4a as merged (c4fb0b9)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Activities insert policy: manager exception back (G1) | caught | FAIL: "insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000b1', 'note')" succeeded, expected 42501 |
| 2 | Activity guard: author line dropped | caught | new row violates row-level security policy for table "activities" |
| 3 | Activities: update grant on outcome too | caught | FAIL: activity update columns are {body,outcome} |
| 4 | Activity guard: link-emptying exception without the depth condition (a direct update to null passes) | caught | FAIL: "update public.activities set contact_id = null where id = '3d9b53a9-b0eb-4e91-9185-c582d87b781b'" succeeded, expected 42501 |
| 5 | Activity guard: no link-emptying exception (a contact delete must then fail) | caught | only the text of an entry can change |
| 6 | Activities delete: no fresh code (the policy as Day 4b redefines it) | caught | FAIL: an entry deleted with no code |
| 7 | Last activity on delete: newest remaining entry only (previous date ignored) | caught | FAIL: deleting the last entry left the date at <NULL> |
| 8 | Activities: contact FK back to cascade | caught | FAIL: foreign key delete actions on activities and tasks |
| 9 | Audit: a deleted entry keeps its text | caught | FAIL: a deleted entry should be audited without its text, with its length: {"id": "5d6d079c-0cb1-4c83-bb48-d446a6785437", "body": "AUDIT-MAR |
| 10 | Import undo: leads with a task count as untouched | caught | FAIL: undo preview with a task {"kept": 0, "tagged": 2, "removable": 2} |
| 11 | Task guard: keeps the client's done_at | caught | FAIL: done takes the server's time and the caller: {"done_at":"2000-01-01T00:00:00+00:00","completed_by":"00000000-0000-0000-0000-0000000000 |
| 12 | Task guard: the source entry need not be the caller's | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000b1', 'Not mine', '5d87a18 |
| 13 | Activity guard: no flood guard | caught | FAIL: "insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000e1', 'note')" succeeded, expected 22023 |
| 14 | Task guard: no flood guard | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 15 | Activities: insert grant on user_id too | caught | FAIL: activity insert columns are {body,company_id,contact_id,outcome,request_id,type,user_id} |
| 16 | Activity guard: the client's edited_at kept on insert | caught | FAIL: the guard kept a server column sent by the client: {"user_id":"00000000-0000-0000-0000-00000000000a","created_at":"2026-10-11T16:49:13 |
| 17 | Activity guard: previous date not set | caught | FAIL: the guard kept a server column sent by the client: {"user_id":"00000000-0000-0000-0000-00000000000a","created_at":"2026-10-11T16:49:24 |
| 18 | Activity guard: previous date not carried forward (the design's literal rule) | caught | FAIL: previous dates 2026-01-15 10:00:00+00, 2026-10-11 16:49:36.970702+00 (expected the sheet's) |
| 19 | Last activity on delete: runs as the caller | caught | FAIL: only the untouch trigger and the lead lock run as their owner |
| 20 | Last activity on delete: previous date only (remaining entries ignored) | caught | FAIL: deleting the newest entry should go back to the newest remaining one |
| 21 | Activities: deal FK back to cascade | caught | FAIL: foreign key delete actions on activities and tasks |
| 22 | Activity guard: any column editable | caught | FAIL: "update public.activities set type = 'email' where id = 'de6e230c-611e-4d56-8ec4-5cfb37229b96'" gave 23514 (hint ""), expected 42501 ( |
| 23 | Activity guard: an edit is not marked | caught | FAIL: an edit by the author (text with CRLF, edited_at set, author kept): {"body":"line one\nline two","edited_at":null,"user_id":"00000000- |
| 24 | Activities update policy: managers and admins edit any entry (Day 3a rule) | caught | FAIL: 00000000-0000-0000-0000-00000000000a rewrote rep b1's entry |
| 25 | Activities insert policy: a contact of another lead | caught | FAIL: linked to a record the caller cannot use: insert into public.activities (company_id, contact_id, type) values ('30000000-0000-0000-000 |
| 26 | Activity guard: no outcome pre-check (the CHECK answers with the row) | caught | FAIL: "insert into public.activities (company_id, type, outcome) values ('32000000-0000-0000-0000-0000000000d1', 'call', NULL)" gave 23514 ( |
| 27 | Activity guard: no text length pre-check | caught | FAIL: "update public.activities set body = 'PLANTED-SECRET xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx |
| 28 | Activity guard: no safe-character pre-check | caught | FAIL: "update public.activities set body = 'PLANTED-SECRET \u202Eevil' where id = '1aab93b5-9e52-4f6a-bc0e-a82890df7652'" gave 23514 (hint ""), e |
| 29 | Activity guard: CRLF not folded on insert | caught | the text contains characters that are not allowed |
| 30 | Activities: a call without an outcome passes the CHECK | caught | FAIL: "insert into public.activities (org_id, company_id, type, outcome, body) select org_id, id, 'call', NULL, NULL from public.companies w |
| 31 | Activities: no safe-character CHECK | caught | FAIL: "insert into public.activities (org_id, company_id, type, outcome, body) select org_id, id, 'note', NULL, 'a\u202Eb' from public.companies  |
| 32 | Audit: an edit keeps the text | caught | FAIL: an edit should be audited as the text's lengths and edited_at: {"body": {"new": "AUDIT-MARKER second, longer words", "old": "AUDIT-MAR |
| 33 | Audit: new entries copied | caught | FAIL: an activity insert was copied into the audit log |
| 34 | Tasks: contact FK back to cascade | caught | FAIL: foreign key delete actions on activities and tasks |
| 35 | Task guard: no link-emptying exception (a contact delete must then fail) | caught | this part of a task cannot change |
| 36 | Task guard: link-emptying exception without the depth condition | caught | FAIL: "update public.tasks set created_by = null where id = 'c1f8eee9-9d1a-4ed9-9873-409175082d7a'" succeeded, expected 42501 |
| 37 | Task guard: link-emptying exception without created_by (the design's list: a person delete fails) | caught | this part of a task cannot change |
| 38 | Task guard: fixed fields editable | caught | FAIL: "insert into pg_temp.depth2 values ('update public.tasks set created_by = ''00000000-0000-0000-0000-0000000000b1'' where title = ''For |
| 39 | Task guard: creator left to the client | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 40 | Task guard: done, completed by and dismissed kept from the client on insert | caught | new row for relation "tasks" violates check constraint "tasks_not_done_and_cancelled" |
| 41 | Task guard: no assignee left empty for an admin | caught | FAIL: a task with no assignee should be its creator's |
| 42 | Task guard: a done task takes a new client time | caught | FAIL: a done task took a client time |
| 43 | Task guard: completed_by changes without done | caught | FAIL: completed_by changed without done_at |
| 44 | Task guard: dismissed takes the client's time | caught | FAIL: dismissing takes the server's time |
| 45 | Task guard: a dismissed task takes a new client time | caught | FAIL: a dismissed task took a client time |
| 46 | Task guard: no done-and-dismissed pre-check | caught | FAIL: "update public.tasks set cancelled_at = now() where id = '67828078-f051-4c7d-94c3-ab0fc7a0b350'" gave 23514 (hint ""), expected 22023  |
| 47 | Task guard: no title pre-check | caught | FAIL: a personal task (trimmed title, no lead, kind todo) |
| 48 | Task guard: no kind pre-check | caught | FAIL: "insert into public.tasks (title, kind) values ('PLANTED-SECRET', 'chore')" gave 23514 (hint ""), expected 22023 (hint "task_kind") |
| 49 | Task guard: no date-or-time pre-check | caught | FAIL: "insert into public.tasks (title, due_date, due_at) values ('PLANTED-SECRET', current_date, now())" gave 23514 (hint ""), expected 220 |
| 50 | Task guard: no meeting-time pre-check | caught | FAIL: "insert into public.tasks (title, kind) values ('PLANTED-SECRET', 'meeting')" gave 23514 (hint ""), expected 22023 (hint "task_due") |
| 51 | Task guard: dates not bounded | caught | FAIL: "insert into public.tasks (title, due_date) values ('PLANTED-SECRET', current_date + 2000)" succeeded, expected 22023 |
| 52 | Task guard: dates checked even when unchanged (overdue tasks stuck) | caught | the date is out of range |
| 53 | Task guard: the source entry may be on another lead | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000d1', 'Elsewhere', '157b18 |
| 54 | Task guard: the source entry may be of any age | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000b1', 'Old', '52000000-000 |
| 55 | Tasks select: the creator loses sight of a task given away | caught | FAIL: the creator lost sight of a task given to a colleague |
| 56 | Tasks select: everyone in the org sees every task | caught | FAIL: rep A can read rep B or other-org rows in tasks |
| 57 | Tasks delete: no fresh code (the policy as Day 4b redefines it) | caught | FAIL: a task deleted without a code |
| 58 | Tasks insert: a lead of another organisation | caught | FAIL: "insert into public.tasks (company_id, title) values ('30000000-0000-0000-0000-0000000000c1', 'x')" succeeded, expected 42501 |
| 59 | Tasks insert: a contact of another lead | caught | new row for relation "tasks" violates check constraint "tasks_contact_needs_lead" |
| 60 | Tasks update: no check on the lead and contact | caught | FAIL: "update public.tasks set contact_id = '12000000-0000-0000-0000-0000000000d1' where id = '3ff32396-c855-4d37-b3cb-4b65e145ebb8'" succee |
| 61 | Tasks: a contact without a lead passes the CHECK | caught | FAIL: "insert into public.tasks (org_id, title, contact_id) select id, 'x', '12000000-0000-0000-0000-0000000000b1' from public.orgs where na |
| 62 | Tasks: insert grant on created_by too | caught | FAIL: task insert columns are {assignee_id,company_id,contact_id,created_by,due_at,due_date,kind,request_id,source_activity_id,title} |
| 63 | Tasks: request id unique across everyone (index on request_id alone) | caught | duplicate key value violates unique constraint "tasks_creator_request_idx" |
| 64 | Activities: request id not unique | caught | FAIL: the request indexes must be unique per author |
| 65 | Activity guard: C1 controls pass the safe-character pre-check | caught | FAIL: "insert into public.activities (company_id, type, body) values ('32000000-0000-0000-0000-0000000000d1', 'note', 'PLANTED-SECRET a\u0080b')" |
| 66 | Activities: C1 controls pass the safe-character CHECK | caught | FAIL: "insert into public.activities (org_id, company_id, type, outcome, body) select org_id, id, 'note', NULL, 'a |
| 67 | Task guard: C1 controls pass the title pre-check | caught | FAIL: "insert into public.tasks (title) values ('PLANTED-SECRET |
| 68 | Tasks: C1 controls pass the title CHECK | caught | FAIL: "insert into public.tasks (org_id, title) select id, 'a |
| 69 | Last activity on delete: no lead lock (two deletes at once leave a deleted entry's date) | caught | FAIL: parallel deletes (newest first) left the lead on 2026-10-11 16:59:23.060952+00, expected the sheet's date |
| 70 | Lead lock on insert: locks nothing (an entry still being logged is missed when the newest is deleted) | caught | FAIL: deleting the newest entry left the lead on 2026-01-15 10:00:00+00 while an entry from 2026-10-11 16:59:45.342375+00 is still there |
| 71 | Lead lock on insert: runs as the caller (locks nothing on a lead the caller cannot change) | caught | FAIL: only the untouch trigger and the lead lock run as their owner |
| 72 | Activity guard: no previous date for sessions with no signed-in user (the chain breaks after them) | caught | FAIL: a maintenance entry should keep the sheet's date as its previous date and move the lead to its own |
| 73 | Last activity on delete: any deleted entry moves the date (not only the one that set it) | caught | FAIL: deleting an entry that did not set the lead's date moved it to 2025-06-01 09:00:00+00 |
| 74 | Activity guard: a maintenance session's own previous date replaced | caught | FAIL: a maintenance session's own previous date was not kept |
| 75 | Activity guard: link-emptying exception lets a link move to another record (depth 2) | caught | FAIL: "insert into pg_temp.depth2 values ('update public.activities set contact_id = ''12000000-0000-0000-0000-0000000000b1'' where body = ' |
| 76 | Activity guard: link-emptying exception lets any column change (depth 2) | caught | FAIL: "insert into pg_temp.depth2 values ('update public.activities set type = ''email'', outcome = ''sent'' where id = ''52000000-0000-0000 |
| 77 | Task guard: link-emptying exception lets a link move to another record (depth 2) | caught | FAIL: "insert into pg_temp.depth2 values ('update public.tasks set created_by = ''00000000-0000-0000-0000-0000000000b1'' where title = ''For |
| 78 | Task guard: link-emptying exception lets any column change (depth 2) | caught | FAIL: "insert into pg_temp.depth2 values ('update public.tasks set kind = ''call'' where title = ''For Fay''')" succeeded, expected 42501 |
| 79 | Activity guard: flood window of one second (60 a second) | caught | FAIL: "insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000e1', 'note')" succeeded, expected 22023 |
| 80 | Activity guard: flood window of two minutes | caught | too many entries in a minute |
| 81 | Task guard: flood window of one second (60 a second) | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 82 | Task guard: flood window of two minutes | caught | too many tasks in a minute |
| 83 | Audit: a deleted entry without its length (D8) | caught | FAIL: a deleted entry should be audited without its text, with its length: {"id": "a82aa0d1-b4da-474c-ba71-07096800ee34", "type": "note", "o |
| 84 | Tasks delete: no role clause (a fresh code deletes any task of the org; the policy as Day 4b redefines it) | caught | FAIL: a bare delete by rep d1 removed 12 tasks (d1's own: 4, all: 13) |
| 85 | Activity time (Day 3a trigger): a session with no signed-in user may change it after the fact | caught | FAIL: a session with no signed-in user changed an entry's time |
| 86 | Tasks: date-or-time CHECK dropped | caught | FAIL: "insert into public.tasks (org_id, title, due_date, due_at) select id, 'x', current_date, now() from public.orgs where name = 'TopStoc |
| 87 | Tasks: meeting-time CHECK dropped | caught | FAIL: "insert into public.tasks (org_id, title, kind) select id, 'x', 'meeting' from public.orgs where name = 'TopStock Wholesale'" succeede |
| 88 | Tasks: done-and-dismissed CHECK dropped | caught | FAIL: "insert into public.tasks (org_id, title, done_at, cancelled_at) select id, 'x', now(), now() from public.orgs where name = 'TopStock  |
| 89 | Tasks: safe-title CHECK dropped | caught | FAIL: "insert into public.tasks (org_id, title) select id, 'a\u202Eb' from public.orgs where name = 'TopStock Wholesale'" succeeded, expected 235 |
| 90 | Tasks: kind CHECK dropped | caught | FAIL: "insert into public.tasks (org_id, title, kind) select id, 'x', 'chore' from public.orgs where name = 'TopStock Wholesale'" succeeded, |
| 91 | Tasks: lead FK without cascade (a lead with a task cannot be deleted) | caught | FAIL: foreign key delete actions on activities and tasks |
| 92 | Tasks: creator FK without set null (a person who created a task cannot leave) | caught | FAIL: foreign key delete actions on activities and tasks |
| 93 | Tasks: source entry FK without set null (an entry with a follow-up cannot be deleted) | caught | FAIL: foreign key delete actions on activities and tasks |
| 94 | Tasks: update grant on kind too | caught | FAIL: task update columns are {assignee_id,cancelled_at,contact_id,done_at,due_at,due_date,kind,title} |
| 95 | Activities update policy: USING without the author rule | caught | new row violates row-level security policy for table "activities" |
| 96 | Activities update policy: WITH CHECK without the author rule (behind USING, the grant and the guard) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 97 | Activities update policy: no author rule in USING nor in WITH CHECK (both layers) | caught | FAIL: rep A changed rep B activity |
| 98 | Tasks update policy: USING without the role clause (behind tasks_select and WITH CHECK) | caught | new row violates row-level security policy for table "tasks" |
| 99 | Tasks update policy: no role clause in USING nor in who sees tasks (both layers) | caught | FAIL: rep A can read rep B or other-org rows in tasks |
| 100 | Tasks update policy: WITH CHECK without the role clause (behind the owner rule and tasks_select) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 101 | Tasks update policy: no role clause in WITH CHECK, and reps may change an owner (both layers) | caught | FAIL: "update public.tasks set assignee_id = '00000000-0000-0000-0000-0000000000b1'" succeeded, expected 42501 |
| 102 | Lead lock on insert: the contact is not locked first (deadlock with log_activity's contact-then-lead order) | caught | deadlock detected |
| 103 | Activity guard: flood window of 45 seconds | caught | FAIL: "insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000e1', 'note')" succeeded, expected 22023 |
| 104 | Task guard: flood window of 45 seconds | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |

### Day 3b (c4fb0b9)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Working rows: insert without a fresh code | caught | FAIL: "insert into private.lead_import_staging (batch_id, row_no, org_id, name) select 'd5e5c2c3-53d6-4bcc-b63a-6d2e17e79cad', 2, org_id, 'x |
| 2 | Working rows: read without a fresh code | caught | FAIL: a stale code reads working rows |
| 3 | Working rows: row number past the file's end | caught | FAIL: "insert into private.lead_import_staging (batch_id, row_no, org_id, name) select '0f82a30d-d2d9-4247-b8e6-71c3ffea2855', 4, org_id, 'x |
| 4 | Tagging leads: no admin check | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 5 | Tagging leads: no admin check in the rule nor in who sees imports (both layers) | caught | FAIL: rep can read import batches |
| 6 | Tagging leads: no fresh-code check | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('late', '2d7619e8-eb17-40f3-b296-feb358c0af36')" succeeded, expected 425 |
| 7 | Tagging leads: import need not be in progress | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('tagged', 'eb5e3821-379c-4845-ad2d-8f24f9681b13')" succeeded, expected 4 |
| 8 | Tagging leads: any last-activity date | caught | FAIL: "insert into public.companies (name, import_batch_id, last_activity_at) |
| 9 | Tagging leads: date bound 1 Jan 1990 UTC (refuses 1 Jan 1990 in Paris) | caught | FAIL: "insert into public.companies (name, import_batch_id, last_activity_at) |
| 10 | Check: dates compared in UTC instead of local time | caught | FAIL: row 7 expected rejected <NULL> <NULL> date_out_of_range, got (ready,,,) |
| 11 | Tagging leads: into someone else's import | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('Sneak', 'ef210e08-94e7-420b-8bb7-24a9b905782d')" succeeded, expected 42 |
| 12 | Import history: no organisation check | caught | FAIL: other org reads our imports |
| 13 | Import status: changeable without a fresh code | caught | new row violates row-level security policy for table "import_batches" |
| 14 | Import counters: client may write one | caught | FAIL: "update public.import_batches set imported = 99" succeeded, expected 42501 |
| 15 | File name: zero-width and bidi characters allowed (controls only) | caught | FAIL: "select public.create_lead_import('leads\u202Evsc.csv', null, 1, 2)" succeeded, expected 23514 |
| 16 | Batch guard trigger dropped | caught | only the person who started this import can add rows |
| 17 | One import at a time: index not unique | caught | FAIL: "select public.commit_lead_import('a2730311-2e91-4097-a57f-3df33747a405')" succeeded, expected 22023 |
| 18 | Undo: leads with an activity count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 19 | Undo: leads with a contact count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 20 | Undo: leads with a deal count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 21 | Undo: edited leads count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 22 | Undo: no second look before deleting (race with a new contact) | caught | FAIL: undo removed a lead that got a contact meanwhile ({"kept": 0, "status": "rolled_back", "removed_now": 1}) |
| 23 | Undo: a short chunk counts as the end (race with a deleted lead) | caught | some leads are still waiting to be removed |
| 24 | Import: no re-check for leads added meanwhile | caught | FAIL: late duplicate not skipped {"status": "committing", "remaining": 1, "imported_now": 3, "imported_total": 6, "late_duplicates": 0} |
| 25 | Import: someone else may run it | caught | FAIL: "select public.commit_lead_import('0a790e6f-0e1c-4fd9-8cca-6bda1dfd09c9')" gave 22023 (hint "not_ready"), expected 42501 (hint "<NULL> |
| 26 | Add rows: no constant-error pre-check | caught | FAIL: "select public.stage_lead_import_rows('3a435fc0-2d2a-41ec-bfb1-06599682209d', '[{"row_no": 4, "problems": ["name_missing"]}]')" gave 4 |
| 27 | Functions: no fresh-code check (hint step_up) | caught | FAIL: "select public.create_lead_import('x.csv', null, 1, 2)" gave 42501 (hint ""), expected 42501 (hint "step_up") |
| 28 | Audit: full copy of imported leads | caught | FAIL: imported leads should each have one small audit row |
| 29 | Audit: search and key columns kept | caught | FAIL: search_text copied into the audit log |
| 30 | Working rows kept after the import | caught | FAIL: working rows kept after the import |
| 31 | Working rows kept after a direct discard | caught | FAIL: a direct discard left working rows |
| 32 | Working rows kept when an undo starts directly | caught | FAIL: a direct undo of a paused import left working rows |
| 33 | Import: running total is this call's count, not the leads tagged so far | caught | FAIL: running total after a resume {"status": "imported", "remaining": 0, "imported_now": 1, "imported_total": 1, "late_duplicates": 0} |
| 34 | Import history: a paused import shows the counter (0), not the leads added | caught | FAIL: history should show the leads a paused import added |
| 35 | Undo of a paused import: working rows deleted before they are counted | caught | FAIL: the counts of a paused import were taken after its working rows were deleted: (0,0,"{""ready"": 0, ""by_name"": 0, ""by_email"": 0, "" |
| 36 | Name rule: a phone too short to be a key counts as no phone (chain shops merged) | caught | FAIL: row 3 expected ready <NULL> <NULL> <NULL>, got (duplicate_file,name,2,) |
| 37 | Counters not recounted at the end of an import | caught | import counts do not add up |
