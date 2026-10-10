-- Leads list at Release 1 size (Master Plan: 30k leads): 30,000 made-up companies and 10,000 contacts, then the list
-- and count functions as a signed-in rep with two-factor (row level security on), timed and with their inner plans
-- (auto_explain prints the statements the functions run). Used by scripts/db-perf.sh on a throwaway database.
\set ON_ERROR_STOP 1
\set QUIET 1
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'perf-rep@test.invalid');
insert into public.companies (org_id, name, owner_id, lead_status, phone, email, city, country, last_activity_at, created_at)
select (select id from public.orgs limit 1),
       (array['Atelier','Comptoir','Maison','Brasserie','Distribution','Halles','Épicerie','Société'])[i % 8 + 1] || ' ' ||
       (array['Verdane','Nordlys','Brécy','Altamar','Corvel','Lunéa','Marsac','Ophir','Tessan','Valmont'])[i / 8 % 10 + 1] || ' ' || i,
       case when i % 3 = 0 then '00000000-0000-0000-0000-0000000000a1'::uuid end,
       (array['cold','warm','negotiation','customer','cool_off','do_not_contact','disqualified'])[i % 7 + 1],
       '+33 6 ' || lpad((i % 100)::text, 2, '0') || ' ' || lpad((i / 100 % 100)::text, 2, '0') || ' 00 00',
       'contact' || i || '@example.com',
       (array['Lyon','Bruxelles','Casablanca','Valencia','Köln','Marseille','Lille'])[i % 7 + 1],
       (array['FR','BE','MA','ES','DE','FR','FR'])[i % 7 + 1],
       case when i % 9 = 0 then null else now() - (i % 4000) * interval '3 hours' end,
       now() - (i % 900) * interval '1 day'
from generate_series(1, 30000) i;
insert into public.contacts (org_id, company_id, first_name, last_name, email, phone)
select c.org_id, c.id, (array['Inès','Malik','Sofia','Théo','Amina','Lucas'])[n % 6 + 1],
       (array['Moreau','Benali','Ferreira','Lambert','Haddad','Rousseau'])[n % 6 + 1] || n,
       'person' || n || '@example.com', '+33 7 00 ' || lpad((n % 100)::text, 2, '0') || ' 00 00'
from (select c.*, row_number() over (order by c.id) as n from public.companies c) c
where c.n % 3 = 0;
vacuum analyze public.companies; -- vacuum also moves the new rows into the trigram indexes, as autovacuum does after an import
vacuum analyze public.contacts;

load 'auto_explain';
set auto_explain.log_min_duration = 0;
set auto_explain.log_analyze = on;
set auto_explain.log_nested_statements = on;
set auto_explain.log_timing = on;
set auto_explain.log_level = 'notice';
set client_min_messages = 'notice';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

\echo '=== plans (one run each, inner statements via auto_explain) ==='
\echo '--- 1. first page, last activity (default)'
select count(*) from public.list_leads(p_limit => 51);
\echo '--- 2. first page, A to Z'
select count(*) from public.list_leads(p_sort => 'name', p_limit => 51);
\echo '--- 3. first page, newest first'
select count(*) from public.list_leads(p_sort => 'created', p_limit => 51);
\echo '--- 4. search with no match, list then count'
select count(*) from public.list_leads(p_search => 'zzqx', p_limit => 51);
select public.count_leads(p_search => 'zzqx');
\echo '--- 5. search matching every lead, list (A to Z) then count'
select count(*) from public.list_leads(p_search => 'example.com', p_sort => 'name', p_limit => 51);
select public.count_leads(p_search => 'example.com');
reset role; -- auto_explain settings need the superuser; the claims stay set
set auto_explain.log_min_duration = -1;
set role authenticated;

