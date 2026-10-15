-- Day 6a spikes S2 and S3 (design docs/evidence/day6/design.md section 2.4) on throwaway tables in schema "spike".
-- Each line printed "S2 (x) ..." or "S3 ..." is one finding; the script stops at the first unexpected result.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'spike-admin@test.invalid'),   -- first user of the org: admin
  ('00000000-0000-0000-0000-0000000000f2', 'spike-rep@test.invalid');     -- then a rep

create schema spike;
grant usage on schema spike to authenticated;
create table spike.products (id integer primary key, archived boolean not null default false);
create table spike.levels (product_id integer primary key references spike.products (id), on_hand integer not null);
create table spike.ledger (id bigint generated always as identity primary key, product_id integer not null,
                           kind text not null, qty integer);
create table spike.uses (movement_id bigint not null references spike.ledger (id) deferrable initially deferred,
                         pieces integer not null);
create table spike.log (n serial primary key, what text, id_in_trigger bigint, cur_user text, uid uuid,
                        supabase_uid uuid, seen_on_hand integer);
alter table spike.products enable row level security;
alter table spike.levels enable row level security;
alter table spike.ledger enable row level security;
alter table spike.uses enable row level security;
create policy products_select on spike.products for select to authenticated using (true);
create policy levels_select on spike.levels for select to authenticated using (true);
create policy ledger_select on spike.ledger for select to authenticated using (true);
create policy ledger_insert on spike.ledger for insert to authenticated with check (true);
revoke all on spike.products, spike.levels, spike.ledger, spike.uses, spike.log from public, anon, authenticated;
grant select on spike.products, spike.levels to authenticated;            -- no UPDATE grant, no UPDATE policy
grant select, insert (product_id, kind, qty) on spike.ledger to authenticated;
grant select on spike.log, spike.uses to authenticated;   -- so the checks below can read them (spike only)
revoke all on sequence spike.ledger_id_seq from public, anon, authenticated;  -- D14: no sequence grant
insert into spike.products values (1, false);
insert into spike.levels values (1, 1000);

-- Supabase's auth.uid() reads request.jwt.claim.sub first, then request.jwt.claims (the shim reads only the latter).
create function spike.supabase_uid() returns uuid language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function spike.note(p_what text, p_id bigint, p_user text, p_seen integer) returns void
language sql security definer set search_path = '' as $$
  insert into spike.log (what, id_in_trigger, cur_user, uid, supabase_uid, seen_on_hand)
  values (p_what, p_id, p_user, auth.uid(), spike.supabase_uid(), p_seen)
$$;
grant execute on function spike.note(text, bigint, text, integer), spike.supabase_uid() to authenticated;

-- The guard: invoker, BEFORE INSERT, name sorts first.
create function spike.a_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  perform spike.note('guard', new.id, current_user::text, null);
  if new.kind = 'count' then
    new.kind := 'adjust';            -- (b) a BEFORE trigger may change the kind
  elsif new.kind = 'noop' then
    return null;                     -- (b) skip the row
  end if;
  return new;
end $$;
-- The apply step: definer, owner postgres, BEFORE INSERT, name sorts second.
create function spike.b_apply() returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v integer;
begin
  perform 1 from spike.products where id = new.product_id for share;                       -- (c)
  select on_hand into v from spike.levels where product_id = new.product_id for update;   -- (c), (f)
  insert into spike.uses (movement_id, pieces) values (new.id, coalesce(new.qty, 0));     -- (e) row not there yet
  update spike.levels set on_hand = on_hand - coalesce(new.qty, 0) where product_id = new.product_id;
  perform spike.note('apply', new.id, current_user::text, v);
  return new;
end $$;
revoke all on function spike.a_guard(), spike.b_apply() from public, anon, authenticated;
create trigger a_guard before insert on spike.ledger for each row execute function spike.a_guard();
create trigger b_apply before insert on spike.ledger for each row execute function spike.b_apply();
-- (d) a definer helper (like expire_due_holds) inserting into the ledger.
create function spike.helper_insert() returns bigint language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  insert into spike.ledger (product_id, kind, qty) values (1, 'expire', 0) returning id into v;
  return v;
end $$;
revoke all on function spike.helper_insert() from public, anon;
grant execute on function spike.helper_insert() to authenticated;

