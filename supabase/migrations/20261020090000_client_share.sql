-- Day 6e: the client stock link (design docs/evidence/day6/design.md sections 3.5, 5.5, 6.8, 8 and 9).
--
-- * private.share_links: one row per link a teammate sends to a client. Only sha256(token) is stored (token_hash, never
--   granted to authenticated, hidden in the audit); the token is made by the guard (256 bits) and handed back once by
--   create_share_link. Links expire (1 hour to 366 days, 90 by default), are revoked for good in one click, and cascade
--   with their lead. At most 3 active links a lead and 200 an organisation.
-- * private.share_rate: minute, hour and day counters per link and per organisation (views 30 a minute and 600 an hour
--   a link; requests 5 an hour and 20 a day a link, 200 a day an organisation). Kept 2 days. No endpoint.
-- * private.inventory_settings.sharing_enabled: the kill switch, off by default. On: an admin with a fresh code; off: a
--   manager or an admin.
-- * Role share_reader (nologin, noinherit): owns the two functions anon may call, public.share_view and
--   public.share_request (SECURITY DEFINER, VOLATILE, static SQL, search_path ''), and holds column grants on exactly
--   what the client page shows, bound by policies to the presented token's hash and its organisation. It has no
--   privilege on costs, minimum prices, leads, contacts, deals, sales, holds, the ledger, profiles or the audit.
-- * private.share_items(org, with_transit): the one whitelist (positional arrays) for the client page and the team's
--   "What clients see" preview (share_preview).
-- * A client request (share_request) writes the request, its lines, the link counters and (definer trigger) one task
--   for the lead's owner (else the link's creator, else the oldest admin); a lead with an open request task keeps one.
-- * Team RPCs (invoker): create_share_link, revoke_share_link, extend_share_link (fresh code), list_share_links,
--   set_sharing_enabled, share_preview.
--
-- Redefines (REBASE when the named migration changes before this one merges):
--   private.stock_request_guard, private.stock_request_line_guard (20261019090000_sales_requests.sql, 6d, unmerged):
--     the share_reader branch, taken before any auth call;
--   private.inventory_settings_guard (20261016090000_stock_engine.sql, 6a, unmerged): the sharing switch;
--   policy inventory_settings_update (20261016090000_stock_engine.sql, 6a, unmerged): managers reach the row;
--   public.get_inventory_settings (20261017090000_inventory_reads.sql, 6b, unmerged): sharing_enabled;
--   private.lead_import_untouched (20261019090000_sales_requests.sql, 6d): a lead with a link is touched.
-- Spike S1 (the role owning definer functions) is proved on the local PostgreSQL 16 shim and the CI image only; the
-- hosted check happens at the dev deploy (docs/evidence/day6e/README.md).

create extension if not exists pgcrypto with schema extensions;      -- gen_random_bytes; a no-op on Supabase

-- ===========================================================================
-- 1. The role
-- ===========================================================================
do $$
begin
  if not exists (select from pg_roles where rolname = 'share_reader') then
    create role share_reader nologin noinherit;
  end if;
end;
$$;
grant share_reader to postgres with set true;            -- PG16+: lets this migration hand ownership over
grant usage on schema public, private to share_reader;

-- ===========================================================================
-- 2. Tables
-- ===========================================================================
create table private.share_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  company_id uuid not null references public.companies (id) on delete cascade,   -- the client
  token_hash bytea not null unique check (octet_length(token_hash) = 32),        -- sha256(token); never granted
  token_hint text not null check (token_hint ~ '^[A-Za-z0-9_-]{4}$'),            -- last 4 characters
  label text check (char_length(label) between 1 and 80
                    and label !~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'),
  language text not null check (language in ('en', 'fr')),
  show_in_transit boolean not null default true,
  allow_requests boolean not null default true,
  signature text check (char_length(signature) <= 60),   -- the creator's first name, taken when the link is made
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  open_count integer not null default 0,
  last_opened_at timestamptz,
  request_count integer not null default 0,
  last_request_at timestamptz,
  check ((revoked_at is null) = (revoked_by is null))
);
create index share_links_company_idx on private.share_links (company_id, created_at desc);
create index share_links_org_idx on private.share_links (org_id, created_at desc, id desc);

alter table private.stock_requests add constraint stock_requests_share_link_fkey
  foreign key (share_link_id) references private.share_links (id) on delete set null;
create unique index stock_requests_idem_idx on private.stock_requests (share_link_id, idempotency_key)
  where share_link_id is not null;
create index stock_requests_link_idx on private.stock_requests (share_link_id, status, created_at desc)
  where share_link_id is not null;

create table private.share_rate (                      -- rate counters; no endpoint; not audited
  scope_id uuid not null,                              -- a link id or an org id
  kind text not null check (kind in ('view', 'request')),
  span text not null check (span in ('m', 'h', 'd')),
  bucket timestamptz not null,
  n integer not null check (n >= 0),
  primary key (scope_id, kind, span, bucket)
);

alter table private.inventory_settings
  add column sharing_enabled boolean not null default false,
  add column sharing_changed_at timestamptz,
  add column sharing_changed_by uuid;

-- ===========================================================================
-- 3. Helpers for share_reader: the presented token's hash, its link and its organisation (transaction-local
--    settings written only by the two functions; null when unset, so every policy then matches nothing)
-- ===========================================================================
create function private.share_token_hash() returns bytea
language sql stable set search_path = '' as $$
  select case when nullif(current_setting('topstock.share_token_hash', true), '') ~ '^[0-9a-f]{64}$'
              then decode(nullif(current_setting('topstock.share_token_hash', true), ''), 'hex') end
$$;
create function private.share_link_id() returns uuid
language sql stable set search_path = '' as $$
  select case when nullif(current_setting('topstock.share_link', true), '')
                   ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then nullif(current_setting('topstock.share_link', true), '')::uuid end
$$;
create function private.share_org() returns uuid
language sql stable set search_path = '' as $$
  select case when nullif(current_setting('topstock.share_org', true), '')
                   ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then nullif(current_setting('topstock.share_org', true), '')::uuid end
$$;

