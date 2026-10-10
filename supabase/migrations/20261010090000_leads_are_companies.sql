-- Day 3a: a lead is a company (Haider, 10 Oct 2026). The company carries the lead status, main phone and email,
-- city, country, its owner (any CRM user of the org) and the date of the last activity; contacts are the people at
-- that company, as many as needed. Everyone in the org sees every lead; the owner, managers and admins change it.
-- Deletes need a two-factor code from the last 10 minutes (CLAUDE.md, step-up MFA).
-- The dev database has no leads or contacts yet, so columns that no longer belong to contacts are dropped outright.

-- ---------------------------------------------------------------------------
-- Companies become leads
-- ---------------------------------------------------------------------------
alter table public.companies
  add column lead_status text not null default 'cold'
    check (lead_status in ('cold', 'warm', 'negotiation', 'customer', 'cool_off', 'do_not_contact', 'disqualified')),
  -- Main phone as written in the sheet or form (digits, spaces and + ( ) . / - only); normalised for dedupe on import.
  add column phone text check (char_length(phone) <= 40 and phone ~ '^[0-9+(). /-]*$'),
  add column email text check (char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  add column city text check (char_length(city) <= 120),
  -- Kept by the CRM: set to the time of the newest call, email, meeting or note (trigger below). Imported leads
  -- start from the date in the sheet.
  add column last_activity_at timestamptz,
  add column import_batch_id uuid references public.import_batches (id) on delete set null;

-- Country is an ISO 3166-1 alpha-2 code ("FR"); the app shows the name in the user's language.
alter table public.companies drop constraint companies_country_check;
alter table public.companies add constraint companies_country_check check (country ~ '^[A-Z]{2}$');

create index companies_status_idx on public.companies (org_id, lead_status);
create index companies_country_idx on public.companies (org_id, country);
create index companies_import_batch_idx on public.companies (import_batch_id);
-- Search looks in name, email, phone and city at once: one trigram index over the four joined by line breaks (a line
-- break cannot be typed in the search box, so a search from the app never spans two fields). Replaces the name index.
drop index public.companies_name_trgm_idx;
create index companies_search_trgm_idx on public.companies using gin (
  (name || E'\n' || coalesce(email, '') || E'\n' || coalesce(phone, '') || E'\n' || coalesce(city, ''))
  extensions.gin_trgm_ops);
-- Keyset pagination for the three sort orders of the leads list.
create index companies_activity_keyset_idx
  on public.companies (org_id, (coalesce(last_activity_at, '-infinity'::timestamptz)) desc, id desc);
create index companies_name_keyset_idx on public.companies (org_id, lower(name), id);
create index companies_created_keyset_idx on public.companies (org_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Contacts are the people at a lead
-- ---------------------------------------------------------------------------
drop policy contacts_rw on public.contacts;
drop trigger enforce_org_and_owner on public.contacts;
drop index public.contacts_status_idx, public.contacts_next_action_idx, public.contacts_import_batch_idx,
  public.contacts_country_idx, public.contacts_org_owner_idx, public.contacts_owner_idx, public.contacts_keyset_idx;
alter table public.contacts
  drop column lead_status, drop column temperature, drop column do_not_contact, drop column last_contacted_at,
  drop column next_action_at, drop column import_batch_id, drop column source, drop column owner_id,
  drop column country, drop column city, drop column timezone, drop column whatsapp, drop column phone_e164,
  add column phone text check (char_length(phone) <= 40 and phone ~ '^[0-9+(). /-]*$'),
  add constraint contacts_email_format_check check (email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  add constraint contacts_name_check check (first_name <> '' or last_name <> '');
alter table public.contacts drop constraint contacts_company_id_fkey;
alter table public.contacts alter column company_id set not null;
alter table public.contacts
  add constraint contacts_company_id_fkey foreign key (company_id) references public.companies (id) on delete cascade;
create trigger enforce_org_and_owner before insert or update on public.contacts
  for each row execute function private.enforce_org_and_owner();
create index contacts_org_idx on public.contacts (org_id);
-- Same for the people at a lead: full name, email and phone in one trigram index (replaces the name and email ones).
drop index public.contacts_name_trgm_idx, public.contacts_email_trgm_idx;
create index contacts_search_trgm_idx on public.contacts using gin (
  (first_name || ' ' || last_name || E'\n' || coalesce(email, '') || E'\n' || coalesce(phone, ''))
  extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Activities belong to a lead (optionally to one of its contacts and a deal)
-- ---------------------------------------------------------------------------
alter table public.activities
  add column company_id uuid not null references public.companies (id) on delete cascade;
create index activities_company_idx on public.activities (company_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
-- Same rules as before, plus: an owner, when set, must be a member of the caller's org (managers and admins can
-- now assign leads to anyone in the team, never to someone outside it).
create or replace function private.enforce_org_and_owner() returns trigger
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
        new_owner := caller;
      elsif tg_op = 'INSERT' and new_owner <> caller then
        raise exception 'reps can only create records they own' using errcode = '42501';
      elsif tg_op = 'UPDATE' and new_owner is distinct from old_owner then
        raise exception 'only managers and admins can change the owner' using errcode = '42501';
      end if;
    end if;
    if new_owner is not null and (tg_op = 'INSERT' or new_owner is distinct from old_owner)
       and not exists (select 1 from public.profiles p where p.id = new_owner and p.org_id = caller_org) then
      raise exception 'the owner must be a member of your organisation' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- Last activity: the newest activity on a lead moves its date forward (never back). Runs as owner so that logging
-- a call on a lead someone else owns still updates the date. Deleting an activity leaves the date as it was.
create function private.touch_company_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.companies
     set last_activity_at = new.created_at
   where id = new.company_id
     and (last_activity_at is null or last_activity_at < new.created_at);
  return null;
end;
$$;
create trigger touch_company_activity after insert on public.activities
  for each row execute function private.touch_company_activity();

-- An activity's time is the server's clock for people using the app (a future date would push the lead's last
-- activity forward); maintenance and import sessions (no auth.uid()) may keep historical dates. It never changes later.
create function private.set_activity_time() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  elsif (select auth.uid()) is not null then
    new.created_at := now();
  end if;
  return new;
end;
$$;
create trigger set_activity_time before insert or update on public.activities
  for each row execute function private.set_activity_time();

-- The audit log skips updates that only move the last-activity date (the activity itself is audited).
create or replace function private.audit_row() returns trigger
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
     where n.value is distinct from o.value and n.key not in ('updated_at', 'last_activity_at');
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

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Leads: the whole org reads them (Haider, 10 Oct: "every user sees every lead"); the owner, managers and admins
-- change them; anyone may add a lead (reps become its owner); deleting needs a manager or admin with a fresh code.
drop policy companies_rw on public.companies;
create policy companies_select on public.companies for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy companies_insert on public.companies for insert to authenticated
  with check (org_id = (select private.current_org_id()));
create policy companies_update on public.companies for update to authenticated
  using (org_id = (select private.current_org_id())
         and ((select private.is_manager_or_admin()) or owner_id = (select auth.uid())))
  with check (org_id = (select private.current_org_id())
              and ((select private.is_manager_or_admin()) or owner_id = (select auth.uid())));
create policy companies_delete on public.companies for delete to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_manager_or_admin())
         and (select private.has_recent_aal2(600)));

-- Contacts follow their lead: everyone reads them; whoever can change the lead adds and changes its contacts.
create policy contacts_select on public.contacts for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy contacts_insert on public.contacts for insert to authenticated
  with check (org_id = (select private.current_org_id())
              and exists (select 1 from public.companies c where c.id = contacts.company_id
                          and ((select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()))));
create policy contacts_update on public.contacts for update to authenticated
  using (org_id = (select private.current_org_id())
         and exists (select 1 from public.companies c where c.id = contacts.company_id
                     and ((select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()))))
  with check (org_id = (select private.current_org_id())
              and exists (select 1 from public.companies c where c.id = contacts.company_id
                          and ((select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()))));
create policy contacts_delete on public.contacts for delete to authenticated
  using (org_id = (select private.current_org_id()) and (select private.has_recent_aal2(600))
         and exists (select 1 from public.companies c where c.id = contacts.company_id
                     and ((select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()))));

-- Activities: the whole team reads a lead's timeline and may log on any lead; each person changes their own
-- entries (managers and admins any); the contact must belong to the same lead; deleting needs a fresh code.
drop policy activities_rw on public.activities;
create policy activities_select on public.activities for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy activities_insert on public.activities for insert to authenticated
  with check (org_id = (select private.current_org_id())
              and ((select private.is_manager_or_admin()) or user_id = (select auth.uid()))
              and exists (select 1 from public.companies c where c.id = activities.company_id)
              and (activities.contact_id is null or exists (select 1 from public.contacts k
                   where k.id = activities.contact_id and k.company_id = activities.company_id))
              and (activities.deal_id is null or exists (select 1 from public.deals d where d.id = activities.deal_id)));
create policy activities_update on public.activities for update to authenticated
  using (org_id = (select private.current_org_id())
         and ((select private.is_manager_or_admin()) or user_id = (select auth.uid())))
  with check (org_id = (select private.current_org_id())
              and ((select private.is_manager_or_admin()) or user_id = (select auth.uid()))
              and exists (select 1 from public.companies c where c.id = activities.company_id)
              and (activities.contact_id is null or exists (select 1 from public.contacts k
                   where k.id = activities.contact_id and k.company_id = activities.company_id))
              and (activities.deal_id is null or exists (select 1 from public.deals d where d.id = activities.deal_id)));
create policy activities_delete on public.activities for delete to authenticated
  using (org_id = (select private.current_org_id()) and (select private.has_recent_aal2(600))
         and ((select private.is_manager_or_admin()) or user_id = (select auth.uid())));

-- Deals: a deal can only be opened on a lead the caller may change (owner, manager, admin), now that every lead is
-- visible to everyone. The rest of the deal rules arrive with the pipeline (Day 5).
drop policy deals_rw on public.deals;
create policy deals_rw on public.deals for all to authenticated
  using (org_id = (select private.current_org_id()) and ((select private.is_manager_or_admin()) or owner_id = (select auth.uid())))
  with check (org_id = (select private.current_org_id()) and ((select private.is_manager_or_admin()) or owner_id = (select auth.uid()))
    and (deals.company_id is null or exists (select 1 from public.companies p where p.id = deals.company_id
         and ((select private.is_manager_or_admin()) or p.owner_id = (select auth.uid()))))
    -- the contact must belong to a lead the caller may change, and to the deal's lead when both are set
    and (deals.contact_id is null or exists (select 1 from public.contacts k join public.companies p on p.id = k.company_id
         where k.id = deals.contact_id
           and (deals.company_id is null or k.company_id = deals.company_id)
           and ((select private.is_manager_or_admin()) or p.owner_id = (select auth.uid()))))
    and exists (select 1 from public.pipeline_stages p where p.id = deals.stage_id));

-- ---------------------------------------------------------------------------
-- Leads API (all SECURITY INVOKER: row level security above decides every row)
-- User text never becomes SQL: it arrives as parameters; LIKE wildcards in it are escaped.
-- ---------------------------------------------------------------------------
create function private.like_escape(value text) returns text
language sql immutable set search_path = '' as $$
  select replace(replace(replace(value, '\', '\\'), '%', '\%'), '_', '\_')
$$;

-- Search (2 to 100 characters) and city (1 to 120) become ILIKE patterns, their wildcards escaped; shorter is "none".
create function private.like_pattern(value text, max_len integer, min_len integer) returns text
language sql immutable set search_path = '' as $$
  select case when char_length(btrim(coalesce(value, ''))) >= min_len
              then '%' || private.like_escape(left(btrim(value), max_len)) || '%' end
$$;

-- Ids of the caller's leads whose name, email, phone or city, or one of whose contacts' name, email or phone, contain the
-- search pattern. Why this runs as the definer: row level security evaluates its own checks before any condition that is
-- not leakproof, and ILIKE is not, so under RLS the trigram indexes cannot be used and every search read all 30k leads
-- (about 100 ms, docs/evidence/day3a/perf.md); here the indexes answer in a few ms. It applies the same rule as the
-- companies_select and contacts_select policies itself (the caller's org, with two-factor) and returns ids only; the
-- calling query reads the leads under row level security as usual. Not reachable from the API (private schema).
create function private.search_lead_ids(p_pattern text) returns setof uuid
language plpgsql stable security definer rows 100 set search_path = '' as $$
declare
  v_org uuid := private.current_org_id();
begin
  if v_org is null or not private.has_aal2() or p_pattern is null then
    return;
  end if;
  return query execute $q$
    select s.id from public.companies s
     where s.org_id = $1
       and (s.name || E'\n' || coalesce(s.email, '') || E'\n' || coalesce(s.phone, '') || E'\n' || coalesce(s.city, ''))
           ilike $2
    union
    select k.company_id from public.contacts k
     where k.org_id = $1
       and (k.first_name || ' ' || k.last_name || E'\n' || coalesce(k.email, '') || E'\n' || coalesce(k.phone, ''))
           ilike $2
  $q$ using v_org, p_pattern;
end;
$$;

-- The leads filter, written once for list_leads and count_leads. It is constant SQL text with positional parameters
-- only ($1 search pattern, $2 statuses, $3 owners, $4 unowned, $5 countries, $6 city pattern, $7 inactive days). The two
-- functions run it with EXECUTE ... USING, so values never become SQL and each call is planned with its real values:
-- the keyset indexes stay usable (a set-returning SQL function with a SET clause is never inlined). Search goes through
-- private.search_lead_ids above.
create function private.lead_filter_sql() returns text
language sql immutable set search_path = '' as $f$
  select $q$
        ($2::text[] is null or c.lead_status = any ($2))
    and (($3::uuid[] is null and not $4) or c.owner_id = any ($3) or ($4 and c.owner_id is null))
    and ($5::text[] is null or c.country = any ($5))
    and ($6::text is null or c.city ilike $6)
    and ($7::integer is null or c.last_activity_at is null
         or c.last_activity_at < now() - make_interval(days => greatest($7, 0)))
    and ($1::text is null or c.id = any (array(select private.search_lead_ids($1))))
  $q$
$f$;

-- One page of leads. p_sort: 'activity' (newest activity first, never-contacted last), 'name' (A to Z), 'created'
-- (newest first). Pass the last row's sort_value and id to get the next page (keyset; never OFFSET). The sort keys and
-- cursor conditions below are fixed strings chosen by p_sort (whitelisted), never user text.
create function public.list_leads(
  p_search text default null,
  p_statuses text[] default null,
  p_owners uuid[] default null,
  p_unowned boolean default false,
  p_countries text[] default null,
  p_city text default null,
  p_inactive_days integer default null,
  p_sort text default 'activity',
  p_after_value text default null,
  p_after_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid,
  name text,
  owner_id uuid,
  owner_first_name text,
  owner_last_name text,
  phone text,
  email text,
  lead_status text,
  last_activity_at timestamptz,
  city text,
  country text,
  contact_count integer,
  created_at timestamptz,
  sort_value text
)
language plpgsql stable set search_path = '' as $$
declare
  sort_key text;
  after_cond text;
  direction text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'limit must be between 1 and 200' using errcode = '22023';
  end if;
  if p_sort is null or p_sort not in ('activity', 'name', 'created') then
    raise exception 'unknown sort' using errcode = '22023';
  end if;
  if (p_after_value is null) <> (p_after_id is null) then
    raise exception 'cursor needs both value and id' using errcode = '22023';
  end if;
  sort_key := case p_sort
    when 'name' then 'lower(c.name)'
    when 'created' then 'c.created_at'
    else 'coalesce(c.last_activity_at, ''-infinity''::timestamptz)'
  end;
  after_cond := case p_sort
    when 'name' then '(lower(c.name), c.id) > ($8, $9)'
    else format('(%s, c.id) < ($8::timestamptz, $9)', sort_key)
  end;
  direction := case p_sort when 'name' then 'asc' else 'desc' end;

  return query execute format(
    $q$select c.id, c.name, c.owner_id, o.first_name, o.last_name, c.phone, c.email, c.lead_status,
              c.last_activity_at, c.city, c.country,
              (select count(*)::integer from public.contacts k where k.company_id = c.id), c.created_at,
              (%1$s)::text
         from public.companies c
         left join public.profiles o on o.id = c.owner_id
        where %2$s
          and ($9::uuid is null or %3$s)
        order by %1$s %4$s, c.id %4$s
        limit $10$q$,
    sort_key, private.lead_filter_sql(), after_cond, direction)
  using private.like_pattern(p_search, 100, 2), p_statuses, p_owners, coalesce(p_unowned, false), p_countries,
        private.like_pattern(p_city, 120, 1), p_inactive_days, p_after_value, p_after_id, p_limit;
end;
$$;

-- How many leads match the same filters (the count next to the title).
create function public.count_leads(
  p_search text default null,
  p_statuses text[] default null,
  p_owners uuid[] default null,
  p_unowned boolean default false,
  p_countries text[] default null,
  p_city text default null,
  p_inactive_days integer default null
) returns bigint
language plpgsql stable set search_path = '' as $$
declare
  n bigint;
begin
  execute format('select count(*) from public.companies c where %s', private.lead_filter_sql())
    into n
    using private.like_pattern(p_search, 100, 2), p_statuses, p_owners, coalesce(p_unowned, false), p_countries,
          private.like_pattern(p_city, 120, 1), p_inactive_days;
  return n;
end;
$$;

-- One lead with its owner and contacts, and whether the caller may change it. Null when not visible.
create function public.get_lead(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'name', c.name, 'lead_status', c.lead_status, 'phone', c.phone, 'email', c.email,
    'city', c.city, 'country', c.country, 'last_activity_at', c.last_activity_at, 'created_at', c.created_at,
    'owner', case when o.id is null then null
                  else jsonb_build_object('id', o.id, 'first_name', o.first_name, 'last_name', o.last_name) end,
    'can_edit', (select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', k.id, 'first_name', k.first_name, 'last_name', k.last_name, 'title', k.title,
               'email', k.email, 'phone', k.phone) order by k.created_at, k.id)
      from public.contacts k where k.company_id = c.id), '[]'::jsonb)
  )
  from public.companies c
  left join public.profiles o on o.id = c.owner_id
  where c.id = p_id
$$;

-- Writes: only these fields, never org or audit columns (the triggers set those).
create function public.create_lead(
  p_name text,
  p_owner uuid default null,
  p_status text default 'cold',
  p_phone text default null,
  p_email text default null,
  p_city text default null,
  p_country text default null
) returns uuid
language sql volatile set search_path = '' as $$
  insert into public.companies (name, owner_id, lead_status, phone, email, city, country)
  values (btrim(p_name), p_owner, coalesce(p_status, 'cold'), nullif(btrim(p_phone), ''), nullif(btrim(p_email), ''),
          nullif(btrim(p_city), ''), nullif(btrim(p_country), ''))
  returning id
$$;

create function public.update_lead(
  p_id uuid,
  p_name text,
  p_owner uuid,
  p_status text,
  p_phone text,
  p_email text,
  p_city text,
  p_country text
) returns void
language plpgsql volatile set search_path = '' as $$
begin
  update public.companies
     set name = btrim(p_name), owner_id = p_owner, lead_status = p_status, phone = nullif(btrim(p_phone), ''),
         email = nullif(btrim(p_email), ''), city = nullif(btrim(p_city), ''), country = nullif(btrim(p_country), '')
   where id = p_id;
  if not found then
    raise exception 'lead not found or not yours to change' using errcode = '42501';
  end if;
end;
$$;

-- Change the status and/or owner of many leads at once. Returns how many changed (rows the caller may not change
-- are left alone). p_set_owner distinguishes "make unassigned" (owner null) from "leave the owner".
create function public.bulk_update_leads(
  p_ids uuid[],
  p_status text default null,
  p_set_owner boolean default false,
  p_owner uuid default null
) returns integer
language plpgsql volatile set search_path = '' as $$
declare
  n integer;
begin
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 500 then
    raise exception 'between 1 and 500 leads at a time' using errcode = '22023';
  end if;
  if p_status is null and not coalesce(p_set_owner, false) then
    raise exception 'nothing to change' using errcode = '22023';
  end if;
  update public.companies
     set lead_status = coalesce(p_status, lead_status),
         owner_id = case when coalesce(p_set_owner, false) then p_owner else owner_id end
   where id = any (p_ids);
  get diagnostics n = row_count;
  return n;
end;
$$;

create function public.add_contact(
  p_company_id uuid,
  p_first_name text,
  p_last_name text default '',
  p_title text default null,
  p_email text default null,
  p_phone text default null
) returns uuid
language sql volatile set search_path = '' as $$
  insert into public.contacts (company_id, first_name, last_name, title, email, phone)
  values (p_company_id, coalesce(btrim(p_first_name), ''), coalesce(btrim(p_last_name), ''),
          nullif(btrim(p_title), ''), nullif(btrim(p_email), ''), nullif(btrim(p_phone), ''))
  returning id
$$;

create function public.update_contact(
  p_id uuid,
  p_first_name text,
  p_last_name text,
  p_title text,
  p_email text,
  p_phone text
) returns void
language plpgsql volatile set search_path = '' as $$
begin
  update public.contacts
     set first_name = coalesce(btrim(p_first_name), ''), last_name = coalesce(btrim(p_last_name), ''),
         title = nullif(btrim(p_title), ''), email = nullif(btrim(p_email), ''), phone = nullif(btrim(p_phone), '')
   where id = p_id;
  if not found then
    raise exception 'contact not found or not yours to change' using errcode = '42501';
  end if;
end;
$$;

-- The team, for owner pickers and filters.
create function public.list_team() returns table (id uuid, first_name text, last_name text, role public.app_role)
language sql stable set search_path = '' as $$
  select p.id, p.first_name, p.last_name, p.role
  from public.profiles p
  order by lower(p.first_name), lower(p.last_name), p.id
$$;

-- Saved filters ("views"), private to each person.
create function public.list_saved_views(p_section text)
returns table (id uuid, name text, filters jsonb, created_at timestamptz)
language sql stable set search_path = '' as $$
  select v.id, v.name, v.filters_json, v.created_at
  from public.saved_views v
  where v.section = p_section and v.user_id = (select auth.uid())
  order by lower(v.name), v.id
$$;

create function public.save_view(p_section text, p_name text, p_filters jsonb) returns uuid
language sql volatile set search_path = '' as $$
  insert into public.saved_views (section, name, filters_json, user_id)
  values (p_section, btrim(p_name), coalesce(p_filters, '{}'::jsonb), (select auth.uid()))
  returning id
$$;

create function public.delete_saved_view(p_id uuid) returns void
language plpgsql volatile set search_path = '' as $$
begin
  delete from public.saved_views where id = p_id and user_id = (select auth.uid());
  if not found then
    raise exception 'view not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: the API functions run as the caller, so authenticated needs the private helpers they use.
-- ---------------------------------------------------------------------------
revoke all on function private.like_escape(text), private.like_pattern(text, integer, integer),
  private.lead_filter_sql(), private.search_lead_ids(text), private.touch_company_activity() from public, anon;
grant execute on function private.like_escape(text), private.like_pattern(text, integer, integer),
  private.lead_filter_sql(), private.search_lead_ids(text) to authenticated;
revoke all on function private.touch_company_activity() from authenticated;
revoke all on function private.set_activity_time() from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.list_leads(text, text[], uuid[], boolean, text[], text, integer, text, text, uuid, integer)',
    'public.count_leads(text, text[], uuid[], boolean, text[], text, integer)',
    'public.get_lead(uuid)',
    'public.create_lead(text, uuid, text, text, text, text, text)',
    'public.update_lead(uuid, text, uuid, text, text, text, text, text)',
    'public.bulk_update_leads(uuid[], text, boolean, uuid)',
    'public.add_contact(uuid, text, text, text, text, text)',
    'public.update_contact(uuid, text, text, text, text, text)',
    'public.list_team()',
    'public.list_saved_views(text)',
    'public.save_view(text, text, jsonb)',
    'public.delete_saved_view(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Column grants (CLAUDE.md: whitelist fields on writes). People change only these columns of a lead and a contact,
-- through the API functions or directly; the last-activity date, import batch, org and timestamps are set by the
-- server (triggers and imports), never by a client, so nobody can backdate a lead or tag it into an import batch.
-- ---------------------------------------------------------------------------
revoke insert, update on public.companies, public.contacts from authenticated;
grant insert (name, website, industry, owner_id, lead_status, phone, email, city, country),
      update (name, website, industry, owner_id, lead_status, phone, email, city, country)
  on public.companies to authenticated;
grant insert (company_id, first_name, last_name, title, email, phone),
      update (company_id, first_name, last_name, title, email, phone)
  on public.contacts to authenticated;
