-- Day 6d attack and behaviour tests: sales, holds from the CRM, team stock requests and the stock automations (design
-- docs/evidence/day6/design.md sections 3.4, 4.5, 6.1 to 6.9 and 11.1; migration 20261019090000_sales_requests.sql).
-- Runs after stock_import_attack.sql on the same database (scripts/db-test.sh, CI job "db"), reusing its users: admins a
-- and b, manager a1, reps b1, d1 and e1, other-org admin c1. Its own leads, deals and products are named "SA …". Any
-- failure raises an exception and stops the run. The file ends with ledger_sums_match_levels.
\set ON_ERROR_STOP 1
\set QUIET 1

create function pg_temp.as_user(sub text, aal text, totp_age_s integer default null) returns void
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', sub, 'role', 'authenticated', 'aal', aal,
    'amr', case when totp_age_s is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - totp_age_s)) end
  )::text, false)
$$;
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
      raise exception 'FAIL: "%" gave % (hint "%", %), expected % (hint "%")', left(stmt, 200), got_state, got_hint,
        got_msg, want_state, want_hint;
    end if;
    if marker is not null and (strpos(coalesce(got_msg, ''), marker) > 0 or strpos(coalesce(got_detail, ''), marker) > 0
                               or strpos(coalesce(got_detail, ''), 'Failing row') > 0) then
      raise exception 'FAIL: "%" put the user''s text in the error', left(stmt, 200);
    end if;
    return;
  end;
  raise exception 'FAIL: "%" succeeded, expected %', left(stmt, 200), want_state;
end;
$$;
create function pg_temp.oh(pname text, k text default 'warehouse') returns integer language sql as $$
  select coalesce((select l.on_hand from public.stock_levels l join public.locations x on x.id = l.location_id
                    join public.products p on p.id = l.product_id where p.name = pname and x.kind = k), 0)
$$;
create function pg_temp.rv(pname text, k text default 'warehouse') returns integer language sql as $$
  select coalesce((select l.reserved from public.stock_levels l join public.locations x on x.id = l.location_id
                    join public.products p on p.id = l.product_id where p.name = pname and x.kind = k), 0)
$$;
create function pg_temp.pid(pname text) returns uuid language sql as $$
  select id from public.products where name = pname
$$;
-- One line of a sale as the RPC takes it.
create function pg_temp.l(pname text, qty integer, price text default '3') returns jsonb language sql as $$
  select jsonb_build_object('product_id', pg_temp.pid(pname), 'quantity', qty::text, 'unit_price', price)
$$;
create function pg_temp.integrity_clean(what text) returns void language plpgsql as $$
declare
  saved constant text := current_setting('request.jwt.claims', true);
  r record;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  for r in select * from public.check_stock_integrity() loop
    raise exception 'FAIL: % left a difference: %', what, row_to_json(r);
  end loop;
  perform set_config('request.jwt.claims', coalesce(saved, ''), false);
end;
$$;

-- 0. Fixtures (as the owner): leads, deals, products, stock ------------------------------------------------------------
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
do $$
declare
  main_org uuid := (select id from public.orgs where name = 'TopStock Wholesale');
  stage uuid := (select s.id from public.pipeline_stages s where s.org_id = main_org and s.position = 1);
begin
  insert into public.companies (id, org_id, name, owner_id, lead_status, country) values
    ('5a000000-0000-0000-0000-0000000000b1', main_org, 'SA Lead B1', '00000000-0000-0000-0000-0000000000b1', 'warm', 'FR'),
    ('5a000000-0000-0000-0000-0000000000d1', main_org, 'SA Lead D1', '00000000-0000-0000-0000-0000000000d1', 'cold', 'BE'),
    ('5a000000-0000-0000-0000-0000000000b2', main_org, 'SA Lead DNC', '00000000-0000-0000-0000-0000000000b1', 'do_not_contact', 'FR'),
    ('5a000000-0000-0000-0000-0000000000b3', main_org, 'SA Lead First', '00000000-0000-0000-0000-0000000000b1', 'negotiation', 'FR');
  insert into public.deals (id, org_id, company_id, stage_id, owner_id, status, fulfilment, lost_reason) values
    ('5d000000-0000-0000-0000-0000000000b1', main_org, '5a000000-0000-0000-0000-0000000000b1', stage,
     '00000000-0000-0000-0000-0000000000b1', 'open', 'from_stock', null),
    ('5d000000-0000-0000-0000-0000000000b2', main_org, '5a000000-0000-0000-0000-0000000000b1', stage,
     '00000000-0000-0000-0000-0000000000b1', 'lost', 'from_stock', 'price'),
    ('5d000000-0000-0000-0000-0000000000b3', main_org, '5a000000-0000-0000-0000-0000000000b1', stage,
     '00000000-0000-0000-0000-0000000000b1', 'open', 'direct_from_source', null),
    ('5d000000-0000-0000-0000-0000000000d1', main_org, '5a000000-0000-0000-0000-0000000000d1', stage,
     '00000000-0000-0000-0000-0000000000d1', 'open', 'from_stock', null);
  insert into public.products (org_id, name, pieces_per_carton, price_min, price_max, reorder_point)
  select main_org, 'SA P' || g, 10, 2, 3, case when g in (5, 6) then 50 end from generate_series(1, 8) g;
  insert into private.product_costs (product_id, org_id, cost_per_piece, source)
  select id, org_id, 1.25, 'manual' from public.products where name like 'SA P%';
  update public.profiles set language = 'fr' where id = '00000000-0000-0000-0000-0000000000a1';
