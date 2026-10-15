-- Day 7c attack tests: the orphan sweeper's database part (migration 20261022090000_orphan_sweeper.sql;
-- docs/evidence/day7c/README.md; plan section 3, on day7-local). Runs after the earlier files in scripts/db-test.sh (CI
-- job "rls"), on the same database, with its own organisation, lead and stored objects:
--   A. Deny by default: the three functions are SECURITY INVOKER with search_path '' and static SQL; public, anon and
--      authenticated cannot execute them (catalog and live calls, 42501); service_role can.
--   B. The candidates: an old object with no files row is returned (with its organisation and size); a young one, one
--      just under 24 hours, one with a pending, ready or deleting row, one in another bucket and names outside the
--      org/lead/file.ext shape are not; the grace period and the limit are bounded; oldest first. The sanity counts.
--   C. The run's audit row: counts only (no organisation, actor, record id, names), bounded; no person in the app reads
--      it; a signed-in person cannot write one.
-- Locally the storage tables are supabase/tests/storage_shim.sql's stand-in; in CI they are the real storage-api schema.
-- Objects are inserted as the superuser with their age set at insert (storage-api would write them the same way).
-- Each scenario that writes runs in a block that is rolled back at the end (raise TS001, caught).
\set ON_ERROR_STOP 1
\set QUIET 1

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
create function pg_temp.anon() returns void
language plpgsql as $$
begin
  perform set_config('role', 'anon', false);
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
end;
$$;
-- The sweeper's key: PostgREST switches to service_role with these claims.
create function pg_temp.svc() returns void
language plpgsql as $$
begin
  perform set_config('role', 'service_role', false);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
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
-- One stored object as storage-api writes it (size and type in metadata), aged at insert.
create function pg_temp.obj(p_name text, p_age interval, p_bucket text default 'lead-files', p_size integer default 1000)
returns void language sql as $$
  insert into storage.objects (bucket_id, name, metadata, version, created_at, updated_at)
  values (p_bucket, p_name, jsonb_build_object('size', p_size, 'mimetype', 'application/pdf'), gen_random_uuid()::text,
          now() - p_age, now() - p_age)
$$;

-- Fixtures: an organisation of its own and one lead in it (superuser: no signed-in user, rows stay as given).
insert into public.orgs (id, name) values ('00000000-0000-0000-0000-0000d7c000cc', 'Sweeper Test Org');
insert into public.companies (id, org_id, name)
values ('30000000-0000-0000-0000-0000d7c00001', '00000000-0000-0000-0000-0000d7c000cc', 'Sweeper lead');

-- ===========================================================================
-- A. Deny by default
-- ===========================================================================
do $$
declare
  f record;
  n integer := 0;
