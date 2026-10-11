-- Spike S5 (Day 4 design 2.4): run with bash docs/evidence/day4a/spike-s5/run.sh (throwaway PG16, the Day 3 migrations only).
\set ON_ERROR_STOP 1
\set QUIET 1
-- Fixtures: admin a, rep a1, rep b1 in the main org; lead A1 owned by a1, lead B1 owned by b1, one contact each,
-- one activity per contact (author = lead owner), a deal on each lead.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@test.invalid'),
  ('00000000-0000-0000-0000-0000000000a1', 'repa@test.invalid'),
  ('00000000-0000-0000-0000-0000000000b1', 'repb@test.invalid');
do $$
declare org uuid := (select id from public.orgs limit 1);
        stage uuid := (select id from public.pipeline_stages order by position limit 1);
begin
  insert into public.companies (id, org_id, name, owner_id) values
    ('30000000-0000-0000-0000-0000000000a1', org, 'Co a1', '00000000-0000-0000-0000-0000000000a1'),
    ('30000000-0000-0000-0000-0000000000b1', org, 'Co b1', '00000000-0000-0000-0000-0000000000b1');
  insert into public.contacts (id, org_id, company_id, first_name) values
    ('10000000-0000-0000-0000-0000000000a1', org, '30000000-0000-0000-0000-0000000000a1', 'Ann'),
    ('10000000-0000-0000-0000-0000000000b1', org, '30000000-0000-0000-0000-0000000000b1', 'Bob');
  insert into public.deals (id, org_id, company_id, stage_id, owner_id) values
    ('40000000-0000-0000-0000-0000000000a1', org, '30000000-0000-0000-0000-0000000000a1', stage, '00000000-0000-0000-0000-0000000000a1');
end $$;
-- The spike changes the activities contact and deal FKs to ON DELETE SET NULL, as 4a will.
alter table public.activities
  drop constraint activities_contact_id_fkey,
  add constraint activities_contact_id_fkey foreign key (contact_id) references public.contacts (id) on delete set null,
  drop constraint activities_deal_id_fkey,
  add constraint activities_deal_id_fkey foreign key (deal_id) references public.deals (id) on delete set null;
insert into public.activities (id, org_id, company_id, contact_id, deal_id, type, user_id)
select '50000000-0000-0000-0000-0000000000a1', o.id, '30000000-0000-0000-0000-0000000000a1',
       '10000000-0000-0000-0000-0000000000a1', '40000000-0000-0000-0000-0000000000a1', 'note', '00000000-0000-0000-0000-0000000000a1'
  from public.orgs o limit 1;

create table public.spike_log (n serial, tg_op text, depth int, uid uuid, claims_set boolean, cur_user text, sess_user text,
  changed text[]);
grant insert on public.spike_log to authenticated;
grant usage on sequence public.spike_log_n_seq to authenticated;
-- An INVOKER BEFORE UPDATE row trigger on the child, like activity_guard will be.
create function private.spike_probe() returns trigger language plpgsql set search_path = '' as $$
begin
  insert into public.spike_log (tg_op, depth, uid, claims_set, cur_user, sess_user, changed)
  values (tg_op, pg_trigger_depth(), (select auth.uid()), current_setting('request.jwt.claims', true) <> '',
          current_user, session_user,
          array(select n.key from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
                 where n.value is distinct from o.value order by 1));
  return new;
end $$;
create trigger aa_spike_probe before update on public.activities for each row execute function private.spike_probe();

create function pg_temp.as_user(sub text, aal text, totp_age_s integer default null) returns void
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', sub, 'role', 'authenticated', 'aal', aal,
    'amr', case when totp_age_s is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - totp_age_s)) end
  )::text, false)
$$;

\echo '--- (a) ON DELETE SET NULL from a contact delete and a deal delete, as the admin with a fresh code'
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
delete from public.contacts where id = '10000000-0000-0000-0000-0000000000a1';
delete from public.deals where id = '40000000-0000-0000-0000-0000000000a1';
\echo '--- (a2) a direct update at top level, for comparison'
update public.activities set body = 'x' where id = '50000000-0000-0000-0000-0000000000a1';
reset role;
select n, tg_op, depth, uid, claims_set, cur_user, sess_user, changed from public.spike_log order by n;
select id, contact_id, deal_id from public.activities;