end $$;

set role authenticated;
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform public.update_inventory_settings('00000000-0000-0000-0000-0000000000a1', 14);
  perform public.post_stock_movement(pg_temp.pid('SA P' || g), 'receive', 100, 'warehouse', 'received')
    from generate_series(1, 4) g;
  perform public.post_stock_movement(pg_temp.pid('SA P5'), 'receive', 60, 'warehouse', 'received');
  perform public.post_stock_movement(pg_temp.pid('SA P6'), 'receive', 60, 'warehouse', 'received');
  perform public.post_stock_movement(pg_temp.pid('SA P7'), 'receive', 96, 'warehouse', 'received');
  perform public.post_stock_movement(pg_temp.pid('SA P3'), 'receive', 200, 'transit', 'received');
end $$;

-- 1. Catalog: private tables with RLS and require_mfa; column grants; RPCs invoker, search_path set, authenticated only;
--    definer helpers revoked from everyone ------------------------------------------------------------------------------
reset role;
do $$
declare
  t text;
  f record;
  cols text[];
begin
  foreach t in array array['private.orders', 'private.order_lines', 'private.order_line_costs', 'private.stock_requests',
                           'private.stock_request_lines'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = t::regclass)
       or not exists (select 1 from pg_policies p where p.schemaname || '.' || p.tablename = t
                        and p.policyname = 'require_mfa' and p.permissive = 'RESTRICTIVE')
       or has_table_privilege('anon', t, 'SELECT') or has_table_privilege('authenticated', t, 'DELETE')
       or has_table_privilege('authenticated', t, 'TRUNCATE') then
      raise exception 'FAIL: % lacks RLS, require_mfa or tight grants', t;
    end if;
  end loop;
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'private.orders'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'UPDATE');
  if cols is distinct from array['cancel_reason', 'status'] then raise exception 'FAIL: order update columns %', cols; end if;
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'private.order_lines'::regclass and attnum > 0 and not attisdropped
     and (has_column_privilege('authenticated', attrelid, attname, 'UPDATE')
          or (has_column_privilege('authenticated', attrelid, attname, 'INSERT')
              and attname not in ('order_id', 'position', 'product_id', 'product_name', 'quantity', 'unit_price')));
  if cols is not null then raise exception 'FAIL: order line write columns %', cols; end if;
  if has_column_privilege('authenticated', 'private.order_lines', 'below_min', 'INSERT')
     or has_table_privilege('authenticated', 'private.order_line_costs', 'INSERT')
     or has_column_privilege('authenticated', 'private.stock_request_lines', 'pieces', 'INSERT')
     or has_column_privilege('authenticated', 'private.stock_request_lines', 'availability', 'INSERT')
     or has_column_privilege('authenticated', 'public.tasks', 'source_product_id', 'INSERT')
     or has_column_privilege('authenticated', 'public.tasks', 'source_request_id', 'UPDATE') then
    raise exception 'FAIL: a server-set column is writable';
  end if;
  for f in select p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('record_sale', 'undo_sale', 'cancel_sale', 'extend_reservation', 'list_sales', 'get_sale',
                                'get_lead_stock', 'list_lead_deals_for_stock', 'log_stock_request',
                                'set_stock_request_status', 'list_stock_requests', 'get_stock_request', 'stock_alerts') loop
    if f.prosecdef or not ('search_path=""' = any (f.proconfig)) or has_function_privilege('anon', f.sig, 'execute')
       or not has_function_privilege('authenticated', f.sig, 'execute') then
      raise exception 'FAIL: % is not an authenticated-only invoker with search_path', f.sig;
    end if;
  end loop;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('record_sale', 'undo_sale', 'cancel_sale', 'extend_reservation', 'list_sales', 'get_sale',
                          'get_lead_stock', 'list_lead_deals_for_stock', 'log_stock_request', 'set_stock_request_status',
                          'list_stock_requests', 'get_stock_request', 'stock_alerts')) <> 13 then
    raise exception 'FAIL: the 13 RPCs are not all there';
  end if;
  foreach t in array array['private.insert_system_task(uuid, uuid, text, text, uuid, uuid, uuid)',
                           'private.stock_low_automation()', 'private.hold_arrived_task()',
                           'private.order_line_cost_snapshot()', 'private.audit_sales_row()'] loop
    if not (select p.prosecdef from pg_proc p where p.oid = t::regprocedure)
       or has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') then
      raise exception 'FAIL: % must be a definer nobody can call', t;
    end if;
  end loop;
end $$;

