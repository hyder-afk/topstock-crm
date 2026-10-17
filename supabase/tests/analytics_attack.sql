-- Analytics v1 P1 attack and behaviour tests (design docs/evidence/analytics/design.md section 3.9; migration
-- 20261024090000_analytics.sql). Runs in scripts/db-test.sh (CI job "rls") after every other day's file and right
-- before gate1_attack.sql (which checks the new functions' catalog rules: no DEFINER, no PUBLIC execute, no dynamic SQL),
-- on the same database; its fixture is committed in an organisation of its own, so it cannot change another file's
-- figures.
-- Fixture: "Analytics Org" with admin Ada, manager Max and reps Rita and Remy, and Tom, a rep of the TopStock org whose
-- rows must never reach an Analytics Org figure. Every block has its own month in the past (activity and call times:
-- September 2026; pipeline: August; speed-to-lead: July; sales: June; list quality: May), so each figure is an exact
-- hand-counted number. Fixed instants are in the past on purpose: a range may not end after Paris today, so the Paris
-- day edges and clock changes are tested on 31 Oct 2025, 26 Oct 2025 (25 hours) and 30 Mar 2025 (23 hours), the same
-- cases as the design's 2026 dates, which are still in the future on 17 Oct 2026. Nothing reads the session's date or
-- zone (db.yml runs this under PGTZ=Pacific/Kiritimati).
-- Probes run as a signed-in user through the API role; scenarios that write run in a block rolled back at the end
-- (raise TS001, caught).
\set ON_ERROR_STOP 1
\set QUIET 1

-- Helpers (temporary functions do not survive into a new psql session, so they are defined again here) -------------
create function pg_temp.act(sub uuid, aal text default 'aal2', totp_age_s integer default 30) returns void
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', false);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', sub::text, 'role', 'authenticated', 'aal', aal,
    'amr', case when totp_age_s is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - totp_age_s)) end)::text, false);
end;
$$;
create function pg_temp.su() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
end;
$$;
create function pg_temp.expect_error(stmt text, want_state text, want_hint text default null) returns void
language plpgsql as $$
declare
  got_state text;
  got_hint text;
  got_msg text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics got_state = returned_sqlstate, got_hint = pg_exception_hint, got_msg = message_text;
    if got_state <> want_state or (want_hint is not null and coalesce(got_hint, '') <> want_hint) then
      raise exception 'FAIL: "%" gave % (hint "%", %), expected % (hint "%")', left(stmt, 200), got_state, got_hint,
        got_msg, want_state, want_hint;
    end if;
    return;
  end;
  raise exception 'FAIL: "%" succeeded, expected %', left(stmt, 200), want_state;
end;
$$;
create function pg_temp.eq(label text, got anyelement, want anyelement) returns void
language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL: % is %, expected %', label, got, want;
  end if;
end;
$$;
-- A lead of an org, created at `at`; status 'customer' by default so it stays out of the coverage counts.
create function pg_temp.lead(org uuid, owner uuid, at timestamptz, status text default 'customer', batch uuid default null,
                             last_at timestamptz default null, next_at timestamptz default null) returns uuid
language sql as $$
  insert into public.companies (org_id, name, owner_id, lead_status, created_at, last_activity_at, next_action_at, import_batch_id)
  values (org, 'Analytics lead', owner, status, at, last_at, next_at, batch)
  returning id
$$;
-- An entry (who may be null: a deleted author); notes and other entries carry a sentinel body that must never leak.
create function pg_temp.ent(org uuid, who uuid, at timestamptz, kind text, outcome text, lead uuid) returns uuid
language sql as $$
  insert into public.activities (org_id, company_id, user_id, type, outcome, body, created_at)
  values (org, lead, who, kind, outcome, 'SENTINEL-BODY planted', at)
  returning id
$$;
-- A deal at `stage` (won and lost take the status, close time and what a closed deal needs).
create function pg_temp.deal(org uuid, owner uuid, lead uuid, stage text, val numeric, created timestamptz,
                             closed timestamptz default null, reason text default null) returns uuid
language sql as $$
  insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, status, stage_entered_at,
                            closed_at, fulfilment, lost_reason, lost_note, created_at)
  select org, lead, s.id, owner, owner, 'Analytics deal', val,
         case stage when 'won' then 'won' when 'lost' then 'lost' else 'open' end, coalesce(closed, created),
         case when stage in ('won', 'lost') then closed end,
         case when stage = 'won' then 'from_stock' end, case when stage = 'lost' then reason end,
         case when stage = 'lost' then 'SENTINEL-NOTE planted' end, created
    from public.pipeline_stages s where s.org_id = org and s.key = stage
  returning id
$$;
create function pg_temp.hist(deal uuid, kind text, from_stage text, to_stage text, at timestamptz, undoes bigint default null)
returns bigint language sql as $$
  insert into public.deal_stage_history (org_id, deal_id, kind, from_stage, to_stage, version_after, undoes, created_at)
  select d.org_id, deal, kind, from_stage, to_stage,
         (select count(*) from public.deal_stage_history h where h.deal_id = deal)::integer, undoes, at
    from public.deals d where d.id = deal
  returning id
$$;
create function pg_temp.task(org uuid, who uuid, lead uuid, due_date date default null, due_at timestamptz default null,
                             done boolean default false, cancelled boolean default false) returns uuid
language sql as $$
  insert into public.tasks (org_id, company_id, assignee_id, created_by, title, kind, due_date, due_at, done_at, cancelled_at)
  values (org, lead, who, who, 'Analytics task', 'todo', due_date, due_at, case when done then now() end,
          case when cancelled then now() end)
  returning id
$$;
-- Every function's payload for one caller, as text (the sentinel check).
create function pg_temp.all_payloads(p_user uuid) returns text
language sql as $$
  select concat_ws(' | ',
    public.analytics_activity('2026-09-01', '2026-09-30', p_user)::text,
    public.analytics_call_times('2026-09-01', '2026-09-30', p_user)::text,
    public.analytics_pipeline('2026-08-01', '2026-08-31', p_user)::text,
    public.analytics_speed('2026-07-01', '2026-07-31', p_user)::text,
    public.analytics_sales('2026-06-01', '2026-06-30', p_user)::text,
    public.analytics_coverage(p_user, 30)::text)
$$;
create function pg_temp.paris_today() returns date language sql as $$ select (now() at time zone 'Europe/Paris')::date $$;

