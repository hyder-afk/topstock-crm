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
select private.seed_org_inventory(o.id) from public.orgs o;

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