-- ===========================================================================
-- 4. Guards and triggers
-- ===========================================================================
-- The link guard (invoker). share_reader (the two anon functions) may only move the counters. A teammate's insert: a
-- fresh code; the token is made here (its entropy holds even for a direct insert; any token_hash sent is replaced) and
-- handed to create_share_link through a transaction-local setting; the server fields are set here. A teammate's
-- update: label, language, the two switches; revoked_at only from null to now (never undone); expires_at with a fresh
-- code and the bounds.
create function private.share_link_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller uuid;
  v_token text;
  counters constant text[] := array['open_count', 'last_opened_at', 'request_count', 'last_request_at'];
  editable constant text[] := array['label', 'language', 'show_in_transit', 'allow_requests', 'expires_at',
                                    'revoked_at', 'revoked_by', 'updated_at'];
begin
  if current_user = 'share_reader' then                 -- before any auth call: share_reader has no auth access
    if tg_op <> 'UPDATE' or (to_jsonb(new) - counters) is distinct from (to_jsonb(old) - counters) then
      raise exception 'not allowed' using errcode = '42501', hint = 'forbidden';
    end if;
    return new;
  end if;
  caller := (select auth.uid());
  if caller is null then
    if current_user = 'postgres' then
      return new;                                       -- maintenance and fixtures
    end if;
    raise exception 'sign in first' using errcode = '42501', hint = 'forbidden';
  end if;
  new.label := nullif(btrim(new.label), '');
  if char_length(new.label) > 80
     or new.label ~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
    raise exception 'the label is too long or has characters that are not allowed' using errcode = '22023', hint = 'label';
  end if;
  if new.language is null or new.language not in ('en', 'fr') then
    raise exception 'the language is en or fr' using errcode = '22023', hint = 'language';
  end if;
  if tg_op = 'INSERT' then
    if not private.has_recent_aal2(600) then
      raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
    end if;
    v_token := 'tss_' || translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
    new.token_hash := sha256(convert_to(v_token, 'UTF8'));
    new.token_hint := right(v_token, 4);
    perform set_config('topstock.new_share_token', v_token, true);   -- read once by create_share_link
    new.id := gen_random_uuid();
    new.org_id := private.current_org_id();
    new.created_by := caller;
    new.created_at := now();
    new.updated_at := now();
    new.signature := (select left(nullif(btrim(p.first_name), ''), 60) from public.profiles p where p.id = caller);
    new.open_count := 0;
    new.last_opened_at := null;
    new.request_count := 0;
    new.last_request_at := null;
    new.revoked_at := null;
    new.revoked_by := null;
    new.show_in_transit := coalesce(new.show_in_transit, true);
    new.allow_requests := coalesce(new.allow_requests, true);
    new.expires_at := coalesce(new.expires_at, now() + interval '90 days');
    if new.expires_at < now() + interval '1 hour' or new.expires_at > now() + interval '366 days' then
      raise exception 'a link lasts 1 hour to 366 days' using errcode = '22023', hint = 'expiry';
    end if;
    return new;
  end if;
  -- Update by a teammate.
  if (to_jsonb(new) - editable) is distinct from (to_jsonb(old) - editable) then
    raise exception 'this part of a link cannot change' using errcode = '42501', hint = 'not_editable';
  end if;
  if old.revoked_at is not null then
    raise exception 'this link is revoked' using errcode = '22023', hint = 'revoked';
  end if;
  if new.revoked_at is not null then
    new.revoked_at := now();
    new.revoked_by := caller;
  else
    new.revoked_by := null;
  end if;
  if new.expires_at is distinct from old.expires_at then
    if not private.has_recent_aal2(600) then
      raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
    end if;
    if new.expires_at is null or new.expires_at < now() + interval '1 hour'
       or new.expires_at > now() + interval '366 days' then
      raise exception 'a link lasts 1 hour to 366 days' using errcode = '22023', hint = 'expiry';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger share_link_guard before insert or update on private.share_links
  for each row execute function private.share_link_guard();

-- The caps (definer, trigger only: a rep's insert must count links it cannot see): 3 active links a lead, 200 an org.
-- Counted after a link is made or its expiry moves (Extend can bring an expired link back), one organisation at a
-- time: the transaction lock is held to commit, and the count that follows it sees every link committed before, so
-- two teammates making links at the same moment cannot pass a cap.
create function private.share_link_caps() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('topstock.share_link_caps:' || new.org_id::text, 0));
  if (select count(*) from private.share_links l
       where l.company_id = new.company_id and l.revoked_at is null and l.expires_at > now()) > 3
     or (select count(*) from private.share_links l
          where l.org_id = new.org_id and l.revoked_at is null and l.expires_at > now()) > 200 then
    raise exception 'too many active links' using errcode = '22023', hint = 'too_many_links';
  end if;
  return null;
end;
$$;
create trigger share_link_caps after insert or update of expires_at on private.share_links
  for each row execute function private.share_link_caps();

-- The audit of links: token_hash hidden; the counters are no diff (an open or a request alone writes no audit row).
create function private.audit_share_link_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  hidden constant text[] := array['token_hash', 'open_count', 'last_opened_at', 'request_count', 'last_request_at',
                                  'updated_at'];
  rec jsonb := to_jsonb(new) - hidden;
  diff jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value)) into diff
      from jsonb_each(to_jsonb(new) - hidden) n
      join jsonb_each(to_jsonb(old) - hidden) o using (key)
     where n.value is distinct from o.value;
    if diff is null then
      return null;
    end if;
  else
    diff := jsonb_build_object('new', rec);
  end if;
  insert into public.audit_log (org_id, actor_id, action, table_name, record_id, diff_json)
  values ((rec ->> 'org_id')::uuid, (select auth.uid()), lower(tg_op), tg_table_name, rec ->> 'id', diff);
  return null;
end;
$$;
create trigger audit_share_link_row after insert or update on private.share_links
  for each row execute function private.audit_share_link_row();

-- The request guard (REBASE: from 20261019090000_sales_requests.sql, 6d, unmerged) gains the share_reader branch, taken
-- before any auth call: a client request belongs to the presented link (its lead, its organisation), is new, has no
-- creator and keeps the link's language.
create or replace function private.stock_request_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller uuid;
  v_link record;