-- Fixture -----------------------------------------------------------------------------------------------------------
-- Analytics Org with its five stages (copied from the TopStock org's); Ada (admin), Max (manager), Rita and Remy (reps);
-- Tom, a rep of the TopStock org. Committed: the database is thrown away after the run.
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
insert into public.orgs (id, name) values ('00000000-0000-0000-0000-00000000a0cc', 'Analytics Org');
insert into public.pipeline_stages (org_id, name, position, is_won, is_lost, key, stall_days)
select '00000000-0000-0000-0000-00000000a0cc', s.name, s.position, s.is_won, s.is_lost, s.key, s.stall_days
  from public.pipeline_stages s join public.orgs o on o.id = s.org_id and o.name = 'TopStock Wholesale';
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000a0a0', 'an-ada@test.invalid', '{"first_name":"Ada"}'),
  ('00000000-0000-0000-0000-00000000a0a1', 'an-max@test.invalid', '{"first_name":"Max"}'),
  ('00000000-0000-0000-0000-00000000a0a2', 'an-rita@test.invalid', '{"first_name":"Rita"}'),
  ('00000000-0000-0000-0000-00000000a0a3', 'an-remy@test.invalid', '{"first_name":"Remy"}'),
  ('00000000-0000-0000-0000-00000000a0a4', 'an-tom@test.invalid', '{"first_name":"Tom"}');
update public.profiles set org_id = '00000000-0000-0000-0000-00000000a0cc', timezone = 'Europe/Paris',
       role = case id when '00000000-0000-0000-0000-00000000a0a0' then 'admin'::public.app_role
                      when '00000000-0000-0000-0000-00000000a0a1' then 'manager'::public.app_role
                      else 'rep'::public.app_role end
 where id in ('00000000-0000-0000-0000-00000000a0a0', '00000000-0000-0000-0000-00000000a0a1',
              '00000000-0000-0000-0000-00000000a0a2', '00000000-0000-0000-0000-00000000a0a3');
update public.profiles set org_id = (select id from public.orgs where name = 'TopStock Wholesale'), role = 'rep'
 where id = '00000000-0000-0000-0000-00000000a0a4';

set session_replication_role = replica;  -- raw fixture rows: no guard, no history row, no "last activity" touch
do $$
declare
  org constant uuid := '00000000-0000-0000-0000-00000000a0cc';
  ts constant uuid := (select id from public.orgs where name = 'TopStock Wholesale');
  ada constant uuid := '00000000-0000-0000-0000-00000000a0a0';
  max_ constant uuid := '00000000-0000-0000-0000-00000000a0a1';
  rita constant uuid := '00000000-0000-0000-0000-00000000a0a2';
  remy constant uuid := '00000000-0000-0000-0000-00000000a0a3';
  tom constant uuid := '00000000-0000-0000-0000-00000000a0a4';
  la uuid; lt uuid; l1 uuid; l2 uuid; l3 uuid; l4 uuid; l6 uuid; b1l uuid; b2l uuid; b3l uuid;
  d1 uuid; d2 uuid; d3 uuid; d4 uuid; d5 uuid; d6 uuid; d7 uuid; d8 uuid; d9 uuid; d10 uuid; d11 uuid; d12 uuid; d13 uuid;
  dt uuid; h bigint; p1 uuid; o1 uuid; o2 uuid; o3 uuid; o4 uuid; ot uuid; line uuid;
begin
  -- Leads that carry entries, deals and sales (created in January, out of every range; status customer).
  la := pg_temp.lead(org, rita, '2026-01-02 10:00+01');
  lt := pg_temp.lead(ts, tom, '2026-01-02 10:00+01');

  -- Activity and call times: September 2026 (Paris summer time, UTC+2).
  perform pg_temp.ent(org, rita, '2026-09-02 10:00+02', 'call', 'connected', la);
  perform pg_temp.ent(org, rita, '2026-09-02 11:00+02', 'call', 'no_answer', la);
  perform pg_temp.ent(org, rita, '2026-09-03 10:30+02', 'call', 'wrong_number', la);   -- a dial, not reached (G1)
  perform pg_temp.ent(org, rita, '2026-09-10 15:00+02', 'call', 'interested', la);
  perform pg_temp.ent(org, rita, '2026-09-03 12:00+02', 'email', 'sent', la);
  perform pg_temp.ent(org, rita, '2026-09-04 12:00+02', 'whatsapp', null, la);
  perform pg_temp.ent(org, rita, '2026-09-05 12:00+02', 'meeting', 'held', la);
  perform pg_temp.ent(org, rita, '2026-09-05 13:00+02', 'note', null, la);              -- notes are not activity
  perform pg_temp.ent(org, rita, '2026-08-31 23:30+02', 'call', 'connected', la);       -- 31 Aug in Paris: out
  perform pg_temp.ent(org, rita, '2026-10-01 00:10+02', 'call', 'connected', la);       -- 1 Oct in Paris: out
  perform pg_temp.ent(org, remy, '2026-09-02 10:15+02', 'call', 'voicemail', la);
  perform pg_temp.ent(org, remy, '2026-09-15 10:45+02', 'call', 'meeting_booked', la);
  perform pg_temp.ent(org, remy, '2026-09-16 12:00+02', 'meeting', 'no_show', la);
  perform pg_temp.ent(org, max_, '2026-09-20 18:00+02', 'call', 'do_not_contact', la);
  perform pg_temp.ent(org, null, '2026-09-21 09:00+02', 'call', 'connected', la);       -- author deleted (C1)
  perform pg_temp.ent(org, ada, '2026-09-22 12:00+02', 'email', 'sent', la);
  perform pg_temp.ent(ts, tom, '2026-09-02 10:00+02', 'call', 'connected', lt);         -- another org: never counted

  -- Speed-to-lead: July 2026. L1 (Rita) touched by Remy after 30 min (a note at 10 min and an entry from before the lead
  -- was created are ignored); L2 (Rita) emailed after 10 h; L3 (Remy) WhatsApp after 2 days; L4 (Remy) meeting after 6
  -- days; L5 (Rita) not touched; L6 (Rita) imported: left out.
  l1 := pg_temp.lead(org, rita, '2026-07-01 09:00+02');
  perform pg_temp.ent(org, rita, '2026-07-01 08:00+02', 'call', 'connected', l1);
  perform pg_temp.ent(org, rita, '2026-07-01 09:10+02', 'note', null, l1);
  perform pg_temp.ent(org, remy, '2026-07-01 09:30+02', 'call', 'no_answer', l1);
  l2 := pg_temp.lead(org, rita, '2026-07-02 09:00+02');
  perform pg_temp.ent(org, rita, '2026-07-02 19:00+02', 'email', 'sent', l2);
  l3 := pg_temp.lead(org, remy, '2026-07-03 09:00+02');
  perform pg_temp.ent(org, remy, '2026-07-05 09:00+02', 'whatsapp', 'sent', l3);
  l4 := pg_temp.lead(org, remy, '2026-07-04 09:00+02');
  perform pg_temp.ent(org, remy, '2026-07-10 09:00+02', 'meeting', 'held', l4);
  perform pg_temp.lead(org, rita, '2026-07-05 09:00+02');
  -- Import batches: B1 (imported, 1 May), B2 (rolled back, 2 May), B3 (imported, 3 May, no leads left), B4 (a stock
  -- sheet). B1's file name is untrusted text and must come back byte for byte.
  insert into public.import_batches (id, org_id, kind, filename, status, created_at, file_sha256) values
    ('00000000-0000-0000-0000-00000000a0b1', org, 'leads', '<img src=x onerror=alert(1)> liste été.csv', 'imported', '2026-05-01 10:00+02', repeat('b', 64)),
    ('00000000-0000-0000-0000-00000000a0b2', org, 'leads', 'rolled back.csv', 'rolled_back', '2026-05-02 10:00+02', repeat('c', 64)),
    ('00000000-0000-0000-0000-00000000a0b3', org, 'leads', 'second.csv', 'imported', '2026-05-03 10:00+02', repeat('d', 64)),
    ('00000000-0000-0000-0000-00000000a0b4', org, 'stock', 'stock.csv', 'imported', '2026-05-04 10:00+02', repeat('e', 64));
  l6 := pg_temp.lead(org, rita, '2026-07-06 09:00+02', 'customer', '00000000-0000-0000-0000-00000000a0b2');
  perform pg_temp.ent(org, rita, '2026-07-06 09:05+02', 'call', 'connected', l6);

  -- List quality: B1's leads. b1 (Rita): reached call and won deal after the import; b2 (Rita): email and open deal
  -- after; b3 (Remy): a reached call and a won deal both dated before the import (count in nothing, D2); b4 (Remy):
  -- nothing.
  b1l := pg_temp.lead(org, rita, '2026-05-01 10:00+02', 'customer', '00000000-0000-0000-0000-00000000a0b1');
  perform pg_temp.ent(org, rita, '2026-05-02 10:00+02', 'call', 'connected', b1l);
  perform pg_temp.deal(org, rita, b1l, 'won', 100, '2026-05-03 10:00+02', '2026-05-04 10:00+02');
  b2l := pg_temp.lead(org, rita, '2026-05-01 10:00+02', 'customer', '00000000-0000-0000-0000-00000000a0b1');
  perform pg_temp.ent(org, rita, '2026-05-02 11:00+02', 'email', 'sent', b2l);
  perform pg_temp.deal(org, rita, b2l, 'lead', 100, '2026-05-03 11:00+02');
  b3l := pg_temp.lead(org, remy, '2026-05-01 10:00+02', 'customer', '00000000-0000-0000-0000-00000000a0b1');
  perform pg_temp.ent(org, remy, '2026-04-01 10:00+02', 'call', 'connected', b3l);
  perform pg_temp.deal(org, remy, b3l, 'won', 100, '2026-04-01 10:00+02', '2026-04-02 10:00+02');
  perform pg_temp.lead(org, remy, '2026-05-01 10:00+02', 'customer', '00000000-0000-0000-0000-00000000a0b1');

  -- Pipeline: August 2026, every event at 10:00 Paris.
  d1 := pg_temp.deal(org, rita, la, 'won', 1000, '2026-08-03 10:00+02', '2026-08-20 10:00+02');   -- full path, won
  perform pg_temp.hist(d1, 'open', null, 'lead', '2026-08-03 10:00+02');
  perform pg_temp.hist(d1, 'move', 'lead', 'qualified', '2026-08-05 10:00+02');
  perform pg_temp.hist(d1, 'move', 'qualified', 'negotiations', '2026-08-10 10:00+02');
  perform pg_temp.hist(d1, 'won', 'negotiations', 'won', '2026-08-20 10:00+02');
  d2 := pg_temp.deal(org, rita, la, 'negotiations', 200, '2026-08-04 10:00+02');                   -- jump Lead -> Neg.
  perform pg_temp.hist(d2, 'open', null, 'lead', '2026-08-04 10:00+02');
  perform pg_temp.hist(d2, 'move', 'lead', 'negotiations', '2026-08-06 10:00+02');
  d3 := pg_temp.deal(org, rita, la, 'lost', 100, '2026-08-05 10:00+02', '2026-08-07 10:00+02', 'price'); -- lost from Lead
  perform pg_temp.hist(d3, 'open', null, 'lead', '2026-08-05 10:00+02');
  perform pg_temp.hist(d3, 'lost', 'lead', 'lost', '2026-08-07 10:00+02');
  d4 := pg_temp.deal(org, rita, la, 'won', 500, '2026-08-06 10:00+02', '2026-08-08 10:00+02');     -- won from Lead
  perform pg_temp.hist(d4, 'open', null, 'lead', '2026-08-06 10:00+02');
  perform pg_temp.hist(d4, 'won', 'lead', 'won', '2026-08-08 10:00+02');
  d5 := pg_temp.deal(org, rita, la, 'lead', 300, '2026-08-07 10:00+02');                           -- move undone
  perform pg_temp.hist(d5, 'open', null, 'lead', '2026-08-07 10:00+02');
  h := pg_temp.hist(d5, 'move', 'lead', 'qualified', '2026-08-08 10:00+02');
  perform pg_temp.hist(d5, 'undo', 'qualified', 'lead', '2026-08-08 10:01+02', h);
  d6 := pg_temp.deal(org, rita, la, 'lost', 50, '2026-08-08 10:00+02', '2026-08-09 10:00+02', 'mistake'); -- mistake
  perform pg_temp.hist(d6, 'open', null, 'lead', '2026-08-08 10:00+02');
  perform pg_temp.hist(d6, 'lost', 'lead', 'lost', '2026-08-09 10:00+02');
  d7 := pg_temp.deal(org, rita, la, 'negotiations', 400, '2026-08-09 10:00+02');                   -- won, reopened
  perform pg_temp.hist(d7, 'open', null, 'lead', '2026-08-09 10:00+02');
  perform pg_temp.hist(d7, 'won', 'lead', 'won', '2026-08-10 10:00+02');
  perform pg_temp.hist(d7, 'reopen', 'won', 'negotiations', '2026-08-12 10:00+02');
  d8 := pg_temp.deal(org, rita, la, 'lead', 60, '2026-08-10 10:00+02');                            -- win undone
  perform pg_temp.hist(d8, 'open', null, 'lead', '2026-08-10 10:00+02');
  h := pg_temp.hist(d8, 'won', 'lead', 'won', '2026-08-11 10:00+02');
  perform pg_temp.hist(d8, 'undo', 'won', 'lead', '2026-08-11 10:01+02', h);
  d9 := pg_temp.deal(org, remy, la, 'won', 2000, '2026-08-11 10:00+02', '2026-08-25 10:00+02');    -- Remy won
  perform pg_temp.hist(d9, 'open', null, 'lead', '2026-08-11 10:00+02');
  perform pg_temp.hist(d9, 'won', 'lead', 'won', '2026-08-25 10:00+02');
  d10 := pg_temp.deal(org, remy, la, 'lost', 70, '2026-07-01 10:00+02', '2026-08-15 10:00+02', 'timing'); -- opened in July
  perform pg_temp.hist(d10, 'open', null, 'lead', '2026-07-01 10:00+02');
  perform pg_temp.hist(d10, 'lost', 'lead', 'lost', '2026-08-15 10:00+02');
  d11 := pg_temp.deal(org, remy, la, 'lead', null, '2026-08-12 10:00+02');                         -- no value yet
  perform pg_temp.hist(d11, 'open', null, 'lead', '2026-08-12 10:00+02');
  d12 := pg_temp.deal(org, max_, la, 'lead', 300, '2026-08-13 10:00+02');
  perform pg_temp.hist(d12, 'open', null, 'lead', '2026-08-13 10:00+02');
  d13 := pg_temp.deal(org, null, la, 'lead', 50, '2026-08-14 10:00+02');                           -- unassigned
  perform pg_temp.hist(d13, 'open', null, 'lead', '2026-08-14 10:00+02');
  dt := pg_temp.deal(ts, tom, lt, 'won', 9999, '2026-08-03 10:00+02', '2026-08-04 10:00+02');      -- another org
  perform pg_temp.hist(dt, 'open', null, 'lead', '2026-08-03 10:00+02');
  perform pg_temp.hist(dt, 'won', 'lead', 'won', '2026-08-04 10:00+02');

  -- Sales: June 2026. O1 Rita from stock: "Denim Jacket" (a stocked product) 10 x 20 and "Cap" 5 x 4; O2 Rita direct:
  -- "denim jacket" (no product) 3 x 30; O3 Remy from stock: "Boots" 2 x 100; O4 Rita cancelled: "Denim Jacket"
  -- 100 x 20 (left out); a TopStock sale (never counted). O1 carries a note, O4 a cancel reason and O1's first line a
  -- cost: none may leak.
  insert into public.products (org_id, name, pieces_per_carton) values (org, 'Denim Jacket', 1) returning id into p1;
  insert into private.orders (org_id, company_id, fulfilment, status, note, created_by, created_at)
  values (org, la, 'from_stock', 'confirmed', 'SENTINEL-ORDERNOTE planted', rita, '2026-06-02 10:00+02') returning id into o1;
  insert into private.order_lines (order_id, org_id, position, product_id, product_name, quantity, unit_price)
  values (o1, org, 1, p1, 'Denim Jacket', 10, 20) returning id into line;
  insert into private.order_line_costs (order_line_id, org_id, cost_per_piece) values (line, org, 98765.4321);
  insert into private.order_lines (order_id, org_id, position, product_id, product_name, quantity, unit_price)
  values (o1, org, 2, null, 'Cap', 5, 4);
  insert into private.orders (org_id, company_id, fulfilment, status, created_by, created_at)
  values (org, la, 'direct_from_source', 'confirmed', rita, '2026-06-10 10:00+02') returning id into o2;
  insert into private.order_lines (order_id, org_id, position, product_id, product_name, quantity, unit_price)
  values (o2, org, 1, null, 'denim jacket', 3, 30);
  insert into private.orders (org_id, company_id, fulfilment, status, created_by, created_at)
  values (org, la, 'from_stock', 'confirmed', remy, '2026-06-15 10:00+02') returning id into o3;
  insert into private.order_lines (order_id, org_id, position, product_id, product_name, quantity, unit_price)
  values (o3, org, 1, null, 'Boots', 2, 100);
  insert into private.orders (org_id, company_id, fulfilment, status, created_by, created_at, cancelled_at, cancelled_by,
                              cancel_reason)
  values (org, la, 'from_stock', 'cancelled', rita, '2026-06-20 10:00+02', '2026-06-20 11:00+02', rita,
          'SENTINEL-CANCEL planted') returning id into o4;
  insert into private.order_lines (order_id, org_id, position, product_id, product_name, quantity, unit_price)
  values (o4, org, 1, p1, 'DENIM JACKET', 100, 20);
  insert into private.orders (org_id, company_id, fulfilment, status, created_by, created_at)
  values (ts, lt, 'from_stock', 'confirmed', tom, '2026-06-02 10:00+02') returning id into ot;
  insert into private.order_lines (order_id, org_id, position, product_id, product_name, quantity, unit_price)
  values (ot, ts, 1, null, 'Denim Jacket', 1000, 1);
end $$;
set session_replication_role = origin;

-- 0. What the database itself says (H2; design 3.1, 3.8) --------------------------------------------------------------
do $$
declare
  f record;
  n integer := 0;
begin
  for f in select p.oid, p.oid::regprocedure::text as sig, p.proname, p.prosecdef, p.provolatile, p.proconfig, p.prosrc
             from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where (s.nspname = 'public' and p.proname like 'analytics\_%')
               or (s.nspname = 'private' and p.proname like 'analytics\_%') loop
    n := n + 1;
    if f.prosecdef or not (f.proconfig @> array['search_path=""'])
       or not has_function_privilege('authenticated', f.oid, 'EXECUTE')
       or has_function_privilege('anon', f.oid, 'EXECUTE') or has_function_privilege('public', f.oid, 'EXECUTE')
       or f.prosrc ~* '\mexecute\M' or f.prosrc ~* 'format\s*\(' then
      raise exception 'FAIL: analytics function rules broken by %', f.sig;
    end if;
    -- Never an entry's text, a lost note, a cancel reason, a sale's note or a cost.
    if f.prosrc ~* '\m(body|lost_note|cancel_reason|cost_per_piece|order_line_costs)\M' or f.prosrc ~* '\m[a-z]\.note\M' then
      raise exception 'FAIL: % reads a text or cost column', f.sig;
    end if;
    -- Stable (the bucket list is immutable); the seven blocks and the four source helpers plan each call for its range,
    -- without JIT.
    if f.provolatile <> (case when f.proname = 'analytics_buckets' then 'i' else 's' end) then
      raise exception 'FAIL: % volatility %', f.sig, f.provolatile;
    end if;
    if f.proname not in ('analytics_owner', 'analytics_window', 'analytics_buckets')
       and not (f.proconfig @> array['plan_cache_mode=force_custom_plan', 'jit=off']) then
      raise exception 'FAIL: % does not force custom plans with JIT off', f.sig;
    end if;
  end loop;
  perform pg_temp.eq('analytics functions (7 blocks + 3 helpers + 4 source helpers)', n, 14);
  perform pg_temp.eq('the seven blocks',
    (select array_agg(p.oid::regprocedure::text order by p.proname) from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.proname like 'analytics\_%'),
    array['analytics_activity(date,date,uuid)', 'analytics_batches(uuid,integer)', 'analytics_call_times(date,date,uuid)',
          'analytics_coverage(uuid,integer)', 'analytics_pipeline(date,date,uuid)', 'analytics_sales(date,date,uuid)',
          'analytics_speed(date,date,uuid)']);
  -- The one new index: authorless entries, partial.
  perform pg_temp.eq('activities_no_author_idx',
    (select pg_get_indexdef(i.indexrelid) from pg_index i where i.indexrelid = 'public.activities_no_author_idx'::regclass),
    'CREATE INDEX activities_no_author_idx ON public.activities USING btree (org_id, created_at) WHERE (user_id IS NULL)');
end $$;

-- 1. Ranges and buckets at fixed dates (F3, design 1.0 and 3.5: why 54) ---------------------------------------------
do $$
declare
  w record;
  b jsonb;
begin
  -- A 366-day range from Sunday 5 Jan 2025 to Monday 5 Jan 2026 touches 54 ISO weeks, partial at both ends.
  select * into w from private.analytics_window('2025-01-05', '2026-01-05');
  perform pg_temp.eq('366 days: weeks', w.bucket, 'week');
  perform pg_temp.eq('366 days: from', w.t_from, timestamptz '2025-01-04 23:00:00+00');
  perform pg_temp.eq('366 days: to', w.t_to, timestamptz '2026-01-05 23:00:00+00');
  perform pg_temp.eq('54 weeks', (select count(*)::integer from private.analytics_buckets('2025-01-05', '2026-01-05', 'week')), 54);
  perform pg_temp.eq('first week', (select array[start::text, partial::text] from private.analytics_buckets('2025-01-05', '2026-01-05', 'week') order by start limit 1),
                     array['2024-12-30', 'true']);
  perform pg_temp.eq('last week', (select array[start::text, partial::text] from private.analytics_buckets('2025-01-05', '2026-01-05', 'week') order by start desc limit 1),
                     array['2026-01-05', 'true']);
  perform pg_temp.eq('whole weeks', (select count(*)::integer from private.analytics_buckets('2025-01-05', '2026-01-05', 'week') where not partial), 52);
  -- 31 days are days, 32 are weeks; a 23-hour and a 25-hour day are one day each.
  perform pg_temp.eq('31 days', (select bucket from private.analytics_window('2026-08-01', '2026-08-31')), 'day');
  perform pg_temp.eq('32 days', (select bucket from private.analytics_window('2026-08-01', '2026-09-01')), 'week');
  select * into w from private.analytics_window('2025-10-26', '2025-10-26');
  perform pg_temp.eq('25 h day', w.t_to - w.t_from, interval '25 hours');
  select * into w from private.analytics_window('2025-03-30', '2025-03-30');
  perform pg_temp.eq('23 h day', w.t_to - w.t_from, interval '23 hours');
  -- The same through a block function: a 90-day range in weeks, contiguous, zeros filled, both ends partial.
  perform pg_temp.act('00000000-0000-0000-0000-00000000a0a0');
  b := public.analytics_activity('2026-06-03', '2026-08-31');
  perform pg_temp.su();
  perform pg_temp.eq('90 days bucket', b ->> 'bucket', 'week');
  perform pg_temp.eq('90 days: 14 weeks', jsonb_array_length(b -> 'buckets'), 14);
  perform pg_temp.eq('90 days: partial flags',
    (select array_agg((e ->> 'partial')::boolean order by n) from jsonb_array_elements(b -> 'buckets') with ordinality x (e, n)),
    array[true, false, false, false, false, false, false, false, false, false, false, false, false, true]);
  perform pg_temp.eq('90 days: contiguous Mondays',
    (select bool_and(((e ->> 'start')::date - date '2026-06-01') = (n - 1) * 7 and extract(isodow from (e ->> 'start')::date) = 1)
       from jsonb_array_elements(b -> 'buckets') with ordinality x (e, n)), true);
  perform pg_temp.eq('90 days: an empty week is zeros', b -> 'buckets' -> 0,
    '{"start":"2026-06-01","partial":true,"calls":0,"reached":0,"emails":0,"whatsapp":0,"meetings":0}'::jsonb);
  -- The design's 366-day case through the function too: exactly 54 buckets.
  perform pg_temp.act('00000000-0000-0000-0000-00000000a0a0');
  b := public.analytics_sales('2025-01-05', '2026-01-05');
  perform pg_temp.su();
  perform pg_temp.eq('366 days through analytics_sales', jsonb_array_length(b -> 'buckets'), 54);
end $$;

-- 2. Not signed in, signed in without two-factor (A1, A2) -----------------------------------------------------------
do $$
declare
  stmt text;
  calls constant text[] := array[
    'select public.analytics_activity(''2026-09-01'', ''2026-09-30'')',
    'select public.analytics_pipeline(''2026-09-01'', ''2026-09-30'')',
    'select public.analytics_speed(''2026-09-01'', ''2026-09-30'')',
    'select public.analytics_call_times(''2026-09-01'', ''2026-09-30'')',
    'select public.analytics_sales(''2026-09-01'', ''2026-09-30'')',
    'select public.analytics_coverage()',
    'select public.analytics_batches()'];
begin
  -- A2: an admin at aal1 is refused by every function, before anything is read.
  perform pg_temp.act('00000000-0000-0000-0000-00000000a0a0', 'aal1', null);
  foreach stmt in array calls loop perform pg_temp.expect_error(stmt, '42501', 'forbidden'); end loop;
  -- An authenticated role without a user id: the same.
  perform pg_temp.su();
  perform set_config('role', 'authenticated', false);
  perform set_config('request.jwt.claims', '{"role": "authenticated", "aal": "aal2"}', false);
  foreach stmt in array calls loop perform pg_temp.expect_error(stmt, '42501', 'forbidden'); end loop;
  -- A1: anon has no EXECUTE at all (permission denied), on the blocks and on the private helpers.
  perform pg_temp.su();
  perform set_config('role', 'anon', false);
  foreach stmt in array calls || array['select private.analytics_owner(null)',
                                       'select * from private.analytics_window(''2026-09-01'', ''2026-09-30'')',
                                       'select * from private.analytics_activity_rows(null, now(), now(), false)'] loop
    perform pg_temp.expect_error(stmt, '42501');
  end loop;
  perform pg_temp.su();
end $$;

-- 3. Bounds (E1): 22023 'bounds' ------------------------------------------------------------------------------------
do $$
declare
  stmt text;
  today constant date := pg_temp.paris_today();
begin
  perform pg_temp.act('00000000-0000-0000-0000-00000000a0a0');
  foreach stmt in array array[
    'select public.analytics_activity(''2026-09-30'', ''2026-09-01'')',                       -- reversed
    'select public.analytics_pipeline(''2025-01-05'', ''2026-01-06'')',                       -- 367 days
    format('select public.analytics_speed(%L, %L)', today - 3, today + 1),                    -- ends tomorrow (Paris)
    'select public.analytics_call_times(null, ''2026-09-30'')',
    'select public.analytics_sales(''2026-09-01'', null)',
    'select public.analytics_coverage(null, 14)',
    'select public.analytics_coverage(null, null)',
    'select public.analytics_batches(null, 0)',
    'select public.analytics_batches(null, 51)',
    'select public.analytics_batches(null, null)'] loop
    perform pg_temp.expect_error(stmt, '22023', 'bounds');
  end loop;
  -- Ending on Paris today is allowed; so is a 366-day range.
  perform public.analytics_activity(today - 6, today);
  perform public.analytics_activity(today - 365, today);
  perform pg_temp.su();
end $$;

-- 4. Who sees what (B1 to B5) ---------------------------------------------------------------------------------------
do $$
declare
  ada constant uuid := '00000000-0000-0000-0000-00000000a0a0';
  max_ constant uuid := '00000000-0000-0000-0000-00000000a0a1';
  rita constant uuid := '00000000-0000-0000-0000-00000000a0a2';
  remy constant uuid := '00000000-0000-0000-0000-00000000a0a3';
  tom constant uuid := '00000000-0000-0000-0000-00000000a0a4';
  stmt text;
  who uuid;
  j jsonb;
begin
  -- B2: a rep asking for a colleague's figures: 42501 'scope' on every function that takes p_user (batches refuses a
  -- rep before that: 42501 'forbidden'). For activity, speed, call times and coverage this is the PRODUCT RULE only:
  -- the same rep can read the colleague's entries straight from the table (activities are readable org-wide), which
  -- is asserted below so this test never claims more. For pipeline and sales it is also a security test (C2).
  perform pg_temp.act(rita);
  foreach stmt in array array[
    format('select public.analytics_activity(''2026-09-01'', ''2026-09-30'', %L)', remy),
    format('select public.analytics_pipeline(''2026-08-01'', ''2026-08-31'', %L)', remy),
    format('select public.analytics_speed(''2026-07-01'', ''2026-07-31'', %L)', remy),
    format('select public.analytics_call_times(''2026-09-01'', ''2026-09-30'', %L)', remy),
    format('select public.analytics_sales(''2026-06-01'', ''2026-06-30'', %L)', remy),
    format('select public.analytics_coverage(%L)', remy),
    format('select public.analytics_activity(''2026-09-01'', ''2026-09-30'', %L)', ada)] loop
    perform pg_temp.expect_error(stmt, '42501', 'scope');
  end loop;
  perform pg_temp.expect_error(format('select public.analytics_batches(%L)', remy), '42501', 'forbidden');
  perform pg_temp.expect_error('select public.analytics_batches()', '42501', 'forbidden');
  perform pg_temp.eq('B2 product rule: the rep reads the colleague''s calls directly (org-wide RLS)',
    (select count(*)::integer from public.activities a
      where a.user_id = remy and a.type = 'call' and a.created_at >= '2026-09-01 00:00+02' and a.created_at < '2026-10-01 00:00+02'), 2);
  -- B1 and B3: a rep gets their own figures with p_user null or = themselves (person scope, owner = the rep).
  j := public.analytics_activity('2026-09-01', '2026-09-30');
  perform pg_temp.eq('B1 scope', j ->> 'scope', 'person');
  perform pg_temp.eq('B1 owner', (j ->> 'owner_id')::uuid, rita);
  perform pg_temp.eq('B3 = B1', public.analytics_activity('2026-09-01', '2026-09-30', rita), j);
  perform pg_temp.eq('B1 no by_person', j ? 'by_person', false);
  -- B4: a manager gets the team with p_user null, and Rita's figures with p_user = Rita (equal to Rita's own call).
  perform pg_temp.act(max_);
  perform pg_temp.eq('B4 team scope', public.analytics_activity('2026-09-01', '2026-09-30') ->> 'scope', 'team');
  perform pg_temp.eq('B4 Rita as the manager sees her', public.analytics_activity('2026-09-01', '2026-09-30', rita), j);
  -- B5: a TopStock-org member or a random id: P0002 'rep', no figures, for a manager and for an admin.
  foreach who in array array[max_, ada] loop
    perform pg_temp.act(who);
    foreach stmt in array array[
      format('select public.analytics_activity(''2026-09-01'', ''2026-09-30'', %L)', tom),
      format('select public.analytics_pipeline(''2026-08-01'', ''2026-08-31'', %L)', gen_random_uuid()),
      format('select public.analytics_sales(''2026-06-01'', ''2026-06-30'', %L)', tom),
      format('select public.analytics_coverage(%L)', tom)] loop
      perform pg_temp.expect_error(stmt, 'P0002', 'rep');
    end loop;
  end loop;
  perform pg_temp.act(ada);
  perform pg_temp.expect_error(format('select public.analytics_batches(%L)', tom), 'P0002', 'rep');
  perform pg_temp.su();
