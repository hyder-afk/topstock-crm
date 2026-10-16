-- Day 7c: the orphan sweeper's database part (docs/evidence/day7/plan.md section 3, on day7-local; Haider 15 Oct 2026,
-- question 2: "orphan sweeper runs from topstock-ops with its own key; dry-run week first").
-- Sorts after Day 7a's migration (20261021100000_day7a_security), the newest on day7a-local.
--
-- The job: find objects in the lead-files bucket that have NO files row at all (any status) and are older than a grace
-- period, so a scheduled GitHub Action in topstock-ops can remove them through the Storage API with its own secret key.
-- Today one path makes them (spike S5: a signed upload link made before Cancel still stores bytes); no person can see or
-- delete them, and they count toward the team's 800 MiB (private.org_storage_bytes sums the bucket's real bytes).
-- SQL cannot remove the bytes (storage.protect_delete refuses direct deletes, and deleting a row would leave the file in
-- object storage), so this migration only LISTS and RECORDS; the Storage API deletes (scripts/ops/sweep-lead-files.mjs).
--
-- What changes, in plain words:
--  - public.lead_file_orphans(p_min_age, p_limit): the candidates, oldest first. Only names in the exact shape the files
--    guard builds (org/lead/file.ext, real lowercase UUIDs), created before now() - p_min_age (24 hours at least), with
--    no files row of any status for that path. Never another bucket.
--  - public.lead_file_sweep_stats(): counts for the script's sanity check (objects and bytes in the bucket, files rows,
--    names outside the shape: counted here, never returned for deletion).
--  - public.record_file_sweep(...): one audit_log row per run, action 'file_sweep', counts only (no names, no org ids).
--  - Deny by default: all three are SECURITY INVOKER with search_path '', static SQL, revoked from public, anon and
--    authenticated, and granted to service_role only (the sweeper's own secret key maps to it). service_role gets
--    exactly the column privileges they read or write (on Supabase it holds more by default; the local test runner's
--    stand-in role holds only these). No new table, so no new policy: audit_log keeps its row level security (the
--    sweep row has no organisation, so no person in the app reads it), and service_role bypasses RLS by design.
--  - Grace period 24 hours: a signed upload link lives 2 hours, a pending row 15 minutes, and take_stale_uploads waits
--    for the uploader's next visit; pending, ready and deleting rows all have a files row, so their objects are never
--    candidates. A caller cannot ask for less than 24 hours.
-- Every reference to storage.* sits in plpgsql (checked when it runs, not when it is created: spike S1).
-- Tests: supabase/tests/sweeper_attack.sql; mutation rows: scripts/db-mutations.py --set day7c.

alter table public.audit_log drop constraint audit_log_action_check,
  add constraint audit_log_action_check
  check (action in ('insert', 'update', 'delete', 'role_change', 'file_access', 'sign_in', 'mfa_verify', 'file_sweep'));

-- ---------------------------------------------------------------------------
-- 1. The candidates
-- ---------------------------------------------------------------------------
-- The size is read as private.org_storage_bytes reads it (a JSON number under storage-api's 'size' key, spike S4;
-- private.object_size_key() holds the same name), inline so service_role needs no access to schema private.
create function public.lead_file_orphans(p_min_age interval default interval '24 hours', p_limit integer default 200)
returns table (name text, org_id uuid, size bigint, created_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
begin
  if p_min_age is null or p_min_age < interval '24 hours' or p_min_age > interval '365 days' then
    raise exception 'the grace period is 24 hours to 365 days' using errcode = '22023', hint = 'bounds';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'between 1 and 1000 objects a call' using errcode = '22023', hint = 'bounds';
  end if;
  return query
    select o.name::text,
           split_part(o.name, '/', 1)::uuid,
           case when jsonb_typeof(o.metadata -> 'size') = 'number' then (o.metadata ->> 'size')::numeric::bigint else 0 end,
           o.created_at
      from storage.objects o
     where o.bucket_id = 'lead-files'
       and o.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg|docx|xlsx)$'
       and o.created_at < now() - p_min_age
       and not exists (select 1 from public.files f where f.storage_path = o.name)
     order by o.created_at, o.name
     limit p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The sanity counts
-- ---------------------------------------------------------------------------
-- The script stops when the bucket holds objects but the database reports no files rows at all (a fault that hid every
-- row would otherwise make every object a candidate). odd_names: objects whose name is outside the shape above; they are
-- reported, never swept.
create function public.lead_file_sweep_stats()
returns table (bucket_objects bigint, bucket_bytes bigint, file_rows bigint, odd_names bigint)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
begin
  return query
    select count(*)::bigint,
           coalesce(sum(case when jsonb_typeof(o.metadata -> 'size') = 'number'
                             then (o.metadata ->> 'size')::numeric else 0 end), 0)::bigint,
           (select count(*) from public.files f)::bigint,
           count(*) filter (where o.name is null or o.name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg|docx|xlsx)$')::bigint
      from storage.objects o
     where o.bucket_id = 'lead-files';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The run's audit row (counts only)
-- ---------------------------------------------------------------------------
-- p_found: candidates listed; p_removed: objects the Storage API confirmed removed (0 in a dry run); p_bytes: their bytes
-- (in a dry run, the bytes found). No organisation, no actor, no record id: nothing that names a lead or a file.
create function public.record_file_sweep(p_found integer, p_removed integer, p_bytes bigint, p_dry boolean)
returns void
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if p_found is null or p_removed is null or p_bytes is null or p_dry is null
     or p_found not between 0 and 100000 or p_removed not between 0 and p_found
     or p_bytes not between 0 and 1099511627776 or (p_dry and p_removed <> 0) then
    raise exception 'sweep counts out of range' using errcode = '22023', hint = 'bounds';
  end if;
  insert into public.audit_log (action, table_name, diff_json)
  values ('file_sweep', 'storage.objects',
          jsonb_build_object('found', p_found, 'removed', p_removed, 'bytes', p_bytes, 'dry_run', p_dry));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Privileges: service_role only
-- ---------------------------------------------------------------------------
revoke all on function public.lead_file_orphans(interval, integer), public.lead_file_sweep_stats(),
  public.record_file_sweep(integer, integer, bigint, boolean) from public, anon, authenticated;
grant execute on function public.lead_file_orphans(interval, integer), public.lead_file_sweep_stats(),
  public.record_file_sweep(integer, integer, bigint, boolean) to service_role;
-- What the three read and write as service_role (they run as their caller).
grant select (storage_path) on public.files to service_role;
grant insert (action, table_name, diff_json) on public.audit_log to service_role;
