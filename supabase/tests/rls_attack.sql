-- Two-user attack test (Master Plan section 8) against the migrated schema. Runs as a superuser and
-- switches to the API roles. Any failure raises an exception and stops the run (ON_ERROR_STOP).
-- Model since 10 Oct 2026: a lead is a company; everyone in the org sees every lead and its contacts; the owner,
-- managers and admins change it; deals, tasks and files stay with their owner; deletes need a fresh two-factor code.
\set ON_ERROR_STOP 1
\set QUIET 1

-- Fixtures (superuser: no auth.uid(), so the org/owner trigger leaves rows as given) ------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@test.invalid', '{"first_name":"Ada"}'),
  ('00000000-0000-0000-0000-0000000000a1', 'repa@test.invalid',  '{"first_name":"Rhea"}'),
  ('00000000-0000-0000-0000-0000000000b1', 'repb@test.invalid',  '{"first_name":"Bo"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'other@test.invalid', '{"first_name":"Cy"}');

do $$ begin
  if (select role from public.profiles where id = '00000000-0000-0000-0000-00000000000a') <> 'admin' then
    raise exception 'FAIL: first invited user should be admin';
  end if;
  if (select role from public.profiles where id = '00000000-0000-0000-0000-0000000000a1') <> 'rep' then
    raise exception 'FAIL: later users should start as rep';
  end if;
end $$;

-- A second organisation for the isolation test.
insert into public.orgs (id, name) values ('00000000-0000-0000-0000-0000000000cc', 'Other Org');
update public.profiles set org_id = '00000000-0000-0000-0000-0000000000cc', role = 'admin'
 where id = '00000000-0000-0000-0000-0000000000c1';

-- One lead (company) per person, a contact at each, and one row per owned table.
insert into public.pipeline_stages (id, org_id, name, position)
values ('20000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000cc', 'Other stage', 1);
do $$
declare
  main_org uuid := (select id from public.orgs where name = 'TopStock Wholesale');
  lead_stage uuid := (select s.id from public.pipeline_stages s join public.orgs o on o.id = s.org_id
                      where o.name = 'TopStock Wholesale' and s.position = 1);
  who record;
begin
  for who in select * from (values
      ('a1', main_org, '00000000-0000-0000-0000-0000000000a1'::uuid, lead_stage, 'warm', 'FR', 'Lyon'),
      ('b1', main_org, '00000000-0000-0000-0000-0000000000b1'::uuid, lead_stage, 'cold', 'BE', 'Bruxelles'),
      ('c1', '00000000-0000-0000-0000-0000000000cc'::uuid, '00000000-0000-0000-0000-0000000000c1'::uuid,
             '20000000-0000-0000-0000-0000000000c1'::uuid, 'warm', 'FR', 'Lyon')
    ) as w (tag, org, usr, stage, status, country, city) loop
    insert into public.companies (id, org_id, name, owner_id, lead_status, country, city)
    values (('30000000-0000-0000-0000-0000000000' || who.tag)::uuid, who.org, 'Co ' || who.tag, who.usr,
            who.status, who.country, who.city);
    insert into public.contacts (id, org_id, company_id, first_name, last_name)
    values (('10000000-0000-0000-0000-0000000000' || who.tag)::uuid, who.org,
            ('30000000-0000-0000-0000-0000000000' || who.tag)::uuid, 'Person', who.tag);
    insert into public.deals (id, org_id, contact_id, company_id, stage_id, owner_id)
    values (('40000000-0000-0000-0000-0000000000' || who.tag)::uuid, who.org,
            ('10000000-0000-0000-0000-0000000000' || who.tag)::uuid,
            ('30000000-0000-0000-0000-0000000000' || who.tag)::uuid, who.stage, who.usr);
    insert into public.activities (id, org_id, company_id, contact_id, type, user_id)
    values (('50000000-0000-0000-0000-0000000000' || who.tag)::uuid, who.org,
            ('30000000-0000-0000-0000-0000000000' || who.tag)::uuid,
            ('10000000-0000-0000-0000-0000000000' || who.tag)::uuid, 'note', who.usr);
    insert into public.tasks (id, org_id, contact_id, title, assignee_id)
    values (('60000000-0000-0000-0000-0000000000' || who.tag)::uuid, who.org,
            ('10000000-0000-0000-0000-0000000000' || who.tag)::uuid, 'Call back', who.usr);
    insert into public.files (id, org_id, contact_id, storage_path, mime, size, uploaded_by)
    values (('70000000-0000-0000-0000-0000000000' || who.tag)::uuid, who.org,
            ('10000000-0000-0000-0000-0000000000' || who.tag)::uuid, 'f/' || who.tag || '.pdf', 'application/pdf', 100, who.usr);
  end loop;
  insert into public.saved_views (id, org_id, user_id, section, name)
  values ('80000000-0000-0000-0000-0000000000b1', main_org, '00000000-0000-0000-0000-0000000000b1', 'leads', 'B only');
  insert into public.import_batches (id, org_id, filename, uploaded_by)
  values ('90000000-0000-0000-0000-00000000000a', main_org, 'leads.csv', '00000000-0000-0000-0000-00000000000a');
  -- The fixture activities moved every last-activity date to now; give the leads distinct dates for the list tests.
  update public.companies set last_activity_at = now() - interval '2 days' where id = '30000000-0000-0000-0000-0000000000a1';
  update public.companies set last_activity_at = null where id = '30000000-0000-0000-0000-0000000000b1';
end $$;

-- Sets the JWT claims the way Supabase does. totp_age_s: seconds since the two-factor code was entered (null = none).
create function pg_temp.as_user(sub text, aal text, totp_age_s integer default null) returns void
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', sub, 'role', 'authenticated', 'aal', aal,
    'amr', case when totp_age_s is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - totp_age_s)) end
  )::text, false)
