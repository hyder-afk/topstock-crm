# Day 5b mutations (design 8.3)

Each row removes one Day 5b protection from a copy of the migrations (`scripts/db-mutations.py`, set `day5b`, run in a
throwaway worktree with its own `db-test.sh` copy on port 54362; the worktree was removed afterwards) and runs the whole
database suite. A row is **caught** when at least one check fails. Run on cd9a4db (the Day 5b migration and tests as
committed; neither has changed since, `git diff cd9a4db HEAD -- supabase scripts .github` touches only
`supabase/tests/perf_day5.sql`, the P5 timing block).

Earlier rows that aim inside `log_activity`, `undo_activity`, `get_lead` or the activities insert policy (Day 4a and
Day 4b sets) now follow the live Day 5b copies (`db-mutations.py` moves an edit aimed at a Day 4 function that Day 5b
recreates to the Day 5b copy; REBASE: and again at the 4c rebase). Those rows were re-run against the Day 5b copies:
**Day 4a: 1 row run, 1 caught; Day 4b: 45 rows run, 45 caught**, 0 documented two-layer rows not caught, 0 not as
listed (the re-run log stayed in the session scratchpad, `mut-relive-4a.md` and `mut-relive-4b.md`).


### day5b

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Activities insert policy: no same-lead deal check | caught | FAIL: linked to a record the caller cannot use: insert into public.activities (company_id, deal_id, type) values ('30000000-0000-0000-0000-0 |
| 2 | undo_activity: removes the deal without version = 0 (a moved deal goes too) | caught | FAIL: undo_activity_vs_move_same_lead_no_deadlock: undo answered 'removed negotiation', stage |
| 3 | undo_activity: deletes the deal before the lead lock (deadlock test) | caught | FAIL: undo_activity_vs_log_activity_with_deal_no_deadlock: a deadlock |
| 4 | Deal delete policy: creator branch without the activity-undo condition | caught | FAIL: deal_direct_delete_refused_while_activity_undo_record |
| 5 | log_activity: opens deals for people who may not change the lead | caught | new row violates row-level security policy for table "deals" |
| 6 | log_activity: opens a deal on a Do not contact lead (the guard refuses the whole call) | caught | this lead asked not to be contacted |
| 7 | log_activity: no open-rate check before the deal (the guard refuses the whole call) | caught | too many deals opened in an hour |
| 8 | log_activity: a deal opens from any outcome | caught | FAIL: "select public.log_activity(p_company => '06f31236-5ca7-4162-8c86-cb7c35eaf500', p_type => 'call', p_outcome => 'no_answer', p_open_de |
| 9 | log_activity: no deal title pre-check (a skipped open never checks it) | caught | FAIL: "select pg_temp.interested('0698500e-027b-4cee-9e2e-a205cf0d16d0', true, 'interested', 'Bad\u202E')" succeeded, expected 22023 |
| 10 | log_activity: no deal value pre-check (3 decimals rounded by the column) | caught | FAIL: "select pg_temp.interested('1c5ea6ec-7244-4965-b6d9-d336b6f18ff1', true, 'interested', null, 1.005)" succeeded, expected 22023 |
| 11 | log_activity: no same-lead check for a linked deal (the policy answers 42501 instead of P0002) | caught | FAIL: "select public.log_activity(p_company => 'f38ad7b7-086f-4dc1-8e07-27d56cef148e', p_type => 'note', p_body => 'x', p_deal => '45b05051- |
| 12 | undo_activity: never removes the deal the call opened | caught | FAIL: undo_activity_vs_log_activity_with_deal_no_deadlock: undo answered 'kept' |
| 13 | log_activity: the undo record forgets the deal | caught | FAIL: undo_activity_vs_log_activity_with_deal_no_deadlock: undo answered '' |
| 14 | Replay answer without the opened deal | caught | FAIL: log_activity_open_deal_replay {"deal": null, "deal_id": null, "task_id": "c4fe7c7f-491e-41dc-ad69-ec4783268ed2", "editable": true, "re |
| 15 | get_lead: can_open_deal ignores Do not contact | caught | FAIL: can_open_deal on a DNC lead |
| 16 | get_lead: open_count counts closed deals too | caught | FAIL: get_lead deals for the owner {"open_count": 3, "latest_open": {"id": "fc4e5119-10c3-4fd9-8da0-e25eace3feaa", "stage": "qualified", "ti |
| 17 | log_activity runs as its owner (DEFINER: deals and links for anyone) | caught | FAIL: RPC rules broken by {"log_activity(uuid,text,text,text,uuid,text,date,timestamp with time zone,text,uuid,boolean,uuid,boolean,text,num |

day5b: 17 rows run: 17 caught, 0 documented two-layer rows not caught, 0 not as listed

Result: **17 of 17 caught**, exit 0.
