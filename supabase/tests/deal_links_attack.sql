-- Day 5b attack and behaviour tests: entries that name a deal, Interested and Book meeting opening a deal, one Undo taking
-- back both, and the lead's deals brief (design docs/evidence/day5/design.md sections 3.2, 5.1, 5.3, 6 threats 1, 12, 17,
-- 19 and 27, and 8.1; migration 20261015120000_deal_links.sql). Runs after deals_attack.sql and deal_concurrency.sh on the
-- same database (scripts/db-test.sh, CI job "rls"), reusing admin a, reps r1 (Rae) and r2 (Rob) and manager m1 (Mia).
-- Probes run as a signed-in user through the API role. Each scenario runs in one block that is rolled back at the end
-- (raise TS001, caught); inside one block now() is one instant. Every scenario ends with Day 5a's two invariants.
-- Day 4's outcome_attack.sql and queue tests run unchanged before this file (log_activity's new parameters default off).
\set ON_ERROR_STOP 1
\set QUIET 1

-- Helpers (temporary functions do not survive into a new psql session, so they are defined again here) -------------
create function pg_temp.as_user(sub text, aal text, totp_age_s integer default null) returns void
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', sub, 'role', 'authenticated', 'aal', aal,
    'amr', case when totp_age_s is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - totp_age_s)) end
  )::text, false)
$$;
create function pg_temp.act(sub uuid, aal text default 'aal2', totp_age_s integer default 30) returns void
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', false);
  perform pg_temp.as_user(sub::text, aal, totp_age_s);
end;
$$;
create function pg_temp.su() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
end;
$$;
create function pg_temp.expect_error(stmt text, want_state text, want_hint text default null, marker text default null)
returns void language plpgsql as $$
declare
  got_state text;
  got_hint text;
  got_msg text;
  got_detail text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics got_state = returned_sqlstate, got_hint = pg_exception_hint, got_msg = message_text,
                            got_detail = pg_exception_detail;
    if got_state <> want_state or (want_hint is not null and coalesce(got_hint, '') <> want_hint) then
      raise exception 'FAIL: "%" gave % (hint "%", %), expected % (hint "%")', left(stmt, 200), got_state, got_hint,
        got_msg, want_state, want_hint;
    end if;
    if marker is not null and (strpos(coalesce(got_msg, ''), marker) > 0 or strpos(coalesce(got_detail, ''), marker) > 0) then
      raise exception 'FAIL: "%" put the user''s text in the error', left(stmt, 200);
    end if;
    return;
  end;
  raise exception 'FAIL: "%" succeeded, expected %', left(stmt, 200), want_state;
end;
$$;
create function pg_temp.new_lead(owner uuid, status text default 'cold', lead_name text default 'Day5b Lead') returns uuid
language sql as $$
  insert into public.companies (org_id, name, owner_id, lead_status, country, phone)
  select o.id, lead_name, owner, status, 'FR', '+33 1 23 45 67 89' from public.orgs o where o.name = 'TopStock Wholesale'
  returning id
$$;
-- A deal of `owner` on a lead, made by the superuser at Lead with its open history row written by the trigger.
create function pg_temp.su_deal(lead uuid, owner uuid) returns uuid
language sql as $$
  insert into public.deals (org_id, company_id, stage_id, owner_id, created_by)
  select c.org_id, c.id, s.id, owner, owner from public.companies c
    join public.pipeline_stages s on s.org_id = c.org_id and s.key = 'lead'
   where c.id = lead
  returning id
$$;
-- An Interested (or Book meeting) call through log_activity as the current user, opening a deal when asked.
create function pg_temp.interested(lead uuid, open_deal boolean default true, outcome text default 'interested',
                                   title text default null, val numeric default null, req uuid default null,
                                   contact uuid default null) returns jsonb
language sql as $$
  select public.log_activity(
    p_company => lead, p_type => 'call', p_outcome => outcome, p_contact => contact,
    p_follow_up_date => case when outcome = 'interested' then current_date + 1 end,
    p_follow_up_at => case when outcome = 'meeting_booked' then now() + interval '2 days' end,
    p_task_title => 'Follow up', p_request_id => req,
    p_open_deal => open_deal, p_deal_title => title, p_deal_value => val)
$$;
create function pg_temp.invariants(label text) returns void
language plpgsql as $$
declare
  n integer;
