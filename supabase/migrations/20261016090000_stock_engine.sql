-- Day 6a: the stock engine (database only; design docs/evidence/day6/design.md sections 3.1, 4 and 5.1; decisions D2 to
-- D9, D13 to D15, D19 to D21, D35). No screens use it yet (6b does).
-- What it adds, in plain words:
--  - products (the stock sheet's CATÉGORIE is the name), one warehouse and one "in transit" place per organisation, and
--    the cost per piece in a separate table only managers and admins can read;
--  - stock levels per product and place, which nobody can write: not a client, not an admin through the API. Every
--    change is one row in an append-only ledger, and one trigger owned by postgres applies each row under a row lock;
--  - holds (reservations) for a lead, and for one of its deals, that end on a date, move with the goods when they
--    arrive, and are released when the deal is lost or deleted;
--  - post_stock_movement and the product RPCs, an integrity check, and a nightly job (scheduled only where pg_cron is
--    already installed).
-- House rules (design 3.0): every function sets search_path = ''; public RPCs are SECURITY INVOKER with static SQL;
-- definer code is limited to trigger functions and private helpers with no REST endpoint, all owned by postgres;
-- every CHECK that user input can reach has a pre-check with a constant message first, so "Failing row contains ..."
-- never reaches the logs; clients get column grants only. "Safe text" refuses C0 and C1 controls, DEL, zero-width
-- characters, bidi embeddings, overrides and isolates, and the byte order mark (design 3.0 plus C1, as Day 4a decided).
-- Shared objects of earlier days: only private.lead_import_untouched is redefined (marked REBASE below); audit uses the
-- existing private.audit_row on products and locations and a new trigger function for the other stock tables.

-- ===========================================================================
-- Part 1. Products, places, costs and settings
-- ===========================================================================

-- The "same product" key (D13): a fixed map folds A-Z and the Latin-1 and Latin Extended-A letters to lower-case ASCII
-- (Œ œ → oe, Æ æ → ae, ß → ss), soft hyphens, combining accents and zero-width characters are deleted, punctuation and
-- symbols become spaces, spaces are collapsed and trimmed, digits are kept. No lower() and only code point ranges, so the
-- key is the same under every database locale (ICU on Supabase, libc C locally): letters of other scripts are kept as
-- typed. "T-SHIRT COTON", "T-shirt coton" and "t shirt  coton" share one key; "1.5L" and "1,5L" too ("1 5l").
create function private.product_name_key(name text) returns text
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  fold_from constant text := 'abcdefghijklmnopqrstuvwxyz 0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝàáâãäåçèéêëìíîïðñòóôõöøùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĐđĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħĨĩĪīĬĭĮįİıĴĵĶķĸĹĺĻļĽľĿŀŁłŃńŅņŇňŉŊŋŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŧŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžſ';
  fold_to constant text := 'abcdefghijklmnopqrstuvwxyz 0123456789-abcdefghijklmnopqrstuvwxyzaaaaaaceeeeiiiidnoooooouuuuyaaaaaaceeeeiiiidnoooooouuuuyyaaaaaaccccccccddddeeeeeeeeeegggggggghhhhiiiiiiiiiijjkkkllllllllllnnnnnnnnnoooooorrrrrrssssssssttttttuuuuuuuuuuuuwwyyyzzzzzzs';
  -- Deleted, as part of the word they sit in: soft hyphens, combining accents (a decomposed "é"), zero-width characters
  -- and the byte order mark.
  glue constant text := '[\u00AD\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u200B-\u200D\u2060\u20D0-\u20FF\uFE20-\uFE2F\uFEFF]';
  -- Turned into spaces: the same set as Day 3b's lead name key (ASCII other than letters and digits, controls, Latin-1
  -- punctuation and symbols, × ÷, General Punctuation to Miscellaneous Symbols and Arrows, CJK and full-width
  -- punctuation, emoji, tag characters).
  punct constant text := '[\u0001-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u00BF\u00D7\u00F7\u02BC\u0300-\u036F\u037E\u0384-\u0385\u0387\u060C-\u060D\u061B-\u061C\u061F\u066A-\u066D\u06D4\u1680\u1AB0-\u1AFF\u1DC0-\u1DFF\u2000-\u2BFF\u2E00-\u2E7F\u3000-\u3004\u3008-\u3020\u302A-\u3030\u3036-\u3037\u303D-\u303F\u30A0\u30FB\uFE00-\uFE6F\uFEFF\uFF00-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\uFFE0-\uFFFF\U0001F000-\U0001FBFF\U000E0000-\U000E007F\U000E0100-\U000E01EF]';
  n text;
begin
  n := replace(replace(replace(replace(replace(translate(coalesce(name, ''), fold_from, fold_to),
         'Œ', 'oe'), 'œ', 'oe'), 'Æ', 'ae'), 'æ', 'ae'), 'ß', 'ss');
  n := regexp_replace(regexp_replace(n, glue, '', 'g'), punct, ' ', 'g');
  return btrim(regexp_replace(n, ' {2,}', ' ', 'g'));   -- '' when nothing is left: the product guard refuses that name
end;
$$;

-- One row per organisation (seeded below and for every new organisation).
create table private.inventory_settings (
  org_id uuid primary key references public.orgs (id),
  alert_assignee_id uuid references public.profiles (id) on delete set null,   -- Restock tasks (6d); seeded: oldest admin
  hold_days smallint not null default 14 check (hold_days between 1 and 90),   -- default length of a hold
  last_sweep_at timestamptz,                                                   -- expiry sweep throttle (D8)
  updated_at timestamptz not null default now()
);
create index inventory_settings_assignee_idx on private.inventory_settings (alert_assignee_id)
  where alert_assignee_id is not null;

-- Places (D35): exactly one warehouse and one transit per organisation. Supplier Stock is not a place.
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  kind text not null check (kind in ('warehouse', 'transit')),
  name text not null check (char_length(name) between 1 and 80 and name = btrim(name)
                            and name !~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, kind)
);