end $$;

-- 5. Activity: exact figures (B1, B4, C1, G1) -------------------------------------------------------------------------
do $$
declare
  ada constant uuid := '00000000-0000-0000-0000-00000000a0a0';
  rita constant uuid := '00000000-0000-0000-0000-00000000a0a2';
  tom constant uuid := '00000000-0000-0000-0000-00000000a0a4';
  j jsonb;
  ts uuid := (select id from public.orgs where name = 'TopStock Wholesale');
begin
  perform pg_temp.act(ada);
  j := public.analytics_activity('2026-09-01', '2026-09-30');
  perform pg_temp.eq('team bucket size', j ->> 'bucket', 'day');
  perform pg_temp.eq('team 30 buckets', jsonb_array_length(j -> 'buckets'), 30);
  -- C1 and G1: the deleted author's call counts once; wrong_number, no_answer and voicemail are dials, not reached;
  -- the note, the two Paris-edge calls and Tom's TopStock call are out.
  perform pg_temp.eq('team totals', j -> 'totals',
    '{"calls":8,"reached":5,"emails":2,"whatsapp":1,"meetings":2,"meetings_held":1}'::jsonb);
  perform pg_temp.eq('team by person (former members last)', j -> 'by_person', jsonb_build_array(
    jsonb_build_object('user_id', ada, 'calls', 0, 'reached', 0, 'emails', 1, 'whatsapp', 0, 'meetings', 0),
    jsonb_build_object('user_id', '00000000-0000-0000-0000-00000000a0a1', 'calls', 1, 'reached', 1, 'emails', 0, 'whatsapp', 0, 'meetings', 0),
    jsonb_build_object('user_id', rita, 'calls', 4, 'reached', 2, 'emails', 1, 'whatsapp', 1, 'meetings', 1),
    jsonb_build_object('user_id', '00000000-0000-0000-0000-00000000a0a3', 'calls', 2, 'reached', 1, 'emails', 0, 'whatsapp', 0, 'meetings', 1),
    jsonb_build_object('user_id', null, 'calls', 1, 'reached', 1, 'emails', 0, 'whatsapp', 0, 'meetings', 0)));
  perform pg_temp.eq('team 2 Sep', j -> 'buckets' -> 1,
    '{"start":"2026-09-02","partial":false,"calls":3,"reached":1,"emails":0,"whatsapp":0,"meetings":0}'::jsonb);
  perform pg_temp.eq('team 3 Sep', j -> 'buckets' -> 2,
    '{"start":"2026-09-03","partial":false,"calls":1,"reached":0,"emails":1,"whatsapp":0,"meetings":0}'::jsonb);
  perform pg_temp.eq('team 1 Sep (the 31 Aug 23:30 Paris call is not here)', j -> 'buckets' -> 0,
    '{"start":"2026-09-01","partial":false,"calls":0,"reached":0,"emails":0,"whatsapp":0,"meetings":0}'::jsonb);
  perform pg_temp.eq('team 30 Sep (the 1 Oct 00:10 Paris call is not here)', (j -> 'buckets' -> 29 ->> 'calls')::integer, 0);
  perform pg_temp.eq('bucket sum = totals', (select sum((e ->> 'calls')::integer)::integer from jsonb_array_elements(j -> 'buckets') e), 8);
  -- Admin with p_user = Rita, and Rita herself: her rows only.
  j := public.analytics_activity('2026-09-01', '2026-09-30', rita);
  perform pg_temp.eq('Rita totals', j -> 'totals',
    '{"calls":4,"reached":2,"emails":1,"whatsapp":1,"meetings":1,"meetings_held":1}'::jsonb);
  perform pg_temp.act(rita);
  perform pg_temp.eq('Rita as herself', public.analytics_activity('2026-09-01', '2026-09-30') -> 'totals', j -> 'totals');
  -- C1, the other side: Tom (TopStock) sees his own call and nothing of Analytics Org.
  perform pg_temp.act(tom);
  perform pg_temp.eq('Tom totals', public.analytics_activity('2026-09-01', '2026-09-30') -> 'totals',
    '{"calls":1,"reached":1,"emails":0,"whatsapp":0,"meetings":0,"meetings_held":0}'::jsonb);
  -- C1, TopStock admin a (rls_attack.sql) when present: team totals equal a hand count of the TopStock org's rows.
  if exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-00000000000a' and role = 'admin') then
    perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
    j := public.analytics_activity('2026-09-01', '2026-09-30');
    perform pg_temp.su();
    perform pg_temp.eq('TopStock team calls = hand count', (j -> 'totals' ->> 'calls')::bigint,
      (select count(*) from public.activities where org_id = ts and type = 'call'
          and created_at >= '2026-09-01 00:00+02' and created_at < '2026-10-01 00:00+02'));
  end if;
  perform pg_temp.su();
