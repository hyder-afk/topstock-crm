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
  glue constant text := '[­̀-ͯ᪰-᫿᷀-᷿​-‍⁠⃐-⃿︠-︯﻿]';
  -- Turned into spaces: the same set as Day 3b's lead name key (ASCII other than letters and digits, controls, Latin-1
  -- punctuation and symbols, × ÷, General Punctuation to Miscellaneous Symbols and Arrows, CJK and full-width
  -- punctuation, emoji, tag characters).
  punct constant text := '[\u0001-/:-@[-`{-¿×÷ʼ̀-ͯ;΄-΅·،-؍؛-؜؟٪-٭۔ ᪰-᫿᷀-᷿ -⯿⸀-⹿　-〄〈-〠〪-〰〶-〷〽-〿゠・︀-﹯﻿＀-／：-＠［-｀｛-･￠-￿\U0001F000-\U0001FBFF\U000E0000-\U000E007F\U000E0100-\U000E01EF]';
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
                            and name !~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'),
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
     or new.name ~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]' then
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
  unit text not null default 'piece',                            -- display word only (open question 16)
  pieces_per_carton integer not null,                            -- QTY PAR CARTON
  cartons_per_pallet integer,
  reorder_point integer,                                         -- warehouse available pieces; null = no alert
  price_min numeric(12,4),                                       -- PRIX PAR PCS: internal floor, EUR per piece
  price_max numeric(12,4),                                       -- PRIX PAR PCS MAX: the price clients see
  transit_eta date,                                              -- expected arrival of the In Transit pieces
  share_visible boolean not null default true,                   -- "Hide from clients" (6e)
  archived_at timestamptz,
  import_batch_id uuid references public.import_batches (id) on delete set null,   -- set by a stock import (6c)
  search_text text generated always as (lower(name || E'\n' || coalesce(category, ''))) stored,
  created_by uuid,                                               -- no FK, like audit_log.actor_id
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_name_check check (char_length(name) between 1 and 200 and name = btrim(name)
    and name !~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'),
  constraint products_category_check check (category is null or (char_length(category) between 1 and 80
    and category = btrim(category)
    and category !~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]')),
  constraint products_unit_check check (unit in ('piece', 'pair')),
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
     or new.name ~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'
     or private.product_name_key(new.name) = '' then
    raise exception 'a product name needs 1 to 200 characters with a letter or a digit, without control characters'
      using errcode = '22023', hint = 'product_name';
  end if;
  new.category := nullif(btrim(new.category), '');
  if char_length(new.category) > 80
     or new.category ~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]' then
    raise exception 'a category needs at most 80 characters, without control characters'
      using errcode = '22023', hint = 'category';
  end if;
  if new.unit is null or new.unit not in ('piece', 'pair') then
    raise exception 'unknown unit' using errcode = '22023', hint = 'unit';
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

-- Cost per piece (D15): managers and admins only, in a table no product query touches.
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
      insert (name, category, unit, pieces_per_carton, cartons_per_pallet, reorder_point, price_min, price_max,
              transit_eta, share_visible),
      update (name, category, unit, pieces_per_carton, cartons_per_pallet, reorder_point, price_min, price_max,
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
                   and note !~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'),
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
                   and note !~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'),
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
     or new.note ~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]' then
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

  -- Rate guard for people: at most 120 rows a minute each (one short range read on movements_user_created_idx).
  if not trusted and (select count(*) from (select 1 from private.stock_movements m
                                             where m.user_id = caller and m.created_at > now() - interval '60 seconds'
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
  --    releases it) or makes this hold fail.
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
create function private.expire_due_holds(p_product uuid default null, p_location uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org constant uuid := private.current_org_id();
begin
  if v_org is null then
    return 0;
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
create trigger release_deal_holds_lost after update of status on public.deals
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
revoke all on function private.expire_due_holds(uuid, uuid), private.sweep_expired_holds() from public, anon;
grant execute on function private.expire_due_holds(uuid, uuid), private.sweep_expired_holds() to authenticated;