$$;

-- 1. anon has no access to any table or API function --------------------------------------------------
set role anon;
do $$ begin perform set_config('request.jwt.claims', '{"role":"anon"}', false); end $$;
do $$
declare t text;
begin
  foreach t in array array['orgs','profiles','companies','import_batches','contacts','pipeline_stages','deals',
                           'activities','tasks','files','saved_views','audit_log'] loop
    begin
      execute format('select count(*) from public.%I', t);
      raise exception 'FAIL: anon could read %', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  foreach t in array array['select * from public.list_leads()', 'select public.count_leads()',
                           'select public.get_lead(gen_random_uuid())', 'select * from public.list_team()',
                           $q$select public.create_lead('x')$q$, $q$select * from public.list_saved_views('leads')$q$,
                           $q$select * from private.search_lead_ids('%co%')$q$] loop
    begin
      execute t;
      raise exception 'FAIL: anon could call %', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
reset role;

-- 2. Signed in without two-factor (aal1): sees nothing, writes nothing --------------------------------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal1'); end $$;
do $$ begin
  if (select count(*) from public.companies) <> 0 then raise exception 'FAIL: aal1 session can read leads'; end if;
  if (select count(*) from public.contacts) <> 0 then raise exception 'FAIL: aal1 session can read contacts'; end if;
  if (select count(*) from public.profiles) <> 0 then raise exception 'FAIL: aal1 session can read profiles'; end if;
  if (select count(*) from public.list_leads()) <> 0 then raise exception 'FAIL: aal1 session can list leads'; end if;
  if exists (select 1 from private.search_lead_ids('%co%')) then raise exception 'FAIL: aal1 session can search leads'; end if;
  if public.get_lead('30000000-0000-0000-0000-0000000000a1') is not null then
    raise exception 'FAIL: aal1 session can read a lead';
  end if;
  begin
    insert into public.companies (name) values ('x');
    raise exception 'FAIL: aal1 session could insert a lead';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.add_contact('30000000-0000-0000-0000-0000000000a1', 'x');
    raise exception 'FAIL: aal1 session could add a contact';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 3. Rep A with two-factor: reads every lead of the org, changes only their own --------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2'); end $$;