end $$;

-- 6. Best time to call: exact cells (Paris weekday x hour) and the clock changes (F2) ------------------------------------
do $$
declare
  ada constant uuid := '00000000-0000-0000-0000-00000000a0a0';
  rita constant uuid := '00000000-0000-0000-0000-00000000a0a2';
  org constant uuid := '00000000-0000-0000-0000-00000000a0cc';
  la uuid := (select id from public.companies where org_id = org and created_at = '2026-01-02 10:00+01' limit 1);
  j jsonb;
begin
  perform pg_temp.act(ada);
  j := public.analytics_call_times('2026-09-01', '2026-09-30');
  perform pg_temp.eq('team cells', j,
    '{"min_calls":5,"cells":[{"dow":1,"hour":9,"calls":1,"reached":1},{"dow":2,"hour":10,"calls":1,"reached":1},
      {"dow":3,"hour":10,"calls":2,"reached":1},{"dow":3,"hour":11,"calls":1,"reached":0},{"dow":4,"hour":10,"calls":1,"reached":0},
      {"dow":4,"hour":15,"calls":1,"reached":1},{"dow":7,"hour":18,"calls":1,"reached":1}]}'::jsonb);
  perform pg_temp.act(rita);
  perform pg_temp.eq('Rita cells', public.analytics_call_times('2026-09-01', '2026-09-30') -> 'cells',
    '[{"dow":3,"hour":10,"calls":1,"reached":1},{"dow":3,"hour":11,"calls":1,"reached":0},{"dow":4,"hour":10,"calls":1,"reached":0},
      {"dow":4,"hour":15,"calls":1,"reached":1}]'::jsonb);
  perform pg_temp.su();
  -- F2: Sunday 26 Oct 2025 (clocks back at 01:00 UTC): 00:30 UTC is 02:30 summer time and 01:30 UTC is 02:30 winter
  -- time, both hour 2 Paris; the day also holds 00:30 Paris (22:30 UTC the day before) and 23:30 Paris (22:30 UTC), one
  -- bucket. Sunday 30 Mar 2025 (clocks forward at 01:00 UTC): 00:30 UTC is 01:30, 01:30 UTC is 03:30; no hour 2.
  set session_replication_role = replica;
  perform pg_temp.ent(org, rita, '2025-10-26 00:30+00', 'call', 'connected', la);
  perform pg_temp.ent(org, rita, '2025-10-26 01:30+00', 'call', 'no_answer', la);
  perform pg_temp.ent(org, rita, '2025-10-25 22:30+00', 'call', 'no_answer', la);
  perform pg_temp.ent(org, rita, '2025-10-26 22:30+00', 'call', 'no_answer', la);
  perform pg_temp.ent(org, rita, '2025-03-30 00:30+00', 'call', 'connected', la);
  perform pg_temp.ent(org, rita, '2025-03-30 01:30+00', 'call', 'no_answer', la);
  set session_replication_role = origin;
  perform pg_temp.act(rita);
  perform pg_temp.eq('25 Oct 2025 cells', public.analytics_call_times('2025-10-26', '2025-10-26') -> 'cells',
    '[{"dow":7,"hour":0,"calls":1,"reached":0},{"dow":7,"hour":2,"calls":2,"reached":1},{"dow":7,"hour":23,"calls":1,"reached":0}]'::jsonb);
  j := public.analytics_activity('2025-10-25', '2025-10-27');
  perform pg_temp.eq('25 h day: one bucket each', (select array_agg((e ->> 'calls')::integer order by e ->> 'start')
                                                     from jsonb_array_elements(j -> 'buckets') e), array[0, 4, 0]);
  perform pg_temp.eq('23 h day cells', public.analytics_call_times('2025-03-30', '2025-03-30') -> 'cells',
    '[{"dow":7,"hour":1,"calls":1,"reached":1},{"dow":7,"hour":3,"calls":1,"reached":0}]'::jsonb);
  perform pg_temp.eq('23 h day: one bucket', public.analytics_activity('2025-03-30', '2025-03-30') -> 'buckets',
    '[{"start":"2025-03-30","partial":false,"calls":2,"reached":1,"emails":0,"whatsapp":0,"meetings":0}]'::jsonb);
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su(); set session_replication_role = origin;
end $$;