-- The two places and the settings row of an organisation. Definer: new organisations are created by maintenance
-- sessions; nothing a client sends reaches it. The admin seeded as the alert assignee is the oldest admin, if any.
create function private.seed_org_inventory(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.locations (org_id, kind, name)
  values (p_org, 'warehouse', 'Warehouse France'), (p_org, 'transit', 'In transit')
  on conflict (org_id, kind) do nothing;
  insert into private.inventory_settings (org_id, alert_assignee_id)
  values (p_org, (select p.id from public.profiles p where p.org_id = p_org and p.role = 'admin'
                   order by p.created_at, p.id limit 1))
  on conflict (org_id) do nothing;
$$;
create function private.seed_org_inventory_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.seed_org_inventory(new.id);
  return null;
end;
$$;
create trigger seed_org_inventory after insert on public.orgs
  for each row execute function private.seed_org_inventory_trigger();
do $$ begin perform private.seed_org_inventory(o.id) from public.orgs o; end $$;

-- Renaming a place: admins (policy), name only (grant), with a constant message before the CHECK.
create function private.location_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  new.name := btrim(new.name);
  if new.name is null or char_length(new.name) not between 1 and 80
     or new.name ~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
    raise exception 'a place name needs 1 to 80 characters, without control characters'
      using errcode = '22023', hint = 'location_name';
  end if;
  return new;
end;
$$;
create trigger location_guard before update on public.locations
  for each row execute function private.location_guard();

-- Products (design 3.1). Archive, never delete: the ledger references them.
create table public.products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  number integer generated always as identity unique,            -- shown as P-0042 (D14); needs no sequence grant
  name text not null,                                            -- CATÉGORIE
  name_key text generated always as (private.product_name_key(name)) stored,
  category text,                                                 -- optional grouping, set in the app
  pieces_per_carton integer not null,                            -- QTY PAR CARTON
  cartons_per_pallet integer,
  reorder_point integer,                                         -- warehouse available pieces; null = no alert
  price_min numeric(12,4),                                       -- PRIX PAR PCS: internal floor, EUR per piece excl. VAT
  price_max numeric(12,4),                                       -- PRIX PAR PCS MAX: the price clients see, excl. VAT
  transit_eta date,                                              -- expected arrival of the In Transit pieces
  share_visible boolean not null default true,                   -- "Hide from clients" (6e)
  archived_at timestamptz,
  import_batch_id uuid references public.import_batches (id) on delete set null,   -- set by a stock import (6c)
  search_text text generated always as (lower(name || E'\n' || coalesce(category, ''))) stored,
  created_by uuid,                                               -- no FK, like audit_log.actor_id
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_name_check check (char_length(name) between 1 and 200 and name = btrim(name)
    and name !~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'),
  constraint products_category_check check (category is null or (char_length(category) between 1 and 80
    and category = btrim(category)
    and category !~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]')),
  constraint products_carton_check check (pieces_per_carton between 1 and 1000000),
  constraint products_pallet_check check (cartons_per_pallet between 1 and 10000),
  constraint products_reorder_check check (reorder_point between 0 and 50000000),
  constraint products_price_min_check check (price_min between 0 and 1000000),
  constraint products_price_max_check check (price_max between 0 and 1000000),
  constraint products_price_order_check check (price_min is null or price_max is null or price_min <= price_max)
);
create unique index products_name_key_idx on public.products (org_id, name_key);   -- archived included (D13)
create index products_keyset_idx on public.products (org_id, lower(name), id);
create index products_import_batch_idx on public.products (import_batch_id) where import_batch_id is not null;

-- The product guard (invoker). Its name sorts after enforce_org_and_owner (which sets org_id from the caller) and
-- before set_updated_at. Sessions with no signed-in user (fixtures, maintenance) are left alone.
create function private.product_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
begin
  if caller is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := caller;
    new.archived_at := null;
  else
    if new.created_by is distinct from old.created_by or new.import_batch_id is distinct from old.import_batch_id then
      raise exception 'this part of a product cannot change' using errcode = '42501', hint = 'not_editable';
    end if;
    -- Archive: a fresh code and nothing left anywhere (on hand and held). The row is already locked by this update, so
    -- a movement waiting on the product (the apply step's FOR SHARE) applies before or after, never in between.
    if old.archived_at is null and new.archived_at is not null then
      if not private.has_recent_aal2(600) then
        raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
      end if;
      if exists (select 1 from public.stock_levels l
                  where l.product_id = new.id and (l.on_hand <> 0 or l.reserved <> 0)) then
        raise exception 'this product still has stock' using errcode = '22023', hint = 'has_stock';
      end if;
      new.archived_at := now();
    elsif old.archived_at is not null and new.archived_at is null then
      if not private.is_admin() then
        raise exception 'only an admin can restore a product' using errcode = '42501', hint = 'forbidden';
      end if;
      if not private.has_recent_aal2(600) then
        raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
      end if;
    elsif old.archived_at is not null then
      new.archived_at := old.archived_at;   -- the archive time never moves
    end if;
  end if;

  -- Constant messages before the CHECKs, so a product name never reaches the logs.
  new.name := btrim(new.name);
  if new.name is null or char_length(new.name) not between 1 and 200
     or new.name ~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'
     or private.product_name_key(new.name) = '' then
    raise exception 'a product name needs 1 to 200 characters with a letter or a digit, without control characters'
      using errcode = '22023', hint = 'product_name';
  end if;
  new.category := nullif(btrim(new.category), '');
  if char_length(new.category) > 80
     or new.category ~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
    raise exception 'a category needs at most 80 characters, without control characters'
      using errcode = '22023', hint = 'category';
  end if;
  if new.pieces_per_carton is null or new.pieces_per_carton not between 1 and 1000000 then
    raise exception 'pieces per carton must be 1 to 1,000,000' using errcode = '22023', hint = 'carton';
  end if;
  if new.cartons_per_pallet not between 1 and 10000 then
    raise exception 'cartons per pallet must be 1 to 10,000' using errcode = '22023', hint = 'pallet';
  end if;
  if new.reorder_point not between 0 and 50000000 then
    raise exception 'the reorder point must be 0 to 50,000,000' using errcode = '22023', hint = 'reorder';
  end if;
  if new.price_min not between 0 and 1000000 or new.price_max not between 0 and 1000000 then
    raise exception 'prices must be 0 to 1,000,000' using errcode = '22023', hint = 'price';
  end if;
  if new.price_min > new.price_max then
    raise exception 'the minimum price is above the maximum' using errcode = '22023', hint = 'price_order';
  end if;
  if new.share_visible is null then
    new.share_visible := true;
  end if;
  -- An expected date in a sensible window, checked when it is set or changed (an old date never blocks other edits).
  if (tg_op = 'INSERT' or new.transit_eta is distinct from old.transit_eta)
     and new.transit_eta not between v_today - 365 and v_today + 730 then
    raise exception 'the expected date is out of range' using errcode = '22023', hint = 'eta';
  end if;
  -- One product per name key in the org, archived ones included (the unique index is the backstop for a race).
  if (tg_op = 'INSERT' or private.product_name_key(new.name) <> old.name_key)
     and exists (select 1 from public.products p
                  where p.org_id = new.org_id and p.name_key = private.product_name_key(new.name) and p.id <> new.id) then
    raise exception 'a product with this name already exists' using errcode = '22023', hint = 'name_taken';
  end if;
  return new;
end;
$$;
create trigger product_guard before insert or update on public.products
  for each row execute function private.product_guard();

-- Cost per piece (D15): managers and admins only, in a table no product query touches. From a stock sheet it is
-- PP ÷ QUANTITÉ (PP is the lot's total purchase cost; Haider confirmed 11 Oct 2026).
create table private.product_costs (
  product_id uuid primary key references public.products (id),
  org_id uuid not null references public.orgs (id),
  cost_per_piece numeric(14,6) not null check (cost_per_piece between 0 and 1000000),
  source text not null check (source in ('import', 'manual')),
  import_batch_id uuid references public.import_batches (id) on delete set null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create index product_costs_org_idx on private.product_costs (org_id);
create index product_costs_import_batch_idx on private.product_costs (import_batch_id) where import_batch_id is not null;

create function private.product_cost_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  if new.cost_per_piece is null or new.cost_per_piece not between 0 and 1000000 then
    raise exception 'the cost per piece must be 0 to 1,000,000' using errcode = '22023', hint = 'cost';
  end if;
  if new.source is null or new.source not in ('import', 'manual') then
    raise exception 'unknown cost source' using errcode = '22023', hint = 'source';
  end if;
  new.updated_by := (select auth.uid());
  new.updated_at := now();
  return new;
end;
$$;
create trigger product_cost_guard before insert or update on private.product_costs
  for each row execute function private.product_cost_guard();

-- Settings: admins change the alert assignee (a person of the org) and the default hold length.
create function private.inventory_settings_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  if new.hold_days is distinct from old.hold_days and (new.hold_days is null or new.hold_days not between 1 and 90) then
    raise exception 'a hold lasts 1 to 90 days' using errcode = '22023', hint = 'hold_days';
  end if;
  if new.alert_assignee_id is distinct from old.alert_assignee_id and new.alert_assignee_id is not null
     and not exists (select 1 from public.profiles p where p.id = new.alert_assignee_id and p.org_id = new.org_id) then
    raise exception 'the assignee must be in this organisation' using errcode = '22023', hint = 'assignee';
  end if;
  return new;
end;
$$;
create trigger inventory_settings_guard before update on private.inventory_settings
  for each row execute function private.inventory_settings_guard();

-- Shared Day 1 triggers on the new tables: org from the caller (no mass assignment), updated_at, audit.
create trigger enforce_org_and_owner before insert or update on public.products
  for each row execute function private.enforce_org_and_owner();
create trigger enforce_org_and_owner before insert or update on private.product_costs
  for each row execute function private.enforce_org_and_owner();
create trigger set_updated_at before update on public.products
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.locations
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on private.inventory_settings
  for each row execute function private.set_updated_at();
create trigger audit_row after insert or update or delete on public.products
  for each row execute function private.audit_row();
create trigger audit_row after insert or update or delete on public.locations
  for each row execute function private.audit_row();

-- Row level security and grants (part 1). Every table: RLS on, the restrictive two-factor policy, column grants only.
-- Supabase gives new tables in public to anon and authenticated by default, so every grant is revoked first.
do $$
declare
  t text;
begin
  foreach t in array array['public.locations', 'public.products', 'private.product_costs',
                           'private.inventory_settings'] loop
    execute format('alter table %s enable row level security', t);
    execute format('create policy require_mfa on %s as restrictive to authenticated using ((select private.has_aal2())) with check ((select private.has_aal2()))', t);
    execute format('revoke all on %s from public, anon, authenticated', t);
  end loop;
end;
$$;
revoke all on sequence public.products_number_seq from public, anon, authenticated;

create policy locations_select on public.locations for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy locations_update on public.locations for update to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_admin()))
  with check (org_id = (select private.current_org_id()) and (select private.is_admin()));
grant select, update (name) on public.locations to authenticated;

-- Everyone in the org sees products; managers and admins create and change them (D21). No delete: archive instead.
create policy products_select on public.products for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy products_insert on public.products for insert to authenticated
  with check (org_id = (select private.current_org_id()) and (select private.is_manager_or_admin()));
create policy products_update on public.products for update to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_manager_or_admin()))
  with check (org_id = (select private.current_org_id()) and (select private.is_manager_or_admin()));
grant select,
      insert (name, category, pieces_per_carton, cartons_per_pallet, reorder_point, price_min, price_max,
              transit_eta, share_visible),
      update (name, category, pieces_per_carton, cartons_per_pallet, reorder_point, price_min, price_max,
              transit_eta, share_visible, archived_at)
  on public.products to authenticated;

-- Costs: managers and admins of the org, for a product of the org.
create policy product_costs_rw on private.product_costs for all to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_manager_or_admin()))
  with check (org_id = (select private.current_org_id()) and (select private.is_manager_or_admin())
              and exists (select 1 from public.products p where p.id = product_costs.product_id));
grant select, insert (product_id, cost_per_piece, source), update (cost_per_piece, source)
  on private.product_costs to authenticated;

create policy inventory_settings_select on private.inventory_settings for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy inventory_settings_update on private.inventory_settings for update to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_admin()))
  with check (org_id = (select private.current_org_id()) and (select private.is_admin()));
grant select, update (alert_assignee_id, hold_days) on private.inventory_settings to authenticated;

-- Function privileges (part 1). Trigger functions are never callable; the name key is used by the generated column,
-- which runs with the inserting user's privileges.
revoke all on function private.product_name_key(text) from public, anon;
grant execute on function private.product_name_key(text) to authenticated;
revoke all on function private.seed_org_inventory(uuid), private.seed_org_inventory_trigger(),
  private.location_guard(), private.product_guard(), private.product_cost_guard(), private.inventory_settings_guard()
  from public, anon, authenticated;

-- ===========================================================================
-- Part 2. Levels, the ledger, holds and the engine (design section 4)
-- ===========================================================================

-- Stock per product and place. Written only by private.stock_movement_b_apply(); clients may only read it.
create table public.stock_levels (
  product_id uuid not null references public.products (id),
  location_id uuid not null references public.locations (id),
  org_id uuid not null references public.orgs (id),
  on_hand integer not null default 0 check (on_hand between 0 and 50000000),
  reserved integer not null default 0 check (reserved >= 0),
  available integer generated always as (on_hand - reserved) stored,
  version bigint not null default 0,          -- +1 per applied ledger row, under the lock: the true order here (D5)
  crm_moved boolean not null default false,   -- on hand changed by the CRM since a stock sheet last set it (6c)
  last_onhand_batch_id uuid,                  -- the stock import that last changed on hand here; null = the CRM (6c)
  updated_at timestamptz not null default now(),
  primary key (product_id, location_id),
  check (reserved <= on_hand)
);
create index stock_levels_location_idx on public.stock_levels (location_id);
create index stock_levels_org_idx on public.stock_levels (org_id);

