-- Gate 1 catalog checks (Day 7d; Master Plan section 8 items 4, 7, 17 and two-user step 3; Day 7 plan step 7a).
-- No fixtures: every check reads the catalog after all migrations, so a table, view or function added later is checked
-- the day it lands, without anyone remembering to list it. The anon side (no privilege of any kind, live
-- SELECT/INSERT/UPDATE/DELETE refused on every relation) is rls_attack.sql section 1; the per-object behaviour is in each
-- day's attack file. These are the rules that must hold for every object at once:
--   G1  row level security is on for every table in public and private (deny by default), and no relation of another
--       kind can carry rows past it (views run as the caller; no materialized views or foreign tables);
--   G2  every table has the restrictive two-factor policy (require_mfa: FOR ALL TO authenticated, USING and WITH CHECK
--       exactly private.has_aal2()), so an aal1 session reads and writes nothing anywhere;
--   G3  policies name only the roles that should reach rows: authenticated, and share_reader (the public share page's
--       owner role, Day 6e) on its reviewed tables; never PUBLIC or anon;
--   G4  every SECURITY DEFINER function is on the reviewed list below, by full signature, with search_path '' and the
--       reviewed owner; which of them signed-in people may call is part of the list;
--   G5  no function in public or private is executable by PUBLIC;
--   G6  dynamic SQL (EXECUTE or format()) appears only in the two reviewed lead list functions (Day 3a: EXECUTE ... USING,
--       sort keys from a whitelist);
--   G7  authenticated holds no TRUNCATE, REFERENCES or TRIGGER on any table or view (TRUNCATE skips row level
--       security). Sequences are left out: on the real Supabase image a sequence created in public may carry Supabase's
--       default grants to authenticated, which the local shim does not copy, and no exposed function calls nextval or
--       setval (Day 7d security review, informational).
-- A failure names the object. Adding a SECURITY DEFINER function, a policy role or dynamic SQL means a review first, then
-- an entry here with the day that reviewed it.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- G1 ------------------------------------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  perform set_config('search_path', '', true);  -- names print schema-qualified, whatever the session's path
  for r in select c.oid::regclass::text as rel, c.relkind, c.relrowsecurity, c.reloptions
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f') loop
    if r.relkind in ('r', 'p') and not r.relrowsecurity then
      raise exception 'FAIL: G1 row level security is off on %', r.rel;
    elsif r.relkind = 'v' and not coalesce(r.reloptions @> array['security_invoker=true'], false) then
      raise exception 'FAIL: G1 view % does not run as the caller (security_invoker)', r.rel;
    elsif r.relkind in ('m', 'f') then
      raise exception 'FAIL: G1 % is a materialized view or foreign table (no row level security)', r.rel;
    end if;
  end loop;
end $$;

-- G2 ------------------------------------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  perform set_config('search_path', '', true);  -- names print schema-qualified, whatever the session's path
  for r in select n.nspname, c.relname
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('public', 'private') and c.relkind in ('r', 'p')
              and not exists (
                select 1 from pg_policies p
                 where p.schemaname = n.nspname and p.tablename = c.relname and p.policyname = 'require_mfa'
                   and p.permissive = 'RESTRICTIVE' and p.cmd = 'ALL' and p.roles = array['authenticated']::name[]
                   and regexp_replace(p.qual, '\s+', ' ', 'g') = '( SELECT private.has_aal2() AS has_aal2)'
                   and regexp_replace(p.with_check, '\s+', ' ', 'g') = '( SELECT private.has_aal2() AS has_aal2)') loop
    raise exception 'FAIL: G2 %.% has no restrictive two-factor policy (require_mfa, has_aal2)', r.nspname, r.relname;
  end loop;
  -- has_aal2 itself: its whole body (comments removed, whitespace collapsed) is the reviewed one, reading the verified
  -- JWT's aal claim and nothing else; a comment that only mentions aal2 cannot pass for it.
  if (select btrim(regexp_replace(regexp_replace(regexp_replace(prosrc, '/\*.*?\*/', ' ', 'g'), '--[^\n]*', ' ', 'g'),
                                  '\s+', ' ', 'g'))
        from pg_proc where oid = 'private.has_aal2()'::regprocedure)
     is distinct from $b$select coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'$b$
     or (select prosecdef or provolatile <> 's' or proconfig is distinct from array['search_path=""']
           from pg_proc where oid = 'private.has_aal2()'::regprocedure) then
    raise exception 'FAIL: G2 private.has_aal2() is not the reviewed check (aal claim = aal2, INVOKER, STABLE, search_path empty)';
  end if;
end $$;