begin
  select count(*) into n from public.deals d join public.pipeline_stages s on s.id = d.stage_id
   where d.status <> case s.key when 'won' then 'won' when 'lost' then 'lost' else 'open' end
      or (d.status = 'open') <> (d.closed_at is null);
  if n <> 0 then raise exception 'FAIL: stage_status_consistent after %: % deals', label, n; end if;
  select count(*) into n from (
    select h.deal_id, h.kind, h.from_stage, h.to_stage, h.version_after,
           lag(h.to_stage) over w as prev_to, lag(h.version_after) over w as prev_version,
           row_number() over w as rn,
           row_number() over (partition by h.deal_id order by h.id desc) as rn_desc
      from public.deal_stage_history h
    window w as (partition by h.deal_id order by h.id)) x
   join public.deals d on d.id = x.deal_id
   join public.pipeline_stages s on s.id = d.stage_id
   where (x.rn = 1 and (x.kind <> 'open' or x.from_stage is not null))
      or (x.rn > 1 and (x.from_stage is distinct from x.prev_to or x.version_after <= x.prev_version))
      or (x.rn_desc = 1 and x.to_stage <> s.key);
  if n <> 0 then raise exception 'FAIL: history_chain_consistent after %: % rows', label, n; end if;
end;
$$;

do $$ begin
  perform set_config('request.jwt.claims', '', false);
  if (select count(*) from public.profiles where id in ('00000000-0000-0000-0000-00000000000a',
        '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005a2',
        '00000000-0000-0000-0000-0000000005b1')) <> 4 then
    raise exception 'FAIL: Day 5b fixture users missing (run after deals_attack.sql)';
  end if;
  perform pg_temp.invariants('the earlier test files');
  -- Open records from the earlier files (deal_concurrency.sh opens many as r1) would trip the 30-an-hour limit here.
  delete from private.deal_opens;
end $$;

-- 0. What the database itself says (threats 1, 17, 28) ------------------------------------------------------------------
do $$
declare
  cols text[];
  f record;