-- 2. record_sale_moves_stock, sale lines, cost snapshot, a rep sees no cost -------------------------------------------
set role authenticated;
do $$
declare
  r jsonb;
  s jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  r := public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock', jsonb_build_array(pg_temp.l('SA P1', 10)));
  if pg_temp.oh('SA P1') <> 90 or (r ->> 'total')::numeric <> 30 or r ->> 'fulfilment' <> 'from_stock'
     or (r -> 'lines' -> 0 ->> 'available_after')::int <> 90 or (r -> 'lines' -> 0 ->> 'used_held')::int <> 0 then
    raise exception 'FAIL: record_sale_moves_stock: % (on hand %)', r, pg_temp.oh('SA P1');
  end if;
  if (select count(*) from private.stock_movements m join private.order_lines ol on ol.id = m.order_line_id
       where ol.order_id = (r ->> 'order_id')::uuid and m.kind = 'ship' and m.reason = 'sold'
         and m.company_id = '5a000000-0000-0000-0000-0000000000b1') <> 1 then
    raise exception 'FAIL: the ship row is missing or wrong';
  end if;
  s := public.get_sale((r ->> 'order_id')::uuid);
  if s -> 'lines' -> 0 ->> 'product_name' <> 'SA P1' or s -> 'lines' -> 0 -> 'cost_per_piece' <> 'null'::jsonb then
    raise exception 'FAIL: rep_sale_cost_hidden: %', s;
  end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  s := public.get_sale((r ->> 'order_id')::uuid);
  if (s -> 'lines' -> 0 ->> 'cost_per_piece')::numeric <> 1.25 then
    raise exception 'FAIL: cost snapshot for managers: %', s;
  end if;
end $$;

-- 3. record_sale_uses_deal_hold_then_lead_hold, record_sale_partial_hold_use, record_sale_never_sells_other_clients_holds,
--    record_sale_insufficient_rolls_back_order -------------------------------------------------------------------------
do $$
declare
  r jsonb;
  n_orders bigint;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  perform public.post_stock_movement(pg_temp.pid('SA P2'), 'reserve', 30, p_company => '5a000000-0000-0000-0000-0000000000b1',
                                     p_deal => '5d000000-0000-0000-0000-0000000000b1');
  perform public.post_stock_movement(pg_temp.pid('SA P2'), 'reserve', 20, p_company => '5a000000-0000-0000-0000-0000000000b1');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2', 30);
  perform public.post_stock_movement(pg_temp.pid('SA P2'), 'reserve', 25, p_company => '5a000000-0000-0000-0000-0000000000d1');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  r := public.record_sale('5a000000-0000-0000-0000-0000000000b1', null, jsonb_build_array(pg_temp.l('SA P2', 40)),
                          p_deal => '5d000000-0000-0000-0000-0000000000b1');
  perform set_config('t.sale_holds', r ->> 'order_id', false);
  if (r -> 'lines' -> 0 ->> 'used_held')::int <> 40 or pg_temp.oh('SA P2') <> 60 or pg_temp.rv('SA P2') <> 35 then
    raise exception 'FAIL: record_sale_uses_deal_hold_then_lead_hold: % (% / %)', r, pg_temp.oh('SA P2'), pg_temp.rv('SA P2');
  end if;
  if (select string_agg(r2.status || ':' || r2.remaining, ',' order by r2.status, r2.remaining)
        from private.stock_reservations r2 where r2.product_id = pg_temp.pid('SA P2')) <> 'active:10,active:25,fulfilled:0'
     or (select count(*) from private.stock_hold_uses u join private.stock_movements m on m.id = u.movement_id
          join private.order_lines ol on ol.id = m.order_line_id where ol.order_id = (r ->> 'order_id')::uuid) <> 2 then
    raise exception 'FAIL: record_sale_partial_hold_use: the holds are %', (select string_agg(r2.status || ':' || r2.remaining, ',' order by r2.status, r2.remaining)
        from private.stock_reservations r2 where r2.product_id = pg_temp.pid('SA P2'));
  end if;
  if (select r2.close_reason || '/' || r2.quantity from private.stock_reservations r2
       where r2.product_id = pg_temp.pid('SA P2') and r2.status = 'fulfilled') <> 'sold/30' then
    raise exception 'FAIL: a used hold is closed as sold';
  end if;
  -- 60 on hand, 35 held (10 for this lead, 25 for D1's lead): 50 more would need D1's pieces.
  n_orders := (select count(*) from private.orders);
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    jsonb_build_array(pg_temp.l('SA P2', 50)))$q$, '22023', 'reserved_by_others');
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    jsonb_build_array(pg_temp.l('SA P1', 5), pg_temp.l('SA P4', 101)))$q$, '22023', 'insufficient_stock');
  if (select count(*) from private.orders) <> n_orders or pg_temp.oh('SA P1') <> 90 then
    raise exception 'FAIL: record_sale_insufficient_rolls_back_order';
  end if;
  r := public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock', jsonb_build_array(pg_temp.l('SA P2', 35)));
  if pg_temp.oh('SA P2') <> 25 or pg_temp.rv('SA P2') <> 25 or (r -> 'lines' -> 0 ->> 'used_held')::int <> 10 then
    raise exception 'FAIL: the lead''s last hold is used, D1''s stays: %', r;
  end if;
end $$;
do $$ begin perform pg_temp.integrity_clean('the hold sales'); end $$;

