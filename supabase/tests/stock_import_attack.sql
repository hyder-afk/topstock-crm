-- Day 6c attack and behaviour tests: the stock sheet import (design docs/evidence/day6/design.md sections 3.3, 7 and
-- 11.1; migration 20261018090000_stock_import.sql). Runs after inventory_attack.sql on the same database
-- (scripts/db-test.sh, CI job "db"), reusing its users: admins a and b, manager a1, rep b1, other-org admin c1. Its own
-- products are named "SI …". Any failure raises an exception and stops the run. Checks compare with IS DISTINCT FROM.
-- The file ends with ledger_sums_match_levels. import_attack.sql runs before it, unchanged (lead_import_tests_unchanged).
\set ON_ERROR_STOP 1
\set QUIET 1

-- The app's day. The guards compare dates with the Paris day ((now() at time zone 'Europe/Paris')::date), so every date
-- this file checks against them is built from it too, never from current_date (the session's time zone: UTC on the
-- runners, a day behind Paris from 22:00 or 23:00 UTC). The suite then passes under any PGTZ, at any hour.
create function pg_temp.paris_today() returns date language sql stable as $$
  select (now() at time zone 'Europe/Paris')::date
$$;

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
create function pg_temp.integrity_clean(what text, admin_sub text default '00000000-0000-0000-0000-00000000000a')
returns void language plpgsql as $$
declare
  saved constant text := current_setting('request.jwt.claims', true);
  r record;
begin
  perform pg_temp.as_user(admin_sub, 'aal2', 30);
  for r in select * from public.check_stock_integrity() loop
    raise exception 'FAIL: % left a difference: %', what, row_to_json(r);
  end loop;
  perform set_config('request.jwt.claims', coalesce(saved, ''), false);
end;
$$;
-- Levels of a product by name: 'wh/tr' on hand, and held after a slash: "100/0 50/0".
create function pg_temp.lv(pname text) returns text language sql as $$
  select coalesce((select l.on_hand || '/' || l.reserved from public.stock_levels l join public.locations x on x.id = l.location_id
                    join public.products p on p.id = l.product_id where p.name = pname and x.kind = 'warehouse'), '0/0')
         || ' ' ||
         coalesce((select l.on_hand || '/' || l.reserved from public.stock_levels l join public.locations x on x.id = l.location_id
                    join public.products p on p.id = l.product_id where p.name = pname and x.kind = 'transit'), '0/0')
$$;
-- A whole stock import as admin a (fresh code): create, stage the rows, check. Returns the batch id.
create function pg_temp.import(rows jsonb, policy text default 'keep_crm') returns uuid language plpgsql as $$
declare
  batch uuid;
begin
  batch := public.create_stock_import('stock-' || gen_random_uuid() || '.csv', repeat('ab', 32),
                                      jsonb_array_length(rows), (select max((r ->> 'row_no')::int) from jsonb_array_elements(rows) r));
  perform public.stage_stock_import_rows(batch, rows);
  perform public.validate_stock_import(batch, policy);
  return batch;
end;
$$;
create function pg_temp.commit_all(batch uuid, chunk integer default 250) returns jsonb language plpgsql as $$
declare
  r jsonb;
begin
  for i in 1..50 loop
    r := public.commit_stock_import(batch, chunk);
    exit when r ->> 'status' = 'imported';
  end loop;
  return r;
end;
$$;
create function pg_temp.rollback_all(batch uuid, chunk integer default 250) returns jsonb language plpgsql as $$
declare
  r jsonb;
begin
  for i in 1..50 loop
    r := public.rollback_stock_import(batch, chunk);
    exit when r ->> 'status' = 'rolled_back';
  end loop;
  return r;
end;
$$;
-- One staged row.
create function pg_temp.r(row_no int, name text, place text, qty text, ppc text default null, pmin text default null,
                          pmax text default null, cost text default null, problems text[] default '{}',
                          fixes text[] default '{}') returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('row_no', row_no::text, 'name', name, 'location_kind', place, 'quantity', qty,
           'pieces_per_carton', ppc, 'price_min', pmin, 'price_max', pmax, 'total_cost', cost))
         || jsonb_build_object('problems', to_jsonb(problems), 'fixes', to_jsonb(fixes))
$$;
create function pg_temp.outcomes(batch uuid) returns text language sql as $$
  select string_agg(s.row_no || ':' || s.outcome || coalesce(':' || s.reason, ''), ' ' order by s.row_no)
    from private.stock_import_staging s where s.batch_id = batch
$$;

-- 1. Catalog ------------------------------------------------------------------------------------------------------------
do $$
declare
  f record;
  n integer := 0;