begin
  if current_user = 'share_reader' then
    if tg_op <> 'INSERT' then
      raise exception 'not allowed' using errcode = '42501', hint = 'forbidden';
    end if;
    select l.id, l.org_id, l.company_id, l.language into v_link
      from private.share_links l where l.id = private.share_link_id();
    if not found then
      raise exception 'not allowed' using errcode = '42501', hint = 'forbidden';
    end if;
    new.id := gen_random_uuid();
    new.org_id := v_link.org_id;
    new.company_id := v_link.company_id;
    new.share_link_id := v_link.id;
    new.source := 'share_link';
    new.language := v_link.language;
    new.created_by := null;
    new.created_at := now();
    new.updated_at := now();
    new.status := 'new';
    new.handled_by := null;
    new.handled_at := null;
    new.team_note := null;
    new.note := nullif(btrim(new.note), '');
    new.requester_name := nullif(btrim(new.requester_name), '');
    if char_length(new.note) > 1000
       or new.note ~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'
       or char_length(new.requester_name) > 80
       or new.requester_name ~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
      raise exception 'not allowed' using errcode = '22023', hint = 'invalid';
    end if;
    return new;
  end if;
  caller := (select auth.uid());
  if caller is null then
    raise exception 'sign in first' using errcode = '42501', hint = 'forbidden';
  end if;
  if tg_op = 'INSERT' then
    new.org_id := private.current_org_id();
    new.source := 'team';
    new.created_by := caller;  -- the person logging it
    new.created_at := now();
    new.status := 'new';
    new.share_link_id := null;
    new.requester_name := null;
    new.language := null;
    new.handled_by := null;
    new.handled_at := null;
    new.team_note := null;
    new.note := nullif(btrim(new.note), '');
    if char_length(new.note) > 1000
       or new.note ~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
      raise exception 'the note is too long or has characters that are not allowed' using errcode = '22023', hint = 'note';
    end if;
    if (select count(*) from (select 1 from private.stock_requests r
                               where r.created_by = caller and r.created_at > now() - interval '60 seconds'
                               limit 60) recent) >= 60 then
      raise exception 'too many requests in a minute' using errcode = '22023', hint = 'rate_limited';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'team_note', 'handled_by', 'handled_at', 'updated_at'])
     is distinct from (to_jsonb(old) - array['status', 'team_note', 'handled_by', 'handled_at', 'updated_at']) then
    raise exception 'only the status and the team note change' using errcode = '42501', hint = 'not_editable';
  end if;
  if new.status is null or new.status not in ('new', 'in_progress', 'done', 'declined') then
    raise exception 'unknown status' using errcode = '22023', hint = 'request_status';
  end if;
  new.team_note := nullif(btrim(new.team_note), '');
  if char_length(new.team_note) > 300
     or new.team_note ~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
    raise exception 'the note is too long or has characters that are not allowed' using errcode = '22023', hint = 'note';
  end if;
  if old.status = 'new' and new.status <> 'new' then
    new.handled_by := caller;
    new.handled_at := now();
  else
    new.handled_by := old.handled_by;
    new.handled_at := old.handled_at;
  end if;
  return new;
end;
$$;

-- The request line guard (REBASE: from 20261019090000_sales_requests.sql, 6d, unmerged) gains the share_reader branch:
-- a line of a request made by the presented link in this transaction; pieces, the max price shown and the
-- availability come from the visible products only (share_reader reads nothing else).
create or replace function private.stock_request_line_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller uuid;
  r record;
  p record;
begin
  if current_user = 'share_reader' then
    select rq.org_id, rq.created_at into r from private.stock_requests rq
     where rq.id = new.request_id and rq.share_link_id = private.share_link_id();
    if not found or r.created_at <> now() then
      raise exception 'not allowed' using errcode = '42501', hint = 'forbidden';
    end if;
  else
    caller := (select auth.uid());
    select rq.org_id, rq.created_by, rq.created_at into r from private.stock_requests rq where rq.id = new.request_id;
    if not found or r.created_by is distinct from caller or r.created_at <> now() then
      raise exception 'lines are added with their request only' using errcode = '42501', hint = 'forbidden';
    end if;
  end if;
  new.org_id := r.org_id;
  if new.position is null or new.position not between 1 and 20 then
    raise exception 'a request has 1 to 20 lines' using errcode = '22023', hint = 'lines';
  end if;
  if new.quantity is null or new.quantity not between 1 and 10000000 or new.unit is null
     or new.unit not in ('piece', 'carton') then
    raise exception 'the quantity must be 1 to 10,000,000' using errcode = '22023', hint = 'quantity';
  end if;
  new.description := nullif(btrim(new.description), '');
  if char_length(new.description) > 200
     or new.description ~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
    raise exception 'describe the item in 1 to 200 characters' using errcode = '22023', hint = 'description';
  end if;
  if new.product_id is not null then
    select pr.pieces_per_carton, pr.price_max, pr.archived_at, pr.share_visible,
           coalesce((select l.on_hand - l.reserved from public.stock_levels l join public.locations x on x.id = l.location_id
                      where l.product_id = pr.id and x.kind = 'warehouse'), 0) as wh_available,
           coalesce((select l.on_hand - l.reserved from public.stock_levels l join public.locations x on x.id = l.location_id
                      where l.product_id = pr.id and x.kind = 'transit'), 0) as tr_available
      into p from public.products pr where pr.id = new.product_id;
    if not found or (current_user = 'share_reader' and (p.archived_at is not null or not p.share_visible)) then
      raise exception 'product not found' using errcode = 'P0002';
    end if;
    new.pieces := new.quantity * (case when new.unit = 'carton' then p.pieces_per_carton else 1 end);
    new.price_shown := p.price_max;
    new.availability := case when p.archived_at is not null then 'not_listed' when p.wh_available > 0 then 'in_warehouse'
                             when p.tr_available > 0 then 'in_transit' else 'not_listed' end;
  else
    if new.description is null then
      raise exception 'describe the item in 1 to 200 characters' using errcode = '22023', hint = 'description';
    end if;
    if new.unit <> 'piece' then
      raise exception 'something not in the list is asked in pieces' using errcode = '22023', hint = 'quantity';
    end if;
    new.pieces := new.quantity;
    new.price_shown := null;
    new.availability := 'not_listed';
  end if;
  if new.pieces not between 1 and 50000000 then
    raise exception 'the quantity must be 1 to 50,000,000 pieces' using errcode = '22023', hint = 'quantity';
  end if;
  return new;