-- Holds (reservations). Written only by the apply step.
create table private.stock_reservations (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  product_id uuid not null references public.products (id),
  location_id uuid not null references public.locations (id),
  company_id uuid not null references public.companies (id) on delete restrict,   -- a lead with holds is kept
  deal_id uuid references public.deals (id) on delete set null,                    -- optional; works before Day 5
  quantity integer not null check (quantity between 1 and 50000000),               -- as created
  remaining integer not null check (remaining between 0 and quantity),
  status text not null default 'active' check (status in ('active', 'released', 'fulfilled', 'expired')),
  hold_until date not null,                                                        -- inclusive, Europe/Paris
  note text check (char_length(note) <= 300
                   and note !~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'),
  split_from uuid references private.stock_reservations (id),                      -- the part moved by Arrived
  restored_from uuid references private.stock_reservations (id),                   -- put back by a sale's Undo (6d)
  created_by uuid not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid,
  close_reason text check (close_reason in ('manual', 'deal_lost', 'deal_deleted', 'expired', 'sold')),
  check ((status = 'active') = (remaining > 0))
);
create index reservations_fifo_idx on private.stock_reservations (product_id, location_id, created_at, id)
  where status = 'active';
create index reservations_product_idx on private.stock_reservations (product_id);
create index reservations_location_idx on private.stock_reservations (location_id);
create index reservations_company_idx on private.stock_reservations (company_id, created_at desc);
create index reservations_deal_idx on private.stock_reservations (deal_id) where deal_id is not null;
create index reservations_due_idx on private.stock_reservations (org_id, hold_until) where status = 'active';
create index reservations_org_idx on private.stock_reservations (org_id, created_at desc, id desc);
create index reservations_split_idx on private.stock_reservations (split_from) where split_from is not null;
create index reservations_restored_idx on private.stock_reservations (restored_from) where restored_from is not null;

-- The ledger: append-only, one row per level touched. Clients insert the document columns; the guard and the apply
-- step set everything else.
create table private.stock_movements (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id),
  group_id uuid not null,                              -- one operation: a transfer pair, a sale, an import chunk
  product_id uuid not null references public.products (id),
  location_id uuid not null references public.locations (id),
  kind text not null check (kind in ('receive', 'adjust_in', 'adjust_out', 'transfer_out', 'transfer_in', 'reserve',
                                     'release', 'expire', 'ship', 'return', 'import_in', 'import_out', 'undo_in',
                                     'undo_out')),
                                                       -- 'count' is accepted as input; the apply step turns it into
                                                       -- adjust_in or adjust_out (or skips the row when nothing changes)
  qty integer check (qty between 1 and 50000000),      -- set by the apply step for count and release-all
  target_on_hand integer check (target_on_hand between 0 and 50000000),   -- count only
  expected_on_hand integer,                            -- compare-and-set; defence only
  d_on_hand integer not null default 0,                -- engine-set
  d_reserved integer not null default 0,               -- engine-set
  on_hand_after integer not null default 0,            -- engine-set
  reserved_after integer not null default 0,           -- engine-set
  level_version bigint not null default 0,             -- engine-set
  reason text check (reason in ('received', 'found', 'count', 'damaged', 'lost', 'sample', 'correction', 'other',
                                'manual', 'deal_lost', 'deal_deleted', 'expired', 'sold', 'sale_undone',
                                'sale_cancelled', 'arrived', 'import', 'import_undo')),
  note text check (char_length(note) <= 500
                   and note !~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'),
  company_id uuid,                                     -- history: no FK (the row is immutable)
  deal_id uuid,
  reservation_id uuid references private.stock_reservations (id),
  order_line_id uuid,                                  -- FK added in 6d
  import_batch_id uuid references public.import_batches (id),
  hold_until date,                                     -- reserve input
  pair_id bigint references private.stock_movements (id),   -- transfer_in: its transfer_out
  user_id uuid,                                        -- null = the system; no FK, like audit_log
  created_at timestamptz not null default now(),
  check (d_on_hand <> 0 or d_reserved <> 0),
  -- Only the system writes rows with no person: expiry, and releases from a deal lost or deleted by a maintenance
  -- session (design 3.1 allowed only expire; a deal changed with no signed-in user would otherwise fail).
  check (user_id is not null or kind = 'expire' or (kind = 'release' and reason in ('deal_lost', 'deal_deleted')))
);
create index movements_org_idx on private.stock_movements (org_id, id desc);
create index movements_product_idx on private.stock_movements (product_id, id desc);
create index movements_org_kind_idx on private.stock_movements (org_id, kind, id desc);
create index movements_location_idx on private.stock_movements (location_id);
create index movements_batch_idx on private.stock_movements (import_batch_id) where import_batch_id is not null;
create index movements_reservation_idx on private.stock_movements (reservation_id) where reservation_id is not null;
create index movements_user_created_idx on private.stock_movements (user_id, created_at) where user_id is not null;
create unique index movements_pair_once_idx on private.stock_movements (pair_id) where pair_id is not null;

-- Which holds a ship row used (6d writes it), for Undo and the audit trail.
create table private.stock_hold_uses (
  movement_id bigint not null references private.stock_movements (id) deferrable initially deferred,
  reservation_id uuid not null references private.stock_reservations (id),
  org_id uuid not null references public.orgs (id),
  pieces integer not null check (pieces between 1 and 50000000),
  primary key (movement_id, reservation_id)
);
create index hold_uses_reservation_idx on private.stock_hold_uses (reservation_id);
create index hold_uses_org_idx on private.stock_hold_uses (org_id);

-- Idempotency for every stock RPC (pruned after 7 days by the nightly job).
create table private.movement_requests (
  user_id uuid not null,
  request_id uuid not null,
  kind text not null check (kind in ('receive', 'adjust_in', 'adjust_out', 'count', 'transfer', 'reserve', 'release',
                                     'create_product')),
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id)
);
create index movement_requests_created_idx on private.movement_requests (created_at);

create function private.movement_request_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.user_id := (select auth.uid());
  new.created_at := now();
  new.result := null;
  if new.user_id is null then
    raise exception 'sign in first' using errcode = '42501', hint = 'forbidden';
  end if;
  if new.request_id is null or new.kind is null
     or new.kind not in ('receive', 'adjust_in', 'adjust_out', 'count', 'transfer', 'reserve', 'release',
                         'create_product') then
    raise exception 'bad request id or kind' using errcode = '22023', hint = 'request';
  end if;
  return new;
end;
$$;
create trigger movement_request_guard before insert on private.movement_requests
  for each row execute function private.movement_request_guard();

-- ---------------------------------------------------------------------------
-- The guard (design 4.3): invoker, BEFORE INSERT, runs first (names sort a before b). It checks who may post this
-- movement and that its document is right. "Trusted" means current_user = 'postgres': only the definer helpers and
-- triggers below (expiry, a deal lost or deleted) run as postgres. They skip the caller checks and keep every other
-- rule. authenticated is never trusted.
-- ---------------------------------------------------------------------------
create function private.stock_movement_a_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  trusted constant boolean := current_user = 'postgres';
  caller constant uuid := (select auth.uid());
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
  v_org uuid;
  v_archived timestamptz;
  v_place text;
  d record;
  h record;