-- 4. Who may sell, below the minimum, shapes and limits, idempotency -----------------------------------------------------
do $$
declare
  r1 jsonb;
  r2 jsonb;
  req uuid := gen_random_uuid();
  many jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  -- record_sale_rep_on_other_lead_refused (D1's lead).
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000d1', 'from_stock',
    jsonb_build_array(pg_temp.l('SA P1', 1)))$q$, '42501', 'forbidden');
  -- record_sale_rep_below_min_refused; record_sale_below_min_needs_flag_and_manager.
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    jsonb_build_array(pg_temp.l('SA P1', 1, '1.5')))$q$, '42501', 'below_min');
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    jsonb_build_array(pg_temp.l('SA P1', 1, '1.5')), p_allow_below_min => true)$q$, '42501', 'below_min');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    jsonb_build_array(pg_temp.l('SA P1', 1, '1.5')))$q$, '22023', 'below_min');
  r1 := public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
                           jsonb_build_array(pg_temp.l('SA P1', 1, '1.5')), p_allow_below_min => true);
  if not (select ol.below_min from private.order_lines ol where ol.order_id = (r1 ->> 'order_id')::uuid) then
    raise exception 'FAIL: below_min is not flagged';
  end if;
  -- Shapes: duplicate product, 51 lines, bad values, extra keys, bidi in a description (never echoed).
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    jsonb_build_array(pg_temp.l('SA P1', 1), pg_temp.l('SA P1', 2)))$q$, '22023', 'duplicate_line');
  many := (select jsonb_agg(jsonb_build_object('description', 'Item ' || g, 'quantity', '1', 'unit_price', '1'))
             from generate_series(1, 51) g);
  perform pg_temp.expect_error(format('select public.record_sale(%L, %L, %L)', '5a000000-0000-0000-0000-0000000000b1',
    'direct_from_source', many), '22023', 'lines');
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    '[{"product_id": null, "quantity": "0", "unit_price": "3"}]')$q$, '22023', 'lines');
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    jsonb_build_array(pg_temp.l('SA P1', 1, '1e3')))$q$, '22023', 'lines');
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    jsonb_build_array(pg_temp.l('SA P1', 1) || '{"line_total": "0"}'))$q$, '22023', 'lines');
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'direct_from_source',
    '[{"description": "Secret \u202e item", "quantity": "1", "unit_price": "1"}]')$q$, '22023', 'lines', 'Secret');
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    '[{"description": "No product", "quantity": "1", "unit_price": "1"}]')$q$, '22023', 'lines');
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'by_air',
    jsonb_build_array(pg_temp.l('SA P1', 1)))$q$, '22023', 'fulfilment');
  -- record_sale_idempotent.
  r1 := public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock', jsonb_build_array(pg_temp.l('SA P4', 2)),
                           p_request_id => req);
  r2 := public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock', jsonb_build_array(pg_temp.l('SA P4', 2)),
                           p_request_id => req);
  if r1 -> 'order_id' <> r2 -> 'order_id' or pg_temp.oh('SA P4') <> 98 then
    raise exception 'FAIL: record_sale_idempotent: % / % (on hand %)', r1, r2, pg_temp.oh('SA P4');
  end if;
  -- No session, aal1, other organisation.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal1');
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    jsonb_build_array(pg_temp.l('SA P1', 1)))$q$, '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1', 'aal2', 30);
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'direct_from_source',
    '[{"description": "x", "quantity": "1", "unit_price": "1"}]')$q$, '42501', 'forbidden');
  if exists (select 1 from private.orders) or exists (select 1 from private.stock_requests) then
    raise exception 'FAIL: another organisation sees sales or requests';
  end if;
end $$;

-- 5. supplier_sale_no_movement, sale_deal_optional_without_day5, sale_deal_other_lead_refused, lost deal ---------------
do $$
declare
  r jsonb;
  n_moves bigint;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  n_moves := (select count(*) from private.stock_movements);
  r := public.record_sale('5a000000-0000-0000-0000-0000000000b1', null,
         '[{"description": "Container of umbrellas", "quantity": "500", "unit_price": "1.1"}]'::jsonb,
         p_deal => '5d000000-0000-0000-0000-0000000000b3');
  if r ->> 'fulfilment' <> 'direct_from_source' or (select count(*) from private.stock_movements) <> n_moves
     or (select o.ship_to_country from private.orders o where o.id = (r ->> 'order_id')::uuid) <> 'FR'
     or (r ->> 'total')::numeric <> 550 then
    raise exception 'FAIL: supplier_sale_no_movement: %', r;
  end if;
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    jsonb_build_array(pg_temp.l('SA P1', 1)), p_deal => '5d000000-0000-0000-0000-0000000000d1')$q$, '22023', 'deal_mismatch');
  perform pg_temp.expect_error($q$select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock',
    jsonb_build_array(pg_temp.l('SA P1', 1)), p_deal => '5d000000-0000-0000-0000-0000000000b2')$q$, '22023', 'deal_lost');
  -- A direct insert of a sale still goes through the guard (server fields, deal checks).
  perform pg_temp.expect_error($q$insert into private.orders (company_id, deal_id, fulfilment)
    values ('5a000000-0000-0000-0000-0000000000b1', '5d000000-0000-0000-0000-0000000000d1', 'from_stock')$q$, '22023', 'deal_mismatch');
  perform pg_temp.expect_error($q$insert into private.orders (company_id, fulfilment, prev_lead_status)
    values ('5a000000-0000-0000-0000-0000000000b1', 'from_stock', 'cold')$q$, '42501');
  -- A line cannot be added to an earlier sale, nor stock shipped outside a sale.
  perform pg_temp.expect_error(format($q$insert into private.order_lines (order_id, position, product_id, product_name, quantity, unit_price)
    values (%L, 9, %L, 'x', 1, 3)$q$, current_setting('t.sale_holds'), pg_temp.pid('SA P1')), '42501', 'forbidden');
  perform pg_temp.expect_error(format($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, order_line_id)
    select gen_random_uuid(), ol.product_id, l.id, 'ship', ol.quantity, ol.id from private.order_lines ol
      join public.locations l on l.kind = 'warehouse' and l.org_id = ol.org_id where ol.order_id = %L$q$,
    current_setting('t.sale_holds')), '42501', 'forbidden');
