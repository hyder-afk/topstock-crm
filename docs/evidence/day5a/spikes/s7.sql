\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
-- fixtures (superuser): admin a, reps b1 and d1; lead owned by b1; deal owned by b1
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a','a@t.invalid'),
 ('00000000-0000-0000-0000-0000000000b1','b@t.invalid'), ('00000000-0000-0000-0000-0000000000d1','d@t.invalid');
insert into public.companies (id, org_id, name, owner_id) select '30000000-0000-0000-0000-0000000000b1', id, 'Lead b1', '00000000-0000-0000-0000-0000000000b1' from public.orgs;
insert into public.deals (id, org_id, company_id, stage_id, owner_id)
select '40000000-0000-0000-0000-0000000000b1', o.id, '30000000-0000-0000-0000-0000000000b1', s.id, '00000000-0000-0000-0000-0000000000b1'
  from public.orgs o join public.pipeline_stages s on s.org_id = o.id and s.position = 1;
-- 5a shape: column grants only on deals (as the migration will do)
revoke insert, update on public.deals from authenticated;
grant update (value, stage_id, lost_reason) on public.deals to authenticated;
create function pg_temp.who(sub text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', sub, 'role','authenticated','aal','aal2')::text, false) $$;
set role authenticated;
-- (a) companies: everyone in the org selects, only editors update (column grants on companies since Day 3a)
select pg_temp.who('00000000-0000-0000-0000-0000000000d1');
select 'S7a viewer d1 sees lead: ' || count(*) from public.companies where id = '30000000-0000-0000-0000-0000000000b1';
select 'S7a viewer d1 FOR NO KEY UPDATE on lead: ' || count(*) || ' rows' from (select 1 from public.companies where id = '30000000-0000-0000-0000-0000000000b1' for no key update) x;
select 'S7a viewer d1 FOR UPDATE on lead: ' || count(*) || ' rows' from (select 1 from public.companies where id = '30000000-0000-0000-0000-0000000000b1' for update) x;
select pg_temp.who('00000000-0000-0000-0000-0000000000b1');
select 'S7a editor b1 FOR NO KEY UPDATE on lead: ' || count(*) || ' rows' from (select 1 from public.companies where id = '30000000-0000-0000-0000-0000000000b1' for no key update) x;
-- (b) deals with column grants only: owner, admin, other rep
select 'S7b owner b1 FOR NO KEY UPDATE on deal: ' || count(*) || ' rows' from (select 1 from public.deals where id = '40000000-0000-0000-0000-0000000000b1' for no key update) x;
select pg_temp.who('00000000-0000-0000-0000-00000000000a');
select 'S7b admin FOR NO KEY UPDATE on deal: ' || count(*) || ' rows' from (select 1 from public.deals where id = '40000000-0000-0000-0000-0000000000b1' for no key update) x;
select pg_temp.who('00000000-0000-0000-0000-0000000000d1');
select 'S7b other rep d1 FOR NO KEY UPDATE on deal: ' || count(*) || ' rows' from (select 1 from public.deals where id = '40000000-0000-0000-0000-0000000000b1' for no key update) x;
reset role;
-- (c) a select-only policy wider than the update policy on deals (as if visibility changed later, open question 5)
create policy spike_select_all on public.deals for select to authenticated using (true);
set role authenticated;
select pg_temp.who('00000000-0000-0000-0000-0000000000d1');
select 'S7c d1 now sees deal: ' || count(*) from public.deals where id = '40000000-0000-0000-0000-0000000000b1';
select 'S7c d1 FOR NO KEY UPDATE with select-only visibility: ' || count(*) || ' rows (no error)' from (select 1 from public.deals where id = '40000000-0000-0000-0000-0000000000b1' for no key update) x;
reset role;
drop policy spike_select_all on public.deals;
-- (d) no UPDATE privilege on any column: is FOR NO KEY UPDATE an error?
revoke update on public.deals from authenticated;
set role authenticated;
select pg_temp.who('00000000-0000-0000-0000-0000000000b1');
do $$ begin perform 1 from public.deals for no key update; raise notice 'S7d no update grant: no error';
exception when others then raise notice 'S7d no update grant: % %', sqlstate, sqlerrm; end $$;
reset role;
grant update (value, stage_id, lost_reason) on public.deals to authenticated;