begin
  -- Server-set columns: whatever the row says, these come from the server and the engine.
  new.created_at := now();
  new.user_id := case when new.kind = 'expire' then null else caller end;
  new.d_on_hand := 0;
  new.d_reserved := 0;
  new.on_hand_after := 0;
  new.reserved_after := 0;
  new.level_version := 0;

  -- Kinds 6a can post. ship and return (6d) and import_* and undo_* (6c) get their document checks with their PRs.
  if new.kind is null or new.kind not in ('receive', 'adjust_in', 'adjust_out', 'count', 'transfer_out', 'transfer_in',
                                          'reserve', 'release', 'expire') then
    raise exception 'this kind of movement is not available' using errcode = '22023', hint = 'kind';
  end if;
  if not trusted then
    if caller is null or not private.has_aal2() then
      raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
    end if;
    if new.kind = 'expire' then
      raise exception 'only the system ends holds' using errcode = '42501', hint = 'forbidden';
    end if;
  end if;
  if new.group_id is null or new.product_id is null or new.location_id is null then
    raise exception 'a movement needs a group, a product and a place' using errcode = '22023', hint = 'document';
  end if;
  if new.order_line_id is not null or new.import_batch_id is not null then
    raise exception 'this document is not available' using errcode = '22023', hint = 'document';
  end if;

  -- The product, read under the caller's row level security: its organisation is the row's organisation.
  select p.org_id, p.archived_at into v_org, v_archived from public.products p where p.id = new.product_id;
  if not found then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  new.org_id := v_org;
  if v_archived is not null and new.kind not in ('release', 'expire') then
    raise exception 'this product is archived' using errcode = '22023', hint = 'product_archived';
  end if;
  -- The place: one of this organisation's, of a kind the movement may touch.
  select l.kind into v_place from public.locations l where l.id = new.location_id and l.org_id = v_org;
  if not found or (new.kind = 'transfer_out' and v_place <> 'transit')
     or (new.kind = 'transfer_in' and v_place <> 'warehouse') then
    raise exception 'wrong place for this movement' using errcode = '22023', hint = 'location';
  end if;

  -- Quantities (constant messages before the CHECKs).
  if new.kind = 'count' then
    if new.qty is not null or new.target_on_hand is null or new.target_on_hand not between 0 and 50000000 then
      raise exception 'the counted quantity must be 0 to 50,000,000' using errcode = '22023', hint = 'quantity';
    end if;
  else
    if new.target_on_hand is not null
       or (new.qty is null and new.kind not in ('release', 'expire'))
       or new.qty not between 1 and 50000000 then
      raise exception 'the quantity must be 1 to 50,000,000 pieces' using errcode = '22023', hint = 'quantity';
    end if;
  end if;
  new.note := nullif(btrim(new.note), '');
  if char_length(new.note) > (case when new.kind = 'reserve' then 300 else 500 end)
     or new.note ~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
    raise exception 'the note is too long or has characters that are not allowed' using errcode = '22023', hint = 'note';
  end if;
  if new.kind <> 'transfer_in' then
    new.pair_id := null;
  end if;
  if new.kind <> 'reserve' then
    new.hold_until := null;
  end if;

  -- Who may post it, and its document (design 4.3, the table per kind).
  if new.kind in ('receive', 'adjust_in', 'adjust_out', 'count') then
    if not trusted then
      if not private.is_manager_or_admin() then
        raise exception 'only managers and admins correct stock' using errcode = '42501', hint = 'forbidden';
      end if;
      if not private.has_recent_aal2(600) then
        raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
      end if;
    end if;
    if (new.kind = 'receive' and (new.reason is null or new.reason not in ('received', 'found', 'correction', 'other')))
       or (new.kind in ('adjust_in', 'adjust_out')
           and (new.reason is null or new.reason not in ('count', 'damaged', 'lost', 'found', 'sample', 'correction',
                                                         'other')))
       or (new.kind = 'count' and new.reason is distinct from 'count') then
      raise exception 'this reason does not fit this movement' using errcode = '22023', hint = 'reason';
    end if;
    if new.reason = 'other' and new.note is null then
      raise exception 'say why in a note' using errcode = '22023', hint = 'note_required';
    end if;
    new.company_id := null;
    new.deal_id := null;
    new.reservation_id := null;
  elsif new.kind in ('transfer_out', 'transfer_in') then
    if not trusted and not private.is_manager_or_admin() then
      raise exception 'only managers and admins mark stock as arrived' using errcode = '42501', hint = 'forbidden';
    end if;
    new.reason := 'arrived';
    new.company_id := null;
    new.deal_id := null;
    new.reservation_id := null;
    -- transfer_in names its transfer_out: same operation, same product and quantity, posted by the same person in this
    -- transaction, and not paired yet. A transfer_out with no transfer_in is refused at commit (constraint trigger
    -- stock_movements_transfer_paired below).
    if new.kind = 'transfer_in' and not exists (
         select 1 from private.stock_movements m
          where m.id = new.pair_id and m.kind = 'transfer_out' and m.group_id = new.group_id
            and m.product_id = new.product_id and m.qty = new.qty and m.created_at = now()
            and m.user_id is not distinct from new.user_id
            and not exists (select 1 from private.stock_movements x where x.pair_id = m.id)) then
      raise exception 'an arrival needs its departure from transit' using errcode = '22023', hint = 'pair';
    end if;
  elsif new.kind = 'reserve' then
    new.reason := null;
    new.reservation_id := null;
    if new.company_id is null or not exists (select 1 from public.companies c
                                              where c.id = new.company_id and c.org_id = v_org) then
      raise exception 'lead not found' using errcode = 'P0002';
    end if;
    -- The lead editor: its owner, a manager or an admin (D21, as for deals).
    if not trusted and not exists (
         select 1 from public.companies c
          where c.id = new.company_id and ((select private.is_manager_or_admin()) or c.owner_id = caller)) then
      raise exception 'you cannot hold stock for this lead' using errcode = '42501', hint = 'forbidden';
    end if;
    -- The deal, if given, read under the deals policy: visible, on the same lead (a deal with no lead never matches),
    -- open and from stock. The apply step checks it again under a lock.
    if new.deal_id is not null then
      select dl.company_id, dl.status, dl.fulfilment into d from public.deals dl where dl.id = new.deal_id;
      if not found or d.company_id is null or d.company_id <> new.company_id then
        raise exception 'this deal is not on this lead' using errcode = '22023', hint = 'deal_mismatch';
      end if;
      if d.status <> 'open' then
        raise exception 'this deal is closed' using errcode = '22023', hint = 'deal_closed';
      end if;
      if d.fulfilment <> 'from_stock' then
        raise exception 'this deal ships from the supplier' using errcode = '22023', hint = 'deal_direct';
      end if;
    end if;
    if new.hold_until is null or new.hold_until not between v_today and v_today + 90 then
      raise exception 'a hold ends today or within 90 days' using errcode = '22023', hint = 'hold_until';
    end if;
  else  -- release, expire
    if new.reservation_id is null then
      raise exception 'which hold?' using errcode = '22023', hint = 'reservation';
    end if;
    select r.* into h from private.stock_reservations r where r.id = new.reservation_id;
    if not found then
      raise exception 'hold not found' using errcode = 'P0002';
    end if;
    if h.product_id <> new.product_id or h.location_id <> new.location_id
       or (not trusted and h.status <> 'active') then
      raise exception 'this hold cannot change' using errcode = '22023', hint = 'reservation_state';
    end if;
    if new.kind = 'expire' then
      new.reason := 'expired';
    elsif not trusted then
      -- The hold's creator or an editor of its lead (design 4.3).
      if h.created_by <> caller and not exists (
           select 1 from public.companies c
            where c.id = h.company_id and ((select private.is_manager_or_admin()) or c.owner_id = caller)) then
        raise exception 'you cannot release this hold' using errcode = '42501', hint = 'forbidden';
      end if;
      new.reason := 'manual';
    elsif new.reason is null or new.reason not in ('manual', 'deal_lost', 'deal_deleted') then
      raise exception 'this reason does not fit this movement' using errcode = '22023', hint = 'reason';
    end if;
    new.company_id := h.company_id;
    new.deal_id := h.deal_id;
  end if;

  -- Rate guard for people: at most 120 rows a minute each (one short range read on movements_user_created_idx). The
  -- system's release rows for a deal lost or deleted carry the person who changed the deal but are not theirs to
  -- count: losing a deal with many holds must not lock its owner out for a minute. A person never writes those
  -- reasons (an untrusted release is always 'manual', above).
  if not trusted and (select count(*) from (select 1 from private.stock_movements m
                                             where m.user_id = caller and m.created_at > now() - interval '60 seconds'
                                               and (m.kind <> 'release' or m.reason = 'manual')
                                             limit 120) recent) >= 120 then
    raise exception 'too many stock changes in a minute' using errcode = '22023', hint = 'rate_limited';
  end if;
  return new;
end;
$$;
create trigger stock_movement_a_guard before insert on private.stock_movements
  for each row execute function private.stock_movement_a_guard();

-- ---------------------------------------------------------------------------
-- The apply step (design 4.4 and 4.5): SECURITY DEFINER, owned by postgres, execute revoked from everyone. It is the
-- only code that writes stock_levels and holds. One global lock order (D4): a reserve's deal row, then the product row
-- (FOR SHARE), then the level rows (FOR UPDATE, in location_id order; a transfer locks both on its first row), then
-- hold rows. Every rule is checked on the locked level, so two people taking the last pieces at once cannot both pass.
-- ---------------------------------------------------------------------------
create function private.stock_movement_b_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
  is_import constant boolean := new.import_batch_id is not null;
  v_active boolean;
  v_locs uuid[];
  v_wh uuid;
  lvl public.stock_levels%rowtype;
  d record;
  h record;
  q integer := new.qty;
  d_on integer := 0;
  d_res integer := 0;
  v_left integer;