-- G3 ------------------------------------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  perform set_config('search_path', '', true);  -- names print schema-qualified, whatever the session's path
  for r in select schemaname, tablename, policyname, roles from pg_policies
            where schemaname in ('public', 'private')
              and not (roles <@ array['authenticated', 'share_reader']::name[]) loop
    raise exception 'FAIL: G3 policy % on %.% names roles %', r.policyname, r.schemaname, r.tablename, r.roles;
  end loop;
  -- share_reader reaches only what the public share page reads and writes (Day 6e, share_attack.sql).
  for r in select distinct schemaname || '.' || tablename as rel from pg_policies
            where schemaname in ('public', 'private') and 'share_reader' = any (roles)
              and (schemaname || '.' || tablename) <> all (array['private.inventory_settings', 'private.share_links',
                   'private.share_rate', 'private.stock_request_lines', 'private.stock_requests', 'public.locations',
                   'public.products', 'public.stock_levels']) loop
    raise exception 'FAIL: G3 share_reader has a policy on % (not on the reviewed list)', r.rel;
  end loop;
end $$;

-- G4 ------------------------------------------------------------------------------------------------------------------
do $$
declare
  -- signature (regprocedure text, search_path '') | owner | signed-in people may call it | reviewed in
  reviewed constant text[][] := array[
    -- core schema and Day 1 (role helpers read the caller's own profile; set_user_role is the admin-only role change,
    -- its advisor WARN accepted on Day 1; handle_new_user is the auth.users trigger)
    ['private.current_app_role()', 'postgres', 'true'],
    ['private.current_org_id()', 'postgres', 'true'],
    ['private.is_admin()', 'postgres', 'true'],
    ['private.is_manager_or_admin()', 'postgres', 'true'],
    ['private.handle_new_user()', 'postgres', 'false'],
    ['private.enforce_org_and_owner()', 'postgres', 'false'],
    ['public.set_user_role(uuid,public.app_role)', 'postgres', 'true'],
    -- audit triggers (Day 1, 3b, 4b, 4c, 5a, 6a, 6d, 6e) and the file-access audit row (Day 4d)
    ['private.audit_row()', 'postgres', 'false'],
    ['private.audit_inventory_row()', 'postgres', 'false'],
    ['private.audit_sales_row()', 'postgres', 'false'],
    ['private.audit_share_link_row()', 'postgres', 'false'],
    ['private.audit_file_access(uuid)', 'postgres', 'true'],
    -- Day 7a: the sign-in row flood guard (a trigger; it counts rows only admins can read)
    ['private.auth_event_guard()', 'postgres', 'false'],
    -- leads, entries and files (Day 3a, 4a, 4b, 4d)
    ['private.lock_activity_lead()', 'postgres', 'false'],
    ['private.touch_company_activity()', 'postgres', 'false'],
    ['private.untouch_company_activity()', 'postgres', 'false'],
    ['private.sync_contact_phone()', 'postgres', 'false'],
    ['private.file_guard_insert()', 'postgres', 'false'],
    ['private.lead_has_files(uuid)', 'postgres', 'true'],
    -- deals (Day 5a, 5b, 6 deal_stock_blocks, 7f)
    ['private.deal_history()', 'postgres', 'false'],
    ['private.deal_move_flood()', 'postgres', 'false'],
    ['private.deal_open_flood()', 'postgres', 'false'],
    ['private.deal_closing_blocked(uuid)', 'postgres', 'true'],
    ['private.deal_delete_stock_block()', 'postgres', 'false'],
    ['private.deal_fulfilment_fits_stock()', 'postgres', 'false'],
    ['private.deal_held_by_stock(uuid)', 'postgres', 'true'],
    ['private.release_deal_holds()', 'postgres', 'false'],
    -- stock engine, imports, sales and requests (Day 6a, 6c, 6d)
    ['private.stock_movement_b_apply()', 'postgres', 'false'],
    ['private.stock_transfer_paired()', 'postgres', 'false'],
    ['private.stock_low_automation()', 'postgres', 'false'],
    ['private.stock_request_task()', 'postgres', 'false'],
    ['private.hold_arrived_task()', 'postgres', 'false'],
    ['private.insert_system_task(uuid,uuid,text,text,uuid,uuid,uuid)', 'postgres', 'false'],
    ['private.expire_due_holds(uuid,uuid,uuid)', 'postgres', 'true'],
    ['private.expire_holds_for(uuid,uuid,uuid,integer)', 'postgres', 'false'],
    ['private.sweep_expired_holds()', 'postgres', 'true'],
    ['private.nightly_stock_jobs()', 'postgres', 'false'],
    ['private.lock_stock_import(uuid,uuid[])', 'postgres', 'true'],
    ['private.order_deal_fit()', 'postgres', 'false'],
    ['private.order_line_cost_snapshot()', 'postgres', 'false'],
    ['private.seed_org_inventory(uuid)', 'postgres', 'false'],
    ['private.seed_org_inventory_trigger()', 'postgres', 'false'],
    -- the daily security digest (section 8 item 43, 16 Oct 2026): counts only, executable by security_digest_reader only
    ['private.security_digest(timestamp with time zone)', 'postgres', 'false'],
    -- client share link (Day 6e): the two public functions run as share_reader (no bypass, own policies)
    ['private.share_link_caps()', 'postgres', 'false'],
    ['public.share_request(text,jsonb)', 'share_reader', 'false'],
    ['public.share_view(text,text)', 'share_reader', 'false']
  ];
  live text[];
  listed text[];
  r record;
  i integer;
