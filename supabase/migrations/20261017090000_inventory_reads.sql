-- Day 6b: inventory reads (design docs/evidence/day6/design.md sections 3.2, 5.2 and 10.1). No new table: the read RPCs
-- behind the Inventory page (Stock, Arriving, Reserved and Movements tabs, the product panel) and the settings page.
-- House rules (design 3.0): every function sets search_path = ''; every RPC here is SECURITY INVOKER with static SQL
-- (no format(), no EXECUTE), so row level security decides what each person sees: the whole organisation's stock, and
-- the cost per piece only for managers and admins (a rep's left join on private.product_costs finds nothing). Lists
-- return keyset pages of at most 200 rows (PostgREST cuts set-returning RPCs at 1,000); the rest return jsonb.
-- Every refusal is a constant message with a hint (22023), 42501 for who, P0002 for what is missing or not visible.
-- The list RPCs take optional filters; each runs with plan_cache_mode = force_custom_plan, so every call is planned
-- with its own arguments (a generic plan cannot drop an unused "filter is null or ..." branch, and walked all 100,000
-- movements before a cursor in 300 ms instead of reading 51 rows down the (org_id, id) index).
-- Shared objects of earlier days: none is redefined.

-- One row per product with its two places folded in (warehouse and transit), its status and its cost. A view with
-- security_invoker, so the caller's row level security applies to every table under it (a rep reads null costs); it is
-- in private (no REST endpoint) and only these RPCs read it. Status (design 10, a dot plus a word):
--   archived  the product is archived
--   sold_out  nothing available in the warehouse and nothing in transit
--   arriving  nothing available in the warehouse, stock in transit
--   low       warehouse available at or under the reorder point
--   in_stock  otherwise
create view private.stock_rows with (security_invoker = true) as
select p.id, p.org_id, p.number, p.name, p.category, p.pieces_per_carton, p.cartons_per_pallet, p.transit_eta,
       p.price_min, p.price_max, p.reorder_point, p.share_visible, p.archived_at, p.search_text, p.created_at,
       coalesce(w.on_hand, 0) as wh_on_hand, coalesce(w.reserved, 0) as wh_reserved,
       coalesce(w.on_hand - w.reserved, 0) as wh_available,
       coalesce(t.on_hand, 0) as tr_on_hand, coalesce(t.reserved, 0) as tr_reserved,
       coalesce(t.on_hand - t.reserved, 0) as tr_available,
       greatest(p.updated_at, w.updated_at, t.updated_at) as touched_at,   -- greatest() skips a missing level
       case when p.archived_at is not null then 'archived'
            when coalesce(w.on_hand - w.reserved, 0) <= 0 and coalesce(t.on_hand, 0) = 0 then 'sold_out'
            when coalesce(w.on_hand - w.reserved, 0) <= 0 then 'arriving'
            when p.reorder_point is not null and coalesce(w.on_hand - w.reserved, 0) <= p.reorder_point then 'low'
            else 'in_stock' end as status_key,
       c.cost_per_piece
  from public.products p
  join public.locations lw on lw.org_id = p.org_id and lw.kind = 'warehouse'
  join public.locations lt on lt.org_id = p.org_id and lt.kind = 'transit'
  left join public.stock_levels w on w.product_id = p.id and w.location_id = lw.id
  left join public.stock_levels t on t.product_id = p.id and t.location_id = lt.id
  left join private.product_costs c on c.product_id = p.id;
revoke all on private.stock_rows from public, anon, authenticated;
grant select on private.stock_rows to authenticated;

-- The caller must be signed in with two factors and belong to an organisation (every RPC below starts with it).
-- Invoker; private; granted to authenticated only.
create function private.require_inventory_reader() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_org constant uuid := private.current_org_id();
begin
  if (select auth.uid()) is null or v_org is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  return v_org;
end;
$$;

-- The stock table (design 5.2 and 10.1): one keyset page. Filters: all (not archived), in_warehouse, in_transit, low,
-- sold_out, held, hidden (from clients), archived. Sorts: name (A to Z), available (most first), updated (newest
-- first). Search: name or category (case-insensitive, LIKE characters escaped), or a reference "P-0042" / "42".
create function public.list_stock(
  p_search text default null,
  p_filter text default 'all',
  p_category text default null,
  p_sort text default 'name',
  p_after_value text default null,
  p_after_id uuid default null,
  p_limit integer default 100
) returns table (
  id uuid, number integer, name text, category text, pieces_per_carton integer, cartons_per_pallet integer,
  wh_on_hand integer, wh_reserved integer, wh_available integer, tr_on_hand integer, tr_reserved integer,
  tr_available integer, transit_eta date, price_min numeric, price_max numeric, reorder_point integer, status_key text,
  share_visible boolean, archived boolean, cost_per_piece numeric, touched_at timestamptz, sort_value text
)
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = 'force_custom_plan' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
  v_like text;
  v_number integer;
  v_category text := nullif(btrim(p_category), '');
  v_after_int integer;
  v_after_ts timestamptz;
begin
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'a page has 1 to 200 rows' using errcode = '22023', hint = 'bounds';
  end if;
  if p_filter is null or p_filter not in ('all', 'in_warehouse', 'in_transit', 'low', 'sold_out', 'held', 'hidden',
                                          'archived') then
    raise exception 'unknown filter' using errcode = '22023', hint = 'bad_filter';
  end if;
  if p_sort is null or p_sort not in ('name', 'available', 'updated') then
    raise exception 'unknown sort' using errcode = '22023', hint = 'bad_sort';
  end if;
  if (p_after_value is null) <> (p_after_id is null)
     or (p_sort = 'available' and p_after_value is not null and not pg_input_is_valid(p_after_value, 'integer'))
     or (p_sort = 'updated' and p_after_value is not null and not pg_input_is_valid(p_after_value, 'timestamptz'))
     or char_length(p_after_value) > 400 then
    raise exception 'this cursor does not fit the sort' using errcode = '22023', hint = 'bad_cursor';
  end if;
  if char_length(p_search) > 200 or char_length(v_category) > 80 then
    raise exception 'search text is too long' using errcode = '22023', hint = 'bounds';
  end if;
  v_after_int := case when p_sort = 'available' then p_after_value::integer end;
  v_after_ts := case when p_sort = 'updated' then p_after_value::timestamptz end;
  v_like := lower(private.like_pattern(p_search, 100, 1));
  -- "P-0042", "p42" or "42": the reference number (at most 9 digits, so it fits an integer).
  v_number := case when btrim(p_search) ~* '^p?-?[0-9]{1,9}$' then substring(btrim(p_search) from '[0-9]+')::integer end;

  return query
  select r.id, r.number, r.name, r.category, r.pieces_per_carton, r.cartons_per_pallet,
         r.wh_on_hand, r.wh_reserved, r.wh_available, r.tr_on_hand, r.tr_reserved, r.tr_available, r.transit_eta,
         r.price_min, r.price_max, r.reorder_point, r.status_key, r.share_visible, r.archived_at is not null,
         r.cost_per_piece, r.touched_at,
         case p_sort when 'name' then lower(r.name) when 'available' then r.wh_available::text
                     else r.touched_at::text end
    from private.stock_rows r
   where r.org_id = v_org
     and case p_filter
           when 'archived' then r.archived_at is not null
           when 'all' then r.archived_at is null
           when 'in_warehouse' then r.archived_at is null and r.wh_on_hand > 0
           when 'in_transit' then r.archived_at is null and r.tr_on_hand > 0
           when 'low' then r.status_key = 'low'
           when 'sold_out' then r.status_key = 'sold_out'
           when 'held' then r.archived_at is null and r.wh_reserved + r.tr_reserved > 0
           else r.archived_at is null and not r.share_visible   -- hidden
         end
     and (v_category is null or r.category = v_category)
     and (v_like is null or r.search_text like v_like escape '\' or r.number = v_number)
     and (p_after_id is null
          or (p_sort = 'name' and (lower(r.name), r.id) > (p_after_value, p_after_id))
          or (p_sort = 'available' and (r.wh_available, r.id) < (v_after_int, p_after_id))
          or (p_sort = 'updated' and (r.touched_at, r.id) < (v_after_ts, p_after_id)))
   order by case when p_sort = 'name' then lower(r.name) end asc,
            case when p_sort = 'name' then r.id end asc,
            case when p_sort = 'available' then r.wh_available end desc,
            case when p_sort = 'updated' then r.touched_at end desc,
            case when p_sort <> 'name' then r.id end desc
   limit p_limit;
end;
$$;

-- How many products match (the table's "1,204 products"; the same filters as list_stock).
create function public.count_stock(p_search text default null, p_filter text default 'all', p_category text default null)
returns integer
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = 'force_custom_plan' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
  v_like text;
  v_number integer;
  v_category text := nullif(btrim(p_category), '');
  n integer;
begin
  if p_filter is null or p_filter not in ('all', 'in_warehouse', 'in_transit', 'low', 'sold_out', 'held', 'hidden',
                                          'archived') then
    raise exception 'unknown filter' using errcode = '22023', hint = 'bad_filter';
  end if;
  if char_length(p_search) > 200 or char_length(v_category) > 80 then
    raise exception 'search text is too long' using errcode = '22023', hint = 'bounds';
  end if;
  v_like := lower(private.like_pattern(p_search, 100, 1));
  v_number := case when btrim(p_search) ~* '^p?-?[0-9]{1,9}$' then substring(btrim(p_search) from '[0-9]+')::integer end;
  select count(*)::integer into n
    from private.stock_rows r
   where r.org_id = v_org
     and case p_filter
           when 'archived' then r.archived_at is not null
           when 'all' then r.archived_at is null
           when 'in_warehouse' then r.archived_at is null and r.wh_on_hand > 0
           when 'in_transit' then r.archived_at is null and r.tr_on_hand > 0
           when 'low' then r.status_key = 'low'
           when 'sold_out' then r.status_key = 'sold_out'
           when 'held' then r.archived_at is null and r.wh_reserved + r.tr_reserved > 0
           else r.archived_at is null and not r.share_visible
         end
     and (v_category is null or r.category = v_category)
     and (v_like is null or r.search_text like v_like escape '\' or r.number = v_number);
  return n;
end;
$$;

-- The KPI row and the filter counts (design 10.1): pieces in the warehouse, in transit and held; products low, sold out
-- and arriving; the categories in use (for the category filter).
create function public.stock_summary() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
  v jsonb;
begin
  select jsonb_build_object(
           'products', count(*) filter (where r.archived_at is null),
           'wh_pieces', coalesce(sum(r.wh_on_hand), 0),
           'wh_available', coalesce(sum(greatest(r.wh_available, 0)), 0),
           'tr_pieces', coalesce(sum(r.tr_on_hand), 0),
           'held_pieces', coalesce(sum(r.wh_reserved + r.tr_reserved), 0),
           'low', count(*) filter (where r.status_key = 'low'),
           'sold_out', count(*) filter (where r.status_key = 'sold_out'),
           'arriving', count(*) filter (where r.archived_at is null and r.tr_on_hand > 0),
           'held', count(*) filter (where r.archived_at is null and r.wh_reserved + r.tr_reserved > 0),
           'hidden', count(*) filter (where r.archived_at is null and not r.share_visible),
           'archived', count(*) filter (where r.archived_at is not null),
           'categories', coalesce((select jsonb_agg(x.category order by lower(x.category), x.category)
                                     from (select distinct p.category from public.products p
                                            where p.org_id = v_org and p.category is not null
                                              and p.archived_at is null) x), '[]'::jsonb))
    into v
    from private.stock_rows r
   where r.org_id = v_org;
  return v;
end;
$$;

-- One product for its panel (design 10.1): details, both places, its active holds (lead, deal when the caller may see
-- it, who, until when; ended-but-not-swept holds flagged), and its last 20 movements. 6d adds its sales and requests.
create function public.get_product(p_id uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
  v_product jsonb;
begin
  select jsonb_build_object(
           'id', r.id, 'number', r.number, 'name', r.name, 'category', r.category,
           'pieces_per_carton', r.pieces_per_carton, 'cartons_per_pallet', r.cartons_per_pallet,
           'transit_eta', r.transit_eta, 'price_min', r.price_min, 'price_max', r.price_max,
           'reorder_point', r.reorder_point, 'share_visible', r.share_visible, 'archived', r.archived_at is not null,
           'status_key', r.status_key, 'cost_per_piece', r.cost_per_piece, 'touched_at', r.touched_at,
           'created_at', r.created_at,
           'wh_on_hand', r.wh_on_hand, 'wh_reserved', r.wh_reserved, 'wh_available', r.wh_available,
           'tr_on_hand', r.tr_on_hand, 'tr_reserved', r.tr_reserved, 'tr_available', r.tr_available)
    into v_product
    from private.stock_rows r
   where r.id = p_id and r.org_id = v_org;
  if v_product is null then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  return v_product || jsonb_build_object(
    'holds', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', h.id, 'location', l.kind, 'company_id', h.company_id, 'company_name', c.name,
               'deal_id', (select d.id from public.deals d where d.id = h.deal_id),   -- null unless the caller sees it
               'quantity', h.quantity, 'remaining', h.remaining, 'hold_until', h.hold_until,
               'ended', h.hold_until < v_today, 'note', h.note, 'created_by', h.created_by,
               'created_by_first_name', u.first_name, 'created_by_last_name', u.last_name, 'created_at', h.created_at)
             order by h.created_at, h.id)
        from private.stock_reservations h
        join public.locations l on l.id = h.location_id
        left join public.companies c on c.id = h.company_id
        left join public.profiles u on u.id = h.created_by
       where h.product_id = p_id and h.status = 'active'), '[]'::jsonb),
    'movements', coalesce((
      select jsonb_agg(x.j order by x.id desc)
        from (select m.id, jsonb_build_object(
                       'id', m.id, 'group_id', m.group_id, 'kind', m.kind, 'location', l.kind, 'qty', m.qty,
                       'd_on_hand', m.d_on_hand, 'd_reserved', m.d_reserved, 'on_hand_after', m.on_hand_after,
                       'reserved_after', m.reserved_after, 'reason', m.reason, 'note', m.note,
                       'company_id', m.company_id, 'company_name', c.name, 'user_id', m.user_id,
                       'user_first_name', u.first_name, 'user_last_name', u.last_name, 'created_at', m.created_at,
                       'pair_id', m.pair_id, 'import_batch_id', m.import_batch_id) as j
                from private.stock_movements m
                join public.locations l on l.id = m.location_id
                left join public.companies c on c.id = m.company_id
                left join public.profiles u on u.id = m.user_id
               where m.product_id = p_id
               order by m.id desc
               limit 20) x), '[]'::jsonb));
end;
$$;

-- The movement log (design 10.1): keyset on id, newest first. Filters: a product, kinds, a person, a date range (Paris
-- dates, inclusive).
create function public.list_movements(
  p_product uuid default null,
  p_kinds text[] default null,
  p_user uuid default null,
  p_from date default null,
  p_to date default null,
  p_before_id bigint default null,
  p_limit integer default 50
) returns table (
  id bigint, group_id uuid, kind text, product_id uuid, product_name text, product_number integer, location text,
  qty integer, d_on_hand integer, d_reserved integer, on_hand_after integer, reserved_after integer, reason text,
  note text, company_id uuid, company_name text, user_id uuid, user_first_name text, user_last_name text,
  created_at timestamptz, pair_id bigint, reservation_id uuid, import_batch_id uuid
)
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = 'force_custom_plan' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'a page has 1 to 100 rows' using errcode = '22023', hint = 'bounds';
  end if;
  if cardinality(p_kinds) > 14 or not (coalesce(p_kinds, '{}'::text[]) <@ array['receive', 'adjust_in', 'adjust_out',
       'transfer_out', 'transfer_in', 'reserve', 'release', 'expire', 'ship', 'return', 'import_in', 'import_out',
       'undo_in', 'undo_out']) or array_position(p_kinds, null) is not null then
    raise exception 'unknown kind of movement' using errcode = '22023', hint = 'bad_types';
  end if;
  if p_from > p_to or p_from < date '2020-01-01' or p_to > date '2100-01-01' then
    raise exception 'the dates are out of range' using errcode = '22023', hint = 'bounds';
  end if;
  -- The page first (51 rows down the (org_id, id) or (org_id, kind, id) index), then the names joined to it: joined
  -- before the limit, the planner walked every movement before the cursor.
  return query
  with page as materialized (
    select m.* from private.stock_movements m
     where m.org_id = v_org
       and (p_product is null or m.product_id = p_product)
       and (p_kinds is null or m.kind = any (p_kinds))
       and (p_user is null or m.user_id = p_user)
       and (p_from is null or m.created_at >= (p_from::timestamp at time zone 'Europe/Paris'))
       and (p_to is null or m.created_at < ((p_to + 1)::timestamp at time zone 'Europe/Paris'))
       and (p_before_id is null or m.id < p_before_id)
     order by m.id desc
     limit p_limit)
  select m.id, m.group_id, m.kind, m.product_id, p.name, p.number, l.kind, m.qty, m.d_on_hand, m.d_reserved,
         m.on_hand_after, m.reserved_after, m.reason, m.note, m.company_id, c.name, m.user_id, u.first_name,
         u.last_name, m.created_at, m.pair_id, m.reservation_id, m.import_batch_id
    from page m
    join public.products p on p.id = m.product_id
    join public.locations l on l.id = m.location_id
    left join public.companies c on c.id = m.company_id
    left join public.profiles u on u.id = m.user_id
   order by m.id desc;
end;
$$;

-- Holds (design 10.1, the Reserved tab, and 6d's lead Stock tab): keyset on (created_at, id), newest first. Status:
-- active (default), closed (released, used, ended) or all. The deal shows only when the caller may see it.
create function public.list_reservations(
  p_company uuid default null,
  p_product uuid default null,
  p_status text default 'active',
  p_before_created timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid, product_id uuid, product_name text, product_number integer, pieces_per_carton integer, location text,
  company_id uuid, company_name text, deal_id uuid, quantity integer, remaining integer, status text,
  hold_until date, ended boolean, note text, created_by uuid, created_by_first_name text, created_by_last_name text,
  created_at timestamptz, closed_at timestamptz, close_reason text
)
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = 'force_custom_plan' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'a page has 1 to 100 rows' using errcode = '22023', hint = 'bounds';
  end if;
  if p_status is null or p_status not in ('active', 'closed', 'all') then
    raise exception 'unknown status' using errcode = '22023', hint = 'state';
  end if;
  if (p_before_created is null) <> (p_before_id is null) then
    raise exception 'this cursor is incomplete' using errcode = '22023', hint = 'bad_cursor';
  end if;
  return query
  with page as materialized (
    select h.* from private.stock_reservations h
     where h.org_id = v_org
       and (p_company is null or h.company_id = p_company)
       and (p_product is null or h.product_id = p_product)
       and (p_status = 'all' or (p_status = 'active') = (h.status = 'active'))
       and (p_before_id is null or (h.created_at, h.id) < (p_before_created, p_before_id))
     order by h.created_at desc, h.id desc
     limit p_limit)
  select h.id, h.product_id, p.name, p.number, p.pieces_per_carton, l.kind, h.company_id, c.name,
         (select d.id from public.deals d where d.id = h.deal_id), h.quantity, h.remaining, h.status, h.hold_until,
         h.status = 'active' and h.hold_until < v_today, h.note, h.created_by, u.first_name, u.last_name,
         h.created_at, h.closed_at, h.close_reason
    from page h
    join public.products p on p.id = h.product_id
    join public.locations l on l.id = h.location_id
    left join public.companies c on c.id = h.company_id
    left join public.profiles u on u.id = h.created_by
   order by h.created_at desc, h.id desc;
end;
$$;

-- Settings (design 5.2 and 10.6): everyone reads them; admins change them.
create function public.get_inventory_settings() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
  v jsonb;
begin
  select jsonb_build_object(
           'hold_days', s.hold_days, 'alert_assignee_id', s.alert_assignee_id,
           'warehouse_name', (select l.name from public.locations l where l.org_id = v_org and l.kind = 'warehouse'),
           'transit_name', (select l.name from public.locations l where l.org_id = v_org and l.kind = 'transit'),
           'can_edit', private.is_admin())
    into v
    from private.inventory_settings s
   where s.org_id = v_org;
  if v is null then
    raise exception 'settings not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

-- Restock task assignee (a person of the organisation, or nobody) and the default hold length (1 to 90 days). Admins.
create function public.update_inventory_settings(p_alert_assignee uuid, p_hold_days integer) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
begin
  if not private.is_admin() then
    raise exception 'only admins change inventory settings' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_hold_days is null or p_hold_days not between 1 and 90 then
    raise exception 'a hold lasts 1 to 90 days' using errcode = '22023', hint = 'hold_days';
  end if;
  if p_alert_assignee is not null
     and not exists (select 1 from public.profiles p where p.id = p_alert_assignee and p.org_id = v_org) then
    raise exception 'the assignee must be in this organisation' using errcode = '22023', hint = 'assignee';
  end if;
  update private.inventory_settings s
     set alert_assignee_id = p_alert_assignee, hold_days = p_hold_days
   where s.org_id = v_org;
  return public.get_inventory_settings();
end;
$$;

-- Rename the warehouse or the transit place (admins; the place guard checks the name with a constant message).
create function public.rename_location(p_kind text, p_name text) returns void
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
  v_name constant text := btrim(p_name);
begin
  if not private.is_admin() then
    raise exception 'only admins rename places' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_kind is null or p_kind not in ('warehouse', 'transit') then
    raise exception 'unknown place' using errcode = '22023', hint = 'location';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 80
     or v_name ~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
    raise exception 'a place name needs 1 to 80 characters, without control characters'
      using errcode = '22023', hint = 'location_name';
  end if;
  update public.locations l set name = v_name where l.org_id = v_org and l.kind = p_kind;
end;
$$;

-- Two one-field changes from the Inventory page (managers and admins), so an inline edit never overwrites a colleague's
-- other changes the way a full update_product would: the expected arrival date (Arriving tab) and "Hide from clients"
-- (product panel). The product guard checks the date's window with a constant message.
create function public.set_product_eta(p_id uuid, p_eta date) returns void
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
begin
  if not private.is_manager_or_admin() then
    raise exception 'only managers and admins change products' using errcode = '42501', hint = 'forbidden';
  end if;
  update public.products p set transit_eta = p_eta where p.id = p_id and p.org_id = v_org;
  if not found then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
end;
$$;
create function public.set_product_share_visible(p_id uuid, p_visible boolean) returns void
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_org constant uuid := private.require_inventory_reader();
begin
  if not private.is_manager_or_admin() then
    raise exception 'only managers and admins change products' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_visible is null then
    raise exception 'say whether clients see it' using errcode = '22023', hint = 'bounds';
  end if;
  update public.products p set share_visible = p_visible where p.id = p_id and p.org_id = v_org;
  if not found then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Function privileges: the Day 3a revoke/grant loop (authenticated only); the private helper for the RPCs above.
revoke all on function private.require_inventory_reader() from public, anon;
grant execute on function private.require_inventory_reader() to authenticated;
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.list_stock(text, text, text, text, text, uuid, integer)',
    'public.count_stock(text, text, text)',
    'public.stock_summary()',
    'public.get_product(uuid)',
    'public.list_movements(uuid, text[], uuid, date, date, bigint, integer)',
    'public.list_reservations(uuid, uuid, text, timestamptz, uuid, integer)',
    'public.get_inventory_settings()',
    'public.update_inventory_settings(uuid, integer)',
    'public.rename_location(text, text)',
    'public.set_product_eta(uuid, date)',
    'public.set_product_share_visible(uuid, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