begin
  -- 0. A hold for a deal locks the deal first, so a deal lost or deleted at the same moment either sees this hold (and
  --    releases it) or makes this hold fail. post_stock_movement has already taken this lock before its expiry rows
  --    (expire_due_holds with the deal); here it is taken again (already held) and the deal re-checked under it.
  if new.kind = 'reserve' and new.deal_id is not null then
    select dl.company_id, dl.status, dl.fulfilment into d from public.deals dl where dl.id = new.deal_id for share;
    if not found or d.company_id is null or d.company_id <> new.company_id then
      raise exception 'this deal is not on this lead' using errcode = '22023', hint = 'deal_mismatch';
    end if;
    if d.status <> 'open' then
      raise exception 'this deal is closed' using errcode = '22023', hint = 'deal_closed';
    end if;
    if d.fulfilment <> 'from_stock' then
      raise exception 'this deal ships from the supplier' using errcode = '22023', hint = 'deal_direct';
    end if;
  end if;
  -- 1. The product, shared lock: serialises against archiving (its update locks the row), checked again here.
  select p.archived_at is null into v_active from public.products p where p.id = new.product_id for share;
  if not v_active and new.kind not in ('release', 'expire') then
    raise exception 'this product is archived' using errcode = '22023', hint = 'product_archived';
  end if;
  -- 2. The level(s), created at zero the first time, locked in location order.
  if new.kind in ('transfer_out', 'transfer_in') then
    select array_agg(l.id order by l.id) into v_locs from public.locations l where l.org_id = new.org_id;
    select l.id into v_wh from public.locations l where l.org_id = new.org_id and l.kind = 'warehouse';
  else
    v_locs := array[new.location_id];
  end if;
  insert into public.stock_levels (org_id, product_id, location_id)
  select new.org_id, new.product_id, x from unnest(v_locs) x order by x
  on conflict do nothing;
  perform 1 from public.stock_levels l
   where l.product_id = new.product_id and l.location_id = any (v_locs)
   order by l.location_id
     for update;
  select * into strict lvl from public.stock_levels l
   where l.product_id = new.product_id and l.location_id = new.location_id;
  -- 3. Compare-and-set (defence for imports and undo; any caller may use it to refuse a stale change).
  if new.expected_on_hand is not null and lvl.on_hand <> new.expected_on_hand then
    raise exception 'stock changed since the check' using errcode = '22023', hint = 'stale';
  end if;
  -- 4. The change per kind (design 4.5). Holds are locked only after their level.
  case new.kind
    when 'receive', 'adjust_in', 'return', 'import_in', 'undo_in' then
      d_on := q;
    when 'adjust_out', 'import_out', 'undo_out' then
      d_on := -q;
    when 'count' then
      -- The change is worked out here, under the lock, so two people counting never add up twice.
      d_on := new.target_on_hand - lvl.on_hand;
      if d_on = 0 then
        return null;   -- nothing changes: no row (the RPC answers "unchanged")
      end if;
      new.kind := case when d_on > 0 then 'adjust_in' else 'adjust_out' end;
      q := abs(d_on);
      new.qty := q;
    when 'transfer_out' then
      d_on := -q;
      d_res := -least(q, lvl.reserved);   -- held pieces travel first, oldest hold first
    when 'transfer_in' then
      d_on := q;
      select -m.d_reserved into d_res from private.stock_movements m where m.id = new.pair_id;
    when 'reserve' then
      d_res := q;
    when 'release', 'expire' then
      select r.* into h from private.stock_reservations r where r.id = new.reservation_id for update;
      if not found or h.status <> 'active' or h.product_id <> new.product_id or h.location_id <> new.location_id
         or (new.kind = 'expire' and h.hold_until >= v_today) then
        -- The system skips a hold that someone released, used or extended meanwhile; a person is told.
        if new.kind = 'expire' or new.reason in ('deal_lost', 'deal_deleted') then
          return null;
        end if;
        raise exception 'this hold cannot change' using errcode = '22023', hint = 'reservation_state';
      end if;
      q := coalesce(q, h.remaining);
      if q > h.remaining then
        raise exception 'more than is held' using errcode = '22023', hint = 'reservation_state';
      end if;
      new.qty := q;
      d_res := -q;
    else
      raise exception 'this kind of movement is not available' using errcode = '22023', hint = 'kind';
  end case;
  -- 5. The rules, on the locked level.
  if lvl.on_hand + d_on < 0 then
    raise exception 'not enough stock' using errcode = '22023', hint = 'insufficient_stock';
  end if;
  if lvl.on_hand + d_on > 50000000 then
    raise exception 'too much stock in one place' using errcode = '22023', hint = 'quantity';
  end if;
  if lvl.reserved + d_res < 0 then
    raise exception 'more than is held' using errcode = '22023', hint = 'not_reserved';
  end if;
  if lvl.reserved + d_res > lvl.on_hand + d_on then
    raise exception 'stock is held' using errcode = '22023',
      hint = case new.kind when 'reserve' then 'over_reservation' when 'ship' then 'reserved_by_others'
                           else 'below_reserved' end;
  end if;
  -- 6. Holds.
  if new.kind = 'reserve' then
    new.reservation_id := gen_random_uuid();
    insert into private.stock_reservations (id, org_id, product_id, location_id, company_id, deal_id, quantity,
                                            remaining, hold_until, note, created_by)
    values (new.reservation_id, new.org_id, new.product_id, new.location_id, new.company_id, new.deal_id, q, q,
            new.hold_until, new.note, new.user_id);
  elsif new.kind in ('release', 'expire') then
    update private.stock_reservations r
       set remaining = r.remaining - q,
           status = case when r.remaining - q > 0 then r.status
                         when new.kind = 'expire' then 'expired' else 'released' end,
           closed_at = case when r.remaining - q = 0 then now() end,
           closed_by = case when r.remaining - q = 0 then new.user_id end,
           close_reason = case when r.remaining - q > 0 then null
                               when new.kind = 'expire' then 'expired' else new.reason end
     where r.id = h.id;
  elsif new.kind = 'transfer_out' and d_res <> 0 then
    -- Arrived: the held pieces move to the warehouse, oldest hold first. A hold covered whole changes place; the last
    -- one is reduced, and its moved part becomes a new hold at the warehouse (split_from), keeping its creator, lead,
    -- deal, end date and age. transfer_in then adds the same number of held pieces to the warehouse level.
    v_left := -d_res;
    for h in select r.* from private.stock_reservations r
              where r.product_id = new.product_id and r.location_id = new.location_id and r.status = 'active'
              order by r.created_at, r.id
                for update loop
      exit when v_left = 0;
      if h.remaining <= v_left then
        update private.stock_reservations set location_id = v_wh where id = h.id;
        v_left := v_left - h.remaining;
      else
        update private.stock_reservations set remaining = remaining - v_left where id = h.id;
        insert into private.stock_reservations (id, org_id, product_id, location_id, company_id, deal_id, quantity,
                                                remaining, hold_until, note, split_from, created_by, created_at)
        values (gen_random_uuid(), h.org_id, h.product_id, v_wh, h.company_id, h.deal_id, v_left, v_left,
                h.hold_until, h.note, h.id, h.created_by, h.created_at);
        v_left := 0;
      end if;
    end loop;
  end if;
  -- 7. The level, then the row's snapshot of it (D5: these fields are written under the lock, in the true order).
  update public.stock_levels l
     set on_hand = l.on_hand + d_on,
         reserved = l.reserved + d_res,
         version = l.version + 1,
         crm_moved = case when d_on = 0 then l.crm_moved else not is_import end,
         last_onhand_batch_id = case when d_on = 0 then l.last_onhand_batch_id
                                     when is_import then new.import_batch_id end,
         updated_at = now()
   where l.product_id = new.product_id and l.location_id = new.location_id
  returning l.on_hand, l.reserved, l.version into new.on_hand_after, new.reserved_after, new.level_version;
  new.d_on_hand := d_on;
  new.d_reserved := d_res;
  return new;
end;
$$;
create trigger stock_movement_b_apply before insert on private.stock_movements
  for each row execute function private.stock_movement_b_apply();

-- Append-only, for every role, the owner included (I4).
create function private.stock_movement_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'stock movements are never changed or deleted' using errcode = '42501', hint = 'append_only';
end;
$$;
create trigger stock_movement_immutable before update or delete on private.stock_movements
  for each row execute function private.stock_movement_immutable();
create trigger stock_movement_immutable_truncate before truncate on private.stock_movements
  for each statement execute function private.stock_movement_immutable();

-- A departure from transit must arrive in the same transaction: checked at commit, so the RPC can post the pair as two
-- statements, while a lone transfer_out (stock leaving transit without a fresh code) is refused.
create function private.stock_transfer_paired() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from private.stock_movements m where m.pair_id = new.id and m.kind = 'transfer_in') then
    raise exception 'a departure from transit needs its arrival' using errcode = '22023', hint = 'pair';
  end if;
  return null;
end;
$$;
create constraint trigger stock_movements_transfer_paired after insert on private.stock_movements
  deferrable initially deferred
  for each row when (new.kind = 'transfer_out') execute function private.stock_transfer_paired();

-- ---------------------------------------------------------------------------
-- Holds that end (D8). A hold ends after its hold_until date (Europe/Paris). Expired holds are released by the RPCs
-- just before they write to that product and place, by a sweep when Inventory, Home or the Stock tab loads (at most
-- once a minute per org), and by the nightly job. Expiry rows have no user: the system wrote them.
-- ---------------------------------------------------------------------------
create function private.expire_holds_for(p_org uuid, p_product uuid, p_location uuid, p_limit integer)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
  v_group constant uuid := gen_random_uuid();
  h record;
  n integer := 0;
  k integer;
begin
  for h in select r.id, r.product_id, r.location_id from private.stock_reservations r
            where r.org_id = p_org and r.status = 'active' and r.hold_until < v_today
              and (p_product is null or r.product_id = p_product)
              and (p_location is null or r.location_id = p_location)
            order by r.product_id, r.location_id, r.created_at, r.id   -- the global lock order
            limit p_limit loop
    insert into private.stock_movements (group_id, product_id, location_id, kind, reservation_id, reason)
    values (v_group, h.product_id, h.location_id, 'expire', h.id, 'expired');
    get diagnostics k = row_count;
    n := n + k;
  end loop;
  return n;