end $$;

-- 5b. The table path (a client writing the rows itself, in one transaction): a rep's line below the minimum is refused
--     by the line guard; a line ships once (unique index); a sale's deal is checked on insert.
do $$
declare
  o uuid;
  line uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  insert into private.orders (company_id, fulfilment) values ('5a000000-0000-0000-0000-0000000000b1', 'from_stock')
  returning id into o;
  perform pg_temp.expect_error(format($q$insert into private.order_lines (order_id, position, product_id, product_name, quantity, unit_price)
    values (%L, 1, %L, 'x', 1, 1.5)$q$, o, pg_temp.pid('SA P8')), '42501', 'below_min');
  insert into private.order_lines (order_id, position, product_id, product_name, quantity, unit_price)
  values (o, 2, pg_temp.pid('SA P1'), 'x', 1, 3) returning id into line;
  insert into private.stock_movements (group_id, product_id, location_id, kind, qty, order_line_id)
  select gen_random_uuid(), pg_temp.pid('SA P1'), l.id, 'ship', 1, line from public.locations l
   where l.kind = 'warehouse' and l.org_id = (select org_id from private.orders where id = o);
  perform pg_temp.expect_error(format($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, order_line_id)
    select gen_random_uuid(), %L, l.id, 'ship', 1, %L from public.locations l
     where l.kind = 'warehouse' and l.org_id = (select org_id from private.orders where id = %L)$q$, pg_temp.pid('SA P1'), line, o),
    '23505');
  perform pg_temp.expect_error(format($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, order_line_id)
    select gen_random_uuid(), %L, l.id, 'ship', 2, %L from public.locations l
     where l.kind = 'warehouse' and l.org_id = (select org_id from private.orders where id = %L)$q$, pg_temp.pid('SA P1'), line, o),
    '22023', 'document');
end $$;
do $$ begin perform pg_temp.integrity_clean('the table path'); end $$;

-- 6. first_sale_sets_customer (not from do_not_contact), undo_sale_window_no_code, undo_sale_restores_consumed_hold,
--    undo_sale_restores_lead_status ---------------------------------------------------------------------------------
do $$
declare
  r jsonb;
  u jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  r := public.record_sale('5a000000-0000-0000-0000-0000000000b3', 'from_stock', jsonb_build_array(pg_temp.l('SA P4', 3)));
  if not (r ->> 'became_customer')::boolean
     or (select lead_status from public.companies where id = '5a000000-0000-0000-0000-0000000000b3') <> 'customer' then
    raise exception 'FAIL: first_sale_sets_customer: %', r;
  end if;
  u := public.undo_sale((r ->> 'order_id')::uuid);
  if (select lead_status from public.companies where id = '5a000000-0000-0000-0000-0000000000b3') <> 'negotiation'
     or pg_temp.oh('SA P4') <> 98
     or (select o.status || '/' || o.cancel_reason from private.orders o where o.id = (r ->> 'order_id')::uuid) <> 'cancelled/undo' then
    raise exception 'FAIL: undo_sale_restores_lead_status: %', u;
  end if;
  perform pg_temp.expect_error(format('select public.undo_sale(%L)', r ->> 'order_id'), '22023', 'sale_state');
  r := public.record_sale('5a000000-0000-0000-0000-0000000000b2', 'from_stock', jsonb_build_array(pg_temp.l('SA P4', 1)));
  if (r ->> 'became_customer')::boolean
     or (select lead_status from public.companies where id = '5a000000-0000-0000-0000-0000000000b2') <> 'do_not_contact' then
    raise exception 'FAIL: a do-not-contact lead stays do-not-contact';
  end if;
  -- The sale that used the deal hold (30) and a lead hold (10): Undo puts both back as active holds.
  u := public.undo_sale(current_setting('t.sale_holds')::uuid);
  if (u ->> 'holds_restored')::int <> 2 or pg_temp.oh('SA P2') <> 65 or pg_temp.rv('SA P2') <> 65
     or (select count(*) from private.stock_reservations r2 where r2.product_id = pg_temp.pid('SA P2') and r2.status = 'active'
           and r2.deal_id = '5d000000-0000-0000-0000-0000000000b1' and r2.remaining = 30) <> 1 then
    raise exception 'FAIL: undo_sale_restores_consumed_hold: % (% / %)', u, pg_temp.oh('SA P2'), pg_temp.rv('SA P2');
  end if;
end $$;
do $$ begin perform pg_temp.integrity_clean('undo'); end $$;