-- S3: the system-task helper's claim clearing (design 3.4, insert_system_task).
create function spike.system_insert(p_assignee uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  r jsonb;
  v_task uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  r := jsonb_build_object('cleared_uid', auth.uid(), 'cleared_supabase_uid', spike.supabase_uid());
  insert into public.tasks (org_id, assignee_id, title)
  select org_id, p_assignee, 'Spike system task' from public.profiles where id = p_assignee
  returning id into v_task;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  return r || jsonb_build_object('restored_uid', auth.uid(), 'restored_supabase_uid', spike.supabase_uid(),
                                 'task', v_task,
                                 'task_created_by', (select created_by from public.tasks where id = v_task));
end $$;
create function spike.system_insert_then_fail() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  raise exception 'spike failure' using errcode = 'TS002';
end $$;
revoke all on function spike.system_insert(uuid), spike.system_insert_then_fail() from public, anon;
grant execute on function spike.system_insert(uuid), spike.system_insert_then_fail() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated"}', false) \g /dev/null
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f2', false) \g /dev/null

-- (a) and D14
do $$
declare v bigint; g bigint;
begin
  insert into spike.ledger (product_id, kind, qty) values (1, 'take', 1) returning id into v;
  select id_in_trigger into g from spike.log where what = 'guard' order by n desc limit 1;
  if g is distinct from v then raise exception 'S2 (a) FAILED: id in the BEFORE trigger % vs stored %', g, v; end if;
  raise notice 'S2 (a) holds: the identity id (%) is set before BEFORE ROW triggers run; authenticated inserted with no grant on the identity sequence (D14)', v;
end $$;

-- (b)
do $$
declare k text; v bigint; before_n bigint; after_n bigint;
begin
  insert into spike.ledger (product_id, kind, qty) values (1, 'count', 1) returning kind into k;
  if k is distinct from 'adjust' then raise exception 'S2 (b) FAILED: kind %', k; end if;
  select count(*) into before_n from spike.ledger;
  insert into spike.ledger (product_id, kind, qty) values (1, 'noop', 1) returning id into v;
  select count(*) into after_n from spike.ledger;
  if v is not null or after_n <> before_n then raise exception 'S2 (b) FAILED: RETURN NULL stored a row'; end if;
  if exists (select 1 from spike.log where what = 'apply' and id_in_trigger is not distinct from
             (select id_in_trigger from spike.log where what = 'guard' order by n desc limit 1)) then
    raise exception 'S2 (b) FAILED: the apply trigger ran after the guard returned NULL';
  end if;
  raise notice 'S2 (b) holds: a BEFORE trigger changed kind count -> adjust; RETURN NULL skipped the row (INSERT ... RETURNING gave no row, the next trigger did not run)';
end $$;

-- (c)
do $$
declare u text; oh integer;
begin
  if has_table_privilege('authenticated', 'spike.levels', 'UPDATE') then raise exception 'S2 (c) setup'; end if;
  select cur_user into u from spike.log where what = 'apply' order by n desc limit 1;
  select on_hand into oh from spike.levels where product_id = 1;
  if u is distinct from 'postgres' or oh <> 998 then raise exception 'S2 (c) FAILED: % %', u, oh; end if;
  raise notice 'S2 (c) holds: as authenticated (no UPDATE grant or policy on the level), the postgres-owned definer trigger took FOR SHARE on the product and FOR UPDATE on the level and changed it (on_hand 1000 -> %)', oh;
end $$;

-- (d)
do $$
declare v bigint; u text; who uuid; sb uuid;
begin
  v := spike.helper_insert();
  select cur_user, uid, supabase_uid into u, who, sb from spike.log where what = 'guard' and id_in_trigger = v;
  if u is distinct from 'postgres' or who is distinct from '00000000-0000-0000-0000-0000000000f2'
     or sb is distinct from '00000000-0000-0000-0000-0000000000f2' then
    raise exception 'S2 (d) FAILED: % % %', u, who, sb;
  end if;
  raise notice 'S2 (d) holds: a definer helper''s insert fires the guard with current_user = % and the caller''s claims still set (auth.uid() = %)', u, who;
end $$;
reset role;

-- (e)
do $$
declare bad boolean := false;
begin
  if (select count(*) from spike.uses u join spike.ledger l on l.id = u.movement_id) <> (select count(*) from spike.uses) then
    raise exception 'S2 (e) FAILED: a uses row lost its ledger row';
  end if;
  begin
    insert into spike.uses (movement_id, pieces) values (999999, 1);
    set constraints all immediate;
  exception when foreign_key_violation then
    bad := true;
  end;
  if not bad then raise exception 'S2 (e) FAILED: the deferred foreign key accepted a missing ledger row'; end if;
  raise notice 'S2 (e) holds: % uses rows were written by the BEFORE trigger before their ledger row existed and passed the deferred foreign key at commit; a missing ledger row is refused when the check runs',
    (select count(*) from spike.uses);
end $$;

-- S3
set role authenticated;
do $$
declare r jsonb; got text;
begin
  -- As rep f2, a task assigned to admin f1 is refused in the user's session ...
  begin
    insert into public.tasks (assignee_id, title) values ('00000000-0000-0000-0000-0000000000f1', 'not mine');
    raise exception 'S3 FAILED: a rep created a task for someone else';
  exception when insufficient_privilege then null;
  end;
  -- ... and allowed as a system row once the claims are cleared for that one insert.
  r := spike.system_insert('00000000-0000-0000-0000-0000000000f1');
  if r ->> 'cleared_uid' is not null or r ->> 'cleared_supabase_uid' is not null
     or r ->> 'restored_uid' is distinct from '00000000-0000-0000-0000-0000000000f2'
     or r ->> 'restored_supabase_uid' is distinct from '00000000-0000-0000-0000-0000000000f2'
     or r ->> 'task' is null or r ->> 'task_created_by' is not null then
    raise exception 'S3 FAILED: %', r;
  end if;
  raise notice 'S3 holds (1): clearing request.jwt.claims and request.jwt.claim.sub makes auth.uid() null on the shim and with Supabase''s definition; the rep''s task for the admin went in as a system row (created_by null); restoring both brought the caller back: %', r;
  -- An error after clearing: the block that catches it rolls the settings back.
  begin
    perform spike.system_insert_then_fail();
  exception when sqlstate 'TS002' then null;
  end;
  got := current_setting('request.jwt.claims', true);
  if got is distinct from '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated"}'
     or current_setting('request.jwt.claim.sub', true) is distinct from '00000000-0000-0000-0000-0000000000f2'
     or auth.uid() is distinct from '00000000-0000-0000-0000-0000000000f2' then
    raise exception 'S3 FAILED: settings after the error: % / %', got, current_setting('request.jwt.claim.sub', true);
  end if;
  raise notice 'S3 holds (2): an error raised after the claims were cleared rolled the settings back with the block that caught it (auth.uid() = % again)', auth.uid();
end $$;
reset role;