do $$
declare n int;
begin
  if (select count(*) from public.companies) <> 2 then raise exception 'FAIL: rep A should see the 2 leads of the org'; end if;
  if (select count(*) from public.contacts) <> 2 then raise exception 'FAIL: rep A should see the 2 contacts of the org'; end if;
  if exists (select 1 from public.companies where id = '30000000-0000-0000-0000-0000000000c1')
     or exists (select 1 from public.contacts where id = '10000000-0000-0000-0000-0000000000c1') then
    raise exception 'FAIL: rep A can read another org';
  end if;

  update public.companies set name = 'hacked' where id = '30000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: rep A changed rep B lead'; end if;
  update public.contacts set first_name = 'hacked' where id = '10000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: rep A changed a contact of rep B lead'; end if;
  delete from public.companies where id in ('30000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000b1');
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a rep deleted a lead'; end if;
  -- Deleting even a contact of one's own lead needs a fresh two-factor code (none in this token).
  delete from public.contacts where id = '10000000-0000-0000-0000-0000000000a1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: contact deleted without a fresh two-factor code'; end if;

  -- Insert: org and owner are set by the server; a client cannot even name the org column.
  begin
    insert into public.companies (name, org_id) values ('mine', '00000000-0000-0000-0000-0000000000cc');
    raise exception 'FAIL: client sent org_id';
  exception when insufficient_privilege then null;
  end;
  insert into public.companies (name) values ('mine');
  if (select org_id from public.companies where name = 'mine') <> (select id from public.orgs where name = 'TopStock Wholesale') then
    raise exception 'FAIL: org not set by the server';
  end if;
  if (select owner_id from public.companies where name = 'mine') <> '00000000-0000-0000-0000-0000000000a1' then
    raise exception 'FAIL: owner not defaulted to caller';
  end if;
  begin
    insert into public.companies (name, owner_id) values ('for B', '00000000-0000-0000-0000-0000000000b1');
    raise exception 'FAIL: rep created a lead owned by someone else';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.companies set owner_id = '00000000-0000-0000-0000-0000000000b1' where id = '30000000-0000-0000-0000-0000000000a1';
    raise exception 'FAIL: rep changed the owner';
  exception when insufficient_privilege then null;
  end;

  -- Own profile: may edit name, never role.
  update public.profiles set first_name = 'Rhea2' where id = '00000000-0000-0000-0000-0000000000a1';
  begin
    update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a1';
    raise exception 'FAIL: rep changed own role';
  exception when insufficient_privilege then null;
  end;
  update public.profiles set first_name = 'x' where id = '00000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: rep edited another profile'; end if;
  begin
    perform public.set_user_role('00000000-0000-0000-0000-0000000000a1', 'admin');
    raise exception 'FAIL: rep promoted self';
  exception when insufficient_privilege then null;
  end;

  -- Audit log, imports and stage settings are admin-only.
  if (select count(*) from public.audit_log) <> 0 then raise exception 'FAIL: rep can read audit log'; end if;
  begin
    insert into public.import_batches (filename) values ('x.csv');
    raise exception 'FAIL: rep created an import batch';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.pipeline_stages (name, position) values ('Hack', 9);
    raise exception 'FAIL: rep created a pipeline stage';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.audit_log (action, table_name) values ('insert', 'x');
    raise exception 'FAIL: rep wrote to the audit log';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 3a. Column grants: server-kept columns cannot be written, even on one's own lead --------------------------
do $$
declare
  attempt text;
begin
  foreach attempt in array array[
    $q$update public.companies set last_activity_at = now() + interval '3 years' where id = '30000000-0000-0000-0000-0000000000a1'$q$,
    $q$update public.companies set created_at = '2000-01-01' where id = '30000000-0000-0000-0000-0000000000a1'$q$,
    $q$update public.companies set import_batch_id = '90000000-0000-0000-0000-00000000000a' where id = '30000000-0000-0000-0000-0000000000a1'$q$,
    $q$insert into public.companies (name, last_activity_at) values ('backdated', now() - interval '1 day')$q$,
    $q$insert into public.companies (name, import_batch_id) values ('tagged', '90000000-0000-0000-0000-00000000000a')$q$,
    $q$update public.contacts set created_at = '2000-01-01' where id = '10000000-0000-0000-0000-0000000000a1'$q$,
    $q$update public.contacts set org_id = '00000000-0000-0000-0000-0000000000cc' where id = '10000000-0000-0000-0000-0000000000a1'$q$
  ] loop
    begin
      execute attempt;
      raise exception 'FAIL: wrote a server-kept column: %', attempt;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;

-- 3b. Deals, tasks and files stay with their owner: rep B's and the other org's rows are invisible ----------
do $$
declare
  t text;
  n int;