-- 7. Paris day edges (F1): 31 Oct 2025 23:30 UTC is 1 Nov 00:30 in Paris -----------------------------------------------
do $$
declare
  rita constant uuid := '00000000-0000-0000-0000-00000000a0a2';
  org constant uuid := '00000000-0000-0000-0000-00000000a0cc';
  la uuid := (select id from public.companies where org_id = org and created_at = '2026-01-02 10:00+01' limit 1);
begin
  set session_replication_role = replica;
  perform pg_temp.ent(org, rita, '2025-10-31 23:30+00', 'call', 'connected', la);
  set session_replication_role = origin;
  perform pg_temp.act(rita);
  perform pg_temp.eq('to = 31 Oct excludes it', (public.analytics_activity('2025-10-31', '2025-10-31') -> 'totals' ->> 'calls')::integer, 0);
  perform pg_temp.eq('1 Nov holds it', public.analytics_activity('2025-11-01', '2025-11-01') -> 'buckets',
    '[{"start":"2025-11-01","partial":false,"calls":1,"reached":1,"emails":0,"whatsapp":0,"meetings":0}]'::jsonb);
  perform pg_temp.eq('its hour is 00 Paris (Saturday)', public.analytics_call_times('2025-11-01', '2025-11-01') -> 'cells',
    '[{"dow":6,"hour":0,"calls":1,"reached":1}]'::jsonb);
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su(); set session_replication_role = origin;
end $$;