begin
  for f in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname in ('create_stock_import', 'stage_stock_import_rows',
              'validate_stock_import', 'list_stock_import_issues', 'list_stock_import_changes', 'commit_stock_import',
              'preview_stock_import_rollback', 'rollback_stock_import', 'discard_stock_import', 'list_stock_imports') loop
    n := n + 1;
    if f.prosecdef or f.proconfig is null or not ('search_path=""' = any (f.proconfig)) then
      raise exception 'FAIL: % must be invoker with search_path = ''''', f.proname;
    end if;
    if has_function_privilege('anon', f.oid, 'execute') or not has_function_privilege('authenticated', f.oid, 'execute') then
      raise exception 'FAIL: % privileges', f.proname;
    end if;
    if pg_get_functiondef(f.oid) ~* '(\mformat\s*\(|\mexecute\M)' then
      raise exception 'FAIL: % builds SQL at run time', f.proname;
    end if;
  end loop;
  if n <> 10 then
    raise exception 'FAIL: expected 10 stock import RPCs, found %', n;
  end if;
  -- The lock helper is the only definer; it has no REST endpoint and anon cannot run it.
  if not (select p.prosecdef from pg_proc p where p.proname = 'lock_stock_import')
     or has_function_privilege('anon', 'private.lock_stock_import(uuid, uuid[])', 'execute') then
    raise exception 'FAIL: lock_stock_import';
  end if;
  if has_table_privilege('anon', 'private.stock_import_staging', 'select')
     or has_table_privilege('anon', 'private.stock_import_changes', 'select')
     or has_table_privilege('authenticated', 'private.stock_import_changes', 'delete')
     or has_table_privilege('authenticated', 'private.stock_import_staging', 'truncate') then
    raise exception 'FAIL: stock import tables privileges';
  end if;
  -- D11: one writer per organisation and kind.
  if (select pg_get_indexdef(i.indexrelid) from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname = 'import_batches_one_writer_idx') !~ '\(org_id, kind\)' then
    raise exception 'FAIL: the one-writer index is not per (org_id, kind)';
  end if;
end $$;

set role authenticated;

-- 2. Who may start, stage and check (role matrix) ------------------------------------------------------------------------
do $$
declare
  batch uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal1');
  perform pg_temp.expect_error($q$select public.create_stock_import('a.csv', repeat('ab', 32), 1, 2)$q$, '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 700);
  perform pg_temp.expect_error($q$select public.create_stock_import('a.csv', repeat('ab', 32), 1, 2)$q$, '42501', 'step_up');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  perform pg_temp.expect_error($q$select public.create_stock_import('a.csv', repeat('ab', 32), 1, 2)$q$, '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  perform pg_temp.expect_error($q$select public.create_stock_import('a.csv', repeat('ab', 32), 1, 2)$q$, '42501');
  -- A direct insert of a stock batch as a manager or a rep: refused by the guard.
  perform pg_temp.expect_error($q$insert into public.import_batches (kind, filename, row_count, last_row_no)
                                 values ('stock', 'x.csv', 1, 2)$q$, '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform pg_temp.expect_error($q$select public.create_stock_import('a.csv', repeat('ab', 32), 5001, 5002)$q$, '22023', 'row_count');
  perform pg_temp.expect_error($q$select public.create_stock_import('a.csv', 'nothex', 1, 2)$q$, '22023');
  -- Server fields: uploaded_by, status and counters come from the guard and defaults.
  insert into public.import_batches (kind, filename, row_count, last_row_no) values ('stock', 'direct.csv', 2, 3)
  returning id into batch;
  if (select row(b.uploaded_by, b.status, b.imported) from public.import_batches b where b.id = batch)
     is distinct from row('00000000-0000-0000-0000-00000000000a'::uuid, 'staged'::text, 0) then
    raise exception 'FAIL: stock_batch_insert_server_fields';
  end if;
  -- A direct PATCH of a stock batch (no RPC marker): bad_transition.
  perform pg_temp.expect_error(format($q$update public.import_batches set status = 'discarded' where id = %L$q$, batch),
                               '22023', 'bad_transition');
  perform public.discard_stock_import(batch);
  -- stock_open_batches_cap_per_kind: 3 open stock imports at most; a lead import is still allowed beside them.
  perform public.create_stock_import('o1.csv', repeat('ab', 32), 1, 2);
  perform public.create_stock_import('o2.csv', repeat('ab', 32), 1, 2);
  perform public.create_stock_import('o3.csv', repeat('ab', 32), 1, 2);
  perform pg_temp.expect_error($q$select public.create_stock_import('o4.csv', repeat('ab', 32), 1, 2)$q$, '22023', 'too_many_open');
  for batch in select b.id from public.import_batches b where b.kind = 'stock' and b.status = 'staged' loop
    perform public.discard_stock_import(batch);
  end loop;
end $$;

-- 3. Staging: shape, constant errors, idempotent, the uploader only -------------------------------------------------------
do $$
declare
  batch uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  batch := public.create_stock_import('stage.csv', repeat('ab', 32), 2, 3);
  perform pg_temp.expect_error(format($q$select public.stage_stock_import_rows(%L, '[{"row_no":"2","name":"SI x","quantity":"1,5"}]')$q$, batch), '22023', null, '1,5');
  perform pg_temp.expect_error(format($q$select public.stage_stock_import_rows(%L, '[{"row_no":"2","name":"SI x","price_max":"2.12345"}]')$q$, batch), '22023');
  perform pg_temp.expect_error(format($q$select public.stage_stock_import_rows(%L, '[{"row_no":"2","name":"SI x","price_max":"123456789"}]')$q$, batch), '22023');
  perform pg_temp.expect_error(format($q$select public.stage_stock_import_rows(%L, '[{"row_no":"2","name":"SI x","cost":"1"}]')$q$, batch), '22023');
  perform pg_temp.expect_error(format($q$select public.stage_stock_import_rows(%L, '[{"row_no":"2","name":"SI x","location_kind":"attic"}]')$q$, batch), '22023');
  perform pg_temp.expect_error(format($q$select public.stage_stock_import_rows(%L, '[{"row_no":"2","name":"SI x","problems":["drop table"]}]')$q$, batch), '22023', null, 'drop table');
  perform pg_temp.expect_error(format($q$select public.stage_stock_import_rows(%L, '[{"row_no":"4","name":"SI x"}]')$q$, batch), '22023');
  perform pg_temp.expect_error(format($q$select public.stage_stock_import_rows(%L, '[{"row_no":"2","name":"%s"}]')$q$, batch, repeat('x', 501)), '22023');
  -- Another admin (b) may not add rows to a's import; a manager may not either.
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000b', 'aal2', 30);
  perform pg_temp.expect_error(format($q$select public.stage_stock_import_rows(%L, '[{"row_no":"2","name":"SI x","location_kind":"warehouse","quantity":"1"}]')$q$, batch), '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  perform pg_temp.expect_error(format($q$select public.stage_stock_import_rows(%L, '[{"row_no":"2","name":"SI x","location_kind":"warehouse","quantity":"1"}]')$q$, batch), '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  if public.stage_stock_import_rows(batch, jsonb_build_array(pg_temp.r(2, 'SI Stage one', 'warehouse', '10', '5'),
                                                             pg_temp.r(3, 'SI Stage two', 'warehouse', '10', '5'))) <> 2
     or public.stage_stock_import_rows(batch, jsonb_build_array(pg_temp.r(2, 'SI Stage one', 'warehouse', '10', '5'))) <> 0 then
    raise exception 'FAIL: re-stage is not idempotent';
  end if;
  -- Staged rows are not readable by a manager (they hold costs).
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  if (select count(*) from private.stock_import_staging) <> 0 then
    raise exception 'FAIL: a manager reads staged stock rows';
  end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform public.validate_stock_import(batch);
  perform pg_temp.expect_error(format($q$select public.stage_stock_import_rows(%L, '[{"row_no":"2","name":"SI x"}]')$q$, batch), '22023', 'not_staged');
  -- Discard purges the working rows.
  perform public.discard_stock_import(batch);
  if exists (select 1 from private.stock_import_staging s where s.batch_id = batch) then
    raise exception 'FAIL: discard left staged rows';
  end if;
end $$;

-- 4. The check: every rule on a crafted sheet ------------------------------------------------------------------------------
-- Before: "SI Moved" (sold in the CRM), "SI Held" (100 in the warehouse, 80 held), "SI Archived" (archived, empty),
-- "SI Arrive" (500 in transit, 100 of them held), "SI Untouched" (300 in the warehouse, not in the sheet).
do $$
declare
  p uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  perform public.create_product(p_name => 'SI Moved', p_pieces_per_carton => 10, p_price_min => 1, p_price_max => 2,
                                p_opening_qty => 100);
  p := (select id from public.products where name = 'SI Moved');
  perform public.post_stock_movement(p, 'adjust_out', 30, p_reason => 'damaged');
  perform public.create_product(p_name => 'SI Held', p_pieces_per_carton => 10, p_opening_qty => 100);
  perform public.post_stock_movement((select id from public.products where name = 'SI Held'), 'reserve', 80,
                                     p_company => '33000000-0000-0000-0000-0000000000a1');
  perform public.create_product(p_name => 'SI Archived', p_pieces_per_carton => 6, p_price_min => 3, p_price_max => 4);
  perform public.archive_product((select id from public.products where name = 'SI Archived'));
  perform public.create_product(p_name => 'SI Arrive', p_pieces_per_carton => 50, p_opening_qty => 500,
                                p_opening_location => 'transit', p_transit_eta => pg_temp.paris_today() + 10);
  perform public.post_stock_movement((select id from public.products where name = 'SI Arrive'), 'reserve', 100, 'transit',
                                     p_company => '33000000-0000-0000-0000-0000000000a1');
  perform public.create_product(p_name => 'SI Untouched', p_pieces_per_carton => 12, p_opening_qty => 300);
end $$;

-- The import functions "CRM moved" means: the levels as the CRM left them. A sheet never set them, so every product made
-- in the app counts as moved (crm_moved true) until a sheet sets it: "SI Arrive" and "SI Held" are imported with the
-- "use the sheet" policy; the default policy is checked on "SI Moved".
do $$
declare
  batch uuid;
  v jsonb;
  t jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  batch := pg_temp.import(jsonb_build_array(
    pg_temp.r(2, 'SI Both', 'warehouse', '480', '48', '2.1', '2.5', '600'),        -- same name two places: one product
    pg_temp.r(3, 'si  both', 'transit', '960', '48', '2.2', '2.6', '1300'),        -- prices differ (warehouse wins)
    pg_temp.r(4, 'SI BOTH', 'warehouse', '1', '48'),                               -- repeated (same name and place)
    pg_temp.r(5, 'SI Conflict', 'warehouse', '10', '12'),
    pg_temp.r(6, 'SI Conflict', 'transit', '10', '24'),                            -- carton conflict: whole group
    pg_temp.r(7, 'SI No carton', 'warehouse', '10'),                               -- new without carton
    pg_temp.r(8, 'SI Sold out', 'warehouse', '0', '20', '1', '1.5'),               -- sold out is fine
    pg_temp.r(9, 'SI Archived', 'warehouse', '12', null, '3.5', '4.5'),            -- restored, carton kept
    pg_temp.r(10, 'SI Bad', 'warehouse', '5', '1', null, null, null, array['price_order']),
    pg_temp.r(11, 'SI Moved', 'warehouse', '200', '10', '1.2', '2.2'),             -- moved in the CRM: kept
    pg_temp.r(12, 'SI Order', 'warehouse', '1', '1', '9', '8'),                    -- db_price (min above max)
    pg_temp.r(13, 'SI Sold later', 'warehouse', '50', '5')                         -- sold in the CRM after the import
  ));
  if pg_temp.outcomes(batch) is distinct from
     '2:new 3:new 4:repeated 5:rejected:carton_conflict 6:rejected:carton_conflict 7:rejected:carton_required 8:new 9:update 10:rejected 11:moved:moved_in_crm 12:rejected:db_price 13:new' then
    raise exception 'FAIL: stock_import_fixture_outcomes: %', pg_temp.outcomes(batch);
  end if;
  if (select s.match_row_no from private.stock_import_staging s where s.batch_id = batch and s.row_no = 4) <> 2 then
    raise exception 'FAIL: repeated_row_rejected: match_row_no';
  end if;
  if not (select 'prices_differ' = any (s.db_warnings) from private.stock_import_staging s where s.batch_id = batch and s.row_no = 2)
     or not (select array['carton_kept', 'restored'] <@ s.db_warnings from private.stock_import_staging s where s.batch_id = batch and s.row_no = 9) then
    raise exception 'FAIL: db warnings';
  end if;
  -- same_name_two_places_one_product, absent status = 0, cost weighted: (600 + 1300) / (480 + 960).
  if (select row(s.group_first, s.sheet_wh, s.sheet_tr, s.final_min, s.final_max, s.final_cost)
        from private.stock_import_staging s where s.batch_id = batch and s.row_no = 2)
     is distinct from row(true, 480, 960, 2.1::numeric, 2.5::numeric, round(1900.0 / 1440, 6)) then
    raise exception 'FAIL: cost_weighted or grouping: %', (select row(s.group_first, s.sheet_wh, s.sheet_tr, s.final_min, s.final_max, s.final_cost)
        from private.stock_import_staging s where s.batch_id = batch and s.row_no = 2);
  end if;
  t := (select b.issue_counts from public.import_batches b where b.id = batch);
  if (t ->> 'rejected')::int <> 5 or (t ->> 'repeated')::int <> 1 or (t ->> 'products_new')::int <> 3
     or (t ->> 'products_moved')::int <> 1 or (t ->> 'price_order')::int <> 1 or (t ->> 'carton_conflict')::int <> 2 then
    raise exception 'FAIL: tally %', t;
  end if;
  -- The check wrote nothing to products or stock.
  if exists (select 1 from public.products where name in ('SI Both', 'SI Sold out')) then
    raise exception 'FAIL: the check created products';
  end if;
  -- The issues list carries codes only.
  if (select count(*) from public.list_stock_import_issues(batch)) < 8 then
    raise exception 'FAIL: list_stock_import_issues';
  end if;
  perform set_config('t.batch1', batch::text, false);
end $$;

-- 5. The commit: new products, restored, kept, transfers, cost, tags ---------------------------------------------------
do $$
declare
  batch constant uuid := current_setting('t.batch1')::uuid;
  r jsonb;
  p uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  -- Another admin cannot import a's batch; a stale code cannot either.
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 700);
  perform pg_temp.expect_error(format('select public.commit_stock_import(%L)', batch), '42501', 'step_up');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  r := pg_temp.commit_all(batch, 1);    -- one product per call: the chunks, resumable
  if r ->> 'status' <> 'imported' then
    raise exception 'FAIL: commit did not finish: %', r;
  end if;
  if (select b.status || '/' || b.imported from public.import_batches b where b.id = batch) <> 'imported/5' then
    raise exception 'FAIL: batch after commit: %', (select b.status || '/' || b.imported from public.import_batches b where b.id = batch);
  end if;
  if exists (select 1 from private.stock_import_staging s where s.batch_id = batch) then
    raise exception 'FAIL: the import left staged rows';
  end if;
  -- New products, tagged with the batch, with their sheet values and cost per piece (PP ÷ QUANTITÉ).
  if pg_temp.lv('SI Both') <> '480/0 960/0' or pg_temp.lv('SI Sold out') <> '0/0 0/0'
     or (select row(p.pieces_per_carton, p.price_min, p.price_max, p.import_batch_id) from public.products p where p.name = 'SI Both')
        is distinct from row(48, 2.1::numeric, 2.5::numeric, batch)
     or (select c.cost_per_piece from private.product_costs c join public.products p on p.id = c.product_id where p.name = 'SI Both')
        is distinct from round(1900.0 / 1440, 6) then
    raise exception 'FAIL: new products after commit';
  end if;
  -- archived_product_restored with its carton kept and prices updated.
  if (select row(p.archived_at is null, p.pieces_per_carton, p.price_min, p.price_max) from public.products p where p.name = 'SI Archived')
     is distinct from row(true, 6, 3.5::numeric, 4.5::numeric) or pg_temp.lv('SI Archived') <> '12/0 0/0' then
    raise exception 'FAIL: archived_product_restored';
  end if;
  -- moved_in_crm_kept: quantities as the CRM has them (70), prices updated.
  if pg_temp.lv('SI Moved') <> '70/0 0/0'
     or (select row(p.price_min, p.price_max) from public.products p where p.name = 'SI Moved') is distinct from row(1.2::numeric, 2.2::numeric) then
    raise exception 'FAIL: stock_import_moved_in_crm_kept: %', pg_temp.lv('SI Moved');
  end if;
  -- not_in_sheet_untouched; rejected and conflicting products not created.
  if pg_temp.lv('SI Untouched') <> '300/0 0/0' or exists (select 1 from public.products where name in ('SI Conflict', 'SI No carton', 'SI Bad', 'SI Order')) then
    raise exception 'FAIL: not_in_sheet_untouched or rejected rows imported';
  end if;
  -- Import rows: tagged, with expected on hand, reason import; the levels now "as the sheet says".
  if exists (select 1 from private.stock_movements m where m.import_batch_id = batch
              and (m.kind not in ('import_in', 'import_out', 'transfer_out', 'transfer_in') or m.reason not in ('import', 'arrived')))
     or (select bool_or(l.crm_moved) from public.stock_levels l join public.products p on p.id = l.product_id where p.name = 'SI Both')
     or (select l.last_onhand_batch_id from public.stock_levels l join public.products p on p.id = l.product_id
          join public.locations x on x.id = l.location_id where p.name = 'SI Both' and x.kind = 'warehouse') is distinct from batch then
    raise exception 'FAIL: import rows or level flags';
  end if;
  -- stock_import_audit_minimal: one minimal audit row per import ledger row, no note.
  if (select count(*) from public.audit_log a where a.table_name = 'stock_movements' and a.diff_json -> 'refs' ->> 'import_batch_id' = batch::text)
     <> (select count(*) from private.stock_movements m where m.import_batch_id = batch) then
    raise exception 'FAIL: stock_import_audit_minimal';
  end if;
  -- The change table after the import reads the changes ledger.
  if (select count(*) from public.list_stock_import_changes(batch)) <> 5 then
    raise exception 'FAIL: list_stock_import_changes after import';
  end if;
  -- reimport_same_file_changes_nothing: the same products now say unchanged.
  r := null;
  p := pg_temp.import(jsonb_build_array(pg_temp.r(2, 'SI Both', 'warehouse', '480', '48', '2.1', '2.5', '600'),
                                        pg_temp.r(3, 'SI Both', 'transit', '960', '48', '2.1', '2.5', '1300')));
  if pg_temp.outcomes(p) <> '2:unchanged 3:unchanged' then
    raise exception 'FAIL: reimport_same_file_changes_nothing: %', pg_temp.outcomes(p);
  end if;
  perform public.discard_stock_import(p);
end $$;

-- 6. Transit to warehouse is a transfer (holds move), below_reserved skipped, use_sheet applied --------------------------
do $$
declare
  batch uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  batch := pg_temp.import(jsonb_build_array(
    pg_temp.r(2, 'SI Arrive', 'warehouse', '500', '50'),       -- all 500 arrived: a transfer, the hold moves
    pg_temp.r(3, 'SI Held', 'warehouse', '50', '10'),          -- 80 are held: quantities skipped
    pg_temp.r(4, 'SI Moved', 'warehouse', '200', '10')         -- use the sheet: applied
  ), 'use_sheet');
  if pg_temp.outcomes(batch) <> '2:update 3:update:below_reserved 4:update' then
    raise exception 'FAIL: use_sheet check: %', pg_temp.outcomes(batch);
  end if;
  perform pg_temp.commit_all(batch);
  if pg_temp.lv('SI Arrive') <> '500/100 0/0'
     or not exists (select 1 from private.stock_movements m join public.products p on p.id = m.product_id
                     where p.name = 'SI Arrive' and m.import_batch_id = batch and m.kind = 'transfer_in' and m.qty = 500)
     or exists (select 1 from private.stock_movements m join public.products p on p.id = m.product_id
                 where p.name = 'SI Arrive' and m.import_batch_id = batch and m.kind like 'import%')
     or (select p.transit_eta from public.products p where p.name = 'SI Arrive') is not null then
    raise exception 'FAIL: transit_to_warehouse_is_transfer: %', pg_temp.lv('SI Arrive');
  end if;
  if (select r.location_id from private.stock_reservations r join public.products p on p.id = r.product_id
       where p.name = 'SI Arrive' and r.status = 'active') <> (select id from public.locations where kind = 'warehouse'
       and org_id = (select org_id from public.products where name = 'SI Arrive')) then
    raise exception 'FAIL: the hold did not move with the arrival';
  end if;
  if pg_temp.lv('SI Held') <> '100/80 0/0' then
    raise exception 'FAIL: below_reserved_skipped: %', pg_temp.lv('SI Held');
  end if;
  if pg_temp.lv('SI Moved') <> '200/0 0/0' then
    raise exception 'FAIL: moved_in_crm_applied_with_use_sheet: %', pg_temp.lv('SI Moved');
  end if;
  perform set_config('t.batch2', batch::text, false);
end $$;

-- 7. Undo: reverses untouched products, keeps moved and held ones, archives new products, restores prices unless edited --
do $$
declare
  b1 constant uuid := current_setting('t.batch1')::uuid;
  pv jsonb;
  r jsonb;
begin
  -- Since import 1: "SI Moved" was set again by import 2 (later_import); "SI Sold out" edited by a manager; "SI Both"
  -- untouched; "SI Archived" got a hold (held).
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  perform public.update_product((select id from public.products where name = 'SI Sold out'), 'SI Sold out', 20,
                                p_price_min => 1, p_price_max => 1.9);
  perform public.post_stock_movement((select id from public.products where name = 'SI Archived'), 'reserve', 2,
                                     p_company => '33000000-0000-0000-0000-0000000000a1');
  perform public.post_stock_movement((select id from public.products where name = 'SI Sold later'), 'adjust_out', 5,
                                     p_reason => 'sample');
  -- A manager cannot undo; an admin with a stale code cannot.
  perform pg_temp.expect_error(format('select public.rollback_stock_import(%L)', b1), '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 700);
  perform pg_temp.expect_error(format('select public.rollback_stock_import(%L)', b1), '42501', 'step_up');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  pv := public.preview_stock_import_rollback(b1);
  if (pv ->> 'products')::int <> 5 or (pv ->> 'qty_reverse')::int <> 1 or (pv ->> 'qty_kept')::int <> 2
     or (pv ->> 'archive')::int <> 1 or (pv ->> 'archive_kept')::int <> 3 or (pv ->> 'fields_kept')::int <> 0 then
    raise exception 'FAIL: preview_stock_import_rollback: %', pv;
  end if;
  r := pg_temp.rollback_all(b1, 1);
  if r ->> 'status' <> 'rolled_back' then
    raise exception 'FAIL: rollback did not finish: %', r;
  end if;
  -- rollback_reverses_untouched_products and rollback_archives_untouched_new_products: SI Both back to nothing, archived.
  if pg_temp.lv('SI Both') <> '0/0 0/0' or (select p.archived_at is null from public.products p where p.name = 'SI Both') then
    raise exception 'FAIL: rollback_archives_untouched_new_products: %', pg_temp.lv('SI Both');
  end if;
  -- rollback_keeps_moved_products (sold since: SI Sold later) and rollback_keeps_held_products (SI Archived); SI Moved
  -- (import 1 kept its quantities) keeps import 2's.
  if pg_temp.lv('SI Moved') <> '200/0 0/0' or pg_temp.lv('SI Archived') <> '12/2 0/0' or pg_temp.lv('SI Sold later') <> '45/0 0/0'
     or (select p.archived_at is not null from public.products p where p.name = 'SI Archived') then
    raise exception 'FAIL: rollback kept: % %', pg_temp.lv('SI Moved'), pg_temp.lv('SI Archived');
  end if;
  -- rollback_restores_prices_unless_edited: SI Moved's prices are as import 2 left them (import 2 did not change them),
  -- so import 1's old prices come back; SI Sold out was edited: kept, not archived.
  if (select row(p.price_min, p.price_max) from public.products p where p.name = 'SI Moved') is distinct from row(1::numeric, 2::numeric)
     or (select p.archived_at is not null from public.products p where p.name = 'SI Sold out') then
    raise exception 'FAIL: rollback_restores_prices_unless_edited';
  end if;
  if (select string_agg(p.name || ':' || coalesce(c.kept_reason, 'undone'), ' ' order by p.name)
        from private.stock_import_changes c join public.products p on p.id = c.product_id where c.batch_id = b1)
     is distinct from 'SI Archived:held SI Both:undone SI Moved:undone SI Sold later:moved SI Sold out:edited' then
    raise exception 'FAIL: kept reasons: %', (select string_agg(p.name || ':' || coalesce(c.kept_reason, 'undone'), ' ' order by p.name)
        from private.stock_import_changes c join public.products p on p.id = c.product_id where c.batch_id = b1);
  end if;
  -- rollback_twice_noop.
  if public.rollback_stock_import(b1) ->> 'done_now' <> '0' then
    raise exception 'FAIL: rollback_twice_noop';
  end if;
  -- The ledger keeps both the import and the undo rows.
  if not exists (select 1 from private.stock_movements m where m.import_batch_id = b1 and m.kind like 'undo%')
     or not exists (select 1 from private.stock_movements m where m.import_batch_id = b1 and m.kind like 'import%') then
    raise exception 'FAIL: the ledger lost import or undo rows';
  end if;
end $$;

-- 8. Lead and stock flows never cross; the two can run together; one stock writer at a time --------------------------------
do $$
declare
  s1 uuid;
  s2 uuid;
  lb uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  s1 := pg_temp.import(jsonb_build_array(pg_temp.r(2, 'SI Cross one', 'warehouse', '5', '5')));
  -- lead_rpcs_refuse_stock_batch: the lead flow's check, import and undo on a stock batch are refused, staging untouched.
  -- (The marker set by the check above lives until this transaction ends; a fresh request has none.)
  perform set_config('topstock.stock_batch_op', '', true);
  perform pg_temp.expect_error(format('select public.validate_lead_import(%L)', s1), '22023');
  perform pg_temp.expect_error(format('select public.commit_lead_import(%L)', s1), '22023', 'bad_transition');
  perform pg_temp.expect_error(format('select public.discard_lead_import(%L)', s1), '22023', 'bad_transition');
  if (select count(*) from private.stock_import_staging s where s.batch_id = s1) <> 1
     or (select status from public.import_batches where id = s1) <> 'dry_run' then
    raise exception 'FAIL: lead_rpcs_refuse_stock_batch left a change';
  end if;
  -- stock_rpcs_refuse_lead_batch.
  lb := public.create_lead_import('leads.csv', repeat('cd', 32), 1, 2);
  perform pg_temp.expect_error(format('select public.validate_stock_import(%L)', lb), '22023', 'bad_transition');
  perform pg_temp.expect_error(format('select public.commit_stock_import(%L)', lb), '22023', 'bad_transition');
  perform pg_temp.expect_error(format('select public.stage_stock_import_rows(%L, ''[{"row_no":"2","name":"x"}]'')', lb), '22023', 'bad_transition');
  -- stock_and_lead_import_can_run_together: a committing lead import (import_attack.sql leaves one paused) does not
  -- block a stock commit.
  if not exists (select 1 from public.import_batches b where b.kind = 'leads' and b.status = 'committing') then
    lb := public.create_lead_import('leads2.csv', repeat('cd', 32), 2, 3);
    perform public.stage_lead_import_rows(lb, '[{"row_no":"2","name":"SI Cross lead A","lead_status":"cold"},
                                                {"row_no":"3","name":"SI Cross lead B","lead_status":"cold"}]');
    perform public.validate_lead_import(lb);
    perform public.commit_lead_import(lb, 1);   -- one row, then paused: committing
  else
    perform public.discard_lead_import(lb);
  end if;
  if not exists (select 1 from public.import_batches b where b.kind = 'leads' and b.status = 'committing') then
    raise exception 'FAIL: expected a paused lead import';
  end if;
  -- stock_import_second_writer_busy: s1 commits one product and pauses; s2 cannot start committing meanwhile.
  s2 := pg_temp.import(jsonb_build_array(pg_temp.r(2, 'SI Cross two', 'warehouse', '5', '5'),
                                         pg_temp.r(3, 'SI Cross three', 'warehouse', '5', '5')));
  perform public.commit_stock_import(s2, 1);
  if (select status from public.import_batches where id = s2) <> 'committing' then
    raise exception 'FAIL: s2 should be paused committing';
  end if;
  perform pg_temp.expect_error(format('select public.commit_stock_import(%L)', s1), '22023', 'busy');
  perform pg_temp.commit_all(s2);
  perform pg_temp.commit_all(s1);
  if pg_temp.lv('SI Cross one') <> '5/0 0/0' or pg_temp.lv('SI Cross three') <> '5/0 0/0' then
    raise exception 'FAIL: crossed imports';
  end if;
end $$;

-- 9. Gates on products, the ledger and the lock helper ------------------------------------------------------------------
do $$
declare
  batch uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  batch := pg_temp.import(jsonb_build_array(pg_temp.r(2, 'SI Gate', 'warehouse', '5', '5')));
  perform set_config('topstock.stock_batch_op', '', true);   -- as a fresh request: no marker
  -- stock_import_product_column_gated: a product insert naming a batch that is not committing (or not stock) is refused.
  perform pg_temp.expect_error(format($q$insert into public.products (name, pieces_per_carton, import_batch_id) values ('SI Sneak', 5, %L)$q$, batch), '42501');
  -- Import rows outside the commit (no marker), with a batch that is not committing, or undo rows outside an undo.
  perform pg_temp.expect_error(format($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, expected_on_hand, import_batch_id)
    select gen_random_uuid(), p.id, l.id, 'import_in', 1, 5, %L from public.products p join public.locations l on l.org_id = p.org_id and l.kind = 'warehouse'
     where p.name = 'SI Cross one'$q$, batch), '22023', 'document');
  perform set_config('topstock.stock_batch_op', batch::text, false);
  perform pg_temp.expect_error(format($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, expected_on_hand, import_batch_id)
    select gen_random_uuid(), p.id, l.id, 'import_in', 1, 5, %L from public.products p join public.locations l on l.org_id = p.org_id and l.kind = 'warehouse'
     where p.name = 'SI Cross one'$q$, batch), '42501', 'forbidden');
  perform pg_temp.expect_error(format($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, expected_on_hand, import_batch_id)
    select gen_random_uuid(), p.id, l.id, 'undo_in', 1, 5, %L from public.products p join public.locations l on l.org_id = p.org_id and l.kind = 'warehouse'
     where p.name = 'SI Cross one'$q$, batch), '22023', 'document');
  perform set_config('topstock.stock_batch_op', '', false);
  -- lock_helper_refuses_non_uploader_and_stale_code (the batch is dry_run: nobody may lock for it).
  perform pg_temp.expect_error(format('select private.lock_stock_import(%L, array[(select id from public.products where name = ''SI Cross one'')])', batch), '42501', 'forbidden');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 700);
  perform pg_temp.expect_error(format('select private.lock_stock_import(%L, ''{}''::uuid[])', batch), '42501', 'step_up');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1', 'aal2', 30);
  perform pg_temp.expect_error(format('select private.lock_stock_import(%L, ''{}''::uuid[])', batch), 'P0002');
  perform pg_temp.expect_error(format('select public.commit_stock_import(%L)', batch), 'P0002');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform public.discard_stock_import(batch);
  -- lock_helper_uploader_only: while admin a's import is committing (paused after one of two products), admin b (fresh
  -- code) may not take its locks nor commit it; a can, and finishes it.
  batch := pg_temp.import(jsonb_build_array(pg_temp.r(2, 'SI Lock one', 'warehouse', '5', '5'),
                                            pg_temp.r(3, 'SI Lock two', 'warehouse', '5', '5')));
  if public.commit_stock_import(batch, 1) ->> 'status' <> 'committing' then
    raise exception 'FAIL: lock_helper_uploader_only: the first chunk finished the import';
  end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000b', 'aal2', 30);
  perform pg_temp.expect_error(format('select private.lock_stock_import(%L, array[(select id from public.products where name = ''SI Lock one'')])', batch), '42501', 'forbidden');
  perform pg_temp.expect_error(format('select public.commit_stock_import(%L)', batch), '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform private.lock_stock_import(batch, array[(select id from public.products where name = 'SI Lock one')]);
  if pg_temp.commit_all(batch) ->> 'status' <> 'imported' then
    raise exception 'FAIL: lock_helper_uploader_only: the uploader could not finish';
  end if;
end $$;

-- 10. The nightly job discards stock imports left open for 24 hours (and their rows) -------------------------------------
do $$
declare
  batch uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  batch := public.create_stock_import('old.csv', repeat('ab', 32), 1, 2);
  perform public.stage_stock_import_rows(batch, jsonb_build_array(pg_temp.r(2, 'SI Old', 'warehouse', '1', '1')));
  perform set_config('t.old', batch::text, false);
end $$;
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
set session_replication_role = replica;
update public.import_batches set updated_at = now() - interval '25 hours' where id = current_setting('t.old')::uuid;
set session_replication_role = origin;
do $$
declare
  batch constant uuid := current_setting('t.old')::uuid;
  r jsonb;
begin
  r := private.nightly_stock_jobs();
  if (r ->> 'stock_imports_discarded')::int < 1 or (select status from public.import_batches where id = batch) <> 'discarded'
     or exists (select 1 from private.stock_import_staging s where s.batch_id = batch) then
    raise exception 'FAIL: nightly discard: %', r;
  end if;
end $$;

-- 11. ledger_sums_match_levels --------------------------------------------------------------------------------------------
set role authenticated;
do $$ begin perform pg_temp.integrity_clean('the stock import attack test'); end $$;
reset role;
do $$
declare
  o record;
begin
  perform set_config('request.jwt.claims', '', false);
  for o in select id from public.orgs loop
    if exists (select 1 from private.stock_integrity_rows(o.id)) then
      raise exception 'FAIL: ledger_sums_match_levels in org %', o.id;
    end if;
  end loop;
end $$;

\echo 'stock_import_attack: all checks passed'