end;
$$;

-- A client request opens one task (design 6.8; definer, trigger only): for the lead's owner, else the link's creator,
-- else the oldest admin; due today in their time zone. A lead with an open request task keeps that one (the partial
-- unique index; the insert is skipped).
create function private.stock_request_task() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_assignee uuid;
begin
  select coalesce(c.owner_id, l.created_by,
                  (select p.id from public.profiles p where p.org_id = new.org_id and p.role = 'admin'
                    order by p.created_at, p.id limit 1))
    into v_assignee
    from public.companies c left join private.share_links l on l.id = new.share_link_id
   where c.id = new.company_id;
  perform private.insert_system_task(new.org_id, v_assignee, 'request', null, new.company_id, null, new.id);
  return null;
end;
$$;
create trigger stock_request_task after insert on private.stock_requests
  for each row when (new.source = 'share_link') execute function private.stock_request_task();

-- The settings guard (REBASE: from 20261016090000_stock_engine.sql, 6a, unmerged) learns the sharing switch: on needs
-- an admin with a fresh code, off a manager or an admin; only admins change the other settings.
create or replace function private.inventory_settings_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  if (new.hold_days is distinct from old.hold_days or new.alert_assignee_id is distinct from old.alert_assignee_id)
     and not private.is_admin() then
    raise exception 'only admins change inventory settings' using errcode = '42501', hint = 'forbidden';
  end if;
  if new.hold_days is distinct from old.hold_days and (new.hold_days is null or new.hold_days not between 1 and 90) then
    raise exception 'a hold lasts 1 to 90 days' using errcode = '22023', hint = 'hold_days';
  end if;
  if new.alert_assignee_id is distinct from old.alert_assignee_id and new.alert_assignee_id is not null
     and not exists (select 1 from public.profiles p where p.id = new.alert_assignee_id and p.org_id = new.org_id) then
    raise exception 'the assignee must be in this organisation' using errcode = '22023', hint = 'assignee';
  end if;
  if new.sharing_enabled is distinct from old.sharing_enabled then
    if new.sharing_enabled is null then
      raise exception 'sharing is on or off' using errcode = '22023', hint = 'sharing';
    end if;
    if new.sharing_enabled and not (private.is_admin() and private.has_recent_aal2(600)) then
      if not private.is_admin() then
        raise exception 'only admins switch sharing on' using errcode = '42501', hint = 'forbidden';
      end if;
      raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
    end if;
    if not new.sharing_enabled and not private.is_manager_or_admin() then
      raise exception 'only managers and admins switch sharing off' using errcode = '42501', hint = 'forbidden';
    end if;
    new.sharing_changed_at := now();
    new.sharing_changed_by := (select auth.uid());
  else
    new.sharing_changed_at := old.sharing_changed_at;
    new.sharing_changed_by := old.sharing_changed_by;
  end if;
  return new;
end;
$$;

-- Import undo: a lead with a link is touched (6d's definition, with Day 4d's file check since the merge of Day 5,
-- 15 Oct 2026).
create or replace function private.lead_import_untouched(p_batch uuid, p_limit integer) returns setof uuid
language sql stable set search_path = '' as $$
  select c.id from public.companies c
   where c.import_batch_id = p_batch and c.updated_at = c.created_at
     and not exists (select 1 from public.activities a where a.company_id = c.id)
     and not exists (select 1 from public.contacts k where k.company_id = c.id)
     and not exists (select 1 from public.deals d where d.company_id = c.id)
     and not exists (select 1 from public.tasks t where t.company_id = c.id)
     and not private.lead_has_files(c.id)
     and not exists (select 1 from private.stock_reservations r where r.company_id = c.id)
     and not exists (select 1 from private.orders o where o.company_id = c.id)
     and not exists (select 1 from private.stock_requests q where q.company_id = c.id)
     and not exists (select 1 from private.share_links s where s.company_id = c.id)
   order by c.id
   limit p_limit
$$;

-- ===========================================================================
-- 5. Row level security and grants (deny by default; restrictive require_mfa for authenticated; column grants only)
-- ===========================================================================
alter table private.share_links enable row level security;
alter table private.share_rate enable row level security;
create policy require_mfa on private.share_links as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
create policy require_mfa on private.share_rate as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));

-- Team: links are seen by the lead's owner, managers and admins; made by an editor of the lead; changed by their
-- creator, the lead's owner, managers and admins.
create policy share_links_select on private.share_links for select to authenticated using (
  org_id = (select private.current_org_id())
  and ((select private.is_manager_or_admin())
       or exists (select 1 from public.companies c where c.id = share_links.company_id and c.owner_id = (select auth.uid()))));
create policy share_links_insert on private.share_links for insert to authenticated with check (
  org_id = (select private.current_org_id())
  and exists (select 1 from public.companies c
               where c.id = share_links.company_id and c.org_id = share_links.org_id
                 and ((select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()))));
create policy share_links_update on private.share_links for update to authenticated
  using (org_id = (select private.current_org_id())
         and (created_by = (select auth.uid()) or (select private.is_manager_or_admin())
              or exists (select 1 from public.companies c where c.id = share_links.company_id and c.owner_id = (select auth.uid()))))
  with check (org_id = (select private.current_org_id()));
revoke all on private.share_links, private.share_rate from public, anon, authenticated;
grant select (id, org_id, company_id, token_hint, label, language, show_in_transit, allow_requests, signature,
              expires_at, revoked_at, revoked_by, created_by, created_at, updated_at, open_count, last_opened_at,
              request_count, last_request_at),
      insert (company_id, label, language, show_in_transit, allow_requests, expires_at),
      update (label, language, show_in_transit, allow_requests, expires_at, revoked_at)
  on private.share_links to authenticated;

-- Settings (REBASE: the 6a policy, widened): managers reach the row to switch sharing off; the guard refuses every
-- other setting to non-admins (one permissive policy, so the advisors see no overlap).
drop policy inventory_settings_update on private.inventory_settings;
create policy inventory_settings_update on private.inventory_settings for update to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_manager_or_admin()))
  with check (org_id = (select private.current_org_id()) and (select private.is_manager_or_admin()));
grant update (sharing_enabled) on private.inventory_settings to authenticated;