\echo '=== timings: average of 5 warm runs, milliseconds ==='
do $$
declare
  cases text[][] := array[
    ['first page, last activity', 'select count(*) from public.list_leads(p_limit => 51)'],
    ['first page, A to Z', $q$select count(*) from public.list_leads(p_sort => 'name', p_limit => 51)$q$],
    ['first page, newest first', $q$select count(*) from public.list_leads(p_sort => 'created', p_limit => 51)$q$],
    ['page 200 deep (keyset), last activity', 'deep'],
    ['total count, no filter', 'select public.count_leads()'],
    ['status + country filter, list', $q$select count(*) from public.list_leads(p_statuses => array['customer'], p_countries => array['FR'], p_limit => 51)$q$],
    ['status + country filter, count', $q$select public.count_leads(p_statuses => array['customer'], p_countries => array['FR'])$q$],
    ['no activity for 30 days, list', 'select count(*) from public.list_leads(p_inactive_days => 30, p_limit => 51)'],
    ['search "verdane" (matches), list', $q$select count(*) from public.list_leads(p_search => 'verdane', p_limit => 51)$q$],
    ['search "verdane" (matches), count', $q$select public.count_leads(p_search => 'verdane')$q$],
    ['search "benali4" (contact name), list', $q$select count(*) from public.list_leads(p_search => 'benali4', p_limit => 51)$q$],
    ['search with no match, list', $q$select count(*) from public.list_leads(p_search => 'zzqx', p_limit => 51)$q$],
    ['search with no match, count', $q$select public.count_leads(p_search => 'zzqx')$q$],
    ['search "example.com" (every lead), list', $q$select count(*) from public.list_leads(p_search => 'example.com', p_limit => 51)$q$],
    ['search "example.com" (every lead), list A to Z', $q$select count(*) from public.list_leads(p_search => 'example.com', p_sort => 'name', p_limit => 51)$q$],
    ['search "example.com" (every lead), count', $q$select public.count_leads(p_search => 'example.com')$q$],
    ['search "+33 6" (every lead), list A to Z', $q$select count(*) from public.list_leads(p_search => '+33 6', p_sort => 'name', p_limit => 51)$q$],
    ['search "+33 6" (every lead), count', $q$select public.count_leads(p_search => '+33 6')$q$],
    ['search "ly" (2 letters), list', $q$select count(*) from public.list_leads(p_search => 'ly', p_limit => 51)$q$],
    ['search "ly" (2 letters), count', $q$select public.count_leads(p_search => 'ly')$q$],
    ['search "éé" (2 letters, no match), list', $q$select count(*) from public.list_leads(p_search => 'éé', p_limit => 51)$q$],
    ['search "verdane" + status customer, list', $q$select count(*) from public.list_leads(p_search => 'verdane', p_statuses => array['customer'], p_limit => 51)$q$],
    ['city filter "lyon", list', $q$select count(*) from public.list_leads(p_city => 'lyon', p_limit => 51)$q$]
  ];
  i int;
  r int;
  t0 timestamptz;
  total numeric;
  q text;
  cur record;
begin
  -- the cursor for "page 200": the 10,000th row in activity order
  select l.sort_value, l.id into cur from public.list_leads(p_limit => 200) l offset 199 limit 1;
  for r in 1..48 loop
    select l.sort_value, l.id into cur from public.list_leads(p_limit => 200, p_after_value => cur.sort_value, p_after_id => cur.id) l offset 199 limit 1;
  end loop;
  for i in 1..array_length(cases, 1) loop
    q := case when cases[i][2] = 'deep'
              then format('select count(*) from public.list_leads(p_limit => 51, p_after_value => %L, p_after_id => %L)', cur.sort_value, cur.id)
              else cases[i][2] end;
    execute q; -- warm
    total := 0;
    for r in 1..5 loop
      t0 := clock_timestamp();
      execute q;
      total := total + extract(epoch from clock_timestamp() - t0) * 1000;
    end loop;
    raise notice '% : % ms', rpad(cases[i][1], 48), round(total / 5, 1);
  end loop;
end $$;
reset role;