begin
  -- The insert columns of an entry gain deal_id (Day 4a took it out; 5b gives it back with the policy below).
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'public.activities'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'INSERT');
  if cols is distinct from array['body', 'company_id', 'contact_id', 'deal_id', 'outcome', 'request_id', 'type'] then
    raise exception 'FAIL: activity insert columns are %', cols;
  end if;
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'public.activities'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'UPDATE');
  if cols is distinct from array['body'] then raise exception 'FAIL: activity update columns are %', cols; end if;
  if (select array_agg(policyname::text order by policyname) from pg_policies
       where schemaname = 'public' and tablename = 'activities' and cmd = 'INSERT') is distinct from array['activities_insert']
     or (select with_check from pg_policies where schemaname = 'public' and tablename = 'activities'
          and policyname = 'activities_insert') !~ 'deal_id' then
    raise exception 'FAIL: the activities insert policy must check the deal';
  end if;
  if not exists (select 1 from pg_attribute where attrelid = 'private.activity_undo'::regclass
                  and attname = 'created_deal_id' and not attisdropped) then
    raise exception 'FAIL: activity_undo.created_deal_id missing';
  end if;
  -- The recreated RPCs: SECURITY INVOKER, search_path '', callable by signed-in people only, static SQL; one
  -- log_activity (the old signature is gone).
  for f in select p.oid, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig, p.prosrc
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('log_activity', 'undo_activity', 'get_lead') loop
    if f.prosecdef or not (f.proconfig @> array['search_path=""'])
       or not has_function_privilege('authenticated', f.oid, 'EXECUTE')
       or has_function_privilege('anon', f.oid, 'EXECUTE') or has_function_privilege('public', f.oid, 'EXECUTE')
       or f.prosrc ~* '\mexecute\M' or f.prosrc ~* 'format\s*\(' then
      raise exception 'FAIL: RPC rules broken by %', f.sig;
    end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'log_activity') <> 1
     or to_regprocedure('public.log_activity(uuid, text, text, text, uuid, text, date, timestamptz, text, uuid, boolean, uuid, boolean, text, numeric)') is null then
    raise exception 'FAIL: exactly one log_activity, with the four Day 5b parameters';
  end if;
  if not has_function_privilege('authenticated', 'private.logged_activity_deal(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'private.logged_activity_deal(uuid)', 'EXECUTE')
     or (select prosecdef from pg_proc where oid = 'private.logged_activity_deal(uuid)'::regprocedure) then
    raise exception 'FAIL: private.logged_activity_deal privileges';
  end if;
end $$;

-- 1. Signed in without two-factor (threat 1) ---------------------------------------------------------------------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  lead uuid := pg_temp.new_lead(r1, 'cold');
begin
  perform pg_temp.act(r1, 'aal1', null);
  perform pg_temp.expect_error(format('select pg_temp.interested(%L)', lead), '42501');
  if public.get_lead(lead) is not null then raise exception 'FAIL: get_lead without two-factor'; end if;
  perform pg_temp.su();
  if exists (select 1 from public.deals where company_id = lead) or exists (select 1 from public.activities where company_id = lead) then
    raise exception 'FAIL: day5b_aal1_blocked wrote something';
  end if;
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 2. Entries that name a deal: same lead, visible, fixed (threat 17) -----------------------------------------------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  r2 constant uuid := '00000000-0000-0000-0000-0000000005a2';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  lead2 uuid := pg_temp.new_lead(r1, 'warm');
  shared uuid := pg_temp.new_lead(r2, 'warm');
  deal uuid := pg_temp.su_deal(lead, r1);
  deal2 uuid := pg_temp.su_deal(lead2, r1);
  r1_deal_on_shared uuid := pg_temp.su_deal(shared, r1);
  r jsonb;
  act uuid;
begin
  perform pg_temp.act(r1);
  -- log_activity_with_deal_same_lead_only: a note on the deal's lead names it (direct insert and RPC)
  insert into public.activities (company_id, deal_id, type, body) values (lead, deal, 'note', 'direct, with the deal') returning id into act;
  r := public.log_activity(p_company => lead, p_type => 'note', p_body => 'about the deal', p_deal => deal);
  if (r ->> 'deal_id')::uuid is distinct from deal or r -> 'deal' <> 'null'::jsonb
     or (select deal_id from public.activities where id = (r ->> 'activity_id')::uuid) is distinct from deal then
    raise exception 'FAIL: log_activity_with_deal_same_lead_only: %', r;
  end if;
  if jsonb_array_length(public.get_deal(deal) -> 'activities') <> 2 then
    raise exception 'FAIL: get_deal lists the entries that name the deal';
  end if;
  -- A call naming the deal: the outcome rules run as before; the entry carries the deal.
  r := public.log_activity(p_company => lead, p_type => 'call', p_outcome => 'no_answer', p_deal => deal);
  if (select deal_id from public.activities where id = (r ->> 'activity_id')::uuid) is distinct from deal then
    raise exception 'FAIL: a call naming a deal';
  end if;
  -- activity_deal_other_lead_refused: another lead's deal (policy 42501 directly; P0002 through the RPC, before any write)
  perform pg_temp.expect_error(format('insert into public.activities (company_id, deal_id, type, body) values (%L, %L, %L, %L)',
                                      lead, deal2, 'note', 'x'), '42501');
  perform pg_temp.expect_error(format('select public.log_activity(p_company => %L, p_type => %L, p_body => %L, p_deal => %L)',
                                      lead, 'note', 'x', deal2), 'P0002');
  perform pg_temp.expect_error(format('select public.log_activity(p_company => %L, p_type => %L, p_body => %L, p_deal => %L)',
                                      lead, 'note', 'x', gen_random_uuid()), 'P0002');
  -- activity_deal_invisible_refused: r2 cannot see r1's deal, even on r2's own lead
  perform pg_temp.act(r2);
  perform pg_temp.expect_error(format('insert into public.activities (company_id, deal_id, type, body) values (%L, %L, %L, %L)',
                                      shared, r1_deal_on_shared, 'note', 'x'), '42501');
  perform pg_temp.expect_error(format('select public.log_activity(p_company => %L, p_type => %L, p_body => %L, p_deal => %L)',
                                      shared, 'note', 'x', r1_deal_on_shared), 'P0002');
  -- an admin sees it and may name it
  perform pg_temp.act(admin);
  r := public.log_activity(p_company => shared, p_type => 'note', p_body => 'admin note', p_deal => r1_deal_on_shared);
  if (r ->> 'deal_id')::uuid is distinct from r1_deal_on_shared then raise exception 'FAIL: admin names a visible deal'; end if;
  -- activity_deal_id_immutable (activity_guard, Day 4a): the link never changes after the insert
  perform pg_temp.act(r1);
  perform pg_temp.expect_error(format('update public.activities set deal_id = %L where id = %L', deal2, act), '42501');
  perform pg_temp.expect_error(format('update public.activities set deal_id = null where id = %L', act), '42501');
  perform pg_temp.su();
  if (select deal_id from public.activities where id = act) is distinct from deal then
    raise exception 'FAIL: activity_deal_id_immutable';
  end if;
  -- a deleted deal keeps its entries (deal_id set null, Day 4a FK)
  delete from public.deals where id = deal;
  if (select count(*) from public.activities where company_id = lead and deal_id is null) < 3 then
    raise exception 'FAIL: deal_delete_keeps_activities';
  end if;
  perform pg_temp.invariants('entries naming a deal');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 3. Interested and Book meeting open a deal (D17, 5.1) -------------------------------------------------------------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'cold');
  lead2 uuid := pg_temp.new_lead(r1, 'cool_off');
  unowned uuid := pg_temp.new_lead(null, 'cold');
  contact uuid;
  r jsonb;
  deal uuid;
  act uuid;
  d record;
  req uuid := gen_random_uuid();
