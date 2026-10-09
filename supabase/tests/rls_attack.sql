-- Two-user attack test (Master Plan section 8) against the migrated schema. Runs as a superuser and
-- switches to the API roles. Any failure raises an exception and stops the run (ON_ERROR_STOP).
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

insert into public.contacts (id, org_id, first_name, owner_id) values
  ('10000000-0000-0000-0000-0000000000a1', (select id from public.orgs where name = 'TopStock Wholesale'), 'A-lead', '00000000-0000-0000-0000-0000000000a1'),
  ('10000000-0000-0000-0000-0000000000b1', (select id from public.orgs where name = 'TopStock Wholesale'), 'B-lead', '00000000-0000-0000-0000-0000000000b1'),
  ('10000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000cc', 'C-lead', '00000000-0000-0000-0000-0000000000c1');

-- 1. anon has no access to any table ------------------------------------------------------------------
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
end $$;
reset role;

-- 2. Signed in without two-factor (aal1): sees nothing, writes nothing --------------------------------
set role authenticated;
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}', false); end $$;
do $$ begin
  if (select count(*) from public.contacts) <> 0 then raise exception 'FAIL: aal1 session can read contacts'; end if;
  if (select count(*) from public.profiles) <> 0 then raise exception 'FAIL: aal1 session can read profiles'; end if;
  begin
    insert into public.contacts (first_name) values ('x');
    raise exception 'FAIL: aal1 session could insert';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 3. Rep A with two-factor: own records only ----------------------------------------------------------
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}', false); end $$;
do $$
declare n int;
begin
  if (select count(*) from public.contacts) <> 1 then raise exception 'FAIL: rep A should see exactly 1 contact'; end if;
  if exists (select 1 from public.contacts where id = '10000000-0000-0000-0000-0000000000b1') then
    raise exception 'FAIL: rep A can read rep B lead';
  end if;
  update public.contacts set first_name = 'hacked' where id = '10000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: rep A updated rep B lead'; end if;
  delete from public.contacts where id = '10000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: rep A deleted rep B lead'; end if;

  -- Insert: org and owner are set by the server, not the client.
  insert into public.contacts (first_name, org_id) values ('mine', '00000000-0000-0000-0000-0000000000cc');
  if (select org_id from public.contacts where first_name = 'mine') = '00000000-0000-0000-0000-0000000000cc' then
    raise exception 'FAIL: client chose org_id';
  end if;
  if (select owner_id from public.contacts where first_name = 'mine') <> '00000000-0000-0000-0000-0000000000a1' then
    raise exception 'FAIL: owner not defaulted to caller';
  end if;
  begin
    insert into public.contacts (first_name, owner_id) values ('for B', '00000000-0000-0000-0000-0000000000b1');
    raise exception 'FAIL: rep created a record owned by someone else';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.contacts set owner_id = '00000000-0000-0000-0000-0000000000b1' where id = '10000000-0000-0000-0000-0000000000a1';
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

-- 4. Admin: aal1 sees nothing; aal2 sees the whole org but never another org ---------------------------
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal1"}', false); end $$;
do $$ begin
  if (select count(*) from public.contacts) <> 0 then raise exception 'FAIL: admin without MFA can read'; end if;
  begin
    perform public.set_user_role('00000000-0000-0000-0000-0000000000a1', 'manager');
    raise exception 'FAIL: role change without step-up MFA';
  exception when insufficient_privilege then null;
  end;
end $$;

do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', false); end $$;
do $$ begin
  if (select count(*) from public.contacts) <> 3 then raise exception 'FAIL: admin should see the 3 contacts of the org'; end if;
  if exists (select 1 from public.contacts where id = '10000000-0000-0000-0000-0000000000c1') then
    raise exception 'FAIL: admin can read another org';
  end if;
  if (select count(*) from public.profiles) <> 3 then raise exception 'FAIL: admin should see 3 profiles of the org'; end if;
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

-- 5. Manager (rep A promoted above) sees the whole org --------------------------------------------------
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}', false); end $$;
do $$ begin
  if (select count(*) from public.contacts) <> 3 then raise exception 'FAIL: manager should see the whole org'; end if;
end $$;
reset role;

\echo 'rls_attack: all checks passed'