-- 7. cancel_sale_after_window_needs_fresh_code, cancel_sale_does_not_recreate_holds, cancel_twice, return_once ----------
do $$
declare
  r jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  r := public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock', jsonb_build_array(pg_temp.l('SA P2', 30)),
                          p_deal => '5d000000-0000-0000-0000-0000000000b1');
  perform set_config('t.cancel_me', r ->> 'order_id', false);
end $$;
reset role;
set session_replication_role = replica;   -- the owner moves the sale out of the Undo window (no guard)
update private.orders set created_at = now() - interval '200 seconds' where id = current_setting('t.cancel_me')::uuid;
set session_replication_role = origin;
set role authenticated;
do $$
declare
  rv_before integer := pg_temp.rv('SA P2');
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  perform pg_temp.expect_error(format('select public.undo_sale(%L)', current_setting('t.cancel_me')), '22023', 'undo_window');
  perform pg_temp.expect_error(format('select public.cancel_sale(%L, %L)', current_setting('t.cancel_me'), 'wrong client'), '42501', 'forbidden');
  perform pg_temp.expect_error(format($q$update private.orders set status = 'cancelled', cancel_reason = 'undo' where id = %L$q$,
    current_setting('t.cancel_me')), '42501', 'forbidden');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 700);
  perform pg_temp.expect_error(format('select public.cancel_sale(%L, %L)', current_setting('t.cancel_me'), 'wrong client'), '42501', 'step_up');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  perform pg_temp.expect_error(format('select public.cancel_sale(%L, %L)', current_setting('t.cancel_me'), 'no'), '22023', 'cancel_reason');
  perform public.cancel_sale(current_setting('t.cancel_me')::uuid, 'Client changed the order');
  if pg_temp.oh('SA P2') <> 65 or pg_temp.rv('SA P2') <> rv_before then
    raise exception 'FAIL: cancel_sale_does_not_recreate_holds: % / % (held before %)', pg_temp.oh('SA P2'), pg_temp.rv('SA P2'), rv_before;
  end if;
  perform pg_temp.expect_error(format('select public.cancel_sale(%L, %L)', current_setting('t.cancel_me'), 'again please'), '22023', 'sale_state');
  -- return_once: a second return of the line, even by the person who just cancelled it, hits the unique index.
  perform pg_temp.expect_error(format($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, order_line_id)
    select gen_random_uuid(), ol.product_id, l.id, 'return', ol.quantity, ol.id from private.order_lines ol
      join public.locations l on l.kind = 'warehouse' and l.org_id = ol.org_id where ol.order_id = %L$q$,
    current_setting('t.cancel_me')), '23505');
  -- A sale is never edited.
  perform pg_temp.expect_error(format($q$update private.orders set cancel_reason = 'Another reason' where id = %L$q$,
    current_setting('t.cancel_me')), '22023', 'sale_state');
end $$;
reset role;
do $$
begin
  if not exists (select 1 from pg_indexes where indexname = 'movements_return_once_idx' and indexdef like '%UNIQUE%')
     or not exists (select 1 from pg_indexes where indexname = 'movements_ship_once_idx' and indexdef like '%UNIQUE%') then
    raise exception 'FAIL: return_once / ship_once indexes';
  end if;
end $$;
set role authenticated;
do $$ begin perform pg_temp.integrity_clean('cancel'); end $$;

-- 8. Automations: rep_sale_crossing_reorder_point_succeeds, system_task_restores_claims, low_stock_task_once_per_product,
--    system_task_title_constant (French for a French assignee), arrived_creates_task_per_moved_hold ------------------
do $$
declare
  t record;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  perform public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock', jsonb_build_array(pg_temp.l('SA P5', 15)));
  if (select auth.uid()) is distinct from '00000000-0000-0000-0000-0000000000b1'::uuid then
    raise exception 'FAIL: system_task_restores_claims';
  end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  select * into t from public.tasks where source_product_id = pg_temp.pid('SA P5');
  if not found or t.created_by is not null or t.assignee_id <> '00000000-0000-0000-0000-0000000000a1'
     or t.title <> 'Réapprovisionner : SA P5' or t.company_id is not null or t.done_at is not null then
    raise exception 'FAIL: rep_sale_crossing_reorder_point_succeeds: %', row_to_json(t);
  end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  perform public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock', jsonb_build_array(pg_temp.l('SA P5', 5)));
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  if (select count(*) from public.tasks where source_product_id = pg_temp.pid('SA P5')) <> 1 then
    raise exception 'FAIL: low_stock_task_once_per_product';
  end if;
  -- The task is not the client's to edit: its links never change.
  perform pg_temp.expect_error(format($q$update public.tasks set title = 'x' || title, source_product_id = null where id = %L$q$, t.id), '42501');
  -- Arrived: b1's transit hold on SA P3 moves to the warehouse and b1 gets a task on the lead.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  perform public.post_stock_movement(pg_temp.pid('SA P3'), 'reserve', 40, 'transit', p_company => '5a000000-0000-0000-0000-0000000000b1');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  perform public.post_stock_movement(pg_temp.pid('SA P3'), 'transfer', 200, 'transit');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  if (select count(*) from public.tasks where assignee_id = '00000000-0000-0000-0000-0000000000b1'
        and company_id = '5a000000-0000-0000-0000-0000000000b1' and title = 'Arrived: record the sale of SA P3'
        and created_by is null) <> 1 then
    raise exception 'FAIL: arrived_creates_task_per_moved_hold';
  end if;