-- share_reader: the whole list. Nothing on product_costs, orders, deals, companies, contacts, profiles, tasks,
-- stock_reservations, stock_movements, audit_log, or any other column of these tables.
grant select (id, org_id, company_id, token_hash, language, show_in_transit, allow_requests, signature, expires_at,
              revoked_at, open_count, last_opened_at, request_count, last_request_at)
  on private.share_links to share_reader;
grant update (open_count, last_opened_at, request_count, last_request_at) on private.share_links to share_reader;
grant select (org_id, sharing_enabled) on private.inventory_settings to share_reader;
grant select (id, org_id, number, name, category, pieces_per_carton, price_max, transit_eta, share_visible, archived_at)
  on public.products to share_reader;
grant select (product_id, location_id, org_id, on_hand, reserved) on public.stock_levels to share_reader;
grant select (id, org_id, kind) on public.locations to share_reader;
grant select, insert, update, delete on private.share_rate to share_reader;
grant select (id, org_id, company_id, share_link_id, status, idempotency_key, created_at) on private.stock_requests
  to share_reader;
grant insert (org_id, company_id, share_link_id, source, note, requester_name, language, idempotency_key)
  on private.stock_requests to share_reader;
grant insert (request_id, position, org_id, product_id, description, quantity, unit, pieces, price_shown, availability)
  on private.stock_request_lines to share_reader;

create policy share_links_reader on private.share_links for select to share_reader
  using (token_hash = (select private.share_token_hash()));
create policy share_links_reader_update on private.share_links for update to share_reader
  using (token_hash = (select private.share_token_hash()))
  with check (token_hash = (select private.share_token_hash()));
create policy share_rate_reader on private.share_rate for all to share_reader
  using (scope_id in ((select private.share_link_id()), (select private.share_org())))
  with check (scope_id in ((select private.share_link_id()), (select private.share_org())));
create policy stock_requests_reader on private.stock_requests for select to share_reader
  using (share_link_id = (select private.share_link_id()));
create policy stock_requests_reader_insert on private.stock_requests for insert to share_reader
  with check (share_link_id = (select private.share_link_id()) and org_id = (select private.share_org())
              and source = 'share_link'
              and company_id = (select l.company_id from private.share_links l
                                 where l.id = (select private.share_link_id())));
create policy stock_request_lines_reader_insert on private.stock_request_lines for insert to share_reader
  with check (org_id = (select private.share_org())
              and exists (select 1 from private.stock_requests r
                           where r.id = stock_request_lines.request_id
                             and r.share_link_id = (select private.share_link_id())));
create policy inventory_settings_reader on private.inventory_settings for select to share_reader
  using (org_id = (select private.share_org()));
create policy products_reader on public.products for select to share_reader
  using (org_id = (select private.share_org()));
create policy stock_levels_reader on public.stock_levels for select to share_reader
  using (org_id = (select private.share_org()));
create policy locations_reader on public.locations for select to share_reader
  using (org_id = (select private.share_org()));

-- ===========================================================================
-- 6. The whitelist, one definition for the client page and the team's preview (invoker: as share_reader inside
--    share_view, as authenticated under RLS inside share_preview). Positional arrays (design I10: about 50 bytes an
--    item, so 2,000 items stay under 150 KB raw): [number, name, category, price_max, pieces_per_carton, warehouse
--    available, transit available, eta week]. The product's number (P-0042) names it in a request; no internal id
--    leaves. Never a cost, a minimum price, a hold, a lead or the exact arrival day. 2,000 items at most, after the
--    filter.
-- ===========================================================================
create function private.share_items(p_org uuid, p_with_transit boolean) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_array(i.number, i.name, i.category, trim_scale(i.price_max)::text,
                                              i.ppc, i.wh, i.tr, i.eta_week)
                            order by i.category nulls last, i.sort_name, i.id), '[]'::jsonb)
    from (select p.id, p.number, p.name, p.category, p.price_max, p.pieces_per_carton as ppc,
                 lower(p.name) as sort_name,
                 greatest(coalesce(w.on_hand - w.reserved, 0), 0) as wh,
                 case when p_with_transit then greatest(coalesce(t.on_hand - t.reserved, 0), 0) else 0 end as tr,
                 case when p_with_transit and coalesce(t.on_hand - t.reserved, 0) > 0
                       and p.transit_eta >= (now() at time zone 'Europe/Paris')::date
                      then date_trunc('week', p.transit_eta)::date end as eta_week      -- never the day
            from public.products p
            join public.locations lw on lw.org_id = p.org_id and lw.kind = 'warehouse'
            join public.locations lt on lt.org_id = p.org_id and lt.kind = 'transit'
            left join public.stock_levels w on w.product_id = p.id and w.location_id = lw.id
            left join public.stock_levels t on t.product_id = p.id and t.location_id = lt.id
           where p.org_id = p_org and p.archived_at is null and p.share_visible
             and (coalesce(w.on_hand - w.reserved, 0) > 0
                  or (p_with_transit and coalesce(t.on_hand - t.reserved, 0) > 0))
           order by p.category nulls last, lower(p.name), p.id
           limit 2000) i
$$;

-- The counters (invoker: runs as share_reader). Over a limit it refuses without writing; otherwise it adds one to each
-- span and drops this scope's buckets older than 2 days. Under concurrency the overshoot is at most the number of
-- parallel calls.
create function private.share_take(p_scope uuid, p_kind text) returns boolean
language plpgsql volatile set search_path = '' as $$
declare
  v_org constant boolean := p_scope = private.share_org();
  b_m constant timestamptz := date_trunc('minute', now());
  b_h constant timestamptz := date_trunc('hour', now());
  b_d constant timestamptz := date_trunc('day', now());
  lim_m integer;
  lim_h integer;
  lim_d integer;
