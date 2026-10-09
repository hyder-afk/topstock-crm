-- TopStock CRM: core schema (Master Plan section 6, R1 core) with RLS on every table.
-- Rules: deny by default; every table has org_id; TOTP MFA (aal2) required for every row (restrictive policy);
-- reps see their own records, managers and admins see everything in their org; anon has no access at all.
-- Inventory tables arrive with the post_stock_movement RPC on Day 6.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Private helpers (not exposed through the API)
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create type public.app_role as enum ('admin', 'manager', 'rep');

-- ---------------------------------------------------------------------------
-- Organisations and profiles
-- ---------------------------------------------------------------------------
create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.orgs (name) values ('TopStock Wholesale');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  org_id uuid not null references public.orgs (id),
  first_name text not null default '' check (char_length(first_name) <= 80),
  last_name text not null default '' check (char_length(last_name) <= 80),
  role public.app_role not null default 'rep',
  language text not null default 'en' check (language in ('en', 'fr')),
  timezone text not null default 'Europe/Paris' check (char_length(timezone) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_org_id_idx on public.profiles (org_id);

create function private.current_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select org_id from public.profiles where id = (select auth.uid())
$$;

create function private.current_app_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = (select auth.uid())
$$;

create function private.is_manager_or_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select role in ('admin', 'manager') from public.profiles where id = (select auth.uid())), false)
$$;

create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select role = 'admin' from public.profiles where id = (select auth.uid())), false)
$$;

create function private.has_aal2() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
$$;

-- ---------------------------------------------------------------------------
-- CRM tables
-- ---------------------------------------------------------------------------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  name text not null check (char_length(name) between 1 and 200),
  website text check (char_length(website) <= 300),
  country text check (char_length(country) <= 2),
  industry text check (char_length(industry) <= 120),
  owner_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index companies_org_owner_idx on public.companies (org_id, owner_id);
create index companies_owner_idx on public.companies (owner_id);
create index companies_name_trgm_idx on public.companies using gin (name extensions.gin_trgm_ops);

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  kind text not null default 'leads' check (kind in ('leads', 'stock')),
  filename text not null check (char_length(filename) <= 255),
  uploaded_by uuid references public.profiles (id) on delete set null,
  row_count integer not null default 0 check (row_count >= 0),
  imported integer not null default 0 check (imported >= 0),
  duplicates integer not null default 0 check (duplicates >= 0),
  rejected integer not null default 0 check (rejected >= 0),
  status text not null default 'staged' check (status in ('staged', 'dry_run', 'imported', 'rolled_back', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index import_batches_org_idx on public.import_batches (org_id);
create index import_batches_uploaded_by_idx on public.import_batches (uploaded_by);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  company_id uuid references public.companies (id) on delete set null,
  first_name text not null default '' check (char_length(first_name) <= 120),
  last_name text not null default '' check (char_length(last_name) <= 120),
  title text check (char_length(title) <= 120),
  email text check (char_length(email) <= 254),
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  whatsapp text check (whatsapp ~ '^\+[1-9][0-9]{6,14}$'),
  country text check (char_length(country) <= 2),
  city text check (char_length(city) <= 120),
  timezone text check (char_length(timezone) <= 64),
  source text check (char_length(source) <= 120),
  -- Values to confirm with Haider (Master Plan 6); a check constraint keeps them easy to change.
  lead_status text not null default 'new'
    check (lead_status in ('new', 'contacted', 'interested', 'not_interested', 'do_not_contact', 'customer')),
  temperature text check (temperature in ('hot', 'warm', 'cold')),
  owner_id uuid references public.profiles (id) on delete set null,
  do_not_contact boolean not null default false,
  last_contacted_at timestamptz,
  next_action_at timestamptz,
  import_batch_id uuid references public.import_batches (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index contacts_org_owner_idx on public.contacts (org_id, owner_id);
create index contacts_owner_idx on public.contacts (owner_id);
create index contacts_company_idx on public.contacts (company_id);
create index contacts_status_idx on public.contacts (org_id, lead_status);
create index contacts_next_action_idx on public.contacts (org_id, next_action_at);
create index contacts_import_batch_idx on public.contacts (import_batch_id);
create index contacts_country_idx on public.contacts (org_id, country);
create index contacts_keyset_idx on public.contacts (org_id, created_at desc, id desc);
create index contacts_name_trgm_idx on public.contacts using gin ((first_name || ' ' || last_name) extensions.gin_trgm_ops);
create index contacts_email_trgm_idx on public.contacts using gin (email extensions.gin_trgm_ops);

create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  name text not null check (char_length(name) between 1 and 60),
  position smallint not null check (position > 0),
  is_won boolean not null default false,
  is_lost boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, position)
);

insert into public.pipeline_stages (org_id, name, position, is_won, is_lost)
select o.id, s.name, s.position, s.is_won, s.is_lost
from public.orgs o
cross join (values
  ('Lead', 1, false, false),
  ('Qualified', 2, false, false),
  ('Negotiations', 3, false, false),
  ('Closed/won', 4, true, false),
  ('Closed/lost', 5, false, true)
) as s (name, position, is_won, is_lost);

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  contact_id uuid references public.contacts (id) on delete set null,
  company_id uuid references public.companies (id) on delete set null,
  stage_id uuid not null references public.pipeline_stages (id),
  value numeric(14, 2) not null default 0 check (value >= 0),
  currency char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  expected_close date,
  owner_id uuid references public.profiles (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'won', 'lost')),
  lost_reason text check (char_length(lost_reason) <= 500),
  fulfilment text not null default 'from_stock' check (fulfilment in ('from_stock', 'direct_from_source')),
  stage_entered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'lost' or lost_reason is not null)
);
create index deals_org_owner_idx on public.deals (org_id, owner_id);
create index deals_owner_idx on public.deals (owner_id);
create index deals_stage_idx on public.deals (stage_id);
create index deals_contact_idx on public.deals (contact_id);
create index deals_company_idx on public.deals (company_id);

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  contact_id uuid references public.contacts (id) on delete cascade,
  deal_id uuid references public.deals (id) on delete cascade,
  type text not null check (type in ('call', 'email', 'whatsapp', 'meeting', 'note')),
  outcome text check (char_length(outcome) <= 60),
  body text check (char_length(body) <= 10000),
  user_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index activities_org_user_idx on public.activities (org_id, user_id);