end $$;

reset role;
do $$
begin
  if private.stock_task_title('restock', 'en', 'X') <> 'Restock: X'
     or private.stock_task_title('arrived', 'fr', 'X') <> 'Arrivé : enregistrer la vente de X'
     or private.stock_task_title('request', 'fr', 'ignored') <> 'Demande de stock (lien client)' then
    raise exception 'FAIL: system_task_title_constant';
  end if;
end $$;
set role authenticated;

-- 9. low_stock_not_from_import: a stock sheet that takes SA P6 under its reorder point opens no task -------------------
do $$
declare
  b uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  b := public.create_stock_import('sa-low.csv', repeat('ef', 32), 1, 2);
  perform public.stage_stock_import_rows(b, jsonb_build_array(jsonb_build_object(
    'row_no', '2', 'name', 'SA P6', 'location_kind', 'warehouse', 'quantity', '10', 'fixes', '[]'::jsonb)));
  perform public.validate_stock_import(b, 'use_sheet');
  perform public.commit_stock_import(b);
  if pg_temp.oh('SA P6') <> 10 or exists (select 1 from public.tasks where source_product_id = pg_temp.pid('SA P6')) then
    raise exception 'FAIL: low_stock_not_from_import (on hand %)', pg_temp.oh('SA P6');
  end if;
end $$;

-- 10. Team requests: team_request_validation, pieces and availability from the server, status moves, the audit keeps
--     no note; extend_reservation rules ---------------------------------------------------------------------------------
do $$
declare
  r jsonb;
  q jsonb;
  hold uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  r := public.log_stock_request('5a000000-0000-0000-0000-0000000000b1',
         jsonb_build_array(jsonb_build_object('product_id', pg_temp.pid('SA P1'), 'quantity', '2', 'unit', 'carton'),
                           jsonb_build_object('description', 'Blue umbrellas', 'quantity', '300', 'unit', 'piece')),
         'Secret client note');
  q := public.get_stock_request((r ->> 'request_id')::uuid);
  if q ->> 'source' <> 'team' or q ->> 'status' <> 'new' or (q -> 'lines' -> 0 ->> 'pieces')::int <> 20
     or q -> 'lines' -> 0 ->> 'availability_then' <> 'in_warehouse' or (q -> 'lines' -> 0 ->> 'price_shown')::numeric <> 3
     or q -> 'lines' -> 1 ->> 'availability_then' <> 'not_listed' or (q -> 'lines' -> 1 ->> 'pieces')::int <> 300 then
    raise exception 'FAIL: team request lines: %', q;
  end if;
  perform pg_temp.expect_error($q$select public.log_stock_request('5a000000-0000-0000-0000-0000000000b1',
    '[{"description": "x", "quantity": "1", "unit": "carton"}]')$q$, '22023', 'quantity');
  perform pg_temp.expect_error(format('select public.log_stock_request(%L, %L)', '5a000000-0000-0000-0000-0000000000b1',
    (select jsonb_agg(jsonb_build_object('description', 'i' || g, 'quantity', '1', 'unit', 'piece')) from generate_series(1, 21) g)),
    '22023', 'lines');
  perform pg_temp.expect_error($q$select public.log_stock_request('5a000000-0000-0000-0000-0000000000b1',
    '[{"description": "x", "quantity": "1", "unit": "piece", "price": "1"}]')$q$, '22023', 'lines');
  perform pg_temp.expect_error($q$select public.log_stock_request('5a000000-0000-0000-0000-0000000000d1',
    '[{"description": "x", "quantity": "1", "unit": "piece"}]')$q$, '42501');
  perform public.set_stock_request_status((r ->> 'request_id')::uuid, 'in_progress', 'Asked the supplier');
  if (select handled_by from private.stock_requests where id = (r ->> 'request_id')::uuid) <> '00000000-0000-0000-0000-0000000000b1' then
    raise exception 'FAIL: handled_by is not set';
  end if;
  perform pg_temp.expect_error(format($q$update private.stock_requests set note = 'changed' where id = %L$q$, r ->> 'request_id'), '42501');
  -- A sale answering the request marks it done.
  perform public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock', jsonb_build_array(pg_temp.l('SA P1', 20)),
                             p_stock_request => (r ->> 'request_id')::uuid);
  if (select status from private.stock_requests where id = (r ->> 'request_id')::uuid) <> 'done' then
    raise exception 'FAIL: the answered request is not done';
  end if;
  -- extend_reservation: the creator, within 90 days; someone else's hold on another lead is not found.
  select r2.id into hold from private.stock_reservations r2
   where r2.company_id = '5a000000-0000-0000-0000-0000000000b1' and r2.status = 'active' order by r2.created_at limit 1;
  perform public.extend_reservation(hold, ((now() at time zone 'Europe/Paris')::date + 30));
  perform pg_temp.expect_error(format('select public.extend_reservation(%L, %L)', hold, ((now() at time zone 'Europe/Paris')::date + 91)),
    '22023', 'hold_until');
  perform pg_temp.expect_error(format($q$update private.stock_reservations set remaining = 1 where id = %L$q$, hold), '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2', 30);
  perform pg_temp.expect_error(format('select public.extend_reservation(%L, %L)', hold, ((now() at time zone 'Europe/Paris')::date + 3)),
    'P0002');