begin
  if p_scope is null then
    return false;
  elsif p_kind = 'view' and not v_org then
    lim_m := 30; lim_h := 600;
  elsif p_kind = 'request' and not v_org then
    lim_h := 5; lim_d := 20;
  elsif p_kind = 'request' and v_org then
    lim_d := 200;
  else
    return false;
  end if;
  if exists (select 1 from private.share_rate r
              where r.scope_id = p_scope and r.kind = p_kind
                and ((r.span = 'm' and r.bucket = b_m and r.n >= lim_m)
                     or (r.span = 'h' and r.bucket = b_h and r.n >= lim_h)
                     or (r.span = 'd' and r.bucket = b_d and r.n >= lim_d))) then
    return false;
  end if;
  insert into private.share_rate as r (scope_id, kind, span, bucket, n)
  select p_scope, p_kind, s.span, s.bucket, 1
    from (values ('m', b_m, lim_m), ('h', b_h, lim_h), ('d', b_d, lim_d)) s (span, bucket, lim)
   where s.lim is not null
  on conflict (scope_id, kind, span, bucket) do update set n = r.n + 1;
  delete from private.share_rate r where r.scope_id = p_scope and r.bucket < now() - interval '2 days';
  return true;
end;
$$;

-- ===========================================================================
-- 7. The two functions anon may call (definer, owner share_reader, VOLATILE so PostgREST serves them on POST only)
-- ===========================================================================
-- One answer for every link that does not work (malformed, unknown, revoked, expired, sharing off, lead deleted):
-- {"status":"inactive"}. A malformed token reads nothing; a well-formed unknown one is one index probe and no write.
create function public.share_view(p_token text, p_known_version text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_link record;
  v_on boolean;
  v_items jsonb;
  v_version text;
begin
  if p_token is null or p_token !~ '^tss_[A-Za-z0-9_-]{43}$' then
    return '{"status":"inactive"}'::jsonb;
  end if;
  perform set_config('topstock.share_token_hash', encode(sha256(convert_to(p_token, 'UTF8')), 'hex'), true);
  select l.id, l.org_id, l.language, l.show_in_transit, l.allow_requests, l.signature into v_link
    from private.share_links l
   where l.token_hash = sha256(convert_to(p_token, 'UTF8')) and l.revoked_at is null and l.expires_at > now();
  if not found then
    return '{"status":"inactive"}'::jsonb;
  end if;
  perform set_config('topstock.share_link', v_link.id::text, true);
  perform set_config('topstock.share_org', v_link.org_id::text, true);
  select s.sharing_enabled into v_on from private.inventory_settings s where s.org_id = v_link.org_id;
  if v_on is not true then
    return '{"status":"inactive"}'::jsonb;
  end if;
  if not private.share_take(v_link.id, 'view') then
    return '{"status":"slow_down"}'::jsonb;
  end if;
  update private.share_links l set open_count = l.open_count + 1, last_opened_at = now()
   where l.id = v_link.id and (l.last_opened_at is null or l.last_opened_at < now() - interval '5 minutes');
  v_items := private.share_items(v_link.org_id, v_link.show_in_transit);
  v_version := left(md5(v_items::text || v_link.allow_requests::text || coalesce(v_link.signature, '')), 16);
  if v_version = p_known_version then
    return jsonb_build_object('status', 'ok', 'unchanged', true, 'version', v_version);
  end if;
  return jsonb_build_object('status', 'ok', 'version', v_version, 'language', v_link.language, 'currency', 'EUR',
    'show_in_transit', v_link.show_in_transit, 'allow_requests', v_link.allow_requests,
    'signature', v_link.signature, 'generated_at', now(), 'items', v_items);
end;
$$;

-- A client's request: {"status": "received" | "inactive" | "closed" | "invalid" | "slow_down" | "too_many_open"}.
-- Every shape problem gets the same "invalid"; products are named by their number and resolve only among the visible
-- ones (the same whitelist the page shows).
create function public.share_request(p_token text, p_payload jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_link record;
  v_on boolean;
  v_key uuid;
  v_note text;
  v_name text;
  v_request uuid;
  v_n integer;
  unsafe constant text := '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]';
  unsafe_note constant text := '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]';
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_token is null or p_token !~ '^tss_[A-Za-z0-9_-]{43}$' then
    return '{"status":"inactive"}'::jsonb;
  end if;
  perform set_config('topstock.share_token_hash', encode(sha256(convert_to(p_token, 'UTF8')), 'hex'), true);
  select l.id, l.org_id, l.company_id, l.show_in_transit, l.allow_requests, l.signature into v_link
    from private.share_links l
   where l.token_hash = sha256(convert_to(p_token, 'UTF8')) and l.revoked_at is null and l.expires_at > now();
  if not found then
    return '{"status":"inactive"}'::jsonb;
  end if;
  perform set_config('topstock.share_link', v_link.id::text, true);
  perform set_config('topstock.share_org', v_link.org_id::text, true);
  select s.sharing_enabled into v_on from private.inventory_settings s where s.org_id = v_link.org_id;
  if v_on is not true then
    return '{"status":"inactive"}'::jsonb;
  end if;
  if not v_link.allow_requests then
    return '{"status":"closed"}'::jsonb;
  end if;
  -- Shape, read as text before anything is cast.
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 16384
     or (select array_agg(k order by k) from jsonb_object_keys(p_payload) k)
        is distinct from array['idempotency_key', 'lines', 'name', 'note']
     or jsonb_typeof(p_payload -> 'lines') <> 'array' or jsonb_array_length(p_payload -> 'lines') > 20
     or jsonb_typeof(p_payload -> 'idempotency_key') <> 'string' or p_payload ->> 'idempotency_key' !~ uuid_re
     or jsonb_typeof(p_payload -> 'note') not in ('string', 'null') or jsonb_typeof(p_payload -> 'name') not in ('string', 'null')
     or char_length(coalesce(p_payload ->> 'note', '')) > 1000 or coalesce(p_payload ->> 'note', '') ~ unsafe_note
     or char_length(coalesce(p_payload ->> 'name', '')) > 80 or coalesce(p_payload ->> 'name', '') ~ unsafe
     or exists (select 1 from jsonb_array_elements(p_payload -> 'lines') e
                 where jsonb_typeof(e) <> 'object'
                    or (select array_agg(k order by k) from jsonb_object_keys(e) k)
                       is distinct from array['description', 'product_number', 'quantity', 'unit']
                    or jsonb_typeof(e -> 'quantity') not in ('string', 'number')
                    or e ->> 'quantity' !~ '^[0-9]{1,8}$' or (e ->> 'quantity')::integer not between 1 and 10000000
                    or jsonb_typeof(e -> 'unit') <> 'string' or e ->> 'unit' not in ('piece', 'carton')
                    or jsonb_typeof(e -> 'product_number') not in ('string', 'number', 'null')
                    or jsonb_typeof(e -> 'description') not in ('string', 'null')
                    or (e ->> 'product_number' is not null and e ->> 'product_number' !~ '^[1-9][0-9]{0,8}$')
                    or (e ->> 'product_number' is null
                        and (char_length(btrim(coalesce(e ->> 'description', ''))) not between 1 and 200
                             or e ->> 'description' ~ unsafe or e ->> 'unit' <> 'piece'))) then
    return '{"status":"invalid"}'::jsonb;
  end if;
  v_key := (p_payload ->> 'idempotency_key')::uuid;
  v_note := nullif(btrim(p_payload ->> 'note'), '');
  v_name := nullif(btrim(p_payload ->> 'name'), '');
  if jsonb_array_length(p_payload -> 'lines') = 0 and char_length(coalesce(v_note, '')) < 3 then
    return '{"status":"invalid"}'::jsonb;
  end if;
  if (select count(*) from jsonb_array_elements(p_payload -> 'lines') e where e ->> 'product_number' is not null)
     <> (select count(distinct e ->> 'product_number') from jsonb_array_elements(p_payload -> 'lines') e
          where e ->> 'product_number' is not null) then
    return '{"status":"invalid"}'::jsonb;
  end if;
  -- A retry of the same request writes nothing.
  if exists (select 1 from private.stock_requests r where r.share_link_id = v_link.id and r.idempotency_key = v_key) then
    return jsonb_build_object('status', 'received', 'signature', v_link.signature);
  end if;
  -- Products: only the visible ones (share_items' rule, read for the named products only: perf I11).
  if exists (select 1 from jsonb_array_elements(p_payload -> 'lines') e
              where e ->> 'product_number' is not null
                and not exists (
                  select 1 from public.products p
                    join public.locations lw on lw.org_id = p.org_id and lw.kind = 'warehouse'
                    join public.locations lt on lt.org_id = p.org_id and lt.kind = 'transit'
                    left join public.stock_levels w on w.product_id = p.id and w.location_id = lw.id
                    left join public.stock_levels t on t.product_id = p.id and t.location_id = lt.id
                   where p.org_id = v_link.org_id and p.number = (e ->> 'product_number')::integer
                     and p.archived_at is null and p.share_visible
                     and (coalesce(w.on_hand - w.reserved, 0) > 0
                          or (v_link.show_in_transit and coalesce(t.on_hand - t.reserved, 0) > 0)))) then
    return '{"status":"invalid"}'::jsonb;
  end if;
  -- Limits: 10 new requests on the link at most; then 5 an hour and 20 a day a link, 200 a day an organisation.
  select count(*) into v_n from (select 1 from private.stock_requests r
                                  where r.share_link_id = v_link.id and r.status = 'new' limit 10) x;
  if v_n >= 10 then
    return '{"status":"too_many_open"}'::jsonb;
  end if;
  if not private.share_take(v_link.id, 'request') or not private.share_take(v_link.org_id, 'request') then
    return '{"status":"slow_down"}'::jsonb;
  end if;
  begin
    insert into private.stock_requests (org_id, company_id, share_link_id, source, note, requester_name, language,
                                        idempotency_key)
    values (v_link.org_id, v_link.company_id, v_link.id, 'share_link', v_note, v_name, null, v_key)
    returning id into v_request;
  exception when unique_violation then
    return jsonb_build_object('status', 'received', 'signature', v_link.signature);
  end;
  insert into private.stock_request_lines (request_id, position, org_id, product_id, description, quantity, unit,
                                           pieces, price_shown, availability)
  select v_request, e.n, v_link.org_id,
         (select p.id from public.products p where p.org_id = v_link.org_id and p.number = (e.v ->> 'product_number')::integer),
         case when e.v ->> 'product_number' is null then btrim(e.v ->> 'description') end,
         (e.v ->> 'quantity')::integer, e.v ->> 'unit', 1, null, 'not_listed'      -- the line guard sets the last three
    from jsonb_array_elements(p_payload -> 'lines') with ordinality e (v, n);
  update private.share_links l set request_count = l.request_count + 1, last_request_at = now() where l.id = v_link.id;
  return jsonb_build_object('status', 'received', 'signature', v_link.signature);
end;
$$;

-- ===========================================================================
-- 8. Team RPCs (invoker, static SQL; the guard, the policies and the column grants decide)
-- ===========================================================================
-- Make a link (an editor of the lead with a fresh code). Returns {id, token, expires_at} once: only the hash is kept.
-- p_replace revokes the lead's other active links in the same transaction.
create function public.create_share_link(p_company uuid, p_language text, p_label text default null,
                                         p_expires_days integer default 90, p_show_in_transit boolean default true,
                                         p_allow_requests boolean default true, p_replace boolean default false)
returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_id uuid;
  v_expires timestamptz;
  v_token text;
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_expires_days is null or p_expires_days not between 1 and 366 or p_language is null
     or p_language not in ('en', 'fr') or p_show_in_transit is null or p_allow_requests is null or p_replace is null then
    raise exception 'check the link settings' using errcode = '22023', hint = 'bounds';
  end if;
  if not private.has_recent_aal2(600) then
    raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company) then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if p_replace then
    update private.share_links l set revoked_at = now()
     where l.company_id = p_company and l.revoked_at is null and l.expires_at > now();
  end if;
  insert into private.share_links (company_id, label, language, show_in_transit, allow_requests, expires_at)
  values (p_company, p_label, p_language, p_show_in_transit, p_allow_requests, now() + make_interval(days => p_expires_days))
  returning id, expires_at into v_id, v_expires;
  v_token := nullif(current_setting('topstock.new_share_token', true), '');
  perform set_config('topstock.new_share_token', '', true);
  if v_token is null or v_token !~ '^tss_[A-Za-z0-9_-]{43}$' then
    raise exception 'the link could not be made' using errcode = '22023', hint = 'unavailable';
  end if;
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_expires);
end;
$$;

-- Revoke (no code; for good; effective on the next request).
create function public.revoke_share_link(p_id uuid) returns void
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  update private.share_links l set revoked_at = now() where l.id = p_id and l.revoked_at is null;
  if not found then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Extend (a fresh code): valid for p_days from now, 1 to 366.
create function public.extend_share_link(p_id uuid, p_days integer) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_expires timestamptz;
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_days is null or p_days not between 1 and 366 then
    raise exception 'a link lasts 1 to 366 days' using errcode = '22023', hint = 'expiry';
  end if;
  if not private.has_recent_aal2(600) then
    raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
  end if;
  update private.share_links l set expires_at = now() + make_interval(days => p_days)
   where l.id = p_id and l.revoked_at is null
  returning l.expires_at into v_expires;
  if not found then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', p_id, 'expires_at', v_expires);
end;
$$;

-- The links the caller may see (a lead's, or every lead's for Settings), newest first, keyset pages. No token_hash.
create function public.list_share_links(p_company uuid default null, p_active_only boolean default true,
                                        p_before_created timestamptz default null, p_before_id uuid default null,
                                        p_limit integer default 50)
returns table (id uuid, company_id uuid, company_name text, label text, language text, show_in_transit boolean,
               allow_requests boolean, signature text, token_hint text, expires_at timestamptz, revoked_at timestamptz,
               created_by uuid, created_by_first_name text, created_at timestamptz, open_count integer,
               last_opened_at timestamptz, request_count integer, last_request_at timestamptz, active boolean)
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = 'force_custom_plan' as $$
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_before_created is null) <> (p_before_id is null)
     or p_active_only is null then
    raise exception 'invalid page' using errcode = '22023', hint = 'bounds';
  end if;
  return query
    with page as materialized (
      select l.id, l.company_id, l.label, l.language, l.show_in_transit, l.allow_requests, l.signature, l.token_hint,
             l.expires_at, l.revoked_at, l.created_by, l.created_at, l.open_count, l.last_opened_at, l.request_count,
             l.last_request_at
        from private.share_links l
       where (p_company is null or l.company_id = p_company)
         and (not p_active_only or (l.revoked_at is null and l.expires_at > now()))
         and (p_before_id is null or (l.created_at, l.id) < (p_before_created, p_before_id))
       order by l.created_at desc, l.id desc
       limit p_limit)
    select pg.id, pg.company_id, c.name, pg.label, pg.language, pg.show_in_transit, pg.allow_requests, pg.signature,
           pg.token_hint, pg.expires_at, pg.revoked_at, pg.created_by, u.first_name, pg.created_at, pg.open_count,
           pg.last_opened_at, pg.request_count, pg.last_request_at, pg.revoked_at is null and pg.expires_at > now()
      from page pg
      join public.companies c on c.id = pg.company_id
      left join public.profiles u on u.id = pg.created_by
     order by pg.created_at desc, pg.id desc;