begin
  foreach t in array array['deals','tasks','files'] loop
    execute format('select count(*) from public.%I where id::text like %L or id::text like %L', t, '%b1', '%c1') into n;
    if n <> 0 then raise exception 'FAIL: rep A can read rep B or other-org rows in %', t; end if;
    execute format('select count(*) from public.%I where id::text like %L', t, '%a1') into n;
    if n <> 1 then raise exception 'FAIL: rep A should see own row in %', t; end if;
    execute format('update public.%I set updated_at = now() where id::text like %L or id::text like %L', t, '%b1', '%c1');
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: rep A updated a foreign row in %', t; end if;
    execute format('delete from public.%I where id::text like %L or id::text like %L', t, '%b1', '%c1');
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: rep A deleted a foreign row in %', t; end if;
  end loop;
  -- Activities: the team reads every timeline of the org, but changes only its own entries.
  if (select count(*) from public.activities) <> 2 then raise exception 'FAIL: rep A should see the org activities'; end if;
  update public.activities set body = 'x' where id = '50000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: rep A changed rep B activity'; end if;
  if (select count(*) from public.saved_views) <> 0 then raise exception 'FAIL: rep A can read rep B saved view'; end if;
  if (select count(*) from public.import_batches) <> 0 then raise exception 'FAIL: rep can read import batches'; end if;
  if (select count(*) from public.orgs) <> 1 then raise exception 'FAIL: rep sees another org'; end if;
  if exists (select 1 from public.pipeline_stages where org_id = '00000000-0000-0000-0000-0000000000cc') then
    raise exception 'FAIL: rep sees another org pipeline stages';
  end if;
end $$;

-- 3c. Writes cannot link to records the caller cannot use (foreign keys alone would allow it) ---------------
do $$
declare
  attempt text;
begin
  foreach attempt in array array[
    -- a contact of another lead, or of another org
    $q$insert into public.activities (company_id, contact_id, type) values ('30000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000b1', 'note')$q$,
    $q$insert into public.activities (company_id, type) values ('30000000-0000-0000-0000-0000000000c1', 'note')$q$,
    $q$insert into public.activities (company_id, deal_id, type) values ('30000000-0000-0000-0000-0000000000a1', '40000000-0000-0000-0000-0000000000b1', 'note')$q$,
    $q$insert into public.tasks (contact_id, title) values ('10000000-0000-0000-0000-0000000000c1', 'x')$q$,
    $q$insert into public.tasks (deal_id, title) values ('40000000-0000-0000-0000-0000000000b1', 'x')$q$,
    $q$insert into public.deals (contact_id, stage_id) values ('10000000-0000-0000-0000-0000000000c1', (select id from public.pipeline_stages where position = 1))$q$,
    -- a deal on a lead the caller may not change
    $q$insert into public.deals (company_id, stage_id) values ('30000000-0000-0000-0000-0000000000b1', (select id from public.pipeline_stages where position = 1))$q$,
    $q$insert into public.deals (contact_id, stage_id) values ('10000000-0000-0000-0000-0000000000b1', (select id from public.pipeline_stages where position = 1))$q$,
    $q$insert into public.deals (company_id, contact_id, stage_id) values ('30000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000b1', (select id from public.pipeline_stages where position = 1))$q$,
    $q$insert into public.deals (stage_id) values ('20000000-0000-0000-0000-0000000000c1')$q$,
    -- a contact on someone else's lead, or another org's
    $q$insert into public.contacts (first_name, company_id) values ('x', '30000000-0000-0000-0000-0000000000b1')$q$,
    $q$insert into public.contacts (first_name, company_id) values ('x', '30000000-0000-0000-0000-0000000000c1')$q$,
    $q$update public.contacts set company_id = '30000000-0000-0000-0000-0000000000b1' where id = '10000000-0000-0000-0000-0000000000a1'$q$,
    $q$insert into public.files (contact_id, storage_path, mime, size) values ('10000000-0000-0000-0000-0000000000c1', 'f/x.pdf', 'application/pdf', 1)$q$,
    $q$update public.activities set contact_id = '10000000-0000-0000-0000-0000000000b1' where id = '50000000-0000-0000-0000-0000000000a1'$q$,
    $q$update public.deals set stage_id = '20000000-0000-0000-0000-0000000000c1' where id = '40000000-0000-0000-0000-0000000000a1'$q$
  ] loop
    begin
      execute attempt;
      raise exception 'FAIL: linked to a record the caller cannot use: %', attempt;
    exception when insufficient_privilege then null;
    end;
  end loop;
  -- Linking to one's own records still works, and anyone may log on any lead of the org.
  insert into public.activities (company_id, contact_id, deal_id, type)
  values ('30000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a1',
          '40000000-0000-0000-0000-0000000000a1', 'call');
  insert into public.tasks (contact_id, title) values ('10000000-0000-0000-0000-0000000000a1', 'Follow up');
  insert into public.deals (company_id, stage_id)
  values ('30000000-0000-0000-0000-0000000000a1', (select id from public.pipeline_stages where position = 1));