begin
  insert into public.contacts (org_id, company_id, first_name, phone) select org_id, id, 'Camille', '+33 6 11 22 33 44'
    from public.companies where id = lead returning id into contact;
  perform pg_temp.act(r1);
  -- log_activity_interested_opens_deal
  r := pg_temp.interested(lead, true, 'interested', '  Denim jackets, 2 pallets ', 6800.50, req, contact);
  act := (r ->> 'activity_id')::uuid;
  deal := (r -> 'deal' ->> 'id')::uuid;
  if not (r -> 'deal' ->> 'opened')::boolean or (r -> 'deal' ->> 'open_deal_count')::integer <> 1 or deal is null
     or r ->> 'status_before' <> 'cold' or r ->> 'status_after' <> 'warm' or r -> 'deal_id' <> 'null'::jsonb then
    raise exception 'FAIL: log_activity_interested_opens_deal answer %', r;
  end if;
  perform pg_temp.su();
  select dd.*, s.key into d from public.deals dd join public.pipeline_stages s on s.id = dd.stage_id where dd.id = deal;
  if d.key <> 'lead' or d.status <> 'open' or d.version <> 0 or d.created_by <> r1 or d.owner_id <> r1
     or d.source_activity_id <> act or d.title <> 'Denim jackets, 2 pallets' or d.value <> 6800.50
     or d.contact_id is distinct from contact or d.fulfilment is not null or d.request_id is not null then
    raise exception 'FAIL: log_activity_interested_opens_deal row %', row_to_json(d);
  end if;
  if (select created_deal_id from private.activity_undo where activity_id = act) is distinct from deal
     or (select count(*) from public.deal_stage_history where deal_id = deal and kind = 'open' and actor_id = r1) <> 1
     or exists (select 1 from private.deal_moves where deal_id = deal)                 -- the deal adds no lead change
     or (select count(*) from private.deal_opens where user_id = r1 and created_at = now()) <> 1
     or (select lead_status from public.companies where id = lead) <> 'warm'
     or (select count(*) from public.tasks where source_activity_id = act and kind = 'call') <> 1 then
    raise exception 'FAIL: log_activity_interested_opens_deal side records';
  end if;
  -- A replay answers the same deal and opens nothing more.
  perform pg_temp.act(r1);
  r := pg_temp.interested(lead, true, 'interested', 'Denim jackets, 2 pallets', 6800.50, req, contact);
  if not (r ->> 'replayed')::boolean or (r -> 'deal' ->> 'id')::uuid is distinct from deal
     or (select count(*) from public.deals where company_id = lead) <> 1 then
    raise exception 'FAIL: log_activity_open_deal_replay %', r;
  end if;
  -- A second Interested with the switch on opens a second deal (several open deals per lead, D18); count 2.
  r := pg_temp.interested(lead, true);
  if (r -> 'deal' ->> 'open_deal_count')::integer <> 2 or (select count(*) from public.deals where company_id = lead) <> 2
     or (select title from public.deals where id = (r -> 'deal' ->> 'id')::uuid) is not null then
    raise exception 'FAIL: a second deal on the lead %', r;
  end if;
  -- The switch off: the call alone (deal null in the answer).
  r := pg_temp.interested(lead, false);
  if r -> 'deal' <> 'null'::jsonb or (select count(*) from public.deals where company_id = lead) <> 2 then
    raise exception 'FAIL: switch off still opened a deal %', r;
  end if;
  -- log_activity_meeting_booked_opens_deal (cool off becomes warm by the outcome)
  r := pg_temp.interested(lead2, true, 'meeting_booked', null, null);
  if not (r -> 'deal' ->> 'opened')::boolean or r ->> 'status_after' <> 'warm'
     or (select count(*) from public.tasks where source_activity_id = (r ->> 'activity_id')::uuid and kind = 'meeting') <> 1
     or (select value from public.deals where id = (r -> 'deal' ->> 'id')::uuid) is not null then
    raise exception 'FAIL: log_activity_meeting_booked_opens_deal %', r;
  end if;
  -- An admin on an unowned lead: the outcome makes the admin the owner, then the deal opens (the policy sees the owner).
  perform pg_temp.act(admin);
  r := pg_temp.interested(unowned, true);
  if not (r -> 'deal' ->> 'opened')::boolean or (select owner_id from public.companies where id = unowned) <> admin
     or (select owner_id from public.deals where id = (r -> 'deal' ->> 'id')::uuid) <> admin then
    raise exception 'FAIL: admin opens on an unowned lead %', r;
  end if;
  perform pg_temp.su();
  perform pg_temp.invariants('interested opens a deal');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 4. Skipped opens keep the call; bad deal inputs write nothing (threats 19, 22, 27, 28) ----------------------------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  r2 constant uuid := '00000000-0000-0000-0000-0000000005a2';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'cold');
  dnc uuid := pg_temp.new_lead(r1, 'do_not_contact');
  deal uuid := pg_temp.su_deal(lead, r1);
  r jsonb;
  stmt text;
  n_acts integer;