end;
$$;

-- The kill switch: on for an admin with a fresh code, off for a manager or an admin (the settings guard checks).
create function public.set_sharing_enabled(p_on boolean) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
begin
  if p_on is null then
    raise exception 'sharing is on or off' using errcode = '22023', hint = 'sharing';
  end if;
  if not private.is_manager_or_admin() or (p_on and not private.is_admin()) then
    raise exception 'not allowed' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_on and not private.has_recent_aal2(600) then
    raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
  end if;
  update private.inventory_settings s set sharing_enabled = p_on where s.org_id = v_org;
  return public.get_inventory_settings();
end;
$$;

-- "What clients see": the same whitelist, read as the signed-in teammate (with arriving stock), plus the switch.
create function public.share_preview() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
begin
  return jsonb_build_object(
    'sharing_enabled', (select s.sharing_enabled from private.inventory_settings s where s.org_id = v_org),
    'signature', (select left(nullif(btrim(p.first_name), ''), 60) from public.profiles p where p.id = (select auth.uid())),
    'generated_at', now(),
    'items', private.share_items(v_org, true));
end;
$$;

-- Settings read (REBASE: from 20261017090000_inventory_reads.sql, 6b, unmerged) with the sharing switch.
create or replace function public.get_inventory_settings() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
  v jsonb;
