# Day 4b: every protection removed one at a time, 11 Oct 2026

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