begin
  perform set_config('search_path', '', true);  -- names print schema-qualified, whatever the session's path
  select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text) into live
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prosecdef;
  select array_agg(reviewed[k][1] order by reviewed[k][1]) into listed from generate_subscripts(reviewed, 1) k;
  for r in select x from unnest(live) x except select y from unnest(listed) y loop
    raise exception 'FAIL: G4 SECURITY DEFINER function % is not on the reviewed list', r.x;
  end loop;
  for r in select y from unnest(listed) y except select x from unnest(live) x loop
    raise exception 'FAIL: G4 reviewed function % is gone or no longer SECURITY DEFINER (update the list)', r.y;
  end loop;
  for i in 1 .. array_length(reviewed, 1) loop
    select p.oid, pg_get_userbyid(p.proowner) as owner, p.proconfig into r
      from pg_proc p where p.oid = reviewed[i][1]::regprocedure;
    if r.proconfig is distinct from array['search_path=""'] then
      raise exception 'FAIL: G4 % must pin search_path to empty (has %)', reviewed[i][1], r.proconfig;
    end if;
    if r.owner <> reviewed[i][2] then
      raise exception 'FAIL: G4 % is owned by %, reviewed as %', reviewed[i][1], r.owner, reviewed[i][2];
    end if;
    if has_function_privilege('authenticated', r.oid, 'EXECUTE')::text <> reviewed[i][3] then
      raise exception 'FAIL: G4 authenticated EXECUTE on % is %, reviewed as %', reviewed[i][1],
        has_function_privilege('authenticated', r.oid, 'EXECUTE'), reviewed[i][3];
    end if;
  end loop;
end $$;

-- G5 ------------------------------------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  perform set_config('search_path', '', true);  -- names print schema-qualified, whatever the session's path
  for r in select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'private') and has_function_privilege('public', p.oid, 'EXECUTE') loop
    raise exception 'FAIL: G5 PUBLIC can execute %', r.sig;
  end loop;
end $$;

-- G6 ------------------------------------------------------------------------------------------------------------------
do $$
declare
  found text[];
begin
  perform set_config('search_path', '', true);  -- names print schema-qualified, whatever the session's path
  select array_agg(p.oid::regprocedure::text order by p.proname::text collate "C") into found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and (p.prosrc ~* '\mexecute\M' or p.prosrc ~* '\mformat\s*\(');
  if found is distinct from array[
       'public.count_leads(text,text[],uuid[],boolean,text[],text,integer,uuid)',
       'public.list_leads(text,text[],uuid[],boolean,text[],text,integer,uuid,text,text,uuid,integer)'] then
    raise exception 'FAIL: G6 dynamic SQL outside the reviewed lead list functions: %', found;
  end if;
  -- The two reviewed ones bind every value with USING and are not SECURITY DEFINER (RLS applies to the caller).
  if exists (select 1 from pg_proc where proname in ('count_leads', 'list_leads') and prosecdef)
     or exists (select 1 from pg_proc where proname in ('count_leads', 'list_leads') and prosrc !~* '\musing\M') then
    raise exception 'FAIL: G6 the lead list functions must be INVOKER and bind values with USING';
  end if;
end $$;

-- G7 ------------------------------------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  perform set_config('search_path', '', true);  -- names print schema-qualified, whatever the session's path
  for r in select c.oid::regclass::text as rel, x.priv
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
             cross join unnest(array['TRUNCATE', 'REFERENCES', 'TRIGGER']) x(priv)
            where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v')
              and has_table_privilege('authenticated', c.oid, x.priv) loop
    raise exception 'FAIL: G7 authenticated has % on %', r.priv, r.rel;
  end loop;
end $$;

select 'gate1_attack: all checks passed' as result;