end;
$$;
-- Called by the invoker RPCs before they take room at a level (design 4.2 step 5). Only the caller's organisation; with
-- a place, only that level, so the RPC never locks a level outside the lock order. At most 500 at a time.
-- With a deal (a hold for a deal), that deal is locked FOR SHARE first: an expiry row locks the level, and a deal lost
-- or deleted at the same moment locks the deal and then needs that level (release_deal_holds). Taking the deal first
-- keeps the one lock order (deal, product, levels, holds); without it the two deadlocked (concurrency case 9c). The
-- lock is taken here, as postgres, because an invoker FOR SHARE would need UPDATE on deals and pass its update policy.
create function private.expire_due_holds(p_product uuid default null, p_location uuid default null,
                                         p_deal uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org constant uuid := private.current_org_id();
begin
  if v_org is null then
    return 0;
  end if;
  if p_deal is not null then
    perform 1 from public.deals d where d.id = p_deal and d.org_id = v_org for share;
  end if;
  return private.expire_holds_for(v_org, p_product, p_location, 500);
end;
$$;
-- The page-load sweep: the whole org, at most once a minute (compare-and-set on last_sweep_at).
create function private.sweep_expired_holds() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org constant uuid := private.current_org_id();
begin
  if v_org is null then
    return 0;
  end if;
  update private.inventory_settings s set last_sweep_at = now()
   where s.org_id = v_org and (s.last_sweep_at is null or s.last_sweep_at <= now() - interval '1 minute');
  if not found then
    return 0;
  end if;
  return private.expire_holds_for(v_org, null, null, 500);
end;
$$;

-- A deal lost or deleted releases its active holds (design 3.1; Day 5 must set deals.status = 'lost', 12.1).
create function private.release_deal_holds() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_deal constant uuid := case when tg_op = 'DELETE' then old.id else new.id end;
  v_reason constant text := case when tg_op = 'DELETE' then 'deal_deleted' else 'deal_lost' end;
  v_group constant uuid := gen_random_uuid();
  h record;
begin
  for h in select r.id, r.product_id, r.location_id from private.stock_reservations r
            where r.deal_id = v_deal and r.status = 'active'
            order by r.product_id, r.location_id, r.created_at, r.id loop
    insert into private.stock_movements (group_id, product_id, location_id, kind, reservation_id, reason)
    values (v_group, h.product_id, h.location_id, 'release', h.id, v_reason);
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
-- On any update that leaves the deal lost, not only one naming status in its SET list: an UPDATE OF status trigger
-- would miss a status set by a BEFORE trigger (for example a stage change that Day 5 turns into "lost").
create trigger release_deal_holds_lost after update on public.deals
  for each row when (new.status = 'lost' and old.status is distinct from 'lost')
  execute function private.release_deal_holds();
create trigger release_deal_holds_deleted before delete on public.deals
  for each row execute function private.release_deal_holds();

-- Row level security and grants (part 2). Levels: read only for everyone in the org. The ledger: read for the org,
-- insert of the document columns (the guard and the apply step decide the rest). Holds and hold uses: read only.
do $$
declare
  t text;
begin
  foreach t in array array['public.stock_levels', 'private.stock_reservations', 'private.stock_movements',
                           'private.stock_hold_uses', 'private.movement_requests'] loop
    execute format('alter table %s enable row level security', t);
    execute format('create policy require_mfa on %s as restrictive to authenticated using ((select private.has_aal2())) with check ((select private.has_aal2()))', t);
    execute format('revoke all on %s from public, anon, authenticated', t);
  end loop;
end;
$$;
revoke all on sequence private.stock_movements_id_seq from public, anon, authenticated;

create policy stock_levels_select on public.stock_levels for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy stock_reservations_select on private.stock_reservations for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy stock_hold_uses_select on private.stock_hold_uses for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy stock_movements_select on private.stock_movements for select to authenticated
  using (org_id = (select private.current_org_id()));
create policy stock_movements_insert on private.stock_movements for insert to authenticated
  with check (org_id = (select private.current_org_id()));
create policy movement_requests_own on private.movement_requests for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select on public.stock_levels, private.stock_reservations, private.stock_hold_uses to authenticated;
grant select,
      insert (group_id, product_id, location_id, kind, qty, target_on_hand, expected_on_hand, reason, note, company_id,
              deal_id, reservation_id, order_line_id, import_batch_id, hold_until, pair_id)
  on private.stock_movements to authenticated;
grant select, insert (request_id, kind), update (result) on private.movement_requests to authenticated;

-- Function privileges (part 2). The expiry helpers are called by the invoker RPCs; private has no REST endpoint.
revoke all on function private.movement_request_guard(), private.stock_movement_a_guard(),
  private.stock_movement_b_apply(), private.stock_movement_immutable(), private.stock_transfer_paired(),
  private.release_deal_holds(), private.expire_holds_for(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function private.expire_due_holds(uuid, uuid, uuid), private.sweep_expired_holds() from public, anon;
grant execute on function private.expire_due_holds(uuid, uuid, uuid), private.sweep_expired_holds() to authenticated;

-- ===========================================================================
-- Part 3. RPCs (design 4.2 and 5.1), integrity, the nightly job, audit and import undo
-- ===========================================================================

-- post_stock_movement: the one public way to change stock (CLAUDE.md). Invoker: it only inserts ledger rows; the guard
-- checks the caller and the apply step changes the levels under the lock. lock_timeout 3 s gives 55P03 ("busy").
create function public.post_stock_movement(
  p_product uuid,
  p_kind text,                       -- receive | adjust_in | adjust_out | count | transfer | reserve | release
  p_qty integer default null,        -- pieces; release: null = everything still held; count: unused
  p_location text default null,      -- 'warehouse' (default) | 'transit'; clients never send place ids
  p_reason text default null,
  p_note text default null,
  p_company uuid default null,       -- reserve: the lead
  p_deal uuid default null,          -- reserve: an open, from-stock deal of that lead
  p_reservation uuid default null,   -- release
  p_hold_until date default null,    -- reserve: default today + hold_days; today to today + 90
  p_target integer default null,     -- count: the counted quantity (0 to 50,000,000)
  p_request_id uuid default null     -- idempotency: a retry returns the first result
) returns jsonb
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_org constant uuid := private.current_org_id();
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
  v_group constant uuid := gen_random_uuid();
  v_reason text := p_reason;
  v_note text := nullif(btrim(p_note), '');
  v_hold_until date := p_hold_until;
  v_place text := coalesce(p_location, 'warehouse');
  v_wh uuid;
  v_transit uuid;
  v_loc uuid;
  v_id bigint;
  v_ids bigint[] := '{}'::bigint[];
  v_res uuid;
  v_new boolean;
  v_prev_kind text;
  v_result jsonb;
  v_extra jsonb := '{}'::jsonb;
begin
  if (select auth.uid()) is null or v_org is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  -- Constant pre-checks (design 4.2 step 2).
  if p_kind is null or p_kind not in ('receive', 'adjust_in', 'adjust_out', 'count', 'transfer', 'reserve', 'release') then
    raise exception 'unknown kind of movement' using errcode = '22023', hint = 'kind';
  end if;
  if p_product is null then
    raise exception 'which product?' using errcode = '22023', hint = 'document';
  end if;
  if (p_kind = 'count' and (p_qty is not null or p_target is null or p_target not between 0 and 50000000))
     or (p_kind <> 'count' and p_target is not null)
     or (p_kind = 'release' and p_qty not between 1 and 50000000)
     or (p_kind not in ('count', 'release') and (p_qty is null or p_qty not between 1 and 50000000)) then
    raise exception 'the quantity must be 1 to 50,000,000 pieces' using errcode = '22023', hint = 'quantity';
  end if;
  v_reason := case p_kind when 'count' then coalesce(p_reason, 'count')
                          when 'transfer' then coalesce(p_reason, 'arrived')
                          when 'release' then coalesce(p_reason, 'manual')
                          else p_reason end;
  if (p_kind = 'receive' and (v_reason is null or v_reason not in ('received', 'found', 'correction', 'other')))
     or (p_kind in ('adjust_in', 'adjust_out')
         and (v_reason is null or v_reason not in ('count', 'damaged', 'lost', 'found', 'sample', 'correction', 'other')))
     or (p_kind = 'count' and v_reason <> 'count')
     or (p_kind = 'transfer' and v_reason <> 'arrived')
     or (p_kind = 'release' and v_reason <> 'manual')
     or (p_kind = 'reserve' and v_reason is not null) then
    raise exception 'this reason does not fit this movement' using errcode = '22023', hint = 'reason';
  end if;
  if v_reason = 'other' and v_note is null then
    raise exception 'say why in a note' using errcode = '22023', hint = 'note_required';
  end if;
  if char_length(v_note) > (case when p_kind = 'reserve' then 300 else 500 end)
     or v_note ~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
    raise exception 'the note is too long or has characters that are not allowed' using errcode = '22023', hint = 'note';
  end if;
  if v_place not in ('warehouse', 'transit') then
    raise exception 'unknown place' using errcode = '22023', hint = 'location';
  end if;
  if p_kind = 'reserve' then
    if p_company is null then
      raise exception 'which lead?' using errcode = '22023', hint = 'document';
    end if;
    v_hold_until := coalesce(p_hold_until,
                             v_today + coalesce((select s.hold_days from private.inventory_settings s where s.org_id = v_org), 14));
    if v_hold_until not between v_today and v_today + 90 then
      raise exception 'a hold ends today or within 90 days' using errcode = '22023', hint = 'hold_until';
    end if;
  end if;
  if p_kind = 'release' and p_reservation is null then
    raise exception 'which hold?' using errcode = '22023', hint = 'reservation';
  end if;

  -- Idempotency (step 3): a replay returns the stored result and changes nothing.
  if p_request_id is not null then
    insert into private.movement_requests (request_id, kind) values (p_request_id, p_kind)
    on conflict do nothing
    returning true into v_new;
    if v_new is null then
      select r.kind, r.result into v_prev_kind, v_result from private.movement_requests r
       where r.user_id = (select auth.uid()) and r.request_id = p_request_id;
      if v_prev_kind is distinct from p_kind or v_result is null then
        raise exception 'this request id was used for something else' using errcode = '22023', hint = 'request';
      end if;
      return v_result;
    end if;
  end if;

  -- Places by kind (step 4); then the ledger rows (step 6).
  select l.id into v_wh from public.locations l where l.org_id = v_org and l.kind = 'warehouse';
  select l.id into v_transit from public.locations l where l.org_id = v_org and l.kind = 'transit';
  if v_wh is null or v_transit is null then
    raise exception 'places not found' using errcode = 'P0002';
  end if;
  v_loc := case when v_place = 'transit' then v_transit else v_wh end;

  if p_kind = 'transfer' then
    -- Arrived (design 6.4). The product row is locked first: this RPC may clear its expected date at the end, and an
    -- update after the level locks would wait on a movement holding the product's share lock while that movement
    -- waits on our level (a deadlock). Ended holds at both places go first, in location order. Only managers and
    -- admins mark stock as arrived (the guard says so too; the lock below would otherwise answer "not found").
    if not private.is_manager_or_admin() then
      raise exception 'only managers and admins mark stock as arrived' using errcode = '42501', hint = 'forbidden';
    end if;
    perform 1 from public.products p where p.id = p_product for no key update;
    if not found then
      raise exception 'product not found' using errcode = 'P0002';
    end if;
    perform private.expire_due_holds(p_product, l.id) from public.locations l where l.org_id = v_org order by l.id;
    insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason, note)
    values (v_group, p_product, v_transit, 'transfer_out', p_qty, v_reason, v_note)
    returning id into v_id;
    v_ids := v_ids || v_id;
    insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason, note, pair_id)
    values (v_group, p_product, v_wh, 'transfer_in', p_qty, v_reason, v_note, v_id)
    returning id into v_id;
    v_ids := v_ids || v_id;
    -- Pieces moved, and how many of them were held (they arrive still held for the same leads).
    v_extra := jsonb_build_object('moved', p_qty,
                                  'held_moved', (select m.d_reserved from private.stock_movements m where m.id = v_id));
    if (select s.on_hand from public.stock_levels s where s.product_id = p_product and s.location_id = v_transit) = 0 then
      update public.products p set transit_eta = null where p.id = p_product and p.transit_eta is not null;
    end if;
  elsif p_kind = 'count' then
    perform private.expire_due_holds(p_product, v_loc);
    insert into private.stock_movements (group_id, product_id, location_id, kind, target_on_hand, reason, note)
    values (v_group, p_product, v_loc, 'count', p_target, v_reason, v_note)
    returning id into v_id;
    if v_id is not null then
      v_ids := v_ids || v_id;
    end if;
  elsif p_kind = 'reserve' then
    -- A hold for a deal: the deal is locked before any expiry row locks the level (lock order deal, product, levels).
    perform private.expire_due_holds(p_product, v_loc, p_deal);
    insert into private.stock_movements (group_id, product_id, location_id, kind, qty, note, company_id, deal_id,
                                         hold_until)
    values (v_group, p_product, v_loc, 'reserve', p_qty, v_note, p_company, p_deal, v_hold_until)
    returning id, reservation_id into v_id, v_res;
    v_ids := v_ids || v_id;
  elsif p_kind = 'release' then
    select r.location_id into v_loc from private.stock_reservations r where r.id = p_reservation;
    if not found then
      raise exception 'hold not found' using errcode = 'P0002';
    end if;
    insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason, note, reservation_id)
    values (v_group, p_product, v_loc, 'release', p_qty, v_reason, v_note, p_reservation)
    returning id into v_id;
    v_ids := v_ids || v_id;
    v_res := p_reservation;
  else
    if p_kind = 'adjust_out' then
      perform private.expire_due_holds(p_product, v_loc);
    end if;
    insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason, note)
    values (v_group, p_product, v_loc, p_kind, p_qty, v_reason, v_note)
    returning id into v_id;
    v_ids := v_ids || v_id;
  end if;

  -- The levels after the change (step 7), warehouse first.
  v_result := jsonb_build_object(
    'group_id', v_group, 'movement_ids', to_jsonb(v_ids), 'reservation_id', v_res, 'unchanged', cardinality(v_ids) = 0,
    'levels', (select coalesce(jsonb_agg(jsonb_build_object('location', l.kind, 'on_hand', coalesce(s.on_hand, 0),
                                                            'reserved', coalesce(s.reserved, 0),
                                                            'available', coalesce(s.available, 0))
                                         order by l.kind desc), '[]'::jsonb)
                 from public.locations l
                 left join public.stock_levels s on s.location_id = l.id and s.product_id = p_product
                where l.org_id = v_org)) || v_extra;
  if p_request_id is not null then
    update private.movement_requests r set result = v_result
     where r.user_id = (select auth.uid()) and r.request_id = p_request_id;
  end if;
  return v_result;