end $$;

-- 3d. The leads API as rep A ------------------------------------------------------------------------------
do $$
declare
  n int;
begin
  -- Rep A logged a call on lead a1 just above: its last-activity date moved to now.
  if (select last_activity_at from public.companies where id = '30000000-0000-0000-0000-0000000000a1') < now() - interval '1 minute' then
    raise exception 'FAIL: logging a call did not move the last-activity date';
  end if;
  -- A client-chosen time is ignored: the server's clock decides, so nobody can push a lead's last activity ahead.
  insert into public.activities (company_id, type, created_at)
  values ('30000000-0000-0000-0000-0000000000a1', 'note', now() + interval '5 years');
  if (select max(created_at) from public.activities where company_id = '30000000-0000-0000-0000-0000000000a1') > now() + interval '1 minute'
     or (select last_activity_at from public.companies where id = '30000000-0000-0000-0000-0000000000a1') > now() + interval '1 minute' then
    raise exception 'FAIL: an activity dated in the future moved the last-activity date';
  end if;
  update public.activities set created_at = now() + interval '5 years' where id = '50000000-0000-0000-0000-0000000000a1';
  if (select created_at from public.activities where id = '50000000-0000-0000-0000-0000000000a1') > now() + interval '1 minute' then
    raise exception 'FAIL: an activity time was changed after the fact';
  end if;
  -- Logging on rep B's lead is allowed and moves its date too (the team works every lead).
  insert into public.activities (company_id, type) values ('30000000-0000-0000-0000-0000000000b1', 'note');
  if (select last_activity_at from public.companies where id = '30000000-0000-0000-0000-0000000000b1') is null then
    raise exception 'FAIL: an activity on another rep lead did not move its date';
  end if;
  update public.companies set name = name where id = '30000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: logging gave rep A edit rights on rep B lead'; end if;

  -- 3 leads in the org now ('mine' was added in section 3).
  if public.count_leads() <> 3 then raise exception 'FAIL: count_leads should be 3, got %', public.count_leads(); end if;
  if (select count(*) from public.list_leads()) <> 3 then raise exception 'FAIL: list_leads should return 3'; end if;
  -- b1 and 'mine' are Cold (the default), a1 is Warm.
  if (select count(*) from public.list_leads(p_statuses => array['cold'])) <> 2
     or (select count(*) from public.list_leads(p_statuses => array['warm', 'negotiation'])) <> 1 then
    raise exception 'FAIL: status filter';
  end if;
  if (select count(*) from public.list_leads(p_countries => array['BE'])) <> 1 then
    raise exception 'FAIL: country filter';
  end if;
  if (select count(*) from public.list_leads(p_owners => array['00000000-0000-0000-0000-0000000000b1'::uuid])) <> 1 then
    raise exception 'FAIL: owner filter';
  end if;
  if (select count(*) from public.list_leads(p_city => 'lyo')) <> 1 then raise exception 'FAIL: city filter'; end if;
  if (select count(*) from public.list_leads(p_search => 'Co b1')) <> 1 then raise exception 'FAIL: search by name'; end if;
  if (select count(*) from public.list_leads(p_search => 'person b1')) <> 1 then
    raise exception 'FAIL: search by contact name';
  end if;
  -- LIKE wildcards in user text are literal: "%" and "_" match nothing here.
  if (select count(*) from public.list_leads(p_search => '%%')) <> 0 or (select count(*) from public.list_leads(p_search => '__')) <> 0
     or public.count_leads(p_search => '%%') <> 0 then
    raise exception 'FAIL: search text was treated as a pattern';
  end if;
  -- The search helper runs as its owner (so the trigram indexes work) but keeps to the caller's org: "c1" is only in
  -- the other org's lead ("Co c1") and contact ("Person c1").
  if (select count(*) from private.search_lead_ids('%co%')) <> 2 then
    raise exception 'FAIL: search helper should find the 2 leads of the org';
  end if;
  if exists (select 1 from private.search_lead_ids('%c1%')) then
    raise exception 'FAIL: search helper returned another org''s lead';
  end if;
end $$;

