-- Day 4d attack and behaviour tests: files on a lead (design docs/evidence/day4/design.md sections 3.4, 5.7, 6 rows 20 to
-- 25 and 31, 8.1; migration 20261014090000_lead_files.sql). Runs after the other attack tests on the same database
-- (scripts/db-test.sh, CI job "rls"), reusing their users: admin a, manager a1 (promoted in rls_attack), rep b1,
-- other-org admin c1, rep d1 (activity_attack). It adds rep g1 (uploads) and rep h1 (only for the upload limits, so its
-- counts are exact). Locally the storage tables are supabase/tests/storage_shim.sql's stand-in; in CI they are the
-- real storage-api schema. An upload is simulated the way storage-api writes it: an insert into storage.objects as the
-- signed-in person (row level security applies), with the size and type in metadata (private.object_size/mime read
-- them). Any failure raises an exception and stops the run.
-- Three kinds of probe, as in activity_attack.sql: through the API role (grants, policies and triggers), as the
-- superuser with a user's claims (only the triggers: a guard on its own), and helpers that undo what they try.
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

-- A statement that must fail with this SQLSTATE (and hint); with a marker, the marker must be in neither the message
-- nor the detail (constant errors keep the user's text out of the logs).
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
      raise exception 'FAIL: "%" gave % (hint "%"), expected % (hint "%")', left(stmt, 160), got_state, got_hint,
        want_state, want_hint;
    end if;
    if marker is not null and (strpos(coalesce(got_msg, ''), marker) > 0 or strpos(coalesce(got_detail, ''), marker) > 0) then
      raise exception 'FAIL: "%" put the user''s text in the error', left(stmt, 160);
    end if;
    return;
  end;
  raise exception 'FAIL: "%" succeeded, expected %', left(stmt, 160), want_state;
end;
$$;

-- The bytes of an upload, as storage-api stores them, inserted as the current role and claims.
create function pg_temp.put(p_path text, p_size bigint, p_mime text) returns void
language sql as $$
  insert into storage.objects (bucket_id, name, owner, metadata)
  values ('lead-files', p_path, (select auth.uid()), jsonb_build_object('size', p_size, 'mimetype', p_mime))
$$;

-- A whole upload (begin, bytes, finish) as the current person; returns the file id.
create function pg_temp.upload(p_lead uuid, p_name text, p_size integer, p_mime text default 'application/pdf') returns uuid
language plpgsql as $$
declare
  r jsonb := public.begin_file_upload(p_lead, p_name, p_mime, p_size);
begin
  perform pg_temp.put(r ->> 'path', p_size, p_mime);
  perform public.finish_file_upload((r ->> 'id')::uuid);
  return (r ->> 'id')::uuid;
end;
$$;

-- A whole delete (begin, remove the bytes, finish) as the current person.
create function pg_temp.remove(p_file uuid) returns void
language plpgsql as $$
declare
  v_path text := public.begin_file_delete(p_file);
begin
  delete from storage.objects o where o.bucket_id = 'lead-files' and o.name = v_path;
  perform public.finish_file_delete(p_file);
end;
$$;

-- 0. What the database itself says: bucket, policies, grants, keys ---------------------------------------------------
do $$
begin
  -- bucket_private: one private bucket with the size limit and the five types (spike S1: the bucket row exists).
  if (select count(*) from storage.buckets where id = 'lead-files' and public = false and file_size_limit = 10485760
        and allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']) <> 1 then
    raise exception 'FAIL: bucket_private (lead-files missing, public, or with other limits)';
  end if;
  -- lead_files_only_bucket: no other bucket to put files in.
  if (select array_agg(id order by id) from storage.buckets) is distinct from array['lead-files'] then
    raise exception 'FAIL: lead_files_only_bucket: %', (select array_agg(id order by id) from storage.buckets);
  end if;
  -- storage_policies_exact: read, add and remove for signed-in people; no update policy (no overwrite, upsert or move).
  if (select array_agg(polname::text || ':' || polcmd::text order by polname) from pg_policy
       where polrelid = 'storage.objects'::regclass)
     is distinct from array['lead_files_delete:d', 'lead_files_insert:a', 'lead_files_select:r'] then
    raise exception 'FAIL: storage_policies_exact: %',
      (select array_agg(polname::text || ':' || polcmd::text order by polname) from pg_policy where polrelid = 'storage.objects'::regclass);
  end if;
  if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass
              and not (polroles = array[(select oid from pg_roles where rolname = 'authenticated')])) then
    raise exception 'FAIL: a storage policy applies to a role other than authenticated';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass
              and pg_get_expr(coalesce(polqual, polwithcheck), polrelid) not like '%has_aal2%') then
    raise exception 'FAIL: a storage policy without the two-factor check';
  end if;
  -- Row level security on, and the restrictive two-factor policy kept, on files.
  if not (select relrowsecurity from pg_class where oid = 'public.files'::regclass)
     or not exists (select 1 from pg_policy where polrelid = 'public.files'::regclass and polname = 'require_mfa' and not polpermissive) then
    raise exception 'FAIL: files lost row level security or require_mfa';
  end if;
  if (select array_agg(polname::text order by polname) from pg_policy where polrelid = 'public.files'::regclass)
     is distinct from array['files_delete', 'files_insert', 'files_select', 'files_update', 'require_mfa'] then
    raise exception 'FAIL: files policies';
  end if;
  -- Column grants (threat 7): clients name the lead, name, type and size, then change the status; nothing else.
  if (select array_agg(column_name::text order by column_name) from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'files' and grantee = 'authenticated' and privilege_type = 'INSERT')
     is distinct from array['company_id', 'mime', 'name', 'size'] then
    raise exception 'FAIL: files insert grant';
  end if;
  if (select array_agg(column_name::text order by column_name) from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'files' and grantee = 'authenticated' and privilege_type = 'UPDATE')
     is distinct from array['status'] then
    raise exception 'FAIL: files update grant';
  end if;
  -- Threat 31: a lead with files cannot be deleted (restrict), and the file guard trigger set is complete.
  if (select confdeltype from pg_constraint where conname = 'files_company_id_fkey') is distinct from 'r' then
    raise exception 'FAIL: files_company_id_fkey must be on delete restrict';
  end if;
  if (select array_agg(tgname::text order by tgname) from pg_trigger where tgrelid = 'public.files'::regclass and not tgisinternal)
     is distinct from array['audit_row', 'enforce_org_and_owner', 'file_guard_delete', 'file_guard_insert', 'file_guard_update', 'set_updated_at'] then
    raise exception 'FAIL: files triggers';
  end if;
  -- Clients can call none of the guards or the space sum; the insert guard and the audit helper are the only definers.
  if has_function_privilege('authenticated', 'private.file_guard_insert()', 'execute')
     or has_function_privilege('authenticated', 'private.file_guard_update()', 'execute')
     or has_function_privilege('authenticated', 'private.org_storage_bytes(uuid)', 'execute')
     or has_function_privilege('anon', 'public.begin_file_upload(uuid, text, text, integer)', 'execute')
     or has_function_privilege('anon', 'public.open_file(uuid)', 'execute') then
    raise exception 'FAIL: function privileges';
  end if;
  if (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and n.nspname in ('public', 'private') and (p.proname like '%file%' or p.proname like '%object%' or p.proname = 'org_storage_bytes'))
     is distinct from array['audit_file_access', 'file_guard_insert'] then
    raise exception 'FAIL: unexpected SECURITY DEFINER file functions';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('begin_file_upload', 'get_pending_upload', 'finish_file_upload',
                'abort_file_upload', 'list_lead_files', 'open_file', 'begin_file_delete', 'finish_file_delete', 'file_usage')
                and (p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false))) then
    raise exception 'FAIL: a file RPC is SECURITY DEFINER or lacks search_path = ''''';
  end if;
  if (select array_agg(action order by action) from (select unnest(array['file_access']) as action) x
       where pg_get_constraintdef((select oid from pg_constraint where conname = 'audit_log_action_check')) like '%file_access%') is null then
    raise exception 'FAIL: audit_log.action lacks file_access';
  end if;
end $$;

-- Fixtures (superuser, no claims: the guards and the org/owner trigger leave rows as given) --------------------------
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000f4', 'repg@test.invalid', '{"first_name":"Gil"}'),
  ('00000000-0000-0000-0000-0000000000f5', 'reph@test.invalid', '{"first_name":"Hal"}');
do $$
declare
  main_org uuid := (select id from public.orgs where name = 'TopStock Wholesale');
begin
  if (select array_agg(role::text order by id) from public.profiles
       where id in ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000f5')) is distinct from array['rep', 'rep'] then
    raise exception 'FAIL: fixture users should be reps';
  end if;
  insert into public.companies (id, org_id, name, owner_id, lead_status, country, city) values
    ('35000000-0000-0000-0000-0000000000a1', main_org, 'Files g1', '00000000-0000-0000-0000-0000000000f4', 'warm', 'FR', 'Lyon'),
    ('35000000-0000-0000-0000-0000000000a2', main_org, 'Files b1', '00000000-0000-0000-0000-0000000000b1', 'cold', 'FR', 'Nantes');
  perform set_config('t.org', main_org::text, false);
end $$;

-- 1. anon and a session without two-factor (aal1) see nothing and store nothing (threat 1) ---------------------------
set role anon;
do $$ begin perform set_config('request.jwt.claims', '{"role":"anon"}', false); end $$;
do $$ begin
  perform pg_temp.expect_error('select count(*) from public.files', '42501');
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'x.pdf', 'application/pdf', 10)$q$, '42501');
  if exists (select 1 from storage.objects) then raise exception 'FAIL: anon reads stored objects'; end if;
end $$;
reset role;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4', 'aal1'); end $$;
do $$ begin
  if (select count(*) from public.files) <> 0 then raise exception 'FAIL: day4_aal1_blocked: aal1 reads files'; end if;
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'x.pdf', 'application/pdf', 10)$q$, '42501');
  perform pg_temp.expect_error($q$select * from public.list_lead_files('35000000-0000-0000-0000-0000000000a1')$q$, '42501');
  perform pg_temp.expect_error($q$select public.open_file('70000000-0000-0000-0000-0000000000a1')$q$, '42501');
  perform pg_temp.expect_error('select public.file_usage()', '42501');
  perform pg_temp.expect_error($q$insert into public.files (company_id, name, mime, size) values ('35000000-0000-0000-0000-0000000000a1', 'x.pdf', 'application/pdf', 10)$q$, '42501');
  if exists (select 1 from storage.objects) then raise exception 'FAIL: aal1 reads stored objects'; end if;
  perform pg_temp.expect_error(format($q$select pg_temp.put(%L, 10, 'application/pdf')$q$,
    current_setting('t.org') || '/35000000-0000-0000-0000-0000000000a1/' || gen_random_uuid() || '.pdf'), '42501');
end $$;

-- 2. An upload: begin, bytes, finish (threats 7, 21, 24) -------------------------------------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4', 'aal2', 30); end $$;
do $$
declare
  r jsonb;
  f record;
begin
  r := public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'Devis n°12 — été 🧾.pdf', 'application/pdf', 1200);
  -- file_path_server_built: org/lead/<new id>.pdf, from ids and the type only.
  if r ->> 'path' is distinct from current_setting('t.org') || '/35000000-0000-0000-0000-0000000000a1/' || (r ->> 'id') || '.pdf'
     or r -> 'stale_paths' is distinct from '[]'::jsonb then
    raise exception 'FAIL: file_path_server_built: %', r;
  end if;
  select * into f from public.files where id = (r ->> 'id')::uuid;
  if f.status <> 'pending' or f.uploaded_by <> '00000000-0000-0000-0000-0000000000f4' or f.ready_at is not null
     or f.org_id::text <> current_setting('t.org') or f.name <> 'Devis n°12 — été 🧾.pdf' then
    raise exception 'FAIL: a new file row: %', row_to_json(f);
  end if;
  if public.get_pending_upload((r ->> 'id')::uuid) is distinct from
     jsonb_build_object('path', r ->> 'path', 'mime', 'application/pdf', 'size', 1200) then
    raise exception 'FAIL: get_pending_upload';
  end if;
  -- Not ready before its bytes are stored (and not visible to open).
  perform pg_temp.expect_error(format('select public.finish_file_upload(%L)', r ->> 'id'), '22023', 'object_mismatch');
  perform pg_temp.expect_error(format('select public.open_file(%L)', r ->> 'id'), 'P0002');
  perform pg_temp.put(r ->> 'path', 1200, 'application/pdf');
  -- The uploader reads their own object (storage-api's RETURNING after an upload needs it).
  if (select count(*) from storage.objects where name = r ->> 'path') <> 1 then raise exception 'FAIL: uploader cannot read own object'; end if;
  r := r || jsonb_build_object('done', public.finish_file_upload((r ->> 'id')::uuid));
  if r -> 'done' ->> 'name' is distinct from 'Devis n°12 — été 🧾.pdf' or (r -> 'done' ->> 'ready_at') is null
     or (select status from public.files where id = (r ->> 'id')::uuid) <> 'ready' then
    raise exception 'FAIL: finish_file_upload: %', r;
  end if;
  perform pg_temp.expect_error(format('select public.finish_file_upload(%L)', r ->> 'id'), 'P0002');
  perform pg_temp.expect_error(format('select public.get_pending_upload(%L)', r ->> 'id'), 'P0002');
  perform set_config('t.f1', r ->> 'id', false);
  perform set_config('t.f1_path', r ->> 'path', false);
  -- An extension that is not the type's is never stored: a JPEG named .png is stored as .jpg.
  r := public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'photo.png', 'image/jpeg', 50);
  if r ->> 'path' not like '%.jpg' then raise exception 'FAIL: the stored extension comes from the type'; end if;
  perform public.abort_file_upload((r ->> 'id')::uuid);
  perform public.finish_file_delete((r ->> 'id')::uuid);
end $$;

-- 3. Server columns cannot be sent (threat 7: file_path_server_built, file_status_insert_ignored) --------------------
do $$
declare
  attempt text;
begin
  foreach attempt in array array[
    $q$insert into public.files (company_id, name, mime, size, storage_path) values ('35000000-0000-0000-0000-0000000000a1', 'x.pdf', 'application/pdf', 10, 'x/y/z.pdf')$q$,
    $q$insert into public.files (company_id, name, mime, size, status) values ('35000000-0000-0000-0000-0000000000a1', 'x.pdf', 'application/pdf', 10, 'ready')$q$,
    $q$insert into public.files (company_id, name, mime, size, uploaded_by) values ('35000000-0000-0000-0000-0000000000a1', 'x.pdf', 'application/pdf', 10, '00000000-0000-0000-0000-0000000000b1')$q$,
    $q$insert into public.files (id, company_id, name, mime, size) values (gen_random_uuid(), '35000000-0000-0000-0000-0000000000a1', 'x.pdf', 'application/pdf', 10)$q$,
    format($q$update public.files set name = 'renamed.pdf' where id = %L$q$, current_setting('t.f1')),
    format($q$update public.files set size = 1 where id = %L$q$, current_setting('t.f1')),
    format($q$update public.files set storage_path = 'x' where id = %L$q$, current_setting('t.f1')),
    format($q$update public.files set company_id = '35000000-0000-0000-0000-0000000000a2' where id = %L$q$, current_setting('t.f1')),
    format($q$update public.files set ready_at = now() where id = %L$q$, current_setting('t.f1'))
  ] loop
    perform pg_temp.expect_error(attempt, '42501');
  end loop;
end $$;
reset role;
-- The insert guard on its own (superuser with the admin's claims: no grant or policy applies, only the triggers; an
-- admin passes enforce_org_and_owner with any uploader): whatever the row says, the id, path, status, uploader and
-- times are the server's.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  f record;
begin
  begin
    insert into public.files (id, company_id, name, mime, size, storage_path, status, ready_at, uploaded_by, created_at)
    values ('77777777-0000-0000-0000-000000000001', '35000000-0000-0000-0000-0000000000a1', 'forged.pdf', 'application/pdf', 10,
            'forged/path.pdf', 'ready', now(), '00000000-0000-0000-0000-0000000000b1', now() - interval '1 year')
    returning * into f;
    if f.id = '77777777-0000-0000-0000-000000000001' or f.status <> 'pending' or f.ready_at is not null
       or f.uploaded_by <> '00000000-0000-0000-0000-00000000000a' or f.created_at < now() - interval '1 minute'
       or f.storage_path <> current_setting('t.org') || '/35000000-0000-0000-0000-0000000000a1/' || f.id || '.pdf' then
      raise exception 'FAIL: day4_server_columns_not_writable (guard kept %)', row_to_json(f);
    end if;
    raise exception 'probe undone' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4', 'aal2', 30);
  -- The update guard on its own: only the status, and only forward.
  perform pg_temp.expect_error(format($q$update public.files set name = 'x.pdf' where id = %L$q$, current_setting('t.f1')), '42501');
  perform pg_temp.expect_error(format($q$update public.files set company_id = '35000000-0000-0000-0000-0000000000a2' where id = %L$q$, current_setting('t.f1')), '42501');
  perform pg_temp.expect_error(format($q$update public.files set uploaded_by = '00000000-0000-0000-0000-0000000000b1' where id = %L$q$, current_setting('t.f1')), '42501');
  perform pg_temp.expect_error(format($q$update public.files set status = 'pending' where id = %L$q$, current_setting('t.f1')), '22023', 'state');
  perform pg_temp.expect_error(format($q$delete from public.files where id = %L$q$, current_setting('t.f1')), '22023', 'state');
end $$;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;

-- 4. Finish checks the real stored size and type (threat 23: finish_size_mismatch_refused) ---------------------------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4', 'aal2', 30); end $$;
do $$
declare
  r jsonb;
  c record;
begin
  for c in select * from (values (1, 2000::bigint, 'application/pdf'), (2, 1999, 'application/pdf'), (3, 2000, 'image/png'), (4, null, null)) v (n, sz, mt) loop
    r := public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'mismatch.pdf', 'application/pdf', 2000);
    if c.sz is not null then
      perform pg_temp.put(r ->> 'path', c.sz, c.mt);
    end if;
    if c.n = 1 then
      -- The declared size and type: finishes. (Kept as the second ready file.)
      perform public.finish_file_upload((r ->> 'id')::uuid);
      perform set_config('t.f_match', r ->> 'id', false);
      continue;
    end if;
    perform pg_temp.expect_error(format('select public.finish_file_upload(%L)', r ->> 'id'), '22023', 'object_mismatch');
    -- Clean-up the way the app does it: cancel (pending -> deleting), remove the bytes, finish the delete.
    if public.abort_file_upload((r ->> 'id')::uuid) is distinct from r ->> 'path' then raise exception 'FAIL: abort path'; end if;
    perform pg_temp.expect_error(format('select public.abort_file_upload(%L)', r ->> 'id'), 'P0002');
    if c.sz is not null then
      perform pg_temp.expect_error(format('select public.finish_file_delete(%L)', r ->> 'id'), '22023', 'state');
      delete from storage.objects where name = r ->> 'path';
    end if;
    perform public.finish_file_delete((r ->> 'id')::uuid);
    if exists (select 1 from public.files where id = (r ->> 'id')::uuid) then raise exception 'FAIL: cancelled upload kept'; end if;
  end loop;
end $$;

-- 5. Where bytes may be stored (threats 20, 21) ----------------------------------------------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f5', 'aal2', 30); end $$;
do $$
declare r jsonb;
begin
  r := public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'hal.pdf', 'application/pdf', 10);
  perform set_config('t.h0', r ->> 'id', false);
  perform set_config('t.h0_path', r ->> 'path', false);
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4', 'aal2', 30); end $$;
do $$
declare
  r jsonb;
  n int;
begin
  r := public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'mine.pdf', 'application/pdf', 10);
  -- object_insert_other_path_denied: a made-up path in the org folder, another person's pending path, a ready file's
  -- path, another org's folder, outside any folder, and another bucket.
  perform pg_temp.expect_error(format($q$select pg_temp.put(%L, 10, 'application/pdf')$q$,
    current_setting('t.org') || '/35000000-0000-0000-0000-0000000000a1/' || gen_random_uuid() || '.pdf'), '42501');
  perform pg_temp.expect_error(format($q$select pg_temp.put(%L, 10, 'application/pdf')$q$, current_setting('t.h0_path')), '42501');
  perform pg_temp.expect_error(format($q$select pg_temp.put(%L, 1200, 'application/pdf')$q$, current_setting('t.f1_path')), '42501');
  perform pg_temp.expect_error(format($q$select pg_temp.put(%L, 10, 'application/pdf')$q$,
    '00000000-0000-0000-0000-0000000000cc/30000000-0000-0000-0000-0000000000c1/' || gen_random_uuid() || '.pdf'), '42501');
  perform pg_temp.expect_error($q$select pg_temp.put('loose.pdf', 10, 'application/pdf')$q$, '42501');
  perform pg_temp.expect_error(format($q$insert into storage.objects (bucket_id, name, metadata) values ('other', %L, '{}')$q$, r ->> 'path'), '42501');
  -- The caller's own pending path works once; a second write to it (overwrite or upsert) does not.
  perform pg_temp.put(r ->> 'path', 10, 'application/pdf');
  perform pg_temp.expect_error(format($q$select pg_temp.put(%L, 10, 'application/pdf')$q$, r ->> 'path'), '23505');
  -- object_update_denied: no update policy, so nothing can be renamed, moved or rewritten.
  update storage.objects set metadata = '{"size": 1, "mimetype": "application/pdf"}' where name = r ->> 'path';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: object_update_denied'; end if;
  update storage.objects set name = name || '.x' where bucket_id = 'lead-files';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: object_update_denied (move)'; end if;
  -- object_delete while the row is pending or ready: refused (only "deleting" rows lose their bytes).
  delete from storage.objects where name in (r ->> 'path', current_setting('t.f1_path'));
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: bytes removed while the file is not being deleted'; end if;
  perform public.finish_file_upload((r ->> 'id')::uuid);
  perform set_config('t.f_mine', r ->> 'id', false);
  -- object_insert_after_15min_denied: an upload begun 16 minutes ago can no longer receive bytes.
  r := public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'late.pdf', 'application/pdf', 10);
  perform set_config('t.late', r ->> 'id', false);
  perform set_config('t.late_path', r ->> 'path', false);
end $$;
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
update public.files set created_at = now() - interval '16 minutes' where id = current_setting('t.late')::uuid;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4', 'aal2', 30); end $$;
do $$
declare r jsonb;
begin
  perform pg_temp.expect_error(format($q$select pg_temp.put(%L, 10, 'application/pdf')$q$, current_setting('t.late_path')), '42501');
  -- The next begin marks it "deleting" and hands its path back for clean-up.
  r := public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'next.pdf', 'application/pdf', 10);
  if r -> 'stale_paths' is distinct from jsonb_build_array(current_setting('t.late_path'))
     or (select status from public.files where id = current_setting('t.late')::uuid) <> 'deleting' then
    raise exception 'FAIL: stale uploads handed back: %', r;
  end if;
  perform public.finish_file_delete(current_setting('t.late')::uuid);
  perform public.abort_file_upload((r ->> 'id')::uuid);
  perform public.finish_file_delete((r ->> 'id')::uuid);
end $$;

-- 6. Who sees a file (D11, as today) ---------------------------------------------------------------------------------
-- g1 adds a file to b1's lead: pending, only g1 sees it; ready, b1 (the lead's owner) and managers and admins too.
do $$
declare r jsonb;
begin
  r := public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'price list.xlsx',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 4096);
  perform set_config('t.f2', r ->> 'id', false);
  perform set_config('t.f2_path', r ->> 'path', false);
  perform pg_temp.put(r ->> 'path', 4096, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$ begin
  if exists (select 1 from public.files where id = current_setting('t.f2')::uuid)
     or exists (select 1 from storage.objects where name = current_setting('t.f2_path')) then
    raise exception 'FAIL: the lead owner sees a pending upload of someone else';
  end if;
  if exists (select 1 from public.files where id = current_setting('t.f1')::uuid) then
    raise exception 'FAIL: rep b1 sees a file on a lead he does not own';
  end if;
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$ begin
  if exists (select 1 from public.files where id = current_setting('t.f2')::uuid) then
    raise exception 'FAIL: an admin sees a pending upload';
  end if;
  if not exists (select 1 from public.files where id = current_setting('t.f1')::uuid)
     or (select count(*) from storage.objects where name = current_setting('t.f1_path')) <> 1 then
    raise exception 'FAIL: an admin should see a ready file and its object';
  end if;
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4', 'aal2', 30); end $$;
do $$ begin perform public.finish_file_upload(current_setting('t.f2')::uuid); end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$ begin
  if not exists (select 1 from public.files where id = current_setting('t.f2')::uuid)
     or (select count(*) from storage.objects where name = current_setting('t.f2_path')) <> 1 then
    raise exception 'FAIL: the lead owner should see a ready file on his lead and its object';
  end if;
  if (select count(*) from public.list_lead_files('35000000-0000-0000-0000-0000000000a2')) <> 1 then
    raise exception 'FAIL: list_lead_files for the lead owner';
  end if;
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2', 30); end $$;
do $$ begin
  if exists (select 1 from public.files where company_id in ('35000000-0000-0000-0000-0000000000a1', '35000000-0000-0000-0000-0000000000a2'))
     or exists (select 1 from storage.objects)
     or exists (select 1 from public.list_lead_files('35000000-0000-0000-0000-0000000000a2')) then
    raise exception 'FAIL: rep_cannot_open_others_file (rep d1 sees another rep''s files)';
  end if;
  perform pg_temp.expect_error(format('select public.open_file(%L)', current_setting('t.f2')), 'P0002');
  perform pg_temp.expect_error(format('select public.begin_file_delete(%L)', current_setting('t.f2')), 'P0002');
  perform pg_temp.expect_error(format('select public.finish_file_delete(%L)', current_setting('t.f2')), 'P0002');
  if public.file_usage() is not null then raise exception 'FAIL: file_usage is for managers and admins'; end if;
end $$;

-- 7. Another organisation (threat 2) ---------------------------------------------------------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1', 'aal2', 30); end $$;
do $$
declare n int;
begin
  if exists (select 1 from public.files where org_id <> '00000000-0000-0000-0000-0000000000cc') then
    raise exception 'FAIL: other_org_file_row_invisible';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'lead-files' and name not like '00000000-0000-0000-0000-0000000000cc/%') then
    raise exception 'FAIL: other_org_object_select_zero';
  end if;
  perform pg_temp.expect_error(format($q$select pg_temp.put(%L, 10, 'application/pdf')$q$, current_setting('t.f1_path')), '42501');
  perform pg_temp.expect_error(format($q$select pg_temp.put(%L, 10, 'application/pdf')$q$,
    '00000000-0000-0000-0000-0000000000cc/30000000-0000-0000-0000-0000000000c1/' || gen_random_uuid() || '.pdf'), '42501');
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'x.pdf', 'application/pdf', 10)$q$, 'P0002');
  perform pg_temp.expect_error($q$insert into public.files (company_id, name, mime, size) values ('35000000-0000-0000-0000-0000000000a1', 'x.pdf', 'application/pdf', 10)$q$, '42501');
  perform pg_temp.expect_error(format('select public.open_file(%L)', current_setting('t.f1')), 'P0002');
  perform pg_temp.expect_error(format('select public.begin_file_delete(%L)', current_setting('t.f1')), 'P0002');
  delete from storage.objects where bucket_id = 'lead-files';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: another org removed stored bytes'; end if;
  if (select count(*) from public.list_lead_files('35000000-0000-0000-0000-0000000000a1')) <> 0 then
    raise exception 'FAIL: another org lists a lead''s files';
  end if;
end $$;

-- 8. Opening is audited; lists page by keyset; the team's usage (threats 22, 30) -------------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  r jsonb;
  p1 uuid[];
  p2 uuid[];
  last record;
begin
  r := public.open_file(current_setting('t.f2')::uuid);
  if r is distinct from jsonb_build_object('path', current_setting('t.f2_path'), 'name', 'price list.xlsx',
       'mime', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') then
    raise exception 'FAIL: open_file: %', r;
  end if;
  if public.file_usage() is distinct from (select sum(size)::bigint from public.files where status = 'ready') then
    raise exception 'FAIL: file_usage for an admin';
  end if;
  -- Pages of 2 on g1's lead (3 ready files): no repeat, no gap, newest first.
  select array_agg(id) into p1 from public.list_lead_files('35000000-0000-0000-0000-0000000000a1', null, null, 2);
  select * into last from public.list_lead_files('35000000-0000-0000-0000-0000000000a1', null, null, 2) offset 1 limit 1;
  select array_agg(id) into p2 from public.list_lead_files('35000000-0000-0000-0000-0000000000a1', last.created_at, last.id, 2);
  if cardinality(p1) <> 2 or cardinality(p2) <> 1 or p1 && p2
     or (select count(*) from public.files where company_id = '35000000-0000-0000-0000-0000000000a1' and status = 'ready') <> 3 then
    raise exception 'FAIL: list_lead_files keyset pages % then %', p1, p2;
  end if;
  perform pg_temp.expect_error($q$select * from public.list_lead_files('35000000-0000-0000-0000-0000000000a1', now(), null)$q$, '22023', 'bad_cursor');
  perform pg_temp.expect_error($q$select * from public.list_lead_files('35000000-0000-0000-0000-0000000000a1', null, null, 0)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from public.list_lead_files('35000000-0000-0000-0000-0000000000a1', null, null, 101)$q$, '22023', 'bounds');
end $$;
reset role;
do $$ begin
  -- audit_file_access_row: who opened which file, nothing else.
  if (select count(*) from public.audit_log where action = 'file_access' and table_name = 'files'
        and record_id = current_setting('t.f2') and actor_id = '00000000-0000-0000-0000-00000000000a' and diff_json = '{}'::jsonb) <> 1 then
    raise exception 'FAIL: audit_file_access_row';
  end if;
  -- Nobody else can write that row type: audit_log has no insert grant, and the helper writes only for a ready file of
  -- the caller's organisation in a two-factor session.
  if has_table_privilege('authenticated', 'public.audit_log', 'insert') then raise exception 'FAIL: audit_log insert grant'; end if;
end $$;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1', 'aal2', 30); end $$;
do $$ begin perform private.audit_file_access(current_setting('t.f2')::uuid); end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal1'); end $$;
do $$ begin perform private.audit_file_access(current_setting('t.f2')::uuid); end $$;
reset role;
do $$ begin
  if (select count(*) from public.audit_log where action = 'file_access' and record_id = current_setting('t.f2')) <> 1 then
    raise exception 'FAIL: audit_file_access wrote for another org or an aal1 session';
  end if;
end $$;

-- 9. Deleting needs a fresh code, then the bytes go, then the row (threat 8: file_delete_stale_code_denied) ----------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4', 'aal2', 660); end $$;
do $$ begin
  perform pg_temp.expect_error(format('select public.begin_file_delete(%L)', current_setting('t.f1')), '42501', 'step_up');
  perform pg_temp.expect_error(format($q$update public.files set status = 'deleting' where id = %L$q$, current_setting('t.f1')), '42501', 'step_up');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4', 'aal2', null); end $$;
do $$ begin
  perform pg_temp.expect_error(format('select public.begin_file_delete(%L)', current_setting('t.f1')), '42501', 'step_up');
end $$;
reset role;
-- The update guard on its own refuses a stale code (row level security out of the way).
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4', 'aal2', 660); end $$;
do $$ begin
  perform pg_temp.expect_error(format($q$update public.files set status = 'deleting' where id = %L$q$, current_setting('t.f1')), '42501', 'step_up');
end $$;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4', 'aal2', 30); end $$;
do $$
declare
  v_path text;
  n int;
begin
  v_path := public.begin_file_delete(current_setting('t.f1')::uuid);
  if v_path is distinct from current_setting('t.f1_path') then raise exception 'FAIL: begin_file_delete path'; end if;
  -- A retry of a file already being deleted answers its path again.
  if public.begin_file_delete(current_setting('t.f1')::uuid) is distinct from v_path then raise exception 'FAIL: retry'; end if;
  perform pg_temp.expect_error(format('select public.open_file(%L)', current_setting('t.f1')), 'P0002');
  perform pg_temp.expect_error(format('select public.finish_file_delete(%L)', current_setting('t.f1')), '22023', 'state');
  -- Listed to its uploader as "couldn't finish deleting" until the bytes are gone.
  if not exists (select 1 from public.list_lead_files('35000000-0000-0000-0000-0000000000a1') where id = current_setting('t.f1')::uuid and status = 'deleting') then
    raise exception 'FAIL: the uploader should see a file stuck in deleting';
  end if;
  delete from storage.objects where name = v_path;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: bytes of a file being deleted could not be removed'; end if;
  perform public.finish_file_delete(current_setting('t.f1')::uuid);
  if exists (select 1 from public.files where id = current_setting('t.f1')::uuid) then raise exception 'FAIL: finish_file_delete'; end if;
end $$;
-- The lead's owner deletes a file someone else added to his lead (with a fresh code).
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$ begin
  perform pg_temp.remove(current_setting('t.f2')::uuid);
  if exists (select 1 from public.files where id = current_setting('t.f2')::uuid) then raise exception 'FAIL: lead owner delete'; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from storage.objects where name in (current_setting('t.f1_path'), current_setting('t.f2_path'))) then
    raise exception 'FAIL: deleted files left their bytes';
  end if;
end $$;

-- 10. Names, sizes and types: constant errors (threats 23, 24, 29: file_name_invisible_refused) ----------------------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4', 'aal2', 30); end $$;
do $$
declare
  cp int;
begin
  foreach cp in array array[1, 9, 10, 31, 127, 133, 1564, 6158, 8203, 8207, 8238, 8294, 65279, 917569, 47, 92, 34] loop
    perform pg_temp.expect_error(format('select public.begin_file_upload(%L, %L, %L, 10)', '35000000-0000-0000-0000-0000000000a1',
      'MARK7' || chr(cp) || 'x.pdf', 'application/pdf'), '22023', 'file_name', 'MARK7');
  end loop;
  perform pg_temp.expect_error(format('select public.begin_file_upload(%L, %L, %L, 10)', '35000000-0000-0000-0000-0000000000a1',
    'MARK7' || repeat('a', 176) || '.pdf', 'application/pdf'), '22023', 'file_name', 'MARK7');
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', '', 'application/pdf', 10)$q$, '22023', 'file_name');
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', null, 'application/pdf', 10)$q$, '22023', 'file_name');
  -- name_dotdot: a path in a name is refused (and a path is never built from a name anyway).
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', '../../etc/passwd.pdf', 'application/pdf', 10)$q$, '22023', 'file_name');
  -- The insert guard's own pre-check (a direct insert), before the CHECK could put the name in the log.
  perform pg_temp.expect_error(format($q$insert into public.files (company_id, name, mime, size) values ('35000000-0000-0000-0000-0000000000a1', %L, 'application/pdf', 10)$q$,
    'MARK7' || chr(8238) || 'fdp.exe'), '22023', 'file_name', 'MARK7');
  foreach cp in array array[0, 10485761, -1] loop
    perform pg_temp.expect_error(format($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'x.pdf', 'application/pdf', %s)$q$, cp), '22023', 'file_size');
  end loop;
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'x.pdf', 'application/pdf', null)$q$, '22023', 'file_size');
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'x.html', 'text/html', 10)$q$, '22023', 'file_type');
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'x.docm', 'application/vnd.ms-word.document.macroEnabled.12', 10)$q$, '22023', 'file_type');
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a1', 'x.svg', 'image/svg+xml', 10)$q$, '22023', 'file_type');
  perform pg_temp.expect_error($q$insert into public.files (company_id, name, mime, size) values ('35000000-0000-0000-0000-0000000000a1', 'x.pdf', 'text/html', 10)$q$, '22023', 'file_type');
  perform pg_temp.expect_error($q$select public.begin_file_upload(gen_random_uuid(), 'x.pdf', 'application/pdf', 10)$q$, 'P0002');
end $$;

-- 11. Limits: 5 waiting, 30 an hour, the team's space (threat 25) ----------------------------------------------------
-- sixth_pending_refused: h1 has one waiting upload (section 5); four more, then the sixth is refused.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f5', 'aal2', 30); end $$;
do $$
declare
  ids uuid[] := array[current_setting('t.h0')::uuid];
  i int;
begin
  for i in 1..4 loop
    ids := ids || (public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'p' || i || '.pdf', 'application/pdf', 10) ->> 'id')::uuid;
  end loop;
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'p6.pdf', 'application/pdf', 10)$q$, '22023', 'too_many_pending');
  perform pg_temp.expect_error($q$insert into public.files (company_id, name, mime, size) values ('35000000-0000-0000-0000-0000000000a2', 'p6.pdf', 'application/pdf', 10)$q$, '22023', 'too_many_pending');
  for i in 1..5 loop
    perform public.abort_file_upload(ids[i]);
    perform public.finish_file_delete(ids[i]);
  end loop;
  -- thirty_first_upload_refused: 5 begun so far this hour (deleted rows still count); 25 more, then the 31st is refused.
  for i in 1..25 loop
    ids[1] := (public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'r' || i || '.pdf', 'application/pdf', 10) ->> 'id')::uuid;
    perform public.abort_file_upload(ids[1]);
    perform public.finish_file_delete(ids[1]);
  end loop;
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'r31.pdf', 'application/pdf', 10)$q$, '22023', 'rate_limited');
end $$;
reset role;
-- The team's space, lowered for this test to what is stored now plus 12 MiB (private.file_quota_bytes is a function so
-- that a test can do this; restored below).
do $$
declare used bigint := private.org_storage_bytes(current_setting('t.org')::uuid);
begin
  perform set_config('t.used', used::text, false);
  execute format('create or replace function private.file_quota_bytes() returns bigint language sql stable set search_path = %L as %L',
                 '', format('select %s::bigint', used + 12582912));
end $$;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2', 30); end $$;
do $$
declare
  big jsonb;
  small jsonb;
begin
  -- declared_1_byte_counted_at_real_size: declares 1 byte, stores 9 MiB. The space counts the 9 MiB.
  big := public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'liar.pdf', 'application/pdf', 1);
  perform pg_temp.put(big ->> 'path', 9437184, 'application/pdf');
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'four.pdf', 'application/pdf', 4194304)$q$, '22023', 'quota');
  -- 2 MiB fits (9 + 2 <= 12); then that reservation counts too: 2 MiB more does not (9 + 2 + 2 > 12).
  small := public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'two.pdf', 'application/pdf', 2097152);
  perform pg_temp.expect_error($q$select public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'two.pdf', 'application/pdf', 2097152)$q$, '22023', 'quota');
  -- The liar's upload can never finish (its stored size is not the declared one).
  perform pg_temp.expect_error(format('select public.finish_file_upload(%L)', big ->> 'id'), '22023', 'object_mismatch');
  perform public.abort_file_upload((big ->> 'id')::uuid);
  delete from storage.objects where name = big ->> 'path';
  perform public.finish_file_delete((big ->> 'id')::uuid);
  perform public.abort_file_upload((small ->> 'id')::uuid);
  perform public.finish_file_delete((small ->> 'id')::uuid);
  -- Space freed: 10 MiB fits again.
  small := public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'ten.pdf', 'application/pdf', 10485760);
  perform public.abort_file_upload((small ->> 'id')::uuid);
  perform public.finish_file_delete((small ->> 'id')::uuid);
end $$;
reset role;
create or replace function private.file_quota_bytes() returns bigint language sql stable set search_path = '' as $$
  select 838860800::bigint
$$;

-- 12. A lead with files is not deleted; undoing an import keeps a lead with a file (threat 31) -----------------------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  batch uuid;
  r jsonb;
begin
  -- lead_with_files_delete_refused_23503 (the app words it "Delete this lead's files first").
  perform pg_temp.expect_error($q$delete from public.companies where id = '35000000-0000-0000-0000-0000000000a1'$q$, '23503');
  -- import_undo_keeps_lead_with_file
  batch := public.create_lead_import('day4d-file.csv', null, 2, 3);
  perform public.stage_lead_import_rows(batch, '[{"row_no": 2, "name": "Day4d Import One", "lead_status": "cold"},
                                                 {"row_no": 3, "name": "Day4d Import Two", "lead_status": "cold"}]');
  perform public.validate_lead_import(batch);
  r := public.commit_lead_import(batch);
  if r ->> 'status' is distinct from 'imported' then raise exception 'FAIL: import %', r; end if;
  perform public.begin_file_upload((select id from public.companies where import_batch_id = batch and name = 'Day4d Import One'),
                                   'quote.pdf', 'application/pdf', 10);
  r := public.preview_lead_import_rollback(batch);
  if r is distinct from '{"tagged": 2, "removable": 1, "kept": 1}'::jsonb then raise exception 'FAIL: undo preview with a file %', r; end if;
  r := public.rollback_lead_import(batch);
  if r ->> 'status' is distinct from 'rolled_back'
     or not exists (select 1 from public.companies where import_batch_id = batch and name = 'Day4d Import One')
     or exists (select 1 from public.companies where import_batch_id = batch and name = 'Day4d Import Two') then
    raise exception 'FAIL: import_undo_keeps_lead_with_file: %', r;
  end if;
end $$;
reset role;

\echo 'files_attack: all checks passed'