begin
  -- log_activity_open_deal_non_editor_skipped: r2 may log on r1's lead but not change it: the call stays, no deal
  perform pg_temp.act(r2);
  r := pg_temp.interested(lead, true);
  if r -> 'deal' <> '{"opened": false, "reason": "not_editable"}'::jsonb or (r ->> 'editable')::boolean
     or r ->> 'activity_id' is null then
    raise exception 'FAIL: log_activity_open_deal_non_editor_skipped %', r;
  end if;
  -- The deal inputs are checked before any write, also when the open would be skipped (the guard never sees them).
  perform pg_temp.expect_error(format('select pg_temp.interested(%L, true, %L, %L)', lead, 'interested', 'Bad' || chr(8238)),
                               '22023', 'deal_title');
  perform pg_temp.expect_error(format('select pg_temp.interested(%L, true, %L, null, 1.005)', lead, 'interested'), '22023', 'value');
  -- log_activity_open_deal_dnc_skipped: Interested on a Do not contact lead keeps the call, opens nothing
  perform pg_temp.act(admin);
  r := pg_temp.interested(dnc, true);
  if r -> 'deal' <> '{"opened": false, "reason": "dnc"}'::jsonb or r ->> 'activity_id' is null then
    raise exception 'FAIL: log_activity_open_deal_dnc_skipped %', r;
  end if;
  perform pg_temp.su();
  if exists (select 1 from public.deals where company_id = dnc) then raise exception 'FAIL: a deal on a DNC lead'; end if;
  -- log_activity_open_deal_rate_limited_skipped: 30 opens in the last hour (the guard's count) skip the 31st
  insert into private.deal_opens (user_id, created_at) select r1, now() - interval '10 minutes' from generate_series(1, 30);
  perform pg_temp.act(r1);
  r := pg_temp.interested(lead, true);
  if r -> 'deal' <> '{"opened": false, "reason": "rate_limited"}'::jsonb or r ->> 'activity_id' is null then
    raise exception 'FAIL: log_activity_open_deal_rate_limited_skipped %', r;
  end if;
  perform pg_temp.su();
  delete from private.deal_opens where user_id = r1;
  -- log_activity_open_deal_bad_title_writes_nothing (constant messages; nothing written)
  select count(*) into n_acts from public.activities where company_id = lead;
  perform pg_temp.act(r1);
  perform pg_temp.expect_error(format('select pg_temp.interested(%L, true, %L, %L)', lead, 'interested', 'Plant' || chr(8238) || 'MARKER5B'),
                               '22023', 'deal_title', 'MARKER5B');
  perform pg_temp.expect_error(format('select pg_temp.interested(%L, true, %L, %L)', lead, 'interested', repeat('x', 121)),
                               '22023', 'deal_title');
  foreach stmt in array array['NaN', '-1', '100000000.01', '12.345', 'Infinity'] loop
    perform pg_temp.expect_error(format('select pg_temp.interested(%L, true, %L, null, %L::numeric)', lead, 'interested', stmt),
                                 '22023', 'value');
  end loop;
  -- state: a deal opens only from Interested or Book meeting calls, never with a linked deal; a title or value needs
  -- the switch; the switch is never null
  perform pg_temp.expect_error(format('select public.log_activity(p_company => %L, p_type => %L, p_outcome => %L, p_open_deal => true)',
                                      lead, 'call', 'no_answer'), '22023', 'state');
  perform pg_temp.expect_error(format('select public.log_activity(p_company => %L, p_type => %L, p_outcome => %L, p_open_deal => true)',
                                      lead, 'call', 'connected'), '22023', 'state');
  perform pg_temp.expect_error(format('select public.log_activity(p_company => %L, p_type => %L, p_body => %L, p_open_deal => true)',
                                      lead, 'note', 'x'), '22023', 'state');
  perform pg_temp.expect_error(format('select public.log_activity(p_company => %L, p_type => %L, p_outcome => %L, p_follow_up_date => current_date + 1, p_task_title => %L, p_deal => %L, p_open_deal => true)',
                                      lead, 'call', 'interested', 'x', deal), '22023', 'state');
  perform pg_temp.expect_error(format('select public.log_activity(p_company => %L, p_type => %L, p_body => %L, p_deal_title => %L)',
                                      lead, 'note', 'x', 'A title'), '22023', 'state');
  perform pg_temp.expect_error(format('select public.log_activity(p_company => %L, p_type => %L, p_body => %L, p_deal_value => 10)',
                                      lead, 'note', 'x'), '22023', 'state');
  perform pg_temp.expect_error(format('select public.log_activity(p_company => %L, p_type => %L, p_body => %L, p_open_deal => null)',
                                      lead, 'note', 'x'), '22023', 'bounds');
  perform pg_temp.su();
  if (select count(*) from public.activities where company_id = lead) <> n_acts
     or (select count(*) from public.deals where company_id = lead) <> 1 then
    raise exception 'FAIL: log_activity_open_deal_bad_title_writes_nothing';
  end if;
  -- Title text that looks like SQL or a PostgREST filter is stored verbatim (threat 28).
  perform pg_temp.act(r1);
  r := pg_temp.interested(lead, true, 'interested', $t$'); drop table deals;-- ),id.eq.$t$);
  perform pg_temp.su();
  if (select title from public.deals where id = (r -> 'deal' ->> 'id')::uuid) <> $t$'); drop table deals;-- ),id.eq.$t$ then
    raise exception 'FAIL: a deal title is stored as typed';
  end if;
  perform pg_temp.invariants('skipped opens');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 5. One Undo takes back the call and its untouched deal; a moved deal stays (5.3; mutations 5b-2, 5b-4) ----------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'cold');
  lead2 uuid := pg_temp.new_lead(r1, 'cold');
  lead3 uuid := pg_temp.new_lead(r1, 'cold');
  r jsonb;
  u jsonb;
  deal uuid;
  act uuid;
begin
  -- undo_activity_removes_untouched_deal
  perform pg_temp.act(r1);
  r := pg_temp.interested(lead, true, 'interested', 'Undo me');
  act := (r ->> 'activity_id')::uuid;
  deal := (r -> 'deal' ->> 'id')::uuid;
  -- deal_direct_delete_refused_while_activity_undo_record: the creator branch waits for the call's undo (the lead comes
  -- back first): a direct delete removes nothing; delete_deal asks for a code (verifier 5a finding 8)
  perform pg_temp.act(r1, 'aal2', 3600);
  delete from public.deals where id = deal;
  if found then raise exception 'FAIL: deal_direct_delete_refused_while_activity_undo_record'; end if;
  perform pg_temp.expect_error(format('select public.delete_deal(%L)', deal), '42501', 'step_up');
  if (public.get_deal(deal) ->> 'can_delete')::boolean then raise exception 'FAIL: can_delete while the undo record stands'; end if;
  perform pg_temp.act(r1);
  u := public.undo_activity(act);
  if u ->> 'deal' <> 'removed' or not (u -> 'restored' ->> 'status')::boolean or u -> 'lead' ->> 'lead_status' <> 'cold'
     or not (u ->> 'task_deleted')::boolean then
    raise exception 'FAIL: undo_activity_removes_untouched_deal answer %', u;
  end if;
  perform pg_temp.su();
  if exists (select 1 from public.deals where id = deal) or exists (select 1 from public.deal_stage_history where deal_id = deal)
     or exists (select 1 from public.activities where id = act)
     or (select count(*) from public.audit_log where table_name = 'deals' and record_id = deal::text and action = 'delete') <> 1 then
    raise exception 'FAIL: undo_activity_removes_untouched_deal rows';
  end if;
  -- undo_activity_keeps_moved_deal: once the deal moved (version 1), Undo takes back the call only
  perform pg_temp.act(r1);
  r := pg_temp.interested(lead2, true);
  act := (r ->> 'activity_id')::uuid;
  deal := (r -> 'deal' ->> 'id')::uuid;
  perform public.move_deal(deal, 'qualified', 0);
  u := public.undo_activity(act);
  perform pg_temp.su();
  if u ->> 'deal' <> 'kept' or not exists (select 1 from public.deals where id = deal and source_activity_id is null and version = 2)
     or exists (select 1 from public.activities where id = act) then
    raise exception 'FAIL: undo_activity_keeps_moved_deal %', u;
  end if;
  -- An edited title (version 1) is a touch too; and a deal handed to a colleague (another owner) stays.
  perform pg_temp.act(r1);
  r := pg_temp.interested(lead3, true);
  perform public.update_deal((r -> 'deal' ->> 'id')::uuid, 0, '{title}', p_title => 'Edited');
  u := public.undo_activity((r ->> 'activity_id')::uuid);
  if u ->> 'deal' <> 'kept' then raise exception 'FAIL: an edited deal stays %', u; end if;
  -- A call that opened nothing answers deal null on Undo.
  r := pg_temp.interested(lead3, false);
  u := public.undo_activity((r ->> 'activity_id')::uuid);
  if u -> 'deal' <> 'null'::jsonb then raise exception 'FAIL: undo without a deal %', u; end if;
  perform pg_temp.su();
  perform pg_temp.invariants('undo takes back the deal');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 6. Undo by someone else, or late, never removes the deal (threat 15) ---------------------------------------------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'cold');
  r jsonb;
  deal uuid;
  act uuid;