\echo '--- (b) SELECT ... FOR UPDATE on a lead the caller may read but not update (rep a1 on lead b1)'
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2') \g /dev/null
select 'plain select rows: ' || count(*) from public.companies where id = '30000000-0000-0000-0000-0000000000b1';
select 'for update rows: ' || count(*) from (select id from public.companies where id = '30000000-0000-0000-0000-0000000000b1' for update) x;
select 'for update own lead rows: ' || count(*) from (select id from public.companies where id = '30000000-0000-0000-0000-0000000000a1' for update) x;
do $$
declare v uuid;
begin
  select id into v from public.companies where id = '30000000-0000-0000-0000-0000000000b1' for update;
  raise notice 'plpgsql select into ... for update on b1: found=%, v=%', found, v;
end $$;
reset role;

\echo '--- (c) INSERT ... ON CONFLICT (pk) DO NOTHING RETURNING under RLS'
-- A claims-like table: select org-wide; insert only for leads the caller may change (design 3.3), plus a narrower
-- variant where select is own rows only, to see whether the conflicting row's select policy is consulted.
create table public.spike_claims (company_id uuid primary key, org_id uuid not null, user_id uuid not null);
alter table public.spike_claims enable row level security;
create policy s_select on public.spike_claims for select to authenticated using (org_id = (select private.current_org_id()));
create policy s_insert on public.spike_claims for insert to authenticated with check (
  org_id = (select private.current_org_id()) and user_id = (select auth.uid())
  and exists (select 1 from public.companies c where c.id = spike_claims.company_id
              and ((select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()))));
create policy s_update on public.spike_claims for update to authenticated using (false) with check (false);
grant select, insert, update on public.spike_claims to authenticated;
create table public.spike_claims_own (company_id uuid primary key, org_id uuid not null, user_id uuid not null);
alter table public.spike_claims_own enable row level security;
create policy s_select on public.spike_claims_own for select to authenticated using (user_id = (select auth.uid()));
create policy s_insert on public.spike_claims_own for insert to authenticated with check (user_id = (select auth.uid()));
grant select, insert on public.spike_claims_own to authenticated;
-- The admin holds a claim on lead a1 in both tables.
insert into public.spike_claims select '30000000-0000-0000-0000-0000000000a1', id, '00000000-0000-0000-0000-00000000000a' from public.orgs limit 1;
insert into public.spike_claims_own select '30000000-0000-0000-0000-0000000000a1', id, '00000000-0000-0000-0000-00000000000a' from public.orgs limit 1;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2') \g /dev/null
\echo 'c1: rep a1 claims own lead a1, already claimed by the admin (select policy lets a1 see the row)'
insert into public.spike_claims select '30000000-0000-0000-0000-0000000000a1', (select private.current_org_id()), '00000000-0000-0000-0000-0000000000a1'
  on conflict (company_id) do nothing returning company_id;
\echo 'c2: same, where the conflicting row is invisible to a1 (select own rows only)'
insert into public.spike_claims_own select '30000000-0000-0000-0000-0000000000a1', (select private.current_org_id()), '00000000-0000-0000-0000-0000000000a1'
  on conflict (company_id) do nothing returning company_id;
\echo 'c3: no conflict, insert policy passes (new lead a2, owned by rep a1)'
reset role;
insert into public.companies (id, org_id, name, owner_id) select '30000000-0000-0000-0000-0000000000a2', id, 'Co a2', '00000000-0000-0000-0000-0000000000a1' from public.orgs limit 1;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2') \g /dev/null
insert into public.spike_claims select '30000000-0000-0000-0000-0000000000a2', (select private.current_org_id()), '00000000-0000-0000-0000-0000000000a1'
  on conflict (company_id) do nothing returning company_id;
\echo 'c4: no conflict, insert policy fails (rep a1 claims lead b1, owned by b1): error expected'
do $$ begin
  insert into public.spike_claims select '30000000-0000-0000-0000-0000000000b1', (select private.current_org_id()), '00000000-0000-0000-0000-0000000000a1'
    on conflict (company_id) do nothing;
  raise notice 'c4: insert succeeded';
exception when others then raise notice 'c4: % %', sqlstate, sqlerrm;
end $$;
\echo 'c5: conflict AND insert policy would fail (rep a1 on lead a1 claimed by admin, but the new row names another user)'
do $$
declare r uuid;
begin
  insert into public.spike_claims select '30000000-0000-0000-0000-0000000000a1', (select private.current_org_id()), '00000000-0000-0000-0000-0000000000b1'
    on conflict (company_id) do nothing returning company_id into r;
  raise notice 'c5: no error, returned %', r;
exception when others then raise notice 'c5: % %', sqlstate, sqlerrm;
end $$;
\echo 'c6: the update policy (using false) is not consulted: c1 above returned no row and no error'
reset role;
select * from public.spike_claims order by company_id;