create index activities_user_idx on public.activities (user_id);
create index activities_contact_idx on public.activities (contact_id, created_at desc);
create index activities_deal_idx on public.activities (deal_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  contact_id uuid references public.contacts (id) on delete cascade,
  deal_id uuid references public.deals (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  due_at timestamptz,
  done_at timestamptz,
  assignee_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_org_assignee_idx on public.tasks (org_id, assignee_id, due_at);
create index tasks_assignee_idx on public.tasks (assignee_id);
create index tasks_contact_idx on public.tasks (contact_id);
create index tasks_deal_idx on public.tasks (deal_id);

create table public.files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  contact_id uuid references public.contacts (id) on delete cascade,
  storage_path text not null unique check (char_length(storage_path) <= 400),
  mime text not null check (mime in (
    'application/pdf', 'image/png', 'image/jpeg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )),
  size integer not null check (size between 1 and 20971520),
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index files_org_idx on public.files (org_id);
create index files_contact_idx on public.files (contact_id);
create index files_uploaded_by_idx on public.files (uploaded_by);

create table public.saved_views (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  user_id uuid not null references public.profiles (id) on delete cascade,
  section text not null check (section in ('leads', 'pipeline', 'inventory', 'tasks')),
  name text not null check (char_length(name) between 1 and 80),
  filters_json jsonb not null default '{}'::jsonb check (pg_column_size(filters_json) <= 8192),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index saved_views_user_idx on public.saved_views (user_id, section);
create index saved_views_org_idx on public.saved_views (org_id);

create table public.audit_log (
  id bigint generated always as identity primary key,
  org_id uuid references public.orgs (id),
  actor_id uuid,
  action text not null check (action in ('insert', 'update', 'delete', 'role_change')),
  table_name text not null,
  record_id text,
  diff_json jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_org_created_idx on public.audit_log (org_id, created_at desc);
create index audit_log_record_idx on public.audit_log (table_name, record_id);

-- ---------------------------------------------------------------------------
-- Triggers: updated_at, server-set org/owner (no mass assignment), audit
-- ---------------------------------------------------------------------------
create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- org_id always comes from the caller's profile, never from the client. Reps can only create and keep
-- records they own; only managers and admins may set or change the owner. Service-role/maintenance
-- sessions (no auth.uid()) are left alone so migrations and imports can run.
create function private.enforce_org_and_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  owner_col text := tg_argv[0];
  caller uuid := (select auth.uid());
  caller_org uuid;
  new_owner uuid;
  old_owner uuid;
begin
  if caller is null then
    return new;
  end if;
  caller_org := private.current_org_id();
  if caller_org is null then
    raise exception 'no profile for caller' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    new.org_id := caller_org;
  elsif new.org_id is distinct from old.org_id then
    raise exception 'org_id cannot be changed' using errcode = '42501';
  end if;

  if owner_col is not null then
    new_owner := (to_jsonb(new) ->> owner_col)::uuid;
    if tg_op = 'UPDATE' then
      old_owner := (to_jsonb(old) ->> owner_col)::uuid;
    end if;
    if not private.is_manager_or_admin() then
      if tg_op = 'INSERT' and new_owner is null then
        new := jsonb_populate_record(new, jsonb_build_object(owner_col, caller));
      elsif tg_op = 'INSERT' and new_owner <> caller then
        raise exception 'reps can only create records they own' using errcode = '42501';
      elsif tg_op = 'UPDATE' and new_owner is distinct from old_owner then
        raise exception 'only managers and admins can change the owner' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  diff jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
      into diff
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value and n.key <> 'updated_at';
    if diff is null then
      return new;
    end if;
  elsif tg_op = 'INSERT' then
    diff := jsonb_build_object('new', rec);
  else
    diff := jsonb_build_object('old', rec);
  end if;
  insert into public.audit_log (org_id, actor_id, action, table_name, record_id, diff_json)
  values ((rec ->> 'org_id')::uuid, (select auth.uid()), lower(tg_op), tg_table_name, rec ->> 'id', diff);
  return coalesce(new, old);
end;
$$;

do $$
declare
  t text;
  owner_cols jsonb := '{"companies":"owner_id","contacts":"owner_id","deals":"owner_id","activities":"user_id",
    "tasks":"assignee_id","files":"uploaded_by","saved_views":"user_id","import_batches":"uploaded_by"}';
begin
  foreach t in array array['orgs','profiles','companies','import_batches','contacts','pipeline_stages','deals',
                           'activities','tasks','files','saved_views'] loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function private.set_updated_at()', t);
    execute format('create trigger audit_row after insert or update or delete on public.%I for each row execute function private.audit_row()', t);
  end loop;
  foreach t in array array['companies','import_batches','contacts','pipeline_stages','deals','activities','tasks','files','saved_views'] loop
    if owner_cols ? t then
      execute format('create trigger enforce_org_and_owner before insert or update on public.%I for each row execute function private.enforce_org_and_owner(%L)', t, owner_cols ->> t);
    else
      execute format('create trigger enforce_org_and_owner before insert or update on public.%I for each row execute function private.enforce_org_and_owner()', t);
    end if;
  end loop;
end;
$$;

-- New auth users (created by invitation only; public sign-up is off) get a profile in the single org.
-- The first user of an org becomes its admin (Haider, invited first); everyone after starts as a rep.
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  target_org uuid;
  has_admin boolean;
begin
  select id into target_org from public.orgs order by created_at limit 1;
  select exists (select 1 from public.profiles where org_id = target_org and role = 'admin') into has_admin;
  insert into public.profiles (id, org_id, first_name, last_name, role)
  values (
    new.id,
    target_org,
    left(coalesce(new.raw_user_meta_data ->> 'first_name', ''), 80),
    left(coalesce(new.raw_user_meta_data ->> 'last_name', ''), 80),
    case when has_admin then 'rep'::public.app_role else 'admin'::public.app_role end
  );
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function private.handle_new_user();

-- Role changes only through this function: admin, step-up MFA (aal2), same org, never removes the last admin.
create function public.set_user_role(target_user uuid, new_role public.app_role) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller_org uuid := private.current_org_id();
  target_org uuid;
  old_role public.app_role;
begin
  if not private.is_admin() or not private.has_aal2() then
    raise exception 'admin with two-factor sign-in required' using errcode = '42501';
  end if;
  select org_id, role into target_org, old_role from public.profiles where id = target_user for update;
  if target_org is null or target_org <> caller_org then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if old_role = 'admin' and new_role <> 'admin'
     and (select count(*) from public.profiles where org_id = caller_org and role = 'admin') <= 1 then
    raise exception 'cannot remove the last admin' using errcode = '42501';
  end if;
  update public.profiles set role = new_role where id = target_user;
  insert into public.audit_log (org_id, actor_id, action, table_name, record_id, diff_json)
  values (caller_org, (select auth.uid()), 'role_change', 'profiles', target_user::text,
          jsonb_build_object('role', jsonb_build_object('old', old_role, 'new', new_role)));
end;
$$;

revoke all on function public.set_user_role(uuid, public.app_role) from public, anon;
grant execute on function public.set_user_role(uuid, public.app_role) to authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Grants: anon gets nothing; authenticated gets table privileges, RLS decides rows
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, public;
revoke all on all sequences in schema public from anon, public;
alter default privileges in schema public revoke all on tables from anon, public;
alter default privileges in schema public revoke all on sequences from anon, public;
alter default privileges in schema public revoke all on functions from anon, public;

revoke all on all tables in schema public from authenticated;
grant select on public.orgs to authenticated;
grant select on public.profiles to authenticated;
grant update (first_name, last_name, language, timezone) on public.profiles to authenticated;
grant select, insert, update, delete on public.companies, public.contacts, public.deals, public.activities,
  public.tasks, public.files, public.saved_views, public.import_batches to authenticated;
grant select, insert, update, delete on public.pipeline_stages to authenticated;
grant select on public.audit_log to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['orgs','profiles','companies','import_batches','contacts','pipeline_stages','deals',
                           'activities','tasks','files','saved_views','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    -- Every row of every table requires a two-factor (aal2) session.
    execute format('create policy require_mfa on public.%I as restrictive to authenticated using (private.has_aal2()) with check (private.has_aal2())', t);
  end loop;
end;
$$;

create policy orgs_select on public.orgs for select to authenticated
  using (id = private.current_org_id());

create policy profiles_select on public.profiles for select to authenticated
  using (org_id = private.current_org_id());
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Owned records: reps see and change their own; managers and admins see and change all in the org.
create policy companies_rw on public.companies for all to authenticated
  using (org_id = private.current_org_id() and (private.is_manager_or_admin() or owner_id = (select auth.uid())))
  with check (org_id = private.current_org_id() and (private.is_manager_or_admin() or owner_id = (select auth.uid())));

create policy contacts_rw on public.contacts for all to authenticated
  using (org_id = private.current_org_id() and (private.is_manager_or_admin() or owner_id = (select auth.uid())))
  with check (org_id = private.current_org_id() and (private.is_manager_or_admin() or owner_id = (select auth.uid())));

create policy deals_rw on public.deals for all to authenticated
  using (org_id = private.current_org_id() and (private.is_manager_or_admin() or owner_id = (select auth.uid())))
  with check (org_id = private.current_org_id() and (private.is_manager_or_admin() or owner_id = (select auth.uid())));

create policy activities_rw on public.activities for all to authenticated
  using (org_id = private.current_org_id() and (private.is_manager_or_admin() or user_id = (select auth.uid())))
  with check (org_id = private.current_org_id() and (private.is_manager_or_admin() or user_id = (select auth.uid())));

create policy tasks_rw on public.tasks for all to authenticated
  using (org_id = private.current_org_id() and (private.is_manager_or_admin() or assignee_id = (select auth.uid())))
  with check (org_id = private.current_org_id() and (private.is_manager_or_admin() or assignee_id = (select auth.uid())));

create policy files_rw on public.files for all to authenticated
  using (org_id = private.current_org_id() and (private.is_manager_or_admin() or uploaded_by = (select auth.uid())))
  with check (org_id = private.current_org_id() and (private.is_manager_or_admin() or uploaded_by = (select auth.uid())));

create policy saved_views_own on public.saved_views for all to authenticated
  using (org_id = private.current_org_id() and user_id = (select auth.uid()))
  with check (org_id = private.current_org_id() and user_id = (select auth.uid()));

-- Imports: admins only (the import page also requires step-up MFA).
create policy import_batches_admin on public.import_batches for all to authenticated
  using (org_id = private.current_org_id() and private.is_admin())
  with check (org_id = private.current_org_id() and private.is_admin());

create policy pipeline_stages_select on public.pipeline_stages for select to authenticated
  using (org_id = private.current_org_id());
create policy pipeline_stages_admin_write on public.pipeline_stages for insert to authenticated
  with check (org_id = private.current_org_id() and private.is_admin());
create policy pipeline_stages_admin_update on public.pipeline_stages for update to authenticated
  using (org_id = private.current_org_id() and private.is_admin())
  with check (org_id = private.current_org_id() and private.is_admin());
create policy pipeline_stages_admin_delete on public.pipeline_stages for delete to authenticated
  using (org_id = private.current_org_id() and private.is_admin());

-- Audit log: append-only (written by triggers), readable by admins of the org only.
create policy audit_log_admin_select on public.audit_log for select to authenticated
  using (org_id = private.current_org_id() and private.is_admin());

-- ---------------------------------------------------------------------------
-- Function privileges: nothing in private is callable by anon or PUBLIC; authenticated may call only the
-- read-only helpers that the policies use. Trigger functions run as their owner and need no grant.
-- ---------------------------------------------------------------------------
revoke all on all functions in schema private from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public;
grant execute on function private.current_org_id(), private.current_app_role(), private.is_manager_or_admin(),
  private.is_admin(), private.has_aal2() to authenticated;