begin
  select jsonb_build_object(
           'hold_days', s.hold_days, 'alert_assignee_id', s.alert_assignee_id,
           'warehouse_name', (select l.name from public.locations l where l.org_id = v_org and l.kind = 'warehouse'),
           'transit_name', (select l.name from public.locations l where l.org_id = v_org and l.kind = 'transit'),
           'can_edit', private.is_admin(),
           'sharing_enabled', s.sharing_enabled, 'sharing_changed_at', s.sharing_changed_at,
           'can_share_on', private.is_admin(), 'can_share_off', private.is_manager_or_admin())
    into v
    from private.inventory_settings s
   where s.org_id = v_org;
  if v is null then
    raise exception 'settings not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

-- ===========================================================================
-- 9. Function privileges
-- ===========================================================================
-- Helpers and the whitelist: share_reader (and authenticated for the preview); trigger functions: nobody.
revoke all on function private.share_token_hash(), private.share_link_id(), private.share_org(),
  private.share_items(uuid, boolean), private.share_take(uuid, text) from public, anon, authenticated;
grant execute on function private.share_token_hash(), private.share_link_id(), private.share_org(),
  private.share_items(uuid, boolean), private.share_take(uuid, text) to share_reader;
grant execute on function private.share_items(uuid, boolean) to authenticated;
revoke all on function private.share_link_guard(), private.share_link_caps(), private.audit_share_link_row(),
  private.stock_request_task() from public, anon, authenticated;
-- The guards share_reader fires (invoker trigger functions run with the caller's rights; a trigger needs no EXECUTE
-- grant, so none is given).

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.create_share_link(uuid, text, text, integer, boolean, boolean, boolean)',
    'public.revoke_share_link(uuid)',
    'public.extend_share_link(uuid, integer)',
    'public.list_share_links(uuid, boolean, timestamptz, uuid, integer)',
    'public.set_sharing_enabled(boolean)',
    'public.share_preview()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- The two anon functions: owned by share_reader (spike S1: create on public only while the owner changes).
grant create on schema public to share_reader;
alter function public.share_view(text, text) owner to share_reader;
alter function public.share_request(text, jsonb) owner to share_reader;
revoke create on schema public from share_reader;
revoke all on function public.share_view(text, text), public.share_request(text, jsonb) from public, authenticated;
grant execute on function public.share_view(text, text), public.share_request(text, jsonb) to anon;