-- 8. Pipeline: exact figures (G2, C2) --------------------------------------------------------------------------------
do $$
declare
  ada constant uuid := '00000000-0000-0000-0000-00000000a0a0';
  max_ constant uuid := '00000000-0000-0000-0000-00000000a0a1';
  rita constant uuid := '00000000-0000-0000-0000-00000000a0a2';
  remy constant uuid := '00000000-0000-0000-0000-00000000a0a3';
  j jsonb;
  r jsonb;
begin
  perform pg_temp.act(ada);
  j := public.analytics_pipeline('2026-08-01', '2026-08-31');
  -- Opened: 12 in August (Remy's July deal is not), 4960.00 (one without a value; the unassigned deal counts); the
  -- TopStock deal never.
  perform pg_temp.eq('opened', j -> 'opened', '{"count":12,"value":"4960.00","no_value":1}'::jsonb);
  -- Won by current status and close date: D1, D4, D9 (D7 was reopened, D8's win undone).
  perform pg_temp.eq('won', j -> 'won', '{"count":3,"value":"3500.00"}'::jsonb);
  -- Lost: D3 (price) and Remy's July deal lost in August (timing); D6 opened by mistake is apart.
  perform pg_temp.eq('lost', j -> 'lost', '{"count":2,"mistake":1}'::jsonb);
  perform pg_temp.eq('win rate (mistake left out; 5 closed)', j -> 'win_rate', '{"won":3,"lost":2,"rate":0.6000}'::jsonb);
  perform pg_temp.eq('cycle (17, 2, 14 days)', j -> 'cycle', '{"n":3,"median_days":14.0,"mean_days":11.0}'::jsonb);
  -- G2 funnel: D5's undone move does not reach Qualified; D2's jump counts Qualified; D4 won from Lead reaches all;
  -- D3 lost from Lead reached Lead only; D7 (won, reopened) reached all stages and Won; D8's undone win is not Won.
  perform pg_temp.eq('funnel', j -> 'funnel',
    '{"cohort":12,"lead":12,"qualified":5,"negotiations":5,"won":4,"still_open":7,"lost":1,"mistake":1}'::jsonb);
  -- Days in stage: rows whose next non-undone row falls in August (Remy's July deal: 45 days in Lead).
  perform pg_temp.eq('stage days', j -> 'stage_days',
    '[{"key":"lead","n":8,"median_days":2.0},{"key":"qualified","n":1,"median_days":5.0},{"key":"negotiations","n":1,"median_days":10.0}]'::jsonb);
  perform pg_temp.eq('lost reasons (mistake apart)', j -> 'lost_reasons',
    '[{"code":"price","count":1},{"code":"timing","count":1}]'::jsonb);
  -- Team view: per owner, sorted by id, the unassigned deal in the totals only.
  perform pg_temp.eq('by owner', j -> 'by_person', jsonb_build_array(
    jsonb_build_object('user_id', max_, 'opened', 1, 'won', 0, 'won_value', '0.00', 'lost', 0, 'rate', null),
    jsonb_build_object('user_id', rita, 'opened', 8, 'won', 2, 'won_value', '1500.00', 'lost', 1, 'rate', null),
    jsonb_build_object('user_id', remy, 'opened', 2, 'won', 1, 'won_value', '2000.00', 'lost', 1, 'rate', null)));
  -- C2: Rita's figures (as the admin with p_user, as the manager, and as herself) are her deals only; no by_person.
  r := public.analytics_pipeline('2026-08-01', '2026-08-31', rita);
  perform pg_temp.eq('Rita opened', r -> 'opened', '{"count":8,"value":"2610.00","no_value":0}'::jsonb);
  perform pg_temp.eq('Rita won', r -> 'won', '{"count":2,"value":"1500.00"}'::jsonb);
  perform pg_temp.eq('Rita lost', r -> 'lost', '{"count":1,"mistake":1}'::jsonb);
  perform pg_temp.eq('Rita win rate', r -> 'win_rate', '{"won":2,"lost":1,"rate":null}'::jsonb);
  perform pg_temp.eq('Rita cycle (under 3 won)', r -> 'cycle', '{"n":2,"median_days":null,"mean_days":null}'::jsonb);
  perform pg_temp.eq('Rita funnel', r -> 'funnel',
    '{"cohort":8,"lead":8,"qualified":4,"negotiations":4,"won":3,"still_open":4,"lost":1,"mistake":1}'::jsonb);
  perform pg_temp.eq('Rita stage days', r -> 'stage_days',
    '[{"key":"lead","n":6,"median_days":2.0},{"key":"qualified","n":1,"median_days":5.0},{"key":"negotiations","n":1,"median_days":10.0}]'::jsonb);
  perform pg_temp.eq('Rita lost reasons', r -> 'lost_reasons', '[{"code":"price","count":1}]'::jsonb);
  perform pg_temp.eq('Rita: no by_person', r ? 'by_person', false);
  perform pg_temp.act(max_);
  perform pg_temp.eq('Rita via the manager', public.analytics_pipeline('2026-08-01', '2026-08-31', rita), r);
  perform pg_temp.act(rita);
  perform pg_temp.eq('Rita herself', public.analytics_pipeline('2026-08-01', '2026-08-31'), r);
  -- C2 security: Remy (a rep) sees none of Rita's deals by any route: his figures have only his deals, and row level
  -- security hides Rita's deals from his own reads.
  perform pg_temp.act(remy);
  r := public.analytics_pipeline('2026-08-01', '2026-08-31');
  perform pg_temp.eq('Remy opened', r -> 'opened', '{"count":2,"value":"2000.00","no_value":1}'::jsonb);
  perform pg_temp.eq('Remy won', r -> 'won', '{"count":1,"value":"2000.00"}'::jsonb);
  perform pg_temp.eq('Remy reads none of Rita''s deals', (select count(*)::integer from public.deals where owner_id = rita), 0);
  perform pg_temp.su();
end $$;

-- 9. Speed-to-lead (G3): hand-added leads only, notes ignored, an entry before the lead ignored -------------------------
do $$
declare
  ada constant uuid := '00000000-0000-0000-0000-00000000a0a0';
  rita constant uuid := '00000000-0000-0000-0000-00000000a0a2';
begin
  perform pg_temp.act(ada);
  perform pg_temp.eq('team speed', public.analytics_speed('2026-07-01', '2026-07-31'),
    '{"leads":5,"touched":4,"median_minutes":1740,"within_1h":1,"within_24h":2,"buckets":[{"key":"lt1h","count":1},
      {"key":"lt24h","count":1},{"key":"lt3d","count":1},{"key":"gte3d","count":1},{"key":"none","count":1}]}'::jsonb);
  perform pg_temp.act(rita);
  perform pg_temp.eq('Rita speed (her L1 touched first by Remy counts)', public.analytics_speed('2026-07-01', '2026-07-31'),
    '{"leads":3,"touched":2,"median_minutes":315,"within_1h":1,"within_24h":2,"buckets":[{"key":"lt1h","count":1},
      {"key":"lt24h","count":1},{"key":"lt3d","count":0},{"key":"gte3d","count":0},{"key":"none","count":1}]}'::jsonb);
  -- No lead in the range: zeros and a null median.
  perform pg_temp.eq('empty speed', public.analytics_speed('2026-03-01', '2026-03-31'),
    '{"leads":0,"touched":0,"median_minutes":null,"within_1h":0,"within_24h":0,"buckets":[{"key":"lt1h","count":0},
      {"key":"lt24h","count":0},{"key":"lt3d","count":0},{"key":"gte3d","count":0},{"key":"none","count":0}]}'::jsonb);
  perform pg_temp.su();
