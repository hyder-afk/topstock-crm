### day7a

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Anon sweep: a later migration grants anon SELECT on a table Day 1's list never named (deal_stage_history) | caught | FAIL: anon has a privilege on public.deal_stage_history |
| 2 | Anon sweep: anon gets USAGE on schema private and EXECUTE on a private function | caught | FAIL: anon has usage or create on schema private, or create on public |
| 3 | Anon sweep: anon gets INSERT on a private table (no schema usage) | caught | FAIL: anon has a privilege on private.deal_moves |
| 4 | Anon sweep: anon may call a public RPC added after Day 1 (record_auth_event) | caught | FAIL: anon can execute public.record_auth_event(p_event text) |
| 5 | Same-org owner: the composite keys removed (the trigger alone; service paths unchecked) | caught | FAIL: foreign key companies_owner_same_org missing or not validated |
| 6 | Same-org owner: the trigger's check removed (the keys alone; signed-in callers get 23503, not 42501) | caught | insert or update on table "companies" violates foreign key constraint "companies_owner_same_org" |
| 7 | Same-org owner: both layers removed | caught | FAIL: lead assigned to someone from another org |
| 8 | Same-org owner: the task assignee key alone removed | caught | FAIL: foreign key tasks_assignee_same_org missing or not validated |
| 9 | Sign-in rows: the insert policy does not pin the actor (another person's row) | caught | FAIL: "insert into public.audit_log (org_id, actor_id, action, table_name) |
| 10 | Sign-in rows: the insert policy does not pin the organisation | caught | FAIL: "insert into public.audit_log (org_id, actor_id, action, table_name) |
| 11 | Sign-in rows: the insert policy allows any action (a forged role change) | caught | FAIL: "select public.record_auth_event('role_change')" succeeded, expected 42501 |
| 12 | Sign-in rows: the insert policy allows any table name | caught | FAIL: "insert into public.audit_log (org_id, actor_id, action, table_name) |
| 13 | Sign-in rows: the insert grant also covers diff_json (details such as an IP address) | caught | FAIL: authenticated has more than the four insert columns on audit_log |
| 14 | Sign-in rows: no flood guard (30 an hour) | caught | FAIL: "select public.record_auth_event('sign_in')" succeeded, expected 22023 |
| 15 | Sign-in rows: the flood guard counts a forged row about another person (its 22023 tells their sign-in count) | caught | FAIL: "insert into public.audit_log (org_id, actor_id, action, table_name) |
| 16 | Sign-in rows: the writer runs as its owner (SECURITY DEFINER) | caught | FAIL: record_auth_event must be SECURITY INVOKER |

day7a: 16 rows run: 16 caught, 0 documented two-layer rows not caught, 0 not as listed