-- Only the server sets the last-activity date: backdate lead a1 as the superuser for the inactivity filter.
reset role;
update public.companies set last_activity_at = now() - interval '40 days' where id = '30000000-0000-0000-0000-0000000000a1';
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2'); end $$;
do $$ begin
  -- "No activity for 30 days": lead a1 (40 days) and 'mine' (never); not b1 (just now).
  if (select count(*) from public.list_leads(p_inactive_days => 30)) <> 2 then
    raise exception 'FAIL: inactivity filter';
  end if;
  -- Search shorter than 2 characters is no search (every lead), longer than 100 is cut.
  if (select count(*) from public.list_leads(p_search => 'C')) <> 3 then
    raise exception 'FAIL: one-character search should not filter';
  end if;
end $$;

-- Keyset pagination, every sort: three pages of one row, no repeats, then nothing.
do $$
declare
  s text;
  r1 record;
  r2 record;
  r3 record;
  n int;
begin
  foreach s in array array['activity', 'name', 'created'] loop
    select * into r1 from public.list_leads(p_sort => s, p_limit => 1);
    select * into r2 from public.list_leads(p_sort => s, p_limit => 1, p_after_value => r1.sort_value, p_after_id => r1.id);
    select * into r3 from public.list_leads(p_sort => s, p_limit => 1, p_after_value => r2.sort_value, p_after_id => r2.id);
    if r1.id is null or r2.id is null or r3.id is null or r1.id = r2.id or r2.id = r3.id or r1.id = r3.id then
      raise exception 'FAIL: keyset pages repeat or stop early for sort %', s;
    end if;
    select count(*) into n from public.list_leads(p_sort => s, p_after_value => r3.sort_value, p_after_id => r3.id);
    if n <> 0 then raise exception 'FAIL: a page after the last lead is not empty for sort %', s; end if;
  end loop;
  -- Newest activity first, never-contacted last.
  select * into r1 from public.list_leads(p_limit => 1);
  if r1.id <> '30000000-0000-0000-0000-0000000000b1' then raise exception 'FAIL: activity sort order'; end if;
  begin
    perform public.list_leads(p_limit => 1000);
    raise exception 'FAIL: limit over 200 accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.list_leads(p_sort => 'name; drop table x');
    raise exception 'FAIL: unknown sort accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;

do $$
declare
  lead jsonb;
  new_id uuid;
  n int;
begin
  lead := public.get_lead('30000000-0000-0000-0000-0000000000b1');
  if lead is null or (lead ->> 'can_edit')::boolean or jsonb_array_length(lead -> 'contacts') <> 1 then
    raise exception 'FAIL: get_lead on rep B lead (visible, not editable, 1 contact)';
  end if;
  if not (public.get_lead('30000000-0000-0000-0000-0000000000a1') ->> 'can_edit')::boolean then
    raise exception 'FAIL: rep A should be able to change own lead';
  end if;
  if public.get_lead('30000000-0000-0000-0000-0000000000c1') is not null then
    raise exception 'FAIL: get_lead returned another org lead';
  end if;

  new_id := public.create_lead('Atelier Test', p_status => 'warm', p_country => 'FR', p_email => 'a@example.com');
  if (select owner_id from public.companies where id = new_id) <> '00000000-0000-0000-0000-0000000000a1' then
    raise exception 'FAIL: create_lead did not make the rep the owner';
  end if;
  begin
    perform public.create_lead('For B', p_owner => '00000000-0000-0000-0000-0000000000b1');
    raise exception 'FAIL: rep created a lead for someone else through the API';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.create_lead('Bad status', p_status => 'hot');
    raise exception 'FAIL: unknown status accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.create_lead('Bad country', p_country => 'France');
    raise exception 'FAIL: country name accepted instead of a code';
  exception when check_violation then null;
  end;
  begin
    perform public.update_lead('30000000-0000-0000-0000-0000000000b1', 'hacked', '00000000-0000-0000-0000-0000000000b1',
                               'cold', null, null, null, null);
    raise exception 'FAIL: rep changed rep B lead through the API';
  exception when insufficient_privilege then null;
  end;
  perform public.update_lead(new_id, 'Atelier Test 2', '00000000-0000-0000-0000-0000000000a1', 'negotiation',
                             '+33 6 00 00 00 01', 'b@example.com', 'Lyon', 'FR');
  if (select lead_status from public.companies where id = new_id) <> 'negotiation' then
    raise exception 'FAIL: update_lead did not apply';
  end if;
  n := public.bulk_update_leads(array[new_id, '30000000-0000-0000-0000-0000000000b1'::uuid], p_status => 'customer');
  if n <> 1 or (select lead_status from public.companies where id = '30000000-0000-0000-0000-0000000000b1') <> 'cold' then
    raise exception 'FAIL: bulk update should change only rep A lead';
  end if;
  begin
    perform public.bulk_update_leads(array[new_id], p_set_owner => true, p_owner => '00000000-0000-0000-0000-0000000000b1');
    raise exception 'FAIL: rep reassigned a lead in bulk';
  exception when insufficient_privilege then null;
  end;

  perform public.add_contact(new_id, 'Jeanne', 'Martin', 'Buyer', 'jeanne@example.com', '06 00 00 00 02');
  if jsonb_array_length(public.get_lead(new_id) -> 'contacts') <> 1 then raise exception 'FAIL: add_contact'; end if;
  begin
    perform public.add_contact('30000000-0000-0000-0000-0000000000b1', 'x');
    raise exception 'FAIL: rep added a contact to rep B lead';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.add_contact(new_id, '', '');
    raise exception 'FAIL: contact without a name accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.update_contact('10000000-0000-0000-0000-0000000000b1', 'x', 'y', null, null, null);
    raise exception 'FAIL: rep changed a contact on rep B lead';
  exception when insufficient_privilege then null;
  end;

  if (select count(*) from public.list_team()) <> 3 then raise exception 'FAIL: list_team should list the 3 org members'; end if;
  if (select count(*) from public.list_saved_views('leads')) <> 0 then raise exception 'FAIL: rep A sees rep B view'; end if;
  perform public.save_view('leads', 'My warm leads', '{"statuses":["warm"]}');
  if (select count(*) from public.list_saved_views('leads')) <> 1 then raise exception 'FAIL: save_view'; end if;
  begin
    perform public.delete_saved_view('80000000-0000-0000-0000-0000000000b1');
    raise exception 'FAIL: rep A deleted rep B view';
  exception when no_data_found then null;
  end;