end $$;
reset role;
do $$
begin
  if exists (select 1 from public.audit_log where table_name = 'stock_requests'
               and (diff_json::text like '%Secret client note%' or diff_json::text like '%"note"%')) then
    raise exception 'FAIL: stock_request_note_masked_in_audit';
  end if;
  if not exists (select 1 from public.audit_log where table_name = 'orders' and action = 'update') then
    raise exception 'FAIL: a cancelled sale is audited';
  end if;
end $$;
set role authenticated;

-- 11. Reads: get_lead_stock, list_sales, list_stock_requests, stock_alerts, list_lead_deals_for_stock -------------------
do $$
declare
  v jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  v := public.get_lead_stock('5a000000-0000-0000-0000-0000000000b1');
  if not (v ->> 'can_edit')::boolean or jsonb_array_length(v -> 'holds') < 1 or jsonb_array_length(v -> 'requests') <> 1
     or (v ->> 'sales_count')::int < 5 or (v ->> 'bought_total')::numeric <= 0 then
    raise exception 'FAIL: get_lead_stock: %', v;
  end if;
  if (select count(*) from public.list_sales(p_company => '5a000000-0000-0000-0000-0000000000b1', p_limit => 2)) <> 2
     or (select count(*) from public.list_sales(p_fulfilment => 'direct_from_source')) <> 1 then
    raise exception 'FAIL: list_sales filters';
  end if;
  perform pg_temp.expect_error('select * from public.list_sales(p_limit => 101)', '22023', 'bounds');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2', 30);
  v := public.get_lead_stock('5a000000-0000-0000-0000-0000000000b1');
  if (v ->> 'can_edit')::boolean or jsonb_array_length(v -> 'requests') <> 0 or jsonb_array_length(v -> 'sales') <> 0 then
    raise exception 'FAIL: another rep sees this lead''s requests or sales: %', v;
  end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  v := public.stock_alerts();
  if (v ->> 'low')::int < 1 or jsonb_array_length(v -> 'sample') < 1 or v ? 'requests_new' is false then
    raise exception 'FAIL: stock_alerts_counts: %', v;
  end if;
  v := public.list_lead_deals_for_stock('5a000000-0000-0000-0000-0000000000b1');
  if jsonb_array_length(v) <> 2 then
    raise exception 'FAIL: open deals of the lead: %', v;
  end if;
  if (select count(*) from public.list_stock_requests(array['done'])) < 1 then
    raise exception 'FAIL: list_stock_requests';
  end if;
end $$;

-- 11b. lead_delete_with_request_task: a lead with a request and a task that points at the request (the client link's
--      task, 6e) can still be deleted by an admin with a fresh code (the cascade clears or removes the task).
reset role;
insert into public.companies (id, org_id, name, owner_id)
select '5a000000-0000-0000-0000-0000000000f9', org_id, 'SA Gone', '00000000-0000-0000-0000-0000000000b1'
  from public.profiles where id = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$
declare
  r jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  r := public.log_stock_request('5a000000-0000-0000-0000-0000000000f9', '[{"description": "x", "quantity": "1", "unit": "piece"}]');
  perform set_config('t.gone_request', r ->> 'request_id', false);
end $$;
reset role;
insert into public.tasks (org_id, assignee_id, title, kind, company_id, source_request_id)
select org_id, '00000000-0000-0000-0000-0000000000b1', 'Stock request (client link)', 'todo',
       '5a000000-0000-0000-0000-0000000000f9', current_setting('t.gone_request')::uuid
  from public.profiles where id = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  delete from public.companies where id = '5a000000-0000-0000-0000-0000000000f9';
  if exists (select 1 from public.companies where id = '5a000000-0000-0000-0000-0000000000f9')
     or exists (select 1 from private.stock_requests where id = current_setting('t.gone_request')::uuid) then
    raise exception 'FAIL: lead_delete_with_request_task';
  end if;
end $$;

-- 12. lead_delete_blocked_by_stock_history, lead_import_untouched_counts_stock (catalog), ledger_sums_match_levels -----
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform pg_temp.expect_error($q$delete from public.companies where id = '5a000000-0000-0000-0000-0000000000b3'$q$, '23503');
end $$;
reset role;
do $$
begin
  if pg_get_functiondef('private.lead_import_untouched(uuid, integer)'::regprocedure) not like '%private.orders%'
     or pg_get_functiondef('private.lead_import_untouched(uuid, integer)'::regprocedure) not like '%private.stock_requests%' then
    raise exception 'FAIL: lead_import_untouched_counts_stock';
  end if;
  if exists (select 1 from (select l.product_id, l.location_id, l.on_hand, l.reserved,
                                   coalesce(sum(m.d_on_hand), 0) as s_on, coalesce(sum(m.d_reserved), 0) as s_res
                              from public.stock_levels l
                              left join private.stock_movements m on m.product_id = l.product_id and m.location_id = l.location_id
                             group by l.product_id, l.location_id, l.on_hand, l.reserved) x
              where x.on_hand <> x.s_on or x.reserved <> x.s_res) then
    raise exception 'FAIL: ledger_sums_match_levels';
  end if;
end $$;
\echo 'sales_attack: all checks passed'