begin
  perform pg_temp.act(r1);
  r := pg_temp.interested(lead, true);
  act := (r ->> 'activity_id')::uuid;
  deal := (r -> 'deal' ->> 'id')::uuid;
  -- a colleague (admin) cannot undo r1's call
  perform pg_temp.act(admin);
  perform pg_temp.expect_error(format('select public.undo_activity(%L)', act), '22023', 'undo_expired');
  -- after 2 minutes the call cannot be undone: the deal stays
  perform pg_temp.su();
  alter table public.activities disable trigger set_activity_time;  -- (rolled back with the block)
  update public.activities set created_at = created_at - interval '121 seconds' where id = act;
  alter table public.activities enable trigger set_activity_time;
  perform pg_temp.act(r1);
  perform pg_temp.expect_error(format('select public.undo_activity(%L)', act), '22023', 'undo_expired');
  perform pg_temp.su();
  if not exists (select 1 from public.deals where id = deal) then raise exception 'FAIL: a late or foreign undo removed the deal'; end if;
  perform pg_temp.invariants('foreign or late undo');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 7. get_lead's deals brief follows deals RLS (threat 3; residual risk 3) -------------------------------------------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  r2 constant uuid := '00000000-0000-0000-0000-0000000005a2';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  dnc uuid := pg_temp.new_lead(r1, 'do_not_contact');
  empty uuid := pg_temp.new_lead(r1, 'cold');
  old_deal uuid := pg_temp.su_deal(lead, r1);
  new_deal uuid;
  won_deal uuid := pg_temp.su_deal(lead, r1);
  g jsonb;