end $$;

-- 10. Sales (G5, C2): cancelled out, revenue = sum of line totals, one row per product name, newest spelling ------------
do $$
declare
  ada constant uuid := '00000000-0000-0000-0000-00000000a0a0';
  rita constant uuid := '00000000-0000-0000-0000-00000000a0a2';
  remy constant uuid := '00000000-0000-0000-0000-00000000a0a3';
  j jsonb;
begin
  perform pg_temp.act(ada);
  j := public.analytics_sales('2026-06-01', '2026-06-30');
  perform pg_temp.eq('team sales totals', j -> 'totals',
    '{"revenue":"510.00","sales":3,"from_stock":"420.00","direct":"90.00"}'::jsonb);
  perform pg_temp.eq('team top products', j -> 'top_products',
    '[{"name":"denim jacket","revenue":"290.00","pieces":13},{"name":"Boots","revenue":"200.00","pieces":2},
      {"name":"Cap","revenue":"20.00","pieces":5}]'::jsonb);
  perform pg_temp.eq('team sales buckets', (select jsonb_agg(e order by e ->> 'start') from jsonb_array_elements(j -> 'buckets') e
                                             where (e ->> 'sales')::integer > 0),
    '[{"start":"2026-06-02","partial":false,"revenue":"220.00","sales":1},{"start":"2026-06-10","partial":false,"revenue":"90.00","sales":1},
      {"start":"2026-06-15","partial":false,"revenue":"200.00","sales":1}]'::jsonb);
  perform pg_temp.eq('team sales 30 buckets', jsonb_array_length(j -> 'buckets'), 30);
  perform pg_temp.eq('bucket revenue = total', (select sum((e ->> 'revenue')::numeric) from jsonb_array_elements(j -> 'buckets') e), 510.00);
  -- Rita (who recorded O1, O2 and the cancelled O4): as the admin's pick and as herself.
  j := public.analytics_sales('2026-06-01', '2026-06-30', rita);
  perform pg_temp.eq('Rita sales totals', j -> 'totals', '{"revenue":"310.00","sales":2,"from_stock":"220.00","direct":"90.00"}'::jsonb);
  perform pg_temp.eq('Rita top products', j -> 'top_products',
    '[{"name":"denim jacket","revenue":"290.00","pieces":13},{"name":"Cap","revenue":"20.00","pieces":5}]'::jsonb);
  perform pg_temp.act(rita);
  perform pg_temp.eq('Rita herself', public.analytics_sales('2026-06-01', '2026-06-30'), j);
  -- C2: Remy gets his own sale only.
  perform pg_temp.act(remy);
  perform pg_temp.eq('Remy sales totals', public.analytics_sales('2026-06-01', '2026-06-30') -> 'totals',
    '{"revenue":"200.00","sales":1,"from_stock":"200.00","direct":"0.00"}'::jsonb);
  perform pg_temp.su();
end $$;

-- 11. Coverage (G4): untouched equals count_leads exactly; overdue by the Paris day ----------------------------------------
do $$
declare
  ada constant uuid := '00000000-0000-0000-0000-00000000a0a0';
  max_ constant uuid := '00000000-0000-0000-0000-00000000a0a1';
  rita constant uuid := '00000000-0000-0000-0000-00000000a0a2';
  remy constant uuid := '00000000-0000-0000-0000-00000000a0a3';
  org constant uuid := '00000000-0000-0000-0000-00000000a0cc';
  today constant date := pg_temp.paris_today();
  c3 uuid; c6 uuid;
  j jsonb;
  d integer;