end;
$$;

-- Create a product (managers and admins). A cost goes to the cost table; an opening quantity is a receipt (fresh code,
-- reason "received"). Returns the new id; a retry with the same request id returns the same id.
create function public.create_product(
  p_name text,
  p_pieces_per_carton integer,
  p_price_min numeric default null,
  p_price_max numeric default null,
  p_category text default null,
  p_cartons_per_pallet integer default null,
  p_reorder_point integer default null,
  p_transit_eta date default null,
  p_share_visible boolean default true,
  p_cost_per_piece numeric default null,
  p_opening_qty integer default null,
  p_opening_location text default null,
  p_request_id uuid default null
) returns uuid
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_org constant uuid := private.current_org_id();
  v_id uuid;
  v_new boolean;
  v_prev jsonb;
  v_prev_kind text;
  v_loc uuid;
begin
  if (select auth.uid()) is null or v_org is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if not private.is_manager_or_admin() then
    raise exception 'only managers and admins create products' using errcode = '42501', hint = 'forbidden';
  end if;
  -- Numbers are checked before they are cast into the columns (a huge value would otherwise fail the cast).
  if p_price_min not between 0 and 1000000 or p_price_max not between 0 and 1000000 then
    raise exception 'prices must be 0 to 1,000,000' using errcode = '22023', hint = 'price';
  end if;
  if p_cost_per_piece not between 0 and 1000000 then
    raise exception 'the cost per piece must be 0 to 1,000,000' using errcode = '22023', hint = 'cost';
  end if;
  if p_opening_qty not between 0 and 50000000 then
    raise exception 'the quantity must be 1 to 50,000,000 pieces' using errcode = '22023', hint = 'quantity';
  end if;
  if coalesce(p_opening_location, 'warehouse') not in ('warehouse', 'transit') then
    raise exception 'unknown place' using errcode = '22023', hint = 'location';
  end if;
  if coalesce(p_opening_qty, 0) > 0 and not private.has_recent_aal2(600) then
    raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
  end if;
  if p_request_id is not null then
    insert into private.movement_requests (request_id, kind) values (p_request_id, 'create_product')
    on conflict do nothing
    returning true into v_new;
    if v_new is null then
      select r.kind, r.result into v_prev_kind, v_prev from private.movement_requests r
       where r.user_id = (select auth.uid()) and r.request_id = p_request_id;
      if v_prev_kind is distinct from 'create_product' or v_prev is null then
        raise exception 'this request id was used for something else' using errcode = '22023', hint = 'request';
      end if;
      return (v_prev ->> 'id')::uuid;
    end if;
  end if;
  begin
    insert into public.products (name, category, pieces_per_carton, cartons_per_pallet, reorder_point, price_min,
                                 price_max, transit_eta, share_visible)
    values (p_name, p_category, p_pieces_per_carton, p_cartons_per_pallet, p_reorder_point,
            p_price_min, p_price_max, p_transit_eta, coalesce(p_share_visible, true))
    returning id into v_id;
  exception when unique_violation then
    -- Two people creating the same name at once: the guard's check passed for both, the index stops the second.
    raise exception 'a product with this name already exists' using errcode = '22023', hint = 'name_taken';
  end;
  if p_cost_per_piece is not null then
    insert into private.product_costs (product_id, cost_per_piece, source) values (v_id, p_cost_per_piece, 'manual');
  end if;
  if coalesce(p_opening_qty, 0) > 0 then
    select l.id into v_loc from public.locations l
     where l.org_id = v_org and l.kind = coalesce(p_opening_location, 'warehouse');
    insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason)
    values (gen_random_uuid(), v_id, v_loc, 'receive', p_opening_qty, 'received');
  end if;
  if p_request_id is not null then
    update private.movement_requests r set result = jsonb_build_object('id', v_id)
     where r.user_id = (select auth.uid()) and r.request_id = p_request_id;
  end if;
  return v_id;
end;
$$;

-- Change a product's details (managers and admins): every editable field is replaced by the value given.
create function public.update_product(
  p_id uuid,
  p_name text,
  p_pieces_per_carton integer,
  p_price_min numeric default null,
  p_price_max numeric default null,
  p_category text default null,
  p_cartons_per_pallet integer default null,
  p_reorder_point integer default null,
  p_transit_eta date default null,
  p_share_visible boolean default true
) returns jsonb
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_row record;
begin
  if (select auth.uid()) is null or private.current_org_id() is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if not private.is_manager_or_admin() then
    raise exception 'only managers and admins change products' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_price_min not between 0 and 1000000 or p_price_max not between 0 and 1000000 then
    raise exception 'prices must be 0 to 1,000,000' using errcode = '22023', hint = 'price';
  end if;
  begin
    update public.products p
       set name = p_name, pieces_per_carton = p_pieces_per_carton, price_min = p_price_min, price_max = p_price_max,
           category = p_category, cartons_per_pallet = p_cartons_per_pallet,
           reorder_point = p_reorder_point, transit_eta = p_transit_eta, share_visible = coalesce(p_share_visible, true)
     where p.id = p_id
    returning p.id, p.number, p.updated_at into v_row;
  exception when unique_violation then
    raise exception 'a product with this name already exists' using errcode = '22023', hint = 'name_taken';
  end;
  if v_row.id is null then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', v_row.id, 'number', v_row.number, 'updated_at', v_row.updated_at);
end;
$$;

-- Set the cost per piece (managers and admins; source "manual").
create function public.set_product_cost(p_id uuid, p_cost numeric) returns void
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if (select auth.uid()) is null or private.current_org_id() is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if not private.is_manager_or_admin() then
    raise exception 'only managers and admins see and set costs' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_cost is null or p_cost not between 0 and 1000000 then
    raise exception 'the cost per piece must be 0 to 1,000,000' using errcode = '22023', hint = 'cost';
  end if;
  if not exists (select 1 from public.products p where p.id = p_id) then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  insert into private.product_costs (product_id, cost_per_piece, source) values (p_id, p_cost, 'manual')
  on conflict (product_id) do update set cost_per_piece = excluded.cost_per_piece, source = excluded.source;
end;
$$;

-- Archive (managers and admins, fresh code, only when nothing is left) and restore (admins, fresh code). The guard on
-- products enforces the same rules for a direct update.
create function public.archive_product(p_id uuid) returns void
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_archived timestamptz;
begin
  if (select auth.uid()) is null or private.current_org_id() is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if not private.is_manager_or_admin() then
    raise exception 'only managers and admins archive products' using errcode = '42501', hint = 'forbidden';
  end if;
  if not private.has_recent_aal2(600) then
    raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
  end if;
  select p.archived_at into v_archived from public.products p where p.id = p_id for update;
  if not found then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if v_archived is null then
    update public.products p set archived_at = now() where p.id = p_id;
  end if;
end;
$$;
create function public.restore_product(p_id uuid) returns void
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
begin
  if (select auth.uid()) is null or private.current_org_id() is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if not private.is_admin() then
    raise exception 'only an admin can restore a product' using errcode = '42501', hint = 'forbidden';
  end if;
  if not private.has_recent_aal2(600) then
    raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
  end if;
  if not exists (select 1 from public.products p where p.id = p_id) then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  update public.products p set archived_at = null where p.id = p_id and p.archived_at is not null;
end;
$$;

-- The page-load sweep of ended holds (D8): Inventory, Home and the lead's Stock tab call it.
create function public.release_expired_reservations() returns integer
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
begin
  if (select auth.uid()) is null or private.current_org_id() is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  return private.sweep_expired_holds();
end;
$$;