begin
  update public.deals set stage_entered_at = now() - interval '20 days', title = 'Older' where id = old_deal;
  update public.deals set stage_id = (select id from public.pipeline_stages s where s.key = 'won'
                                       and s.org_id = (select org_id from public.companies where id = lead)),
                          status = 'won', closed_at = now(), value = 10, fulfilment = 'from_stock', version = 1
   where id = won_deal;  -- (the superuser skips the guard: the version is set by hand so the history chain rises)
  perform pg_temp.act(r1);
  new_deal := (public.open_deal(lead, 'Newer', 2500) -> 'deal' ->> 'id')::uuid;
  perform public.move_deal(new_deal, 'qualified', 0);
  -- get_lead_deals_respects_rls: the owner sees both open deals, the newest in stage first; closed deals do not count
  g := public.get_lead(lead);
  if (g -> 'deals' ->> 'open_count')::integer <> 2 or (g -> 'deals' -> 'latest_open' ->> 'id')::uuid <> new_deal
     or g -> 'deals' -> 'latest_open' ->> 'stage' <> 'qualified' or g -> 'deals' -> 'latest_open' ->> 'value' <> '2500.00'
     or g -> 'deals' -> 'latest_open' ->> 'title' <> 'Newer' or (g -> 'deals' -> 'latest_open' ->> 'is_stalled')::boolean
     or (g -> 'deals' -> 'latest_open' ->> 'version')::integer <> 1 or not (g ->> 'can_open_deal')::boolean then
    raise exception 'FAIL: get_lead deals for the owner %', g -> 'deals';
  end if;
  g := public.get_lead(empty);
  if (g -> 'deals' ->> 'open_count')::integer <> 0 or g -> 'deals' -> 'latest_open' <> 'null'::jsonb then
    raise exception 'FAIL: get_lead deals on a lead with none %', g -> 'deals';
  end if;
  if (public.get_lead(dnc) ->> 'can_open_deal')::boolean then raise exception 'FAIL: can_open_deal on a DNC lead'; end if;
  -- a rep who is not the deals' owner sees none (deals are owner, manager or admin; D2) and may not open one here
  perform pg_temp.act(r2);
  g := public.get_lead(lead);
  if (g -> 'deals' ->> 'open_count')::integer <> 0 or g -> 'deals' -> 'latest_open' <> 'null'::jsonb
     or (g ->> 'can_open_deal')::boolean then
    raise exception 'FAIL: get_lead_deals_respects_rls (rep) %', g;
  end if;
  -- an admin sees them all
  perform pg_temp.act(admin);
  if (public.get_lead(lead) -> 'deals' ->> 'open_count')::integer <> 2 or not (public.get_lead(lead) ->> 'can_open_deal')::boolean then
    raise exception 'FAIL: get_lead deals for an admin';
  end if;
  perform pg_temp.su();
  perform pg_temp.invariants('get_lead deals');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 8. claim_card_open_deal_count (design 8.1, 3.2): the work queue's card (Day 4c's private.queue_card, which