begin
  set session_replication_role = replica;
  perform pg_temp.lead(org, rita, now() - interval '400 days', 'cold');                                        -- never
  perform pg_temp.lead(org, rita, now() - interval '400 days', 'warm', null, now() - interval '40 days');      -- no step
  c3 := pg_temp.lead(org, rita, now() - interval '400 days', 'negotiation', null, now() - interval '5 days');  -- open task
  perform pg_temp.lead(org, rita, now() - interval '400 days', 'warm', null, now() - interval '1 day', now() + interval '1 day');
  perform pg_temp.lead(org, rita, now() - interval '400 days', 'customer');                                    -- left out
  c6 := pg_temp.lead(org, rita, now() - interval '400 days', 'negotiation', null, now() - interval '31 days'); -- done task
  perform pg_temp.lead(org, remy, now() - interval '400 days', 'cold');
  perform pg_temp.task(org, rita, c3, today + 1);
  perform pg_temp.task(org, rita, c6, today - 3, null, true);
  perform pg_temp.task(org, rita, null, today - 1);                         -- overdue (all-day, Paris yesterday)
  perform pg_temp.task(org, rita, null, today);                             -- due today: not overdue
  perform pg_temp.task(org, rita, null, null, now() - interval '1 hour');   -- overdue (timed)
  perform pg_temp.task(org, rita, null, null, now() + interval '1 hour');
  perform pg_temp.task(org, rita, null, today - 1, null, false, true);      -- dismissed
  perform pg_temp.task(org, remy, null, today - 2);                         -- Remy's overdue
  set session_replication_role = origin;
  perform pg_temp.act(rita);
  j := public.analytics_coverage();
  perform pg_temp.eq('Rita coverage', j - 'as_of',
    '{"idle_days":30,"untouched":3,"never_contacted":1,"no_next_step":2,"overdue_tasks":2}'::jsonb);
  foreach d in array array[7, 30, 90] loop
    perform pg_temp.eq('untouched = count_leads, ' || d || ' days', (public.analytics_coverage(null, d) ->> 'untouched')::bigint,
      public.count_leads(p_statuses => '{cold,warm,negotiation}', p_owners => array[rita], p_inactive_days => d)::bigint);
  end loop;
  perform pg_temp.eq('Rita untouched 90', (public.analytics_coverage(rita, 90) ->> 'untouched')::integer, 1);
  perform pg_temp.act(max_);
  j := public.analytics_coverage();
  perform pg_temp.eq('team coverage', j - 'as_of',
    '{"idle_days":30,"untouched":4,"never_contacted":2,"no_next_step":2,"overdue_tasks":3}'::jsonb);
  perform pg_temp.eq('team untouched = count_leads', (j ->> 'untouched')::bigint,
    public.count_leads(p_statuses => '{cold,warm,negotiation}', p_inactive_days => 30)::bigint);
  perform pg_temp.eq('manager picks Rita', public.analytics_coverage(rita) - 'as_of',
    '{"idle_days":30,"untouched":3,"never_contacted":1,"no_next_step":2,"overdue_tasks":2}'::jsonb);
  perform pg_temp.act(ada);
  perform pg_temp.eq('admin picks Remy', public.analytics_coverage(remy, 7) - 'as_of',
    '{"idle_days":7,"untouched":1,"never_contacted":1,"no_next_step":0,"overdue_tasks":1}'::jsonb);
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su(); set session_replication_role = origin;
end $$;

-- 12. List quality (D1, D2): admins only; rolled-back and stock batches absent; the file name byte for byte -------------
do $$
declare
  ada constant uuid := '00000000-0000-0000-0000-00000000a0a0';
  max_ constant uuid := '00000000-0000-0000-0000-00000000a0a1';
  rita constant uuid := '00000000-0000-0000-0000-00000000a0a2';
  remy constant uuid := '00000000-0000-0000-0000-00000000a0a3';
  org constant uuid := '00000000-0000-0000-0000-00000000a0cc';
  j jsonb;
  b3l uuid;
begin
  perform pg_temp.act(max_);
  perform pg_temp.expect_error('select public.analytics_batches()', '42501', 'forbidden');
  perform pg_temp.act(rita);
  perform pg_temp.expect_error('select public.analytics_batches()', '42501', 'forbidden');
  perform pg_temp.act(ada);
  j := public.analytics_batches();
  perform pg_temp.eq('batches (newest first, B2 rolled back and B4 stock absent)',
    (select jsonb_agg(e - 'created_at' order by n) from jsonb_array_elements(j) with ordinality x (e, n)),
    '[{"id":"00000000-0000-0000-0000-00000000a0b3","filename":"second.csv","leads":0,"contacted":0,"reached":0,"with_deal":0,"won":0},
      {"id":"00000000-0000-0000-0000-00000000a0b1","filename":"<img src=x onerror=alert(1)> liste été.csv","leads":4,"contacted":2,"reached":1,"with_deal":2,"won":1}]'::jsonb);
  perform pg_temp.eq('file name byte for byte', convert_to(j -> 1 ->> 'filename', 'UTF8'),
    convert_to('<img src=x onerror=alert(1)> liste été.csv', 'UTF8'));
  perform pg_temp.eq('created_at', (j -> 1 ->> 'created_at')::timestamptz, timestamptz '2026-05-01 10:00+02');
  perform pg_temp.eq('limit', jsonb_array_length(public.analytics_batches(null, 1)), 1);
  perform pg_temp.eq('Rita''s leads of B1', (public.analytics_batches(rita) -> 1) - 'created_at',
    '{"id":"00000000-0000-0000-0000-00000000a0b1","filename":"<img src=x onerror=alert(1)> liste été.csv","leads":2,"contacted":2,"reached":1,"with_deal":2,"won":1}'::jsonb);
  perform pg_temp.eq('Remy''s leads of B1 (history from before the import counts in nothing)',
    (public.analytics_batches(remy) -> 1) - 'created_at' - 'filename',
    '{"id":"00000000-0000-0000-0000-00000000a0b1","leads":2,"contacted":0,"reached":0,"with_deal":0,"won":0}'::jsonb);
  perform pg_temp.su();
  -- D2, the other side: the same three facts dated after the import count in each column.
  b3l := (select c.id from public.companies c join public.activities a on a.company_id = c.id
           where c.import_batch_id = '00000000-0000-0000-0000-00000000a0b1' and a.created_at = '2026-04-01 10:00+02');
  set session_replication_role = replica;
  perform pg_temp.ent(org, remy, '2026-05-05 10:00+02', 'call', 'interested', b3l);
  perform pg_temp.deal(org, remy, b3l, 'won', 100, '2026-05-05 11:00+02', '2026-05-06 10:00+02');
  set session_replication_role = origin;
  perform pg_temp.act(ada);
  perform pg_temp.eq('D2 after the import', (public.analytics_batches(remy) -> 1) - 'created_at' - 'filename',
    '{"id":"00000000-0000-0000-0000-00000000a0b1","leads":2,"contacted":1,"reached":1,"with_deal":1,"won":1}'::jsonb);
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su(); set session_replication_role = origin;
end $$;

-- 13. The role is read on every call (B6): Max demoted to rep through set_user_role loses the team at once ------------
do $$
declare
  ada constant uuid := '00000000-0000-0000-0000-00000000a0a0';
  max_ constant uuid := '00000000-0000-0000-0000-00000000a0a1';
begin
  perform pg_temp.act(max_);
  perform pg_temp.eq('Max sees the team', public.analytics_activity('2026-09-01', '2026-09-30') ->> 'scope', 'team');
  perform pg_temp.act(ada);  -- a two-factor code 30 s old: fresh enough for a role change
  perform public.set_user_role(max_, 'rep');
  perform pg_temp.act(max_);
  perform pg_temp.eq('Max now gets his own figures', public.analytics_activity('2026-09-01', '2026-09-30') ->> 'scope', 'person');
  perform pg_temp.expect_error(format('select public.analytics_pipeline(''2026-08-01'', ''2026-08-31'', %L)',
                                      '00000000-0000-0000-0000-00000000a0a2'), '42501', 'scope');
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 14. No text leaks (H1): no entry text, lost note, cancel reason, sale note or cost in any payload ---------------------
do $$
declare
  who uuid;
  p text;
begin
  foreach who in array array['00000000-0000-0000-0000-00000000a0a0', '00000000-0000-0000-0000-00000000a0a1']::uuid[] loop
    perform pg_temp.act(who);
    p := pg_temp.all_payloads(null) || pg_temp.all_payloads('00000000-0000-0000-0000-00000000a0a2');
    if p ~ 'SENTINEL' or p ~ '98765' then raise exception 'FAIL: H1 a payload carries a text or cost: %', left(p, 300); end if;
  end loop;
  perform pg_temp.act('00000000-0000-0000-0000-00000000a0a0');
  if public.analytics_batches()::text ~ 'SENTINEL' then raise exception 'FAIL: H1 list quality carries a text'; end if;
  perform pg_temp.act('00000000-0000-0000-0000-00000000a0a2');
  p := pg_temp.all_payloads(null);
  if p ~ 'SENTINEL' or p ~ '98765' then raise exception 'FAIL: H1 a rep payload carries a text or cost'; end if;
  perform pg_temp.su();
end $$;

\echo 'analytics_attack.sql: all Analytics P1 checks passed'