end $$;

-- 4. Admin: aal1 sees nothing; aal2 sees the whole org but never another org ---------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal1'); end $$;
do $$ begin
  if (select count(*) from public.contacts) <> 0 then raise exception 'FAIL: admin without MFA can read'; end if;
  begin
    perform public.set_user_role('00000000-0000-0000-0000-0000000000a1', 'manager');
    raise exception 'FAIL: role change without step-up MFA';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Step-up (Master Plan F3): a two-factor code older than 10 minutes, or none at all, is not enough for a role
-- change or a delete.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 660); end $$;
do $$
declare n int;
begin
  begin
    perform public.set_user_role('00000000-0000-0000-0000-0000000000a1', 'manager');
    raise exception 'FAIL: role change with a two-factor code older than 10 minutes';
  exception when insufficient_privilege then null;
  end;
  delete from public.companies where name = 'mine';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: lead deleted with a two-factor code older than 10 minutes'; end if;
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', null); end $$;
do $$ begin
  begin
    perform public.set_user_role('00000000-0000-0000-0000-0000000000a1', 'manager');
    raise exception 'FAIL: role change with no two-factor time in the token';
  exception when insufficient_privilege then null;
  end;
end $$;

do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare n int;
begin
  if exists (select 1 from public.companies where org_id = '00000000-0000-0000-0000-0000000000cc')
     or exists (select 1 from public.contacts where org_id = '00000000-0000-0000-0000-0000000000cc') then
    raise exception 'FAIL: admin can read another org';
  end if;
  if (select count(*) from public.saved_views) <> 0 then raise exception 'FAIL: admin can read another user saved view'; end if;
  if (select count(*) from public.import_batches) <> 1 then raise exception 'FAIL: admin should see the org import batch'; end if;
  if (select count(*) from public.orgs) <> 1 then raise exception 'FAIL: admin sees another org'; end if;
  if exists (select 1 from public.pipeline_stages where org_id = '00000000-0000-0000-0000-0000000000cc') then
    raise exception 'FAIL: admin sees another org pipeline stages';
  end if;
  if (select count(*) from public.deals where org_id <> (select id from public.orgs)) <> 0
     or (select count(*) from public.files) <> 2 then
    raise exception 'FAIL: admin should see both reps'' files, nothing from the other org';
  end if;
  if (select count(*) from public.profiles) <> 3 then raise exception 'FAIL: admin should see 3 profiles of the org'; end if;

  -- Not even an admin writes the server-kept columns.
  begin
    update public.companies set last_activity_at = now() + interval '3 years' where id = '30000000-0000-0000-0000-0000000000b1';
    raise exception 'FAIL: admin wrote the last-activity date';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.companies set import_batch_id = '90000000-0000-0000-0000-00000000000a' where id = '30000000-0000-0000-0000-0000000000b1';
    raise exception 'FAIL: admin tagged a lead into an import batch';
  exception when insufficient_privilege then null;
  end;

  -- Admins assign leads to anyone in the team, never to someone outside it.
  perform public.update_lead('30000000-0000-0000-0000-0000000000a1', 'Co a1', '00000000-0000-0000-0000-0000000000b1',
                             'warm', null, null, 'Lyon', 'FR');
  if (select owner_id from public.companies where id = '30000000-0000-0000-0000-0000000000a1') <> '00000000-0000-0000-0000-0000000000b1' then
    raise exception 'FAIL: admin could not reassign a lead';
  end if;
  begin
    perform public.update_lead('30000000-0000-0000-0000-0000000000a1', 'Co a1', '00000000-0000-0000-0000-0000000000c1',
                               'warm', null, null, 'Lyon', 'FR');
    raise exception 'FAIL: lead assigned to someone from another org';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.create_lead('Outsider', p_owner => '00000000-0000-0000-0000-0000000000c1');
    raise exception 'FAIL: lead created for someone from another org';
  exception when insufficient_privilege then null;
  end;
  n := public.bulk_update_leads(array['30000000-0000-0000-0000-0000000000a1'::uuid, '30000000-0000-0000-0000-0000000000b1'::uuid],
                                p_set_owner => true, p_owner => null);
  if n <> 2 or exists (select 1 from public.companies where id in ('30000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000b1') and owner_id is not null) then
    raise exception 'FAIL: admin bulk unassign';
  end if;
  if (select count(*) from public.list_leads(p_unowned => true)) <> 2 then raise exception 'FAIL: unowned filter'; end if;

  -- With a fresh code an admin may delete a lead; its contacts and activities go with it.
  delete from public.companies where name = 'mine';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: admin with a fresh code could not delete a lead'; end if;

  -- Moving the last-activity date is not an audited change; real edits are.
  if exists (select 1 from public.audit_log where table_name = 'companies' and action = 'update'
             and diff_json ? 'last_activity_at' and not diff_json ? 'name' and not diff_json ? 'owner_id'
             and not diff_json ? 'lead_status') then
    raise exception 'FAIL: last-activity moves are flooding the audit log';
  end if;
  if not exists (select 1 from public.audit_log where table_name = 'companies' and action = 'update' and diff_json ? 'owner_id') then
    raise exception 'FAIL: owner change not audited';
  end if;

  perform public.set_user_role('00000000-0000-0000-0000-0000000000a1', 'manager');
  if (select role from public.profiles where id = '00000000-0000-0000-0000-0000000000a1') <> 'manager' then
    raise exception 'FAIL: role change did not apply';
  end if;
  begin
    perform public.set_user_role('00000000-0000-0000-0000-00000000000a', 'rep');
    raise exception 'FAIL: removed the last admin';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_user_role('00000000-0000-0000-0000-0000000000c1', 'rep');
    raise exception 'FAIL: changed a role in another org';
  exception when no_data_found then null;
  end;
  if not exists (select 1 from public.audit_log where action = 'role_change') then
    raise exception 'FAIL: role change not audited';
  end if;
  if not exists (select 1 from public.audit_log where table_name = 'contacts' and action = 'insert') then
    raise exception 'FAIL: contact insert not audited';
  end if;
  if exists (select 1 from public.audit_log where org_id = '00000000-0000-0000-0000-0000000000cc') then
    raise exception 'FAIL: admin can read another org audit log';
  end if;
  begin
    update public.audit_log set action = 'delete';
    raise exception 'FAIL: audit log is editable';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.audit_log;
    raise exception 'FAIL: audit log is deletable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 5. Manager (rep A promoted above) changes every lead of the org ------------------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2'); end $$;
do $$
declare n int;
begin
  if (select count(*) from public.saved_views) <> 1 then raise exception 'FAIL: manager should see only own saved view'; end if;
  if (select count(*) from public.import_batches) <> 0 then raise exception 'FAIL: manager can read import batches'; end if;
  update public.companies set lead_status = 'negotiation' where id = '30000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: manager could not change another rep lead'; end if;
  perform public.add_contact('30000000-0000-0000-0000-0000000000b1', 'Paul');
end $$;
reset role;

\echo 'rls_attack: all checks passed'
