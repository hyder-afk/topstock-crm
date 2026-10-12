-- Day 4d: files on a lead (design docs/evidence/day4/design.md sections 3.4, 4.3, 5.7, 6 rows 20 to 25 and 31, and
-- Haider's answer to open question 6: PDF, PNG, JPG, Word and Excel only, 10 MB a file, 800 MB for the team, the content
-- checked when it is uploaded and every time it is opened). Before this migration the dev database had no file rows
-- (the migration refuses to run otherwise, since files move from contacts to leads).
-- What changes, in plain words:
--  - a file belongs to a lead (not a contact); a lead with files cannot be deleted until its files are (no lost bytes);
--  - the server builds the storage path from ids and the file's type (never from its name), and keeps every other
--    server column; clients write only the lead, the name, the type and the size, and then only the status;
--  - an upload is "pending" until the stored object's real size and type match what was declared ("ready"); deleting a
--    ready file needs a fresh authenticator code, checked here in the database (spike S2's fallback: it never relies
--    on the storage service passing the code's time to its policies);
--  - at most 5 uploads waiting and 30 uploads an hour per person, and 800 MiB for the team, counted from the real
--    stored bytes (not from what the browser declares), under a lock so two uploads cannot both take the last space;
--  - a private bucket with three exact policies (read, add, remove; no update, so no overwrite, upsert or move); each
--    checks the organisation folder AND the matching file row, so the file rules above decide;
--  - opening a file is audited ("file_access").
-- House rules (design section 3): search_path = '' everywhere; the RPCs are SECURITY INVOKER with static SQL; DEFINER
-- only for the insert guard (it must see the whole team's usage), which is trigger-only and revoked, and for the one
-- private audit helper; constant-message pre-checks before every CHECK user input can reach; column grants only.
-- Storage (spike S1): every reference to storage.* sits in plpgsql (checked when it runs, not when it is created), and
-- the bucket row and its policies are created only when the storage schema is there (it is on Supabase and in CI with
-- storage-api; supabase/tests/shim.sql provides a stand-in for the local test runners). files_attack.sql fails loudly
-- when the bucket or the policies are missing.
-- REBASE: re-copy after 4c merges (private.lead_import_untouched is redefined here; 4c may redefine it too).

do $$
begin
  if exists (select 1 from public.files) then
    raise exception 'public.files has rows: move them to their lead by hand before this migration';
  end if;
end;
$$;

-- ===========================================================================
-- Part 1. The files table (G4, G5)
-- ===========================================================================
-- The type's extension, from the type alone (the name never decides the stored extension). Null for any other type.
create function private.file_ext(p_mime text) returns text
language sql immutable set search_path = '' as $$
  select case p_mime
    when 'application/pdf' then 'pdf'
    when 'image/png' then 'png'
    when 'image/jpeg' then 'jpg'
    when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then 'docx'
    when 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' then 'xlsx'
  end
$$;

-- A file name the app shows: 1 to 180 characters, no control, invisible or bidi character (Day 3b's list for import
-- file names), no slash, backslash or double quote. Code point ranges, so the rule is the same under any locale.
create function private.file_name_ok(p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(char_length(p_name) between 1 and 180 and p_name !~
    '[\u0001-\u001F\u007F-\u009F؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿￹-￻\U000E0000-\U000E007F/\\"]', false)
$$;

-- The team's space (800 MiB on the free plan's 1 GiB). A function, so a test can lower it for one run.
create function private.file_quota_bytes() returns bigint
language sql stable set search_path = '' as $$
  select 838860800::bigint
$$;

-- The stored object's size and type, as storage-api writes them into storage.objects.metadata (spike S4: the key names
-- live here only; if the pinned image uses others, these two lines change and nothing else).
create function private.object_size(p_metadata jsonb) returns bigint
language sql immutable set search_path = '' as $$
  select case when (p_metadata ->> 'size') ~ '^[0-9]{1,12}$' then (p_metadata ->> 'size')::bigint end
$$;
create function private.object_mime(p_metadata jsonb) returns text
language sql immutable set search_path = '' as $$
  select p_metadata ->> 'mimetype'
$$;

drop policy files_rw on public.files;
alter table public.files
  drop column contact_id,                                       -- files belong to the lead (0 rows, checked above)
  add column company_id uuid not null references public.companies (id) on delete restrict,   -- no orphaned bytes
  add column name text not null constraint files_name_check check (char_length(name) between 1 and 180 and name !~
    '[\u0001-\u001F\u007F-\u009F؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿￹-￻\U000E0000-\U000E007F/\\"]'),
  add column status text not null default 'pending' constraint files_status_check check (status in ('pending', 'ready', 'deleting')),
  add column ready_at timestamptz,
  add constraint files_ready_has_time check (status <> 'ready' or ready_at is not null);
alter table public.files drop constraint files_size_check, add constraint files_size_check check (size between 1 and 10485760);
alter table public.files add constraint files_path_shape check (storage_path ~
  '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|png|jpg|docx|xlsx)$');      -- org/lead/file.ext
create index files_company_idx on public.files (company_id);
create index files_company_ready_idx on public.files (company_id, created_at desc, id desc) where status = 'ready';
create index files_pending_idx on public.files (uploaded_by, created_at) where status = 'pending';
create index files_org_pending_idx on public.files (org_id, created_at) where status = 'pending';

-- Clients name only these columns. The id, path, status on insert, uploader, org and times are the server's.
revoke insert, update, delete on public.files from authenticated;
grant insert (company_id, name, mime, size), update (status), delete on public.files to authenticated;

-- ===========================================================================
-- Part 2. Guards
-- ===========================================================================
-- Space used by an organisation in the bucket: the real stored bytes (storage.objects.metadata), whatever the rows say.
-- plpgsql so the migration applies before the storage schema exists (spike S1). Called only by the insert guard.
create function private.org_storage_bytes(p_org uuid) returns bigint
language plpgsql stable set search_path = '' as $$
begin
  return coalesce((select sum(coalesce(private.object_size(o.metadata), 0))
                     from storage.objects o
                    where o.bucket_id = 'lead-files'
                      and o.name >= p_org::text || '/' and o.name < p_org::text || '0'), 0);   -- '0' follows '/'
end;
$$;

-- BEFORE INSERT (after enforce_org_and_owner, by name). DEFINER so the space and rate sums see the whole team's rows; it
-- returns nothing about them (only a constant error). A session the policies refuse anyway (no two-factor, or a lead
-- outside its organisation) gets no checks here, so it learns nothing (row level security then refuses it). Sessions
-- with no signed-in user (fixtures, maintenance) keep what they give; the path is built if they give none.
create function private.file_guard_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_ext text := private.file_ext(new.mime);
  v_reserved bigint;
begin
  if caller is null then
    new.storage_path := coalesce(new.storage_path,
      new.org_id::text || '/' || new.company_id::text || '/' || new.id::text || '.' || v_ext);
    return new;
  end if;
  new.id := gen_random_uuid();
  new.status := 'pending';
  new.ready_at := null;
  new.uploaded_by := caller;
  new.created_at := now();
  new.updated_at := now();
  -- Constant errors before any CHECK can fire (no "Failing row contains" with a file name in the log).
  if v_ext is null then
    raise exception 'PDF, PNG, JPG, Word or Excel files only' using errcode = '22023', hint = 'file_type';
  end if;
  if new.size is null or new.size not between 1 and 10485760 then
    raise exception 'a file is 1 byte to 10 MB' using errcode = '22023', hint = 'file_size';
  end if;
  if not private.file_name_ok(new.name) then
    raise exception 'this file name cannot be stored' using errcode = '22023', hint = 'file_name';
  end if;
  if new.company_id is null then
    raise exception 'a file belongs to a lead' using errcode = '22023', hint = 'file_lead';
  end if;
  new.storage_path := new.org_id::text || '/' || new.company_id::text || '/' || new.id::text || '.' || v_ext;
  if not (select private.has_aal2())
     or not exists (select 1 from public.companies c where c.id = new.company_id and c.org_id = new.org_id) then
    return new;
  end if;
  -- One upload at a time per organisation decides on the space (two uploads cannot both take the last of it).
  perform pg_advisory_xact_lock(hashtextextended('files:' || new.org_id::text, 0));
  if (select count(*) from public.files f
       where f.uploaded_by = caller and f.status = 'pending' and f.created_at > now() - interval '15 minutes') >= 5 then
    raise exception 'too many uploads waiting' using errcode = '22023', hint = 'too_many_pending';
  end if;
  -- Uploads started in the last hour, from the audit log (a row deleted since still counts).
  if (select count(*) from public.audit_log l
       where l.org_id = new.org_id and l.created_at > now() - interval '1 hour'
         and l.table_name = 'files' and l.action = 'insert' and l.actor_id = caller) >= 30 then
    raise exception 'too many uploads this hour' using errcode = '22023', hint = 'rate_limited';
  end if;
  -- Space: the real stored bytes, plus what uploads of the last 15 minutes still waiting for their bytes declared.
  select coalesce(sum(f.size), 0) into v_reserved
    from public.files f
   where f.org_id = new.org_id and f.status = 'pending' and f.created_at > now() - interval '15 minutes'
     and not exists (select 1 from storage.objects o where o.bucket_id = 'lead-files' and o.name = f.storage_path);
  if private.org_storage_bytes(new.org_id) + v_reserved + new.size > private.file_quota_bytes() then
    raise exception 'the team''s file space is full' using errcode = '22023', hint = 'quota';
  end if;
  return new;
end;
$$;
create trigger file_guard_insert before insert on public.files
  for each row execute function private.file_guard_insert();

-- BEFORE UPDATE (INVOKER). Only the status changes, and only by these moves:
--   pending -> ready     the uploader, once the stored object's real size and type are the declared ones;
--   pending -> deleting  the uploader (an abandoned or cancelled upload);
--   ready -> deleting    whoever may change the row (row level security: uploader, lead owner, manager, admin) with an
--                        authenticator code from the last 10 minutes (step-up, design F3; spike S2's fallback).
create function private.file_guard_update() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  keep constant text[] := array['status', 'ready_at', 'updated_at'];
begin
  if caller is null then
    return new;
  end if;
  if (to_jsonb(new) - keep) is distinct from (to_jsonb(old) - keep) then
    raise exception 'only the status of a file changes' using errcode = '42501';
  end if;
  new.ready_at := old.ready_at;
  if new.status = old.status then
    return new;
  end if;
  if old.status = 'pending' and new.status = 'ready' then
    if old.uploaded_by is distinct from caller then
      raise exception 'only the uploader finishes an upload' using errcode = '42501';
    end if;
    if not exists (select 1 from storage.objects o
                    where o.bucket_id = 'lead-files' and o.name = old.storage_path
                      and private.object_size(o.metadata) = old.size
                      and private.object_mime(o.metadata) = old.mime) then
      raise exception 'the stored file is not the one declared' using errcode = '22023', hint = 'object_mismatch';
    end if;
    new.ready_at := now();
  elsif old.status = 'pending' and new.status = 'deleting' then
    if old.uploaded_by is distinct from caller then
      raise exception 'only the uploader cancels an upload' using errcode = '42501';
    end if;
  elsif old.status = 'ready' and new.status = 'deleting' then
    if not (select private.has_recent_aal2(600)) then
      raise exception 'confirm it is you first' using errcode = '42501', hint = 'step_up';
    end if;
  else
    raise exception 'a file cannot move back' using errcode = '22023', hint = 'state';
  end if;
  return new;
end;
$$;
create trigger file_guard_update before update on public.files
  for each row execute function private.file_guard_update();

-- BEFORE DELETE (INVOKER): only a file being deleted, once its stored object is gone (no orphaned bytes).
create function private.file_guard_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    return old;
  end if;
  if old.status <> 'deleting'
     or exists (select 1 from storage.objects o where o.bucket_id = 'lead-files' and o.name = old.storage_path) then
    raise exception 'remove the stored file first' using errcode = '22023', hint = 'state';
  end if;
  return old;
end;
$$;
create trigger file_guard_delete before delete on public.files
  for each row execute function private.file_guard_delete();

-- ===========================================================================
-- Part 3. Who sees and changes a file (D11: as today)
-- ===========================================================================
-- The uploader sees their own files in every state; once ready, the lead's owner, managers and admins see them too.
create policy files_select on public.files for select to authenticated using (
  org_id = (select private.current_org_id()) and (
       uploaded_by = (select auth.uid())
    or (status in ('ready', 'deleting') and ((select private.is_manager_or_admin())
        or exists (select 1 from public.companies c where c.id = files.company_id and c.owner_id = (select auth.uid()))))));
-- Anyone in the organisation may add a file to any lead of it (every lead is visible to the team).
create policy files_insert on public.files for insert to authenticated with check (
  org_id = (select private.current_org_id())
  and exists (select 1 from public.companies c where c.id = files.company_id));
-- The uploader, the lead's owner, managers and admins; the guards hold the rules of each move.
create policy files_update on public.files for update to authenticated
  using (org_id = (select private.current_org_id()) and (uploaded_by = (select auth.uid()) or (select private.is_manager_or_admin())
         or exists (select 1 from public.companies c where c.id = files.company_id and c.owner_id = (select auth.uid()))))
  with check (org_id = (select private.current_org_id()) and (uploaded_by = (select auth.uid()) or (select private.is_manager_or_admin())
         or exists (select 1 from public.companies c where c.id = files.company_id and c.owner_id = (select auth.uid()))));
create policy files_delete on public.files for delete to authenticated using (
  org_id = (select private.current_org_id()) and (uploaded_by = (select auth.uid()) or (select private.is_manager_or_admin())
  or exists (select 1 from public.companies c where c.id = files.company_id and c.owner_id = (select auth.uid()))));

-- ===========================================================================
-- Part 4. The bucket and its policies (no UPDATE policy: no overwrite, upsert or move)
-- ===========================================================================
-- Each policy checks the organisation folder (a second, independent fence) and the matching file row, read under the
-- caller's own row level security, so the file rules above decide. Reading also serves storage-api's RETURNING after an
-- upload (the uploader sees their own pending row). Created only when the storage schema exists (spike S1).
do $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise notice 'storage schema missing: bucket lead-files and its policies not created (spike S1)';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('lead-files', 'lead-files', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                                 allowed_mime_types = excluded.allowed_mime_types;
  execute $p$create policy lead_files_select on storage.objects for select to authenticated using (
    bucket_id = 'lead-files' and (select private.has_aal2())
    and (storage.foldername(name))[1] = (select private.current_org_id())::text
    and exists (select 1 from public.files f where f.storage_path = objects.name))$p$;
  execute $p$create policy lead_files_insert on storage.objects for insert to authenticated with check (
    bucket_id = 'lead-files' and (select private.has_aal2())
    and (storage.foldername(name))[1] = (select private.current_org_id())::text
    and exists (select 1 from public.files f where f.storage_path = objects.name and f.status = 'pending'
                and f.uploaded_by = (select auth.uid()) and f.created_at > now() - interval '15 minutes'))$p$;
  execute $p$create policy lead_files_delete on storage.objects for delete to authenticated using (
    bucket_id = 'lead-files' and (select private.has_aal2())
    and (storage.foldername(name))[1] = (select private.current_org_id())::text
    and exists (select 1 from public.files f where f.storage_path = objects.name and f.status = 'deleting'))$p$;
end;
$$;

-- ===========================================================================
-- Part 5. Audit and import undo (G7)
-- ===========================================================================
alter table public.audit_log drop constraint audit_log_action_check,
  add constraint audit_log_action_check check (action in ('insert', 'update', 'delete', 'role_change', 'file_access'));

-- One "file_access" row per open. DEFINER (the audit log has no insert grant); private, so it has no API endpoint;
-- open_file calls it after reading the file under the caller's row level security. Only a ready file of the caller's
-- organisation, in a two-factor session.
create function private.audit_file_access(p_file uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.current_org_id();
begin
  if (select auth.uid()) is null or not private.has_aal2() or v_org is null then
    return;
  end if;
  insert into public.audit_log (org_id, actor_id, action, table_name, record_id, diff_json)
  select f.org_id, (select auth.uid()), 'file_access', 'files', f.id::text, '{}'::jsonb
    from public.files f
   where f.id = p_file and f.org_id = v_org and f.status = 'ready';
end;
$$;

-- Import undo: a lead with a file has been worked on, so an undo keeps it (and its bytes). Day 4a's definition plus files.
-- REBASE: re-copy after 4c merges.
create or replace function private.lead_import_untouched(p_batch uuid, p_limit integer) returns setof uuid
language sql stable set search_path = '' as $$
  select c.id from public.companies c
   where c.import_batch_id = p_batch and c.updated_at = c.created_at
     and not exists (select 1 from public.activities a where a.company_id = c.id)
     and not exists (select 1 from public.contacts k where k.company_id = c.id)
     and not exists (select 1 from public.deals d where d.company_id = c.id)
     and not exists (select 1 from public.tasks t where t.company_id = c.id)
     and not exists (select 1 from public.files f where f.company_id = c.id)
   order by c.id
   limit p_limit
$$;

-- ===========================================================================
-- Part 6. RPCs (SECURITY INVOKER, static SQL; design 4.3)
-- ===========================================================================
-- Start an upload: first the caller's own uploads left pending for over 15 minutes become "deleting" (their paths come
-- back for clean-up: remove the object, then finish_file_delete), then the new row. Returns {id, path, stale_paths}.
create function public.begin_file_upload(p_company uuid, p_name text, p_mime text, p_size integer) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_stale text[];
  v_id uuid;
  v_path text;
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if private.file_ext(p_mime) is null then
    raise exception 'PDF, PNG, JPG, Word or Excel files only' using errcode = '22023', hint = 'file_type';
  end if;
  if p_size is null or p_size not between 1 and 10485760 then
    raise exception 'a file is 1 byte to 10 MB' using errcode = '22023', hint = 'file_size';
  end if;
  if not private.file_name_ok(p_name) then
    raise exception 'this file name cannot be stored' using errcode = '22023', hint = 'file_name';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company) then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  with stale as (
    update public.files f set status = 'deleting'
     where f.id in (select s.id from public.files s
                     where s.uploaded_by = (select auth.uid()) and s.status = 'pending'
                       and s.created_at <= now() - interval '15 minutes'
                     order by s.created_at limit 20)
    returning f.storage_path)
  select coalesce(array_agg(storage_path), '{}') into v_stale from stale;
  insert into public.files (company_id, name, mime, size) values (p_company, p_name, p_mime, p_size)
  returning id, storage_path into v_id, v_path;
  return jsonb_build_object('id', v_id, 'path', v_path, 'stale_paths', to_jsonb(v_stale));
end;
$$;

-- The caller's own pending upload, for the server's check at finish: {path, mime, size}.
create function public.get_pending_upload(p_id uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  r jsonb;
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  select jsonb_build_object('path', f.storage_path, 'mime', f.mime, 'size', f.size) into r
    from public.files f
   where f.id = p_id and f.uploaded_by = (select auth.uid()) and f.status = 'pending';
  if r is null then
    raise exception 'upload not found' using errcode = 'P0002';
  end if;
  return r;
end;
$$;

-- Finish an upload: the guard checks the stored object's real size and type (hint object_mismatch otherwise).
create function public.finish_file_upload(p_id uuid) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  r jsonb;
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  update public.files f set status = 'ready'
   where f.id = p_id and f.uploaded_by = (select auth.uid()) and f.status = 'pending'
  returning jsonb_build_object('id', f.id, 'name', f.name, 'mime', f.mime, 'size', f.size,
                               'created_at', f.created_at, 'ready_at', f.ready_at) into r;
  if r is null then
    raise exception 'upload not found' using errcode = 'P0002';
  end if;
  return r;
end;
$$;

-- Cancel one's own pending upload: it becomes "deleting"; returns its path (remove the object, then finish_file_delete).
create function public.abort_file_upload(p_id uuid) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_path text;
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  update public.files f set status = 'deleting'
   where f.id = p_id and f.uploaded_by = (select auth.uid()) and f.status = 'pending'
  returning f.storage_path into v_path;
  if v_path is null then
    raise exception 'upload not found' using errcode = 'P0002';
  end if;
  return v_path;
end;
$$;

-- A lead's files, newest first, 1 to 100 a page (keyset on created_at, id): ready files the caller can see, plus files
-- stuck in "deleting" for their uploader and for managers and admins ("Couldn't finish deleting · Retry").
create function public.list_lead_files(
  p_company uuid,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid, name text, mime text, size integer, status text, uploaded_by uuid, uploader_first_name text,
  uploader_last_name text, created_at timestamptz, is_mine boolean, can_delete boolean
)
language plpgsql stable set search_path = '' as $$
declare
  v_me constant uuid := (select auth.uid());
  v_boss boolean;
  v_owner uuid;
begin
  if v_me is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'between 1 and 100 files a page' using errcode = '22023', hint = 'bounds';
  end if;
  if (p_before_at is null) <> (p_before_id is null) then
    raise exception 'a cursor needs both parts' using errcode = '22023', hint = 'bad_cursor';
  end if;
  v_boss := (select private.is_manager_or_admin());
  select c.owner_id into v_owner from public.companies c where c.id = p_company;
  return query
    select f.id, f.name, f.mime, f.size, f.status, f.uploaded_by, p.first_name, p.last_name, f.created_at,
           coalesce(f.uploaded_by = v_me, false), coalesce(f.uploaded_by = v_me or v_boss or v_owner = v_me, false)
      from public.files f
      left join public.profiles p on p.id = f.uploaded_by
     where f.company_id = p_company
       and (f.status = 'ready' or (f.status = 'deleting' and (f.uploaded_by = v_me or v_boss)))
       and (p_before_at is null or (f.created_at, f.id) < (p_before_at, p_before_id))
     order by f.created_at desc, f.id desc
     limit p_limit;
end;
$$;

-- Open a ready file the caller can see: {path, name, mime}; writes the file_access audit row. The server then checks
-- the stored bytes again (every open) and answers with a 60-second link.
create function public.open_file(p_id uuid) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  r jsonb;
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  select jsonb_build_object('path', f.storage_path, 'name', f.name, 'mime', f.mime) into r
    from public.files f
   where f.id = p_id and f.status = 'ready';
  if r is null then
    raise exception 'file not found' using errcode = 'P0002';
  end if;
  perform private.audit_file_access(p_id);
  return r;
end;
$$;

-- Start deleting a file: ready -> deleting needs a fresh code (the guard, hint step_up); a pending one of the caller's
-- moves without one; one already "deleting" (a retry) just returns its path. Then: remove the object, finish_file_delete.
create function public.begin_file_delete(p_id uuid) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_status text;
  v_path text;
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  select f.status, f.storage_path into v_status, v_path from public.files f where f.id = p_id;
  if not found then
    raise exception 'file not found' using errcode = 'P0002';
  end if;
  if v_status = 'deleting' then
    return v_path;
  end if;
  if v_status = 'ready' and not (select private.has_recent_aal2(600)) then
    raise exception 'confirm it is you first' using errcode = '42501', hint = 'step_up';
  end if;
  update public.files f set status = 'deleting' where f.id = p_id and f.status = v_status returning f.storage_path into v_path;
  if not found then
    raise exception 'not yours to delete' using errcode = '42501';
  end if;
  return v_path;
end;
$$;

-- Finish deleting: the row goes once its stored object is gone (the guard, hint state otherwise).
create function public.finish_file_delete(p_id uuid) returns void
language plpgsql volatile set search_path = '' as $$
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.files f where f.id = p_id) then
    raise exception 'file not found' using errcode = 'P0002';
  end if;
  delete from public.files f where f.id = p_id;
  if not found then
    raise exception 'not yours to delete' using errcode = '42501';
  end if;
end;
$$;

-- The team's space used by ready files (their sizes were checked against the stored bytes at finish). Managers and
-- admins only (they see every ready file); null for everyone else.
create function public.file_usage() returns bigint
language plpgsql stable set search_path = '' as $$
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if not (select private.is_manager_or_admin()) then
    return null;
  end if;
  return (select coalesce(sum(f.size), 0)::bigint from public.files f where f.status = 'ready');
end;
$$;

-- ===========================================================================
-- Function privileges: trigger functions and the space sum are never callable by clients; the helpers the RPCs and
-- invoker guards use are callable by signed-in people (private has no API endpoint); every RPC is revoked from public
-- and anon and granted to authenticated.
-- ===========================================================================
revoke all on function private.file_guard_insert(), private.file_guard_update(), private.file_guard_delete(),
  private.org_storage_bytes(uuid) from public, anon, authenticated;
revoke all on function private.file_ext(text), private.file_name_ok(text), private.file_quota_bytes(),
  private.object_size(jsonb), private.object_mime(jsonb), private.audit_file_access(uuid) from public, anon;
grant execute on function private.file_ext(text), private.file_name_ok(text), private.file_quota_bytes(),
  private.object_size(jsonb), private.object_mime(jsonb), private.audit_file_access(uuid) to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.begin_file_upload(uuid, text, text, integer)',
    'public.get_pending_upload(uuid)',
    'public.finish_file_upload(uuid)',
    'public.abort_file_upload(uuid)',
    'public.list_lead_files(uuid, timestamptz, uuid, integer)',
    'public.open_file(uuid)',
    'public.begin_file_delete(uuid)',
    'public.finish_file_delete(uuid)',
    'public.file_usage()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