begin
  for f in select p.oid, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig, p.prosrc
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('lead_file_orphans', 'lead_file_sweep_stats', 'record_file_sweep') loop
    n := n + 1;
    if f.prosecdef or not (f.proconfig @> array['search_path=""'])
       or f.prosrc ~* '\mexecute\M' or f.prosrc ~* 'format\s*\(' then
      raise exception 'FAIL: % must be SECURITY INVOKER with search_path '''' and static SQL', f.sig;
    end if;
    if has_function_privilege('public', f.oid, 'EXECUTE') or has_function_privilege('anon', f.oid, 'EXECUTE')
       or has_function_privilege('authenticated', f.oid, 'EXECUTE') then
      raise exception 'FAIL: % is callable by public, anon or authenticated', f.sig;
    end if;
    if not has_function_privilege('service_role', f.oid, 'EXECUTE') then
      raise exception 'FAIL: % is not callable by service_role', f.sig;
    end if;
  end loop;
  perform pg_temp.eq('sweeper functions found', n, 3);
  if to_regprocedure('public.lead_file_orphans(interval, integer)') is null
     or to_regprocedure('public.record_file_sweep(integer, integer, bigint, boolean)') is null
     or to_regprocedure('public.lead_file_sweep_stats()') is null then
    raise exception 'FAIL: a sweeper function has an unexpected signature';
  end if;
end $$;

-- Live calls: anon and a signed-in admin with a two-factor session are refused (42501) on all three.
do $$
declare
  stmt text;
begin
  foreach stmt in array array[
    'select * from public.lead_file_orphans()',
    $q$select * from public.lead_file_orphans(interval '30 days', 10)$q$,
    'select * from public.lead_file_sweep_stats()',
    'select public.record_file_sweep(0, 0, 0, true)'
  ] loop
    perform pg_temp.anon();
    perform pg_temp.expect_error(stmt, '42501');
    perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
    perform pg_temp.expect_error(stmt, '42501');
    perform pg_temp.su();
  end loop;
end $$;

-- service_role (the sweeper's key) can call all three.
do $$
begin
  perform pg_temp.svc();
  perform count(*) from public.lead_file_orphans();
  perform * from public.lead_file_sweep_stats();
  perform public.record_file_sweep(0, 0, 0, true);
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- ===========================================================================
-- B. The candidates and the sanity counts
-- ===========================================================================
do $$
declare
  o constant text := '00000000-0000-0000-0000-0000d7c000cc';
  l constant text := '30000000-0000-0000-0000-0000d7c00001';
  p_old constant text := o || '/' || l || '/a0000000-0000-4000-8000-000000000001.pdf';
  p_young constant text := o || '/' || l || '/a0000000-0000-4000-8000-000000000002.pdf';
  p_23h constant text := o || '/' || l || '/a0000000-0000-4000-8000-000000000003.pdf';
  p_pending constant text := o || '/' || l || '/a0000000-0000-4000-8000-000000000004.pdf';
  p_ready constant text := o || '/' || l || '/a0000000-0000-4000-8000-000000000005.pdf';
  p_deleting constant text := o || '/' || l || '/a0000000-0000-4000-8000-000000000006.pdf';
  p_other_bucket constant text := o || '/' || l || '/a0000000-0000-4000-8000-000000000007.pdf';
  p_30h constant text := o || '/' || l || '/a0000000-0000-4000-8000-000000000008.png';
  p_badsize constant text := o || '/' || l || '/a0000000-0000-4000-8000-000000000009.xlsx';
  odd_txt constant text := o || '/notes.txt';
  odd_upper constant text := upper(o) || '/' || l || '/a0000000-0000-4000-8000-00000000000a.pdf';
  odd_deep constant text := o || '/' || l || '/x/a0000000-0000-4000-8000-00000000000b.pdf';
  odd_ext constant text := o || '/' || l || '/a0000000-0000-4000-8000-00000000000c.exe';
  before record;
  after record;
  got text[];
begin
  perform pg_temp.svc();
  select * into before from public.lead_file_sweep_stats();
  perform pg_temp.su();

  insert into storage.buckets (id, name, public) values ('sweep-other', 'sweep-other', false);
  perform pg_temp.obj(p_old, interval '3 days', p_size => 1234);
  perform pg_temp.obj(p_young, interval '1 hour');
  perform pg_temp.obj(p_23h, interval '23 hours');
  perform pg_temp.obj(p_pending, interval '3 days');
  perform pg_temp.obj(p_ready, interval '3 days');
  perform pg_temp.obj(p_deleting, interval '3 days');
  perform pg_temp.obj(p_other_bucket, interval '3 days', 'sweep-other');
  perform pg_temp.obj(p_30h, interval '30 hours', p_size => 2000);
  insert into storage.objects (bucket_id, name, metadata, created_at, updated_at)
  values ('lead-files', p_badsize, '{"size": "lots", "mimetype": "application/pdf"}', now() - interval '4 days', now() - interval '4 days');
  perform pg_temp.obj(odd_txt, interval '5 days');
  perform pg_temp.obj(odd_upper, interval '5 days');
  perform pg_temp.obj(odd_deep, interval '5 days');
  perform pg_temp.obj(odd_ext, interval '5 days');
  -- A files row of each status for three of the old objects (pending, ready and deleting all keep their bytes).
  insert into public.files (org_id, company_id, name, mime, size, storage_path, status, ready_at) values
    (o::uuid, l::uuid, 'p.pdf', 'application/pdf', 1000, p_pending, 'pending', null),
    (o::uuid, l::uuid, 'r.pdf', 'application/pdf', 1000, p_ready, 'ready', now()),
    (o::uuid, l::uuid, 'd.pdf', 'application/pdf', 1000, p_deleting, 'deleting', null);

  perform pg_temp.svc();
  -- B1. Default grace period (24 hours): the old orphans of this organisation, oldest first, nothing else of ours.
  select array_agg(x.name order by x.created_at, x.name) into got
    from public.lead_file_orphans() x where x.name like o || '/%' or x.name like upper(o) || '/%';
  perform pg_temp.eq('candidates (default grace)', got, array[p_badsize, p_old, p_30h]);
  -- Order of the function itself (not only of this test's re-sort).
  select array_agg(x.name) into got from public.lead_file_orphans() x where x.name like o || '/%';
  perform pg_temp.eq('candidates come oldest first', got, array[p_badsize, p_old, p_30h]);
  perform pg_temp.eq('org of the old orphan',
    (select x.org_id from public.lead_file_orphans() x where x.name = p_old), o::uuid);
  perform pg_temp.eq('size of the old orphan', (select x.size from public.lead_file_orphans() x where x.name = p_old), 1234::bigint);
  perform pg_temp.eq('size when metadata holds no number',
    (select x.size from public.lead_file_orphans() x where x.name = p_badsize), 0::bigint);
  -- B2. Never: young, just under 24 hours, any files row, another bucket, a name outside the shape.
  if exists (select 1 from public.lead_file_orphans(interval '24 hours', 1000) x
              where x.name in (p_young, p_23h, p_pending, p_ready, p_deleting, odd_txt, odd_upper, odd_deep, odd_ext)) then
    raise exception 'FAIL: a young object, one with a files row or one outside the shape was returned';
  end if;
  -- The other bucket's object has the same shape; only its bucket differs, and the result has no bucket column, so
  -- count this organisation's results: still the three lead-files orphans.
  perform pg_temp.eq('another bucket is never swept',
    (select count(*) from public.lead_file_orphans(interval '24 hours', 1000) x where x.name = p_other_bucket), 0::bigint);
  -- B3. A longer grace period leaves the 30-hour orphan alone; the limit holds.
  select array_agg(x.name order by x.created_at) into got
    from public.lead_file_orphans(interval '48 hours', 1000) x where x.name like o || '/%';
  perform pg_temp.eq('candidates (48 hours)', got, array[p_badsize, p_old]);
  perform pg_temp.eq('limit 1', (select count(*) from public.lead_file_orphans(interval '24 hours', 1)), 1::bigint);
  -- B4. Bounds: never under 24 hours, never over a year, 1 to 1000 a call, no nulls.
  perform pg_temp.expect_error($q$select * from public.lead_file_orphans(interval '23 hours 59 minutes', 10)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from public.lead_file_orphans(interval '1 hour', 10)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from public.lead_file_orphans(interval '-1 day', 10)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from public.lead_file_orphans(interval '366 days', 10)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from public.lead_file_orphans(null, 10)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from public.lead_file_orphans(interval '24 hours', 0)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from public.lead_file_orphans(interval '24 hours', 1001)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from public.lead_file_orphans(interval '24 hours', null)$q$, '22023', 'bounds');
  -- B5. The sanity counts moved by exactly what this block stored: 12 objects in lead-files (the other bucket's is not
  -- counted), 3 files rows, 4 names outside the shape, their bytes.
  select * into after from public.lead_file_sweep_stats();
  perform pg_temp.eq('bucket objects counted', after.bucket_objects - before.bucket_objects, 12::bigint);
  perform pg_temp.eq('files rows counted', after.file_rows - before.file_rows, 3::bigint);
  perform pg_temp.eq('names outside the shape counted', after.odd_names - before.odd_names, 4::bigint);
  perform pg_temp.eq('bucket bytes counted', after.bucket_bytes - before.bucket_bytes, (1234 + 2000 + 9 * 1000)::bigint);
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- B6. The candidates read the files table under the caller's rights: a files row the sweeper's role could not see would
-- make its object a candidate, so service_role must read storage_path whatever row level security says (it bypasses
-- RLS by design; here proven with a row of another organisation, uploaded by nobody, still pending).
do $$
declare
  o constant text := '00000000-0000-0000-0000-0000d7c000cc';
  l constant text := '30000000-0000-0000-0000-0000d7c00001';
  p constant text := o || '/' || l || '/b0000000-0000-4000-8000-000000000001.docx';
begin
  perform pg_temp.obj(p, interval '10 days');
  insert into public.files (org_id, company_id, name, mime, size, storage_path, status)
  values (o::uuid, l::uuid, 'x.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1000, p, 'pending');
  perform pg_temp.svc();
  if exists (select 1 from public.lead_file_orphans() x where x.name = p) then
    raise exception 'FAIL: an object with a files row the sweeper reads was returned';
  end if;
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- ===========================================================================
-- C. The run's audit row
-- ===========================================================================
do $$
declare
  n0 bigint;
  r record;
begin
  n0 := (select count(*) from public.audit_log where action = 'file_sweep');
  perform pg_temp.svc();
  perform public.record_file_sweep(3, 2, 2048, false);
  perform public.record_file_sweep(5, 0, 100, true);
  perform pg_temp.su();
  perform pg_temp.eq('sweep rows written', (select count(*) from public.audit_log where action = 'file_sweep') - n0, 2::bigint);
  select * into r from public.audit_log where action = 'file_sweep' and diff_json ->> 'dry_run' = 'false'
   order by id desc limit 1;
  perform pg_temp.eq('sweep row table', r.table_name, 'storage.objects');
  perform pg_temp.eq('sweep row has no organisation', r.org_id, null::uuid);
  perform pg_temp.eq('sweep row has no actor', r.actor_id, null::uuid);
  perform pg_temp.eq('sweep row has no record id', r.record_id, null::text);
  perform pg_temp.eq('sweep row holds counts only', r.diff_json,
    '{"found": 3, "removed": 2, "bytes": 2048, "dry_run": false}'::jsonb);

  -- Bounds: removed never above found, a dry run removes nothing, no negative or missing counts.
  perform pg_temp.svc();
  perform pg_temp.expect_error('select public.record_file_sweep(1, 2, 0, false)', '22023', 'bounds');
  perform pg_temp.expect_error('select public.record_file_sweep(1, 1, 0, true)', '22023', 'bounds');
  perform pg_temp.expect_error('select public.record_file_sweep(-1, 0, 0, false)', '22023', 'bounds');
  perform pg_temp.expect_error('select public.record_file_sweep(1, -1, 0, false)', '22023', 'bounds');
  perform pg_temp.expect_error('select public.record_file_sweep(0, 0, -1, true)', '22023', 'bounds');
  perform pg_temp.expect_error('select public.record_file_sweep(100001, 0, 0, true)', '22023', 'bounds');
  perform pg_temp.expect_error('select public.record_file_sweep(null, 0, 0, true)', '22023', 'bounds');
  perform pg_temp.expect_error('select public.record_file_sweep(0, 0, 0, null)', '22023', 'bounds');

  -- No person in the app reads a sweep row (it has no organisation), not even an admin with a fresh code.
  perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
  perform pg_temp.eq('admin reads sweep rows', (select count(*) from public.audit_log where action = 'file_sweep'), 0::bigint);
  -- A signed-in person cannot forge one (the only insert policy is for their own sign-in rows).
  perform pg_temp.expect_error($q$insert into public.audit_log (org_id, actor_id, action, table_name)
    select p.org_id, p.id, 'file_sweep', 'auth' from public.profiles p where p.id = '00000000-0000-0000-0000-00000000000a'$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.audit_log (action, table_name) values ('file_sweep', 'storage.objects')$q$, '42501');
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- The action is allowed by the table's check, and nothing else new is.
do $$
begin
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'audit_log_action_check'
                            and conrelid = 'public.audit_log'::regclass)) !~ 'file_sweep' then
    raise exception 'FAIL: audit_log_action_check does not allow file_sweep';
  end if;
  perform pg_temp.expect_error($q$insert into public.audit_log (action, table_name) values ('file_purge', 'storage.objects')$q$, '23514');
end $$;

\echo 'sweeper_attack: all checks passed'