-- claim_next_lead returns) says how many open deals the caller sees on the lead and the newest in stage, under deals RLS.
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  r2 constant uuid := '00000000-0000-0000-0000-0000000005a2';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  empty uuid := pg_temp.new_lead(r1, 'cold');
  old_deal uuid := pg_temp.su_deal(lead, r1);
  won_deal uuid := pg_temp.su_deal(lead, r1);
  new_deal uuid;
  c jsonb;
begin
  update public.deals set stage_entered_at = now() - interval '20 days' where id = old_deal;
  update public.deals set stage_id = (select id from public.pipeline_stages s where s.key = 'won'
                                       and s.org_id = (select org_id from public.companies where id = lead)),
                          status = 'won', closed_at = now(), value = 10, fulfilment = 'from_stock', version = 1
   where id = won_deal;
  perform pg_temp.act(r1);
  new_deal := (public.open_deal(lead, 'Newer', 18400) -> 'deal' ->> 'id')::uuid;
  perform public.move_deal(new_deal, 'negotiations', 0);
  if position('private.queue_card(' in (select p.prosrc from pg_proc p where p.oid = to_regproc('public.claim_next_lead'))) = 0 then
    raise exception 'FAIL: claim_next_lead no longer builds its cards with private.queue_card';
  end if;
  c := private.queue_card(lead, null, false) -> 'open_deal';
  if (c ->> 'count')::integer <> 2 or (c -> 'latest' ->> 'id')::uuid <> new_deal or c -> 'latest' ->> 'stage' <> 'negotiations'
     or c -> 'latest' ->> 'value' <> '18400.00' then
    raise exception 'FAIL: claim_card_open_deal_count for the owner %', c;
  end if;
  c := private.queue_card(empty, null, false) -> 'open_deal';
  if (c ->> 'count')::integer <> 0 or c -> 'latest' <> 'null'::jsonb then
    raise exception 'FAIL: claim_card_open_deal_count on a lead with none %', c;
  end if;
  -- another rep sees none of r1's deals (deals RLS), whatever the card says about the lead
  perform pg_temp.act(r2);
  c := private.queue_card(lead, null, false) -> 'open_deal';
  if (c ->> 'count')::integer <> 0 or c -> 'latest' <> 'null'::jsonb then
    raise exception 'FAIL: claim_card_open_deal_count respects deals RLS %', c;
  end if;
  perform pg_temp.act(admin);
  if (private.queue_card(lead, null, false) -> 'open_deal' ->> 'count')::integer <> 2 then
    raise exception 'FAIL: claim_card_open_deal_count for an admin';
  end if;
  perform pg_temp.su();
  perform pg_temp.invariants('queue card deals');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

do $$ begin
  perform pg_temp.invariants('the end of deal_links_attack');
end $$;
\echo 'deal_links_attack: all checks passed'