-- The integrity checks (design 4.9) for one organisation. Invoker: called by check_stock_integrity as an admin (row
-- level security keeps it to the caller's org) and by the nightly job as postgres. One row per difference:
--  ledger_vs_levels    on hand differs from the sum of the ledger's on-hand changes (I2)
--  ledger_vs_reserved  held differs from the sum of the ledger's held changes (I2)
--  holds_vs_reserved   held differs from the active holds' remaining pieces (I3)
--  versions            a level's version is not its number of ledger rows, or its newest row's snapshot (I8)
--  bounds              a level outside 0 <= held <= on hand (I1; the CHECKs make this a sanity line)
-- ship_lines (I7) arrives with sales in 6d.
create function private.stock_integrity_rows(p_org uuid)
returns table (check_name text, product_id uuid, location_id uuid, expected bigint, actual bigint)
language sql stable set search_path = '' as $$
  with o as (
    -- The organisation: the argument only for postgres (the nightly job, tests); anyone else gets their own, whatever
    -- they pass (row level security would hide another org's rows anyway).
    select case when current_user = 'postgres' then p_org else (select private.current_org_id()) end as id),
  led as (
    select m.product_id, m.location_id, sum(m.d_on_hand)::bigint as s_on, sum(m.d_reserved)::bigint as s_res,
           count(*)::bigint as n, max(m.level_version) as top
      from private.stock_movements m
     where m.org_id = (select o.id from o)
     group by m.product_id, m.location_id),
  lv as (
    select l.product_id, l.location_id, l.on_hand::bigint as on_hand, l.reserved::bigint as reserved, l.version
      from public.stock_levels l
     where l.org_id = (select o.id from o)),
  holds as (
    select r.product_id, r.location_id, sum(r.remaining)::bigint as s
      from private.stock_reservations r
     where r.org_id = (select o.id from o) and r.status = 'active'
     group by r.product_id, r.location_id),
  j as (
    select coalesce(lv.product_id, led.product_id) as product_id, coalesce(lv.location_id, led.location_id) as location_id,
           coalesce(lv.on_hand, 0) as on_hand, coalesce(lv.reserved, 0) as reserved, coalesce(lv.version, 0) as version,
           coalesce(led.s_on, 0) as s_on, coalesce(led.s_res, 0) as s_res, coalesce(led.n, 0) as n,
           coalesce(led.top, 0) as top
      from lv full join led on led.product_id = lv.product_id and led.location_id = lv.location_id)
  select 'ledger_vs_levels', j.product_id, j.location_id, j.s_on, j.on_hand from j where j.s_on <> j.on_hand
  union all
  select 'ledger_vs_reserved', j.product_id, j.location_id, j.s_res, j.reserved from j where j.s_res <> j.reserved
  union all
  select 'holds_vs_reserved', coalesce(j.product_id, h.product_id), coalesce(j.location_id, h.location_id),
         coalesce(h.s, 0), coalesce(j.reserved, 0)
    from j full join holds h on h.product_id = j.product_id and h.location_id = j.location_id
   where coalesce(h.s, 0) <> coalesce(j.reserved, 0)
  union all
  select 'versions', j.product_id, j.location_id, j.version, j.n from j where j.n <> j.version or j.top <> j.version
  union all
  select 'versions', lv.product_id, lv.location_id, lv.on_hand, m.on_hand_after::bigint
    from lv join private.stock_movements m
      on m.product_id = lv.product_id and m.location_id = lv.location_id and m.level_version = lv.version
   where m.on_hand_after <> lv.on_hand or m.reserved_after <> lv.reserved
  union all
  select 'bounds', lv.product_id, lv.location_id, lv.on_hand, lv.reserved
    from lv where lv.on_hand < 0 or lv.reserved < 0 or lv.reserved > lv.on_hand or lv.on_hand > 50000000
$$;

create function public.check_stock_integrity()
returns table (check_name text, product_id uuid, location_id uuid, expected bigint, actual bigint)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if (select auth.uid()) is null or private.current_org_id() is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if not private.is_admin() then
    raise exception 'only admins run the stock check' using errcode = '42501', hint = 'forbidden';
  end if;
  return query select * from private.stock_integrity_rows(null);   -- its own organisation (see above)
end;
$$;

-- The nightly job (design 4.9): run as postgres with no claims (pg_cron where it is installed; tests call it).
-- Ends due holds in every org (500 at a time), runs the integrity checks and opens one task for the alert assignee (or
-- the oldest admin) on a day they find a difference, and prunes idempotency rows older than 7 days. 6c and 6e add the
-- stale stock batches and the share rate counters.
create function private.nightly_stock_jobs() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o record;
  n integer;
  v_expired integer := 0;
  v_diffs integer := 0;
  v_tasks integer := 0;
  v_pruned integer;
  v_assignee uuid;
  v_lang text;
  v_tz text;
  title_en constant text := 'Stock check found a difference';
  title_fr constant text := 'Le contrôle du stock a trouvé un écart';
begin
  if (select auth.uid()) is not null then
    raise exception 'the nightly job runs as the system' using errcode = '42501', hint = 'forbidden';
  end if;
  for o in select g.id from public.orgs g order by g.id loop
    loop
      n := private.expire_holds_for(o.id, null, null, 500);
      v_expired := v_expired + n;
      exit when n < 500;
    end loop;
    select count(*)::integer into n from private.stock_integrity_rows(o.id);
    if n > 0 then
      v_diffs := v_diffs + n;
      select coalesce(s.alert_assignee_id,
                      (select p.id from public.profiles p where p.org_id = o.id and p.role = 'admin'
                        order by p.created_at, p.id limit 1))
        into v_assignee
        from private.inventory_settings s where s.org_id = o.id;
      select p.language, coalesce(nullif(p.timezone, ''), 'Europe/Paris') into v_lang, v_tz
        from public.profiles p where p.id = v_assignee;
      if v_assignee is not null and not exists (
           select 1 from public.tasks t
            where t.org_id = o.id and t.created_by is null and t.title in (title_en, title_fr)
              and (t.created_at at time zone 'Europe/Paris')::date = (now() at time zone 'Europe/Paris')::date) then
        -- A system row: no claims are set, so the task guards treat it as the system's (created_by stays null).
        insert into public.tasks (org_id, assignee_id, title, kind, due_date)
        values (o.id, v_assignee, case when v_lang = 'fr' then title_fr else title_en end, 'todo',
                (now() at time zone v_tz)::date);
        v_tasks := v_tasks + 1;
      end if;
    end if;
  end loop;
  delete from private.movement_requests r where r.created_at < now() - interval '7 days';
  get diagnostics v_pruned = row_count;
  return jsonb_build_object('expired', v_expired, 'integrity_rows', v_diffs, 'tasks', v_tasks,
                            'requests_pruned', v_pruned);
end;
$$;

-- Scheduled only where pg_cron is already installed (spike S6: not on the local runner; this migration never creates
-- the extension). 01:10 UTC is 03:10 in Paris in summer and 02:10 in winter.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $cron$select cron.schedule('topstock-nightly-stock', '10 1 * * *', 'select private.nightly_stock_jobs()')$cron$;
  end if;
end;
$$;

-- Audit (D19, design 3.7). Products and places use the shared private.audit_row (attached in part 1). The other stock
-- tables use this function, so the shared one stays as Day 4a left it:
--  - each ledger row gets one minimal row: kind, product, place, the changes, the reason, the references and the
--    note's length (never the note);
--  - costs and settings get the usual new/old/diff rows, keyed by product or organisation; a settings change of the
--    sweep time alone writes nothing;
--  - levels and holds are not audited: the ledger is their record.
create function private.audit_inventory_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec constant jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  diff jsonb;
begin
  if tg_table_name = 'stock_movements' then
    diff := jsonb_build_object(
      'kind', rec -> 'kind', 'product_id', rec -> 'product_id', 'location_id', rec -> 'location_id',
      'd_on_hand', rec -> 'd_on_hand', 'd_reserved', rec -> 'd_reserved', 'reason', rec -> 'reason',
      'refs', jsonb_strip_nulls(jsonb_build_object(
                'group_id', rec -> 'group_id', 'company_id', rec -> 'company_id', 'deal_id', rec -> 'deal_id',
                'reservation_id', rec -> 'reservation_id', 'order_line_id', rec -> 'order_line_id',
                'import_batch_id', rec -> 'import_batch_id', 'pair_id', rec -> 'pair_id')),
      'note_len', coalesce(char_length(rec ->> 'note'), 0));
  elsif tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
      into diff
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value and n.key not in ('updated_at', 'last_sweep_at');
    if diff is null then
      return new;
    end if;
  elsif tg_op = 'INSERT' then
    diff := jsonb_build_object('new', rec);
  else
    diff := jsonb_build_object('old', rec);
  end if;
  insert into public.audit_log (org_id, actor_id, action, table_name, record_id, diff_json)
  values ((rec ->> 'org_id')::uuid, (select auth.uid()), lower(tg_op), tg_table_name,
          coalesce(rec ->> 'id', rec ->> 'product_id', rec ->> 'org_id'), diff);
  return coalesce(new, old);
end;
$$;
create trigger audit_inventory_row after insert on private.stock_movements
  for each row execute function private.audit_inventory_row();
create trigger audit_inventory_row after insert or update or delete on private.product_costs
  for each row execute function private.audit_inventory_row();
create trigger audit_inventory_row after insert or update or delete on private.inventory_settings
  for each row execute function private.audit_inventory_row();

-- Import undo (Day 3b, G7): a lead with a hold (any status) has stock history, so an undo keeps it (its foreign key
-- would refuse the delete anyway).
-- REBASE: copied from 20261011120000_activity_hardening.sql; re-copy from the newest definition before merge
create or replace function private.lead_import_untouched(p_batch uuid, p_limit integer) returns setof uuid
language sql stable set search_path = '' as $$
  select c.id from public.companies c
   where c.import_batch_id = p_batch and c.updated_at = c.created_at
     and not exists (select 1 from public.activities a where a.company_id = c.id)
     and not exists (select 1 from public.contacts k where k.company_id = c.id)
     and not exists (select 1 from public.deals d where d.company_id = c.id)
     and not exists (select 1 from public.tasks t where t.company_id = c.id)
     and not exists (select 1 from private.stock_reservations r where r.company_id = c.id)
   order by c.id
   limit p_limit
$$;

-- Function privileges (part 3): the Day 3a revoke/grant loop for the public RPCs (authenticated only); the private
-- integrity rows for the invoker RPC; the nightly job and the audit trigger for nobody.
revoke all on function private.nightly_stock_jobs(), private.audit_inventory_row() from public, anon, authenticated;
revoke all on function private.stock_integrity_rows(uuid) from public, anon;
grant execute on function private.stock_integrity_rows(uuid) to authenticated;
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.post_stock_movement(uuid, text, integer, text, text, text, uuid, uuid, uuid, date, integer, uuid)',
    'public.create_product(text, integer, numeric, numeric, text, integer, integer, date, boolean, numeric, integer, text, uuid)',
    'public.update_product(uuid, text, integer, numeric, numeric, text, integer, integer, date, boolean)',
    'public.set_product_cost(uuid, numeric)',
    'public.archive_product(uuid)',
    'public.restore_product(uuid)',
    'public.release_expired_reservations()',
    'public.check_stock_integrity()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
