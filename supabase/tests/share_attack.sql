-- Day 6e attack and behaviour tests: the client stock link (design docs/evidence/day6/design.md sections 3.5, 8, 9 and
-- 11.1; migration 20261020090000_client_share.sql). Runs after sales_attack.sql on the same database
-- (scripts/db-test.sh, CI job "db"), reusing its users: admins a and b, manager a1, reps b1, d1 and e1, other-org admin
-- c1. Its own leads and products are named "SH …". The anon calls run as the anon role exactly as PostgREST would.
-- Any failure raises an exception and stops the run.
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
create function pg_temp.expect_error(stmt text, want_state text, want_hint text default null) returns void
language plpgsql as $$
declare
  got_state text;
  got_hint text;
  got_msg text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics got_state = returned_sqlstate, got_hint = pg_exception_hint, got_msg = message_text;
    if got_state <> want_state or (want_hint is not null and coalesce(got_hint, '') <> want_hint) then
      raise exception 'FAIL: "%" gave % (hint "%", %), expected % (hint "%")', left(stmt, 200), got_state, got_hint,
        got_msg, want_state, want_hint;
    end if;
    return;
  end;
  raise exception 'FAIL: "%" succeeded, expected %', left(stmt, 200), want_state;
end;
$$;
grant execute on function pg_temp.as_user(text, text, integer), pg_temp.expect_error(text, text, text)
  to authenticated, anon;
-- A request payload as the client page sends it.
create function pg_temp.req(lines jsonb, note text default null, nm text default null, k uuid default gen_random_uuid())
returns jsonb language sql as $$
  select jsonb_build_object('lines', lines, 'note', note, 'name', nm, 'idempotency_key', k)
$$;
create function pg_temp.line(pnum text, qty text default '2', unit text default 'carton', descr text default null)
returns jsonb language sql as $$
  select jsonb_build_object('product_number', pnum::integer, 'description', descr, 'quantity', qty, 'unit', unit)
$$;
grant execute on function pg_temp.req(jsonb, text, text, uuid), pg_temp.line(text, text, text, text) to anon;

-- 0. Fixtures ----------------------------------------------------------------------------------------------------------
-- Leads: SH A (admin a's), SH B1 (rep b1's), SH Gone (deleted later), SH Orphan (no owner); SH C1 in the other org.
-- Products (as admin a, through the RPCs): Visible (480 pcs, min 1.11, max 999.99, cost 0.42), Hidden, Archived,
-- Sold out, Fully held, Transit (eta a Wednesday next month), Past eta (transit, eta last week); one in the other org.
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
do $$
declare
  main_org uuid := (select id from public.orgs where name = 'TopStock Wholesale');
begin
  insert into public.companies (id, org_id, name, owner_id, lead_status, country) values
    ('5e000000-0000-0000-0000-0000000000a0', main_org, 'SH A', '00000000-0000-0000-0000-00000000000a', 'warm', 'FR'),
    ('5e000000-0000-0000-0000-0000000000b1', main_org, 'SH B1', '00000000-0000-0000-0000-0000000000b1', 'warm', 'FR'),
    ('5e000000-0000-0000-0000-0000000000b2', main_org, 'SH B2', '00000000-0000-0000-0000-0000000000b1', 'warm', 'FR'),
    ('5e000000-0000-0000-0000-0000000000f0', main_org, 'SH Gone', '00000000-0000-0000-0000-00000000000a', 'warm', 'FR'),
    ('5e000000-0000-0000-0000-0000000000f1', main_org, 'SH Orphan', null, 'warm', 'FR'),
    ('5e000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000cc', 'SH C1',
     '00000000-0000-0000-0000-0000000000c1', 'warm', 'FR');
end $$;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select set_config('t.p_vis', public.create_product(p_name => 'SH Visible', p_pieces_per_carton => 24, p_price_min => 1.11,
  p_price_max => 999.99, p_category => 'Bags', p_cost_per_piece => 0.42, p_opening_qty => 480,
  p_opening_location => 'warehouse')::text, false) \g /dev/null
select set_config('t.p_hid', public.create_product(p_name => 'SH Hidden', p_pieces_per_carton => 10, p_price_max => 2,
  p_share_visible => false, p_opening_qty => 100, p_opening_location => 'warehouse')::text, false) \g /dev/null
select set_config('t.p_arch', public.create_product(p_name => 'SH Archived', p_pieces_per_carton => 10, p_price_max => 2)::text,
  false) \g /dev/null
select set_config('t.p_out', public.create_product(p_name => 'SH Sold out', p_pieces_per_carton => 10, p_price_max => 2)::text,
  false) \g /dev/null
select set_config('t.p_held', public.create_product(p_name => 'SH Fully held', p_pieces_per_carton => 12, p_price_max => 3,
  p_opening_qty => 48, p_opening_location => 'warehouse')::text, false) \g /dev/null
select public.post_stock_movement(current_setting('t.p_held')::uuid, 'reserve', 48, 'warehouse',
  p_company => '5e000000-0000-0000-0000-0000000000a0') \g /dev/null
select set_config('t.eta', (date_trunc('month', current_date + 40)::date + 2
  + ((3 - extract(isodow from date_trunc('month', current_date + 40)::date + 2)::integer + 7) % 7))::text, false) \g /dev/null
select set_config('t.p_tr', public.create_product(p_name => 'SH Transit', p_pieces_per_carton => 50, p_price_max => 1.5,
  p_category => 'Cups', p_transit_eta => current_setting('t.eta')::date, p_opening_qty => 500,
  p_opening_location => 'transit')::text, false) \g /dev/null
select set_config('t.p_past', public.create_product(p_name => 'SH Past eta', p_pieces_per_carton => 50, p_price_max => 1.5,
  p_category => 'Cups', p_transit_eta => current_date - 7, p_opening_qty => 200, p_opening_location => 'transit')::text,
  false) \g /dev/null
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1', 'aal2', 30) \g /dev/null
select set_config('t.p_other', public.create_product(p_name => 'SH Other org', p_pieces_per_carton => 10, p_price_max => 5,
  p_opening_qty => 100, p_opening_location => 'warehouse')::text, false) \g /dev/null
reset role;
select set_config('request.jwt.claims', '', false) \g /dev/null
update public.products set archived_at = now() where id = current_setting('t.p_arch')::uuid;
-- The client page names products by their number (P-0042), never by an internal id.
select set_config('t.n_' || k, (select number::text from public.products where id = current_setting('t.p_' || k)::uuid), false)
  from unnest(array['vis', 'hid', 'arch', 'out', 'held', 'tr', 'past', 'other']) k \g /dev/null

-- 1. share_view_valid_link_ok (first, so a lookup-order bug cannot hide), share_functions_volatile ---------------------
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b', 'aal2', 30) \g /dev/null
select public.set_sharing_enabled(true) \g /dev/null
select set_config('t.tok', public.create_share_link('5e000000-0000-0000-0000-0000000000a0', 'fr') ->> 'token', false) \g /dev/null
reset role;
set role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', false) \g /dev/null
do $$
declare
  r jsonb := public.share_view(current_setting('t.tok'));
begin
  if r ->> 'status' <> 'ok' or not exists (select 1 from jsonb_array_elements(r -> 'items') i
                                            where i ->> 0 = current_setting('t.n_vis')) then
    raise exception 'FAIL: share_view_valid_link_ok: %', left(r::text, 300);
  end if;
  if r ->> 'signature' <> 'Henri' or r ->> 'language' <> 'fr' or r ->> 'currency' <> 'EUR' then
    raise exception 'FAIL: share_view_valid_link_ok header: %', r - 'items';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from pg_proc p where p.oid in ('public.share_view(text, text)'::regprocedure,
                                                     'public.share_request(text, jsonb)'::regprocedure)
              and (p.provolatile <> 'v' or not p.prosecdef or p.proowner <> 'share_reader'::regrole
                   or not coalesce(p.proconfig, '{}') @> array['search_path=""'])) then
    raise exception 'FAIL: share_functions_volatile (volatile, definer, owner share_reader, search_path)';
  end if;
end $$;

-- 2. anon_executable_functions_exact, anon_cannot_select_any_table ----------------------------------------------------
do $$
declare
  got text[];
  t record;
begin
  select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text) into got
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'EXECUTE');
  if got is distinct from array['share_request(text,jsonb)', 'share_view(text,text)'] then
    raise exception 'FAIL: anon_executable_functions_exact: %', got;
  end if;
  for t in select c.oid, c.relname, n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p') loop
    if has_table_privilege('anon', t.oid, 'SELECT') or has_table_privilege('anon', t.oid, 'INSERT')
       or has_table_privilege('anon', t.oid, 'UPDATE') or has_table_privilege('anon', t.oid, 'DELETE')
       or has_any_column_privilege('anon', t.oid, 'SELECT') then
      raise exception 'FAIL: anon_cannot_select_any_table: %.%', t.nspname, t.relname;
    end if;
  end loop;
end $$;

-- 3. share_reader: share_reader_column_privileges (every column of every table), share_reader_cannot_read_cost,
--    share_reader_no_lead_columns, share_rls_org_setting_scoping, share_cross_org_never_returned -------------------------
do $$
declare
  want_select constant text[] := array[
    'private.inventory_settings.org_id', 'private.inventory_settings.sharing_enabled',
    'private.share_links.allow_requests', 'private.share_links.company_id', 'private.share_links.expires_at',
    'private.share_links.id', 'private.share_links.language', 'private.share_links.last_opened_at',
    'private.share_links.last_request_at', 'private.share_links.open_count', 'private.share_links.org_id',
    'private.share_links.request_count', 'private.share_links.revoked_at', 'private.share_links.show_in_transit',
    'private.share_links.signature', 'private.share_links.token_hash',
    'private.share_rate.bucket', 'private.share_rate.kind', 'private.share_rate.n', 'private.share_rate.scope_id',
    'private.share_rate.span',
    'private.stock_requests.company_id', 'private.stock_requests.created_at', 'private.stock_requests.id',
    'private.stock_requests.idempotency_key', 'private.stock_requests.org_id', 'private.stock_requests.share_link_id',
    'private.stock_requests.status',
    'public.locations.id', 'public.locations.kind', 'public.locations.org_id',
    'public.products.archived_at', 'public.products.category', 'public.products.id', 'public.products.name',
    'public.products.number', 'public.products.org_id', 'public.products.pieces_per_carton', 'public.products.price_max',
    'public.products.share_visible', 'public.products.transit_eta',
    'public.stock_levels.location_id', 'public.stock_levels.on_hand', 'public.stock_levels.org_id',
    'public.stock_levels.product_id', 'public.stock_levels.reserved'];
  want_insert constant text[] := array[
    'private.share_rate.bucket', 'private.share_rate.kind', 'private.share_rate.n', 'private.share_rate.scope_id',
    'private.share_rate.span',
    'private.stock_request_lines.availability', 'private.stock_request_lines.description',
    'private.stock_request_lines.org_id', 'private.stock_request_lines.pieces', 'private.stock_request_lines.position',
    'private.stock_request_lines.price_shown', 'private.stock_request_lines.product_id',
    'private.stock_request_lines.quantity', 'private.stock_request_lines.request_id', 'private.stock_request_lines.unit',
    'private.stock_requests.company_id', 'private.stock_requests.idempotency_key', 'private.stock_requests.language',
    'private.stock_requests.note', 'private.stock_requests.org_id', 'private.stock_requests.requester_name',
    'private.stock_requests.share_link_id', 'private.stock_requests.source'];
  want_update constant text[] := array[
    'private.share_links.last_opened_at', 'private.share_links.last_request_at', 'private.share_links.open_count',
    'private.share_links.request_count',
    'private.share_rate.bucket', 'private.share_rate.kind', 'private.share_rate.n', 'private.share_rate.scope_id',
    'private.share_rate.span'];
  got text[];
begin
  select array_agg(n.nspname || '.' || c.relname || '.' || a.attname order by n.nspname || '.' || c.relname || '.' || a.attname) into got
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private', 'auth') and c.relkind in ('r', 'v', 'm', 'p') and a.attnum > 0
     and not a.attisdropped and has_column_privilege('share_reader', c.oid, a.attnum, 'SELECT');
  if got is distinct from (select array_agg(x order by x) from unnest(want_select) x) then
    raise exception 'FAIL: share_reader_column_privileges (select): %', got;
  end if;
  select array_agg(n.nspname || '.' || c.relname || '.' || a.attname order by n.nspname || '.' || c.relname || '.' || a.attname) into got
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private', 'auth') and c.relkind in ('r', 'v', 'm', 'p') and a.attnum > 0
     and not a.attisdropped and has_column_privilege('share_reader', c.oid, a.attnum, 'INSERT');
  if got is distinct from (select array_agg(x order by x) from unnest(want_insert) x) then
    raise exception 'FAIL: share_reader_column_privileges (insert): %', got;
  end if;
  select array_agg(n.nspname || '.' || c.relname || '.' || a.attname order by n.nspname || '.' || c.relname || '.' || a.attname) into got
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private', 'auth') and c.relkind in ('r', 'v', 'm', 'p') and a.attnum > 0
     and not a.attisdropped and has_column_privilege('share_reader', c.oid, a.attnum, 'UPDATE');
  if got is distinct from (select array_agg(x order by x) from unnest(want_update) x) then
    raise exception 'FAIL: share_reader_column_privileges (update): %', got;
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname in ('public', 'private', 'auth') and c.relkind in ('r', 'p')
                and has_table_privilege('share_reader', c.oid, 'DELETE') and c.relname <> 'share_rate')
     or exists (select 1 from pg_roles r where r.rolname = 'share_reader' and (r.rolcanlogin or r.rolinherit or r.rolbypassrls))
     or pg_has_role('anon', 'share_reader', 'member') or pg_has_role('authenticated', 'share_reader', 'member') then
    raise exception 'FAIL: share_reader is more than a nologin, noinherit owner of the two functions';
  end if;
end $$;
set role share_reader;
do $$
declare
  q text;
begin
  -- share_reader_cannot_read_cost
  foreach q in array array['select count(*) from private.product_costs', 'select price_min from public.products',
                           'select cost_per_piece from private.order_line_costs', 'select below_min from private.order_lines']
  loop
    perform pg_temp.expect_error(q, '42501');
  end loop;
  -- share_reader_no_lead_columns
  foreach q in array array['select name from public.companies', 'select count(*) from public.contacts',
                           'select count(*) from public.deals', 'select count(*) from private.orders',
                           'select count(*) from private.stock_reservations', 'select count(*) from public.profiles',
                           'select count(*) from public.tasks', 'select count(*) from public.audit_log',
                           'select count(*) from private.stock_movements', 'select note from private.stock_requests',
                           'select created_by from private.share_links', 'select count(*) from auth.users']
  loop
    perform pg_temp.expect_error(q, '42501');
  end loop;
  -- share_rls_org_setting_scoping: no setting, no rows; another org's setting shows only that org.
  if (select count(id) from public.products) <> 0 or (select count(id) from private.share_links) <> 0
     or (select count(org_id) from private.inventory_settings) <> 0 then
    raise exception 'FAIL: share_rls_org_setting_scoping (no setting must read nothing)';
  end if;
  perform set_config('topstock.share_org', '00000000-0000-0000-0000-0000000000cc', true);
  if exists (select 1 from public.products p where p.org_id <> '00000000-0000-0000-0000-0000000000cc')
     or not exists (select 1 from public.products p where p.id = current_setting('t.p_other')::uuid) then
    raise exception 'FAIL: share_rls_org_setting_scoping (another org)';
  end if;
  perform set_config('topstock.share_org', '', true);
end $$;
reset role;
set role anon;
do $$
declare
  r jsonb := public.share_view(current_setting('t.tok'));
begin
  if exists (select 1 from jsonb_array_elements(r -> 'items') i where i ->> 0 = current_setting('t.n_other')) then
    raise exception 'FAIL: share_cross_org_never_returned';
  end if;
end $$;
reset role;

-- 4. share_view_inactive_cases_same_answer, share_view_rejects_hash_as_token, share_view_payload_keys_exact,
--    share_items_signature_exact, share_preview_equals_view_items -----------------------------------------------------
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select set_config('t.tok_rev', public.create_share_link('5e000000-0000-0000-0000-0000000000a0', 'en') ->> 'token', false) \g /dev/null
select set_config('t.tok_exp', public.create_share_link('5e000000-0000-0000-0000-0000000000a0', 'en') ->> 'token', false) \g /dev/null
select set_config('t.tok_gone', public.create_share_link('5e000000-0000-0000-0000-0000000000f0', 'en') ->> 'token', false) \g /dev/null
reset role;
select set_config('t.rev_id', l.id::text, false) from private.share_links l
 where l.token_hash = sha256(convert_to(current_setting('t.tok_rev'), 'UTF8')) \g /dev/null
set role authenticated;
select public.revoke_share_link(current_setting('t.rev_id')::uuid) \g /dev/null
reset role;
select set_config('request.jwt.claims', '', false) \g /dev/null
update private.share_links set expires_at = now() - interval '1 second'
 where token_hash = sha256(convert_to(current_setting('t.tok_exp'), 'UTF8'));
delete from public.companies where id = '5e000000-0000-0000-0000-0000000000f0';
set role anon;
do $$
declare
  t text;
  r jsonb;
begin
  foreach t in array array['', 'tss_short', 'TSS_' || repeat('a', 43), 'tss_' || repeat('a', 42) || '!',
                           'tss_' || repeat('a', 44), 'tss_' || repeat('a', 43), current_setting('t.tok_rev'),
                           current_setting('t.tok_exp'), current_setting('t.tok_gone')] loop
    r := public.share_view(t);
    if r::text <> '{"status": "inactive"}' then
      raise exception 'FAIL: share_view_inactive_cases_same_answer (%): %', left(t, 12), r;
    end if;
    if public.share_request(t, pg_temp.req('[]'::jsonb, 'Bonjour à vous'))::text <> '{"status": "inactive"}' then
      raise exception 'FAIL: share_request inactive (%)', left(t, 12);
    end if;
  end loop;
  if public.share_view(null)::text <> '{"status": "inactive"}' then
    raise exception 'FAIL: share_view(null)';
  end if;
end $$;
reset role;
-- The hash is not a token, in any spelling.
select set_config('t.hash_hex', encode(token_hash, 'hex'), false),
       set_config('t.hash_b64', 'tss_' || translate(rtrim(encode(token_hash, 'base64'), '='), '+/', '-_'), false)
  from private.share_links where token_hash = sha256(convert_to(current_setting('t.tok'), 'UTF8')) \g /dev/null
set role anon;
do $$
begin
  if public.share_view(current_setting('t.hash_hex'))::text <> '{"status": "inactive"}'
     or public.share_view(current_setting('t.hash_b64'))::text <> '{"status": "inactive"}' then
    raise exception 'FAIL: share_view_rejects_hash_as_token';
  end if;
end $$;
do $$
declare
  r jsonb := public.share_view(current_setting('t.tok'));
begin
  if (select array_agg(k order by k) from jsonb_object_keys(r) k)
     is distinct from array['allow_requests', 'currency', 'generated_at', 'items', 'language', 'show_in_transit',
                            'signature', 'status', 'version'] then
    raise exception 'FAIL: share_view_payload_keys_exact: %', (select array_agg(k) from jsonb_object_keys(r) k);
  end if;
  if exists (select 1 from jsonb_array_elements(r -> 'items') i
              where jsonb_typeof(i) <> 'array' or jsonb_array_length(i) <> 8
                 or i ->> 0 ~ '-') then
    raise exception 'FAIL: share_view_payload_keys_exact (items are 8-place arrays, no internal id)';
  end if;
  -- The planted minimum price and cost never travel.
  if r::text like '%1.11%' or r::text like '%0.42%' or r::text not like '%999.99%' then
    raise exception 'FAIL: share_view sends the minimum price or the cost';
  end if;
end $$;
reset role;
do $$
declare
  body text := pg_get_functiondef('private.share_items(uuid, boolean)'::regprocedure);
begin
  if pg_get_function_result('private.share_items(uuid, boolean)'::regprocedure) <> 'jsonb'
     or pg_get_function_identity_arguments('private.share_items(uuid, boolean)'::regprocedure)
        <> 'p_org uuid, p_with_transit boolean'
     or body like '%price_min%' or body like '%product_costs%' or body like '%companies%' or body like '%reservations%'
     or pg_get_functiondef('public.share_view(text, text)'::regprocedure) like '%price_min%'
     or pg_get_functiondef('public.share_request(text, jsonb)'::regprocedure) like '%price_min%' then
    raise exception 'FAIL: share_items_signature_exact';
  end if;
end $$;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30) \g /dev/null
select set_config('t.preview', (public.share_preview() -> 'items')::text, false) \g /dev/null
reset role;
set role anon;
do $$
begin
  if (public.share_view(current_setting('t.tok')) -> 'items') is distinct from current_setting('t.preview')::jsonb then
    raise exception 'FAIL: share_preview_equals_view_items';
  end if;
end $$;
reset role;

-- 5. Visibility: share_view_hides_sold_out_hidden_archived_fully_held, share_view_transit_respects_link_setting,
--    share_view_past_eta_hidden, share_view_eta_is_week_start, share_view_unchanged_version --------------------------
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select set_config('t.tok_notr', public.create_share_link('5e000000-0000-0000-0000-0000000000b1', 'en',
  p_show_in_transit => false) ->> 'token', false) \g /dev/null
reset role;
set role anon;
do $$
declare
  r jsonb := public.share_view(current_setting('t.tok'));
  ids text[] := (select array_agg(i ->> 0) from jsonb_array_elements(r -> 'items') i);
  tr jsonb := (select i from jsonb_array_elements(r -> 'items') i where i ->> 0 = current_setting('t.n_tr'));
  past jsonb := (select i from jsonb_array_elements(r -> 'items') i where i ->> 0 = current_setting('t.n_past'));
  vis jsonb := (select i from jsonb_array_elements(r -> 'items') i where i ->> 0 = current_setting('t.n_vis'));
  v text := r ->> 'version';
  r2 jsonb;
begin
  if ids && array[current_setting('t.n_hid'), current_setting('t.n_arch'), current_setting('t.n_out'),
                  current_setting('t.n_held')] then
    raise exception 'FAIL: share_view_hides_sold_out_hidden_archived_fully_held: %', ids;
  end if;
  if vis ->> 1 <> 'SH Visible' or vis ->> 2 <> 'Bags' or vis ->> 3 <> '999.99' or (vis ->> 4)::integer <> 24
     or (vis ->> 5)::integer <> 480 or (vis ->> 6)::integer <> 0 then
    raise exception 'FAIL: the visible product reads %', vis;
  end if;
  if tr is null or (tr ->> 6)::integer <> 500 or (tr ->> 5)::integer <> 0
     or (tr ->> 7)::date <> date_trunc('week', current_setting('t.eta')::date)::date
     or extract(isodow from (tr ->> 7)::date) <> 1 or (tr ->> 7)::date = current_setting('t.eta')::date then
    raise exception 'FAIL: share_view_eta_is_week_start: % (eta %)', tr, current_setting('t.eta');
  end if;
  if past is null or past -> 7 <> 'null'::jsonb then
    raise exception 'FAIL: share_view_past_eta_hidden: %', past;
  end if;
  r := public.share_view(current_setting('t.tok_notr'));
  if exists (select 1 from jsonb_array_elements(r -> 'items') i
              where i ->> 0 in (current_setting('t.n_tr'), current_setting('t.n_past')) or (i ->> 6)::integer <> 0
                 or i -> 7 <> 'null'::jsonb)
     or (r ->> 'show_in_transit')::boolean then
    raise exception 'FAIL: share_view_transit_respects_link_setting';
  end if;
  r2 := public.share_view(current_setting('t.tok'), v);
  if r2::text <> jsonb_build_object('status', 'ok', 'unchanged', true, 'version', v)::text then
    raise exception 'FAIL: share_view_unchanged_version: %', r2;
  end if;
  r2 := public.share_view(current_setting('t.tok'), '0000000000000000');
  if r2 ? 'unchanged' or r2 -> 'items' is null then
    raise exception 'FAIL: a stale version gets the whole list';
  end if;
end $$;
reset role;

-- share_view_2000_items_not_truncated (and capped at 2,000 after the filter): an org of its own, rolled back.
begin;
set local session_replication_role = replica;
insert into public.orgs (id, name) values ('00000000-0000-0000-0000-0000000000ee', 'Share Big Org');
insert into public.locations (org_id, kind, name) values ('00000000-0000-0000-0000-0000000000ee', 'warehouse', 'W'),
  ('00000000-0000-0000-0000-0000000000ee', 'transit', 'T');
insert into private.inventory_settings (org_id, sharing_enabled) values ('00000000-0000-0000-0000-0000000000ee', true);
insert into public.companies (id, org_id, name) values ('5e000000-0000-0000-0000-0000000000ee', '00000000-0000-0000-0000-0000000000ee', 'SH Big');
insert into public.products (id, org_id, name, pieces_per_carton, price_max)
select ('5e100000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, '00000000-0000-0000-0000-0000000000ee',
       'Big ' || lpad(g::text, 5, '0'), 10, 1 from generate_series(1, 2100) g;
-- 2,000 sold out first in name order, then 2,050 in stock: all 2,000 shown are in stock.
insert into public.stock_levels (product_id, location_id, org_id, on_hand, reserved)
select p.id, l.id, p.org_id, case when p.name <= 'Big 00050' then 0 else 7 end, 0
  from public.products p join public.locations l on l.org_id = p.org_id and l.kind = 'warehouse'
 where p.org_id = '00000000-0000-0000-0000-0000000000ee';
insert into private.share_links (org_id, company_id, token_hash, token_hint, language, expires_at, created_by)
values ('00000000-0000-0000-0000-0000000000ee', '5e000000-0000-0000-0000-0000000000ee',
        sha256(convert_to('tss_' || repeat('B', 43), 'UTF8')), 'BBBB', 'en', now() + interval '1 day',
        '00000000-0000-0000-0000-00000000000a');
set local session_replication_role = origin;
set local role anon;
do $$
declare
  r jsonb := public.share_view('tss_' || repeat('B', 43));
begin
  if jsonb_array_length(r -> 'items') <> 2000
     or exists (select 1 from jsonb_array_elements(r -> 'items') i where (i ->> 5)::integer = 0) then
    raise exception 'FAIL: share_view_2000_items_not_truncated: % items', jsonb_array_length(r -> 'items');
  end if;
end $$;
rollback;

-- 6. Limits and writes: share_view_rate_limited, share_view_over_limit_writes_nothing, share_unknown_token_writes_nothing,
--    share_view_writes_no_audit_rows, share_view_not_granted_to_authenticated, share_last_opened_throttled ------------
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select set_config('t.tok_rate', public.create_share_link('5e000000-0000-0000-0000-0000000000b1', 'en') ->> 'token', false) \g /dev/null
reset role;
select set_config('t.audit_n', (select count(*) from public.audit_log)::text, false),
       set_config('t.rate_n', (select coalesce(sum(n), 0) from private.share_rate)::text, false) \g /dev/null
set role anon;
do $$
declare
  r jsonb;
begin
  for i in 1..30 loop
    r := public.share_view(current_setting('t.tok_rate'));
    if r ->> 'status' <> 'ok' then
      raise exception 'FAIL: view % of 30 in a minute refused: %', i, r;
    end if;
  end loop;
  r := public.share_view(current_setting('t.tok_rate'));
  if r::text <> '{"status": "slow_down"}' then
    raise exception 'FAIL: share_view_rate_limited: the 31st view gave %', r;
  end if;
  perform public.share_view('tss_' || repeat('z', 43)) from generate_series(1, 20);
end $$;
reset role;
do $$
declare
  l record;
begin
  select * into l from private.share_links where token_hash = sha256(convert_to(current_setting('t.tok_rate'), 'UTF8'));
  -- Only the 30 accepted views counted (3 spans each minus the absent day span: minute and hour), nothing for the 31st
  -- or the unknown tokens; one open counted (at most one per 5 minutes); no audit row.
  if (select coalesce(sum(n), 0) from private.share_rate) - current_setting('t.rate_n')::bigint <> 60 then
    raise exception 'FAIL: share_view_over_limit_writes_nothing / share_unknown_token_writes_nothing: % counter steps',
      (select coalesce(sum(n), 0) from private.share_rate) - current_setting('t.rate_n')::bigint;
  end if;
  if l.open_count <> 1 or l.last_opened_at is null then
    raise exception 'FAIL: share_last_opened_throttled: open_count %', l.open_count;
  end if;
  if (select count(*) from public.audit_log) <> current_setting('t.audit_n')::bigint then
    raise exception 'FAIL: share_view_writes_no_audit_rows';
  end if;
  if has_function_privilege('authenticated', 'public.share_view(text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.share_request(text, jsonb)', 'EXECUTE')
     or has_function_privilege('public', 'public.share_view(text, text)', 'EXECUTE') then
    raise exception 'FAIL: share_view_not_granted_to_authenticated';
  end if;
end $$;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select pg_temp.expect_error($q$select public.share_view(current_setting('t.tok'))$q$, '42501') \g /dev/null
reset role;

-- 7. Requests: share_request_creates_request_and_one_task, share_request_task_assignee_fallback,
--    share_request_rejects_foreign_or_hidden_product, share_request_payload_limits, share_request_rate_limits,
--    share_request_too_many_open, share_request_idempotent, share_request_closed_link, share_request_bidi_refused --------
set role anon;
do $$
declare
  r jsonb;
  k uuid := gen_random_uuid();
begin
  r := public.share_request(current_setting('t.tok'),
         pg_temp.req(jsonb_build_array(pg_temp.line(current_setting('t.n_vis'), '2', 'carton'),
                                       pg_temp.line(current_setting('t.n_tr'), '100', 'piece'),
                                       pg_temp.line(null, '30', 'piece', 'Sacs kraft 30 cm')),
                     'Livraison avant le 15', 'Marie', k));
  if r::text <> '{"status": "received", "signature": "Henri"}' then
    raise exception 'FAIL: share_request_creates_request_and_one_task: %', r;
  end if;
  perform set_config('t.k1', k::text, false);
  -- share_request_idempotent: the same key again writes nothing.
  if public.share_request(current_setting('t.tok'),
       pg_temp.req(jsonb_build_array(pg_temp.line(current_setting('t.n_vis'))), null, null, k)) ->> 'status' <> 'received' then
    raise exception 'FAIL: share_request_idempotent answer';
  end if;
  -- A second request on the same lead keeps the one open task.
  if public.share_request(current_setting('t.tok'), pg_temp.req('[]'::jsonb, 'Avez-vous des gobelets ?')) ->> 'status' <> 'received' then
    raise exception 'FAIL: a note-only request';
  end if;
end $$;
reset role;
do $$
declare
  q record;
begin
  select r.* into q from private.stock_requests r where r.idempotency_key = current_setting('t.k1')::uuid;
  if (select count(*) from private.stock_requests r where r.idempotency_key = current_setting('t.k1')::uuid) <> 1 then
    raise exception 'FAIL: share_request_idempotent (% rows)',
      (select count(*) from private.stock_requests r where r.idempotency_key = current_setting('t.k1')::uuid);
  end if;
  if q.source <> 'share_link' or q.company_id <> '5e000000-0000-0000-0000-0000000000a0' or q.created_by is not null
     or q.status <> 'new' or q.language <> 'fr' or q.note <> 'Livraison avant le 15' or q.requester_name <> 'Marie' then
    raise exception 'FAIL: share_request_creates_request_and_one_task (request row) %', row_to_json(q);
  end if;
  if (select string_agg(l.position || ':' || coalesce(l.product_id::text, l.description) || ':' || l.pieces || ':'
                        || l.availability || ':' || coalesce(l.price_shown::text, '-'), ' ' order by l.position)
        from private.stock_request_lines l where l.request_id = q.id)
     <> '1:' || current_setting('t.p_vis') || ':48:in_warehouse:999.9900 2:' || current_setting('t.p_tr')
        || ':100:in_transit:1.5000 3:Sacs kraft 30 cm:30:not_listed:-' then
    raise exception 'FAIL: share request lines: %', (select string_agg(row_to_json(l)::text, ' ')
                                                       from private.stock_request_lines l where l.request_id = q.id);
  end if;
  if (select count(*) from public.tasks t where t.company_id = '5e000000-0000-0000-0000-0000000000a0'
        and t.source_request_id is not null and t.done_at is null) <> 1
     or (select t.assignee_id from public.tasks t where t.source_request_id = q.id)
        <> '00000000-0000-0000-0000-00000000000a'
     or (select t.created_by from public.tasks t where t.source_request_id = q.id) is not null
     or (select t.title from public.tasks t where t.source_request_id = q.id) not in ('Stock request (client link)',
                                                                                     'Demande de stock (lien client)') then
    raise exception 'FAIL: share_request_creates_request_and_one_task (task)';
  end if;
  if (select request_count from private.share_links where token_hash = sha256(convert_to(current_setting('t.tok'), 'UTF8'))) <> 2 then
    raise exception 'FAIL: request_count';
  end if;
  -- The audit keeps no client text.
  if exists (select 1 from public.audit_log a where a.table_name = 'stock_requests' and a.record_id = q.id::text
              and (a.diff_json::text like '%Livraison%' or a.diff_json::text like '%Marie%')) then
    raise exception 'FAIL: the client request text reached the audit';
  end if;
end $$;
-- share_request_task_assignee_fallback: a lead with no owner gives the task to the link's creator.
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30) \g /dev/null
select set_config('t.tok_orphan', public.create_share_link('5e000000-0000-0000-0000-0000000000f1', 'en') ->> 'token', false) \g /dev/null
reset role;
set role anon;
select public.share_request(current_setting('t.tok_orphan'), pg_temp.req(jsonb_build_array(
  pg_temp.line(current_setting('t.n_vis'), '1', 'carton')))) \g /dev/null
reset role;
do $$
begin
  if (select t.assignee_id from public.tasks t where t.company_id = '5e000000-0000-0000-0000-0000000000f1'
        and t.source_request_id is not null) is distinct from '00000000-0000-0000-0000-0000000000a1' then
    raise exception 'FAIL: share_request_task_assignee_fallback';
  end if;
end $$;
set role anon;
do $$
declare
  tok constant text := current_setting('t.tok');
  vis constant text := current_setting('t.n_vis');
  bad jsonb;
  r jsonb;
begin
  -- share_request_rejects_foreign_or_hidden_product
  foreach bad in array array[
    pg_temp.req(jsonb_build_array(pg_temp.line(current_setting('t.n_other')))),
    pg_temp.req(jsonb_build_array(pg_temp.line(current_setting('t.n_hid')))),
    pg_temp.req(jsonb_build_array(pg_temp.line(current_setting('t.n_arch')))),
    pg_temp.req(jsonb_build_array(pg_temp.line(current_setting('t.n_held')))),
    pg_temp.req(jsonb_build_array(pg_temp.line('987654321')))] loop
    r := public.share_request(tok, bad);
    if r::text <> '{"status": "invalid"}' then
      raise exception 'FAIL: share_request_rejects_foreign_or_hidden_product: %', r;
    end if;
  end loop;
  -- share_request_payload_limits, share_request_bidi_refused
  foreach bad in array array[
    pg_temp.req((select jsonb_agg(pg_temp.line(null, '1', 'piece', 'Item ' || g)) from generate_series(1, 21) g)),
    pg_temp.req('[]'::jsonb, repeat('n', 1001)),
    pg_temp.req('[]'::jsonb, 'ok'),                                            -- no line and a note under 3
    pg_temp.req('[]'::jsonb, 'Bonjour ' || chr(8238) || 'evil'),               -- bidi override
    pg_temp.req('[]'::jsonb, 'Bonjour ' || chr(7)),                            -- control character
    pg_temp.req('[]'::jsonb, 'Bonjour', repeat('m', 81)),
    pg_temp.req('[]'::jsonb, 'Bonjour', 'Marie ' || chr(8206)),
    pg_temp.req('[]'::jsonb, 'Bonjour') || '{"extra": 1}',
    pg_temp.req('[]'::jsonb, 'Bonjour') - 'name',
    jsonb_build_object('lines', '[]'::jsonb, 'note', 'Bonjour', 'name', null, 'idempotency_key', 'not-a-uuid'),
    pg_temp.req(jsonb_build_array(pg_temp.line(vis, '0'))),
    pg_temp.req(jsonb_build_array(pg_temp.line(vis, '10000001', 'piece'))),
    pg_temp.req(jsonb_build_array(pg_temp.line(vis, '1.5'))),
    pg_temp.req(jsonb_build_array(pg_temp.line(vis, '-2'))),
    pg_temp.req(jsonb_build_array(pg_temp.line(vis, '2', 'box'))),
    pg_temp.req(jsonb_build_array(pg_temp.line(vis), pg_temp.line(vis))),       -- the same product twice
    pg_temp.req(jsonb_build_array(pg_temp.line(null, '2', 'carton', 'Sacs'))),  -- free text in cartons
    pg_temp.req(jsonb_build_array(pg_temp.line(null, '2', 'piece', ''))),
    pg_temp.req(jsonb_build_array(pg_temp.line(null, '2', 'piece', repeat('d', 201)))),
    pg_temp.req(jsonb_build_array(pg_temp.line(vis) || '{"price": 0.01}')),
    pg_temp.req(jsonb_build_array('"just text"'::jsonb)),
    '[]'::jsonb, 'null'::jsonb] loop
    r := public.share_request(tok, bad);
    if r::text <> '{"status": "invalid"}' then
      raise exception 'FAIL: share_request_payload_limits: % gave %', left(bad::text, 120), r;
    end if;
  end loop;
  r := public.share_request(tok, jsonb_build_object('lines', '[]'::jsonb, 'note', repeat('é', 9000), 'name', null,
                                                    'idempotency_key', gen_random_uuid()));
  if r::text <> '{"status": "invalid"}' then
    raise exception 'FAIL: share_request_payload_limits (over 16 KB): %', r;
  end if;
end $$;
reset role;
-- share_request_rate_limits: the 6th in an hour on a link; the 21st in a day (day bucket at 20); the 201st an org-day.
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select set_config('t.tok_rq', public.create_share_link('5e000000-0000-0000-0000-0000000000b1', 'en') ->> 'token', false) \g /dev/null
reset role;
set role anon;
do $$
declare
  r jsonb;
begin
  for i in 1..5 loop
    r := public.share_request(current_setting('t.tok_rq'), pg_temp.req('[]'::jsonb, 'Request number ' || i));
    if r ->> 'status' <> 'received' then
      raise exception 'FAIL: request % of 5 refused: %', i, r;
    end if;
  end loop;
  r := public.share_request(current_setting('t.tok_rq'), pg_temp.req('[]'::jsonb, 'Request number 6'));
  if r::text <> '{"status": "slow_down"}' then
    raise exception 'FAIL: share_request_rate_limits (6th an hour): %', r;
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from private.stock_requests r join private.share_links l on l.id = r.share_link_id
       where l.token_hash = sha256(convert_to(current_setting('t.tok_rq'), 'UTF8'))) <> 5 then
    raise exception 'FAIL: the refused request wrote a row';
  end if;
end $$;
-- Day: a fresh link whose day bucket already holds 20; org: the org's day bucket at 200.
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select set_config('t.tok_day', public.create_share_link('5e000000-0000-0000-0000-0000000000b2', 'en') ->> 'token', false) \g /dev/null
reset role;
insert into private.share_rate (scope_id, kind, span, bucket, n)
select l.id, 'request', 'd', date_trunc('day', now(), 'Europe/Paris'), 20 from private.share_links l
 where l.token_hash = sha256(convert_to(current_setting('t.tok_day'), 'UTF8'));
set role anon;
do $$
begin
  if public.share_request(current_setting('t.tok_day'), pg_temp.req('[]'::jsonb, 'Twenty-first'))::text <> '{"status": "slow_down"}' then
    raise exception 'FAIL: share_request_rate_limits (21st a day)';
  end if;
end $$;
reset role;
delete from private.share_rate where kind = 'request' and span = 'd'
   and scope_id = (select l.id from private.share_links l
                    where l.token_hash = sha256(convert_to(current_setting('t.tok_day'), 'UTF8')));
insert into private.share_rate (scope_id, kind, span, bucket, n)
values ((select id from public.orgs where name = 'TopStock Wholesale'), 'request', 'd', date_trunc('day', now(), 'Europe/Paris'), 200)
on conflict (scope_id, kind, span, bucket) do update set n = 200;
set role anon;
do $$
begin
  if public.share_request(current_setting('t.tok_day'), pg_temp.req('[]'::jsonb, 'Org limit'))::text <> '{"status": "slow_down"}' then
    raise exception 'FAIL: share_request_rate_limits (201st an org-day)';
  end if;
end $$;
reset role;
delete from private.share_rate where scope_id = (select id from public.orgs where name = 'TopStock Wholesale');
-- share_take_day_bucket_is_the_paris_day (Day 7f, 20261022130000): whatever the session's zone, the day and hour buckets
-- are Paris ones. With the session on UTC (production's zone; these tests otherwise run on PGTZ=Europe/Paris, where the
-- old code looked right), a request writes its day rows at Paris midnight, never UTC midnight, and a link whose Paris-day
-- bucket is full is refused.
set timezone = 'UTC';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select set_config('t.tok_tz', public.create_share_link('5e000000-0000-0000-0000-0000000000b2', 'en') ->> 'token', false) \g /dev/null
reset role;
set role anon;
do $$
declare
  r jsonb;
begin
  r := public.share_request(current_setting('t.tok_tz'), pg_temp.req('[]'::jsonb, 'Counted in the Paris day'));
  if r ->> 'status' <> 'received' then
    raise exception 'FAIL: share_take_day_bucket_is_the_paris_day (first request): %', r;
  end if;
end $$;
reset role;
do $$
declare
  l constant uuid := (select id from private.share_links
                       where token_hash = sha256(convert_to(current_setting('t.tok_tz'), 'UTF8')));
  o constant uuid := (select org_id from private.share_links
                       where token_hash = sha256(convert_to(current_setting('t.tok_tz'), 'UTF8')));
  paris_day constant timestamptz := date_trunc('day', now(), 'Europe/Paris');
  paris_hour constant timestamptz := date_trunc('hour', now(), 'Europe/Paris');
begin
  if current_setting('TimeZone') <> 'UTC' or paris_day = date_trunc('day', now()) then
    raise exception 'FAIL: the session must be on UTC, where Paris midnight is another instant';
  end if;
  if (select array_agg(bucket) from private.share_rate where scope_id = l and kind = 'request' and span = 'd')
       is distinct from array[paris_day]
     or (select array_agg(bucket) from private.share_rate where scope_id = o and kind = 'request' and span = 'd')
       is distinct from array[paris_day]
     or (select array_agg(bucket) from private.share_rate where scope_id = l and kind = 'request' and span = 'h')
       is distinct from array[paris_hour] then
    raise exception 'FAIL: share_take_day_bucket_is_the_paris_day: buckets % (want day %, hour %)',
      (select jsonb_agg(jsonb_build_object('span', span, 'bucket', bucket, 'scope', scope_id = l))
         from private.share_rate where scope_id in (l, o) and kind = 'request'), paris_day, paris_hour;
  end if;
  update private.share_rate set n = 20 where scope_id = l and kind = 'request' and span = 'd';
end $$;
set role anon;
do $$
begin
  if public.share_request(current_setting('t.tok_tz'), pg_temp.req('[]'::jsonb, 'Over the Paris day'))::text <> '{"status": "slow_down"}' then
    raise exception 'FAIL: share_take_day_bucket_is_the_paris_day (a full Paris-day bucket must refuse)';
  end if;
end $$;
reset role;
delete from private.share_rate
 where scope_id in (select id from private.share_links where token_hash = sha256(convert_to(current_setting('t.tok_tz'), 'UTF8')))
    or scope_id = (select id from public.orgs where name = 'TopStock Wholesale');
-- The link is revoked again so the lead keeps room under its 3 active links for the tests below.
select set_config('t.tz_id', l.id::text, false) from private.share_links l
 where l.token_hash = sha256(convert_to(current_setting('t.tok_tz'), 'UTF8')) \g /dev/null
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select public.revoke_share_link(current_setting('t.tz_id')::uuid) \g /dev/null
reset role;
reset timezone;
-- share_request_too_many_open: 10 new requests on the link already.
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select set_config('t.tok_open', public.create_share_link('5e000000-0000-0000-0000-0000000000a0', 'en') ->> 'token', false) \g /dev/null
reset role;
begin;
set local session_replication_role = replica;
insert into private.stock_requests (org_id, company_id, share_link_id, source, status, created_at)
select l.org_id, l.company_id, l.id, 'share_link', 'new', now() - g * interval '1 hour'
  from private.share_links l, generate_series(1, 10) g
 where l.token_hash = sha256(convert_to(current_setting('t.tok_open'), 'UTF8'));
commit;
set role anon;
do $$
begin
  if public.share_request(current_setting('t.tok_open'), pg_temp.req('[]'::jsonb, 'Eleventh'))::text <> '{"status": "too_many_open"}' then
    raise exception 'FAIL: share_request_too_many_open';
  end if;
end $$;
reset role;
-- share_request_closed_link
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select set_config('t.tok_closed', public.create_share_link('5e000000-0000-0000-0000-0000000000b2', 'en',
  p_allow_requests => false) ->> 'token', false) \g /dev/null
reset role;
set role anon;
do $$
begin
  if public.share_request(current_setting('t.tok_closed'), pg_temp.req('[]'::jsonb, 'Hello there'))::text <> '{"status": "closed"}'
     or (public.share_view(current_setting('t.tok_closed')) ->> 'allow_requests')::boolean then
    raise exception 'FAIL: share_request_closed_link';
  end if;
end $$;
reset role;
-- share_reader cannot write anything else, even inside the function's transaction settings.
set role share_reader;
do $$
begin
  perform set_config('topstock.share_token_hash', encode(sha256(convert_to(current_setting('t.tok'), 'UTF8')), 'hex'), true);
  perform pg_temp.expect_error($q$update private.share_links set revoked_at = null$q$, '42501');
  perform pg_temp.expect_error($q$update private.share_links set open_count = 0, language = 'en'$q$, '42501');
  perform pg_temp.expect_error($q$insert into private.stock_requests (org_id, company_id, source) values
    ((select id from public.orgs limit 1), '5e000000-0000-0000-0000-0000000000a0', 'share_link')$q$, '42501');
end $$;
reset role;

-- 8. The token: token_hash_not_readable_by_authenticated, token_hash_not_in_audit, share_link_client_token_hash_ignored,
--    share_token_format, share_link_counters_not_writable -----------------------------------------------------------
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select set_config('t.made', public.create_share_link('5e000000-0000-0000-0000-0000000000a0', 'en', 'Salon')::text, false) \g /dev/null
do $$
begin
  perform pg_temp.expect_error('select token_hash from private.share_links', '42501');
  perform pg_temp.expect_error('select * from private.share_links', '42501');
  -- share_link_client_token_hash_ignored: a client cannot even name the column.
  perform pg_temp.expect_error($q$insert into private.share_links (company_id, language, token_hash)
    values ('5e000000-0000-0000-0000-0000000000a0', 'en', sha256('x'))$q$, '42501');
  perform pg_temp.expect_error($q$insert into private.share_links (company_id, language, created_by)
    values ('5e000000-0000-0000-0000-0000000000a0', 'en', '00000000-0000-0000-0000-0000000000b1')$q$, '42501');
  -- share_link_counters_not_writable
  perform pg_temp.expect_error($q$update private.share_links set open_count = 99$q$, '42501');
  perform pg_temp.expect_error($q$update private.share_links set request_count = 0, last_opened_at = now()$q$, '42501');
  perform pg_temp.expect_error($q$update private.share_links set company_id = '5e000000-0000-0000-0000-0000000000b1'$q$, '42501');
end $$;
reset role;
do $$
declare
  made jsonb := current_setting('t.made')::jsonb;
  l record;
begin
  select * into l from private.share_links where id = (made ->> 'id')::uuid;
  if made ->> 'token' !~ '^tss_[A-Za-z0-9_-]{43}$' or l.token_hash <> sha256(convert_to(made ->> 'token', 'UTF8'))
     or l.token_hint <> right(made ->> 'token', 4) or l.label <> 'Salon' or l.signature <> 'Ada'
     or l.created_by <> '00000000-0000-0000-0000-00000000000a'
     or abs(extract(epoch from l.expires_at - (now() + interval '90 days'))) > 60
     or (select count(distinct token_hash) from private.share_links) <> (select count(*) from private.share_links) then
    raise exception 'FAIL: share_token_format: %', made;
  end if;
  if current_setting('topstock.new_share_token', true) not in ('', null) and current_setting('topstock.new_share_token', true) is not null then
    raise exception 'FAIL: the new token stayed in the session';
  end if;
  if has_column_privilege('authenticated', 'private.share_links', 'token_hash', 'SELECT')
     or has_column_privilege('authenticated', 'private.share_links', 'token_hash', 'INSERT')
     or has_column_privilege('authenticated', 'private.share_links', 'token_hash', 'UPDATE') then
    raise exception 'FAIL: token_hash_not_readable_by_authenticated';
  end if;
  if exists (select 1 from public.audit_log a where a.table_name = 'share_links' and a.diff_json::text like '%token_hash%') then
    raise exception 'FAIL: token_hash_not_in_audit';
  end if;
  if not exists (select 1 from public.audit_log a where a.table_name = 'share_links' and a.action = 'insert') then
    raise exception 'FAIL: link creation is not audited';
  end if;
end $$;

-- The guard makes the token even for a row inserted past the grants (a maintenance session acting for an admin): a
-- planted hash is replaced.
do $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  insert into private.share_links (company_id, language, token_hash, token_hint, expires_at)
  values ('5e000000-0000-0000-0000-0000000000f1', 'en', sha256(convert_to('planted', 'UTF8')), 'xxxx', now() + interval '2 days')
  returning id into v_id;
  if (select token_hash = sha256(convert_to('planted', 'UTF8')) or token_hint = 'xxxx' from private.share_links where id = v_id) then
    raise exception 'FAIL: share_link_client_token_hash_ignored (the guard kept a planted hash)';
  end if;
  delete from private.share_links where id = v_id;
  perform set_config('request.jwt.claims', '', false);
end $$;

-- 9. Team rules: create_link_needs_editor_and_fresh_code, revoke_is_permanent, expiry_bounds_and_extension_needs_code,
--    max_links_per_lead, replace_revokes_old, kill_switch_disables_all, enable_sharing_needs_admin_fresh_code ---------
set role authenticated;
do $$
begin
  -- A rep on someone else's lead; a stale code; aal1; another org's lead.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1', 'aal2', 30);
  perform pg_temp.expect_error($q$select public.create_share_link('5e000000-0000-0000-0000-0000000000b1', 'en')$q$, '42501');
  -- The same rep straight into the table (fresh code, granted columns only): the insert policy's editor check refuses.
  perform pg_temp.expect_error($q$insert into private.share_links (company_id, language)
    values ('5e000000-0000-0000-0000-0000000000b1', 'en')$q$, '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 900);
  perform pg_temp.expect_error($q$select public.create_share_link('5e000000-0000-0000-0000-0000000000b1', 'en')$q$, '42501', 'step_up');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal1');
  perform pg_temp.expect_error($q$select public.create_share_link('5e000000-0000-0000-0000-0000000000b1', 'en')$q$, '42501', 'forbidden');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform pg_temp.expect_error($q$select public.create_share_link('5e000000-0000-0000-0000-0000000000c1', 'en')$q$, 'P0002');
  perform pg_temp.expect_error($q$select public.create_share_link('5e000000-0000-0000-0000-0000000000b1', 'de')$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.create_share_link('5e000000-0000-0000-0000-0000000000b1', 'en', p_expires_days => 367)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.create_share_link('5e000000-0000-0000-0000-0000000000b1', 'en', p_label => 'x' || chr(8238))$q$, '22023', 'label');
  -- The lead's own rep (fresh code) may; a rep sees only their leads' links.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  if public.create_share_link('5e000000-0000-0000-0000-0000000000b2', 'en') ->> 'token' is null then
    raise exception 'FAIL: the lead''s owner could not make a link';
  end if;
  if exists (select 1 from public.list_share_links(p_active_only => false) l
              where l.company_id not in ('5e000000-0000-0000-0000-0000000000b1', '5e000000-0000-0000-0000-0000000000b2')) then
    raise exception 'FAIL: a rep sees another lead''s links';
  end if;
end $$;
reset role;
-- max_links_per_lead (3 active on a fresh lead, the 4th refused), replace_revokes_old.
do $$
begin
  perform set_config('request.jwt.claims', '', false);
  insert into public.companies (id, org_id, name, owner_id) select '5e000000-0000-0000-0000-0000000000d0', o.id,
    'SH Caps', '00000000-0000-0000-0000-00000000000a' from public.orgs o where o.name = 'TopStock Wholesale';
end $$;
set role authenticated;
do $$
declare
  first_id uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  first_id := (public.create_share_link('5e000000-0000-0000-0000-0000000000d0', 'en') ->> 'id')::uuid;
  perform public.create_share_link('5e000000-0000-0000-0000-0000000000d0', 'en');
  perform public.create_share_link('5e000000-0000-0000-0000-0000000000d0', 'en');
  perform pg_temp.expect_error($q$select public.create_share_link('5e000000-0000-0000-0000-0000000000d0', 'en')$q$, '22023', 'too_many_links');
  perform public.create_share_link('5e000000-0000-0000-0000-0000000000d0', 'fr', p_replace => true);
  if (select count(*) from public.list_share_links('5e000000-0000-0000-0000-0000000000d0')) <> 1
     or (select count(*) from public.list_share_links('5e000000-0000-0000-0000-0000000000d0', false)) <> 4 then
    raise exception 'FAIL: replace_revokes_old';
  end if;
  -- revoke_is_permanent
  perform pg_temp.expect_error(format($q$update private.share_links set revoked_at = null where id = %L$q$, first_id), '22023', 'revoked');
  perform pg_temp.expect_error(format($q$update private.share_links set label = 'again' where id = %L$q$, first_id), '22023', 'revoked');
  perform pg_temp.expect_error(format($q$select public.revoke_share_link(%L)$q$, first_id), 'P0002');
  -- expiry_bounds_and_extension_needs_code
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 900);
  perform pg_temp.expect_error(format($q$select public.extend_share_link(%L, 30)$q$,
    (select l.id from public.list_share_links('5e000000-0000-0000-0000-0000000000d0') l limit 1)), '42501', 'step_up');
  perform pg_temp.expect_error(format($q$update private.share_links set expires_at = now() + interval '5 days' where id = %L$q$,
    (select l.id from public.list_share_links('5e000000-0000-0000-0000-0000000000d0') l limit 1)), '42501', 'step_up');
  -- A revoke needs no fresh code.
  perform public.revoke_share_link((select l.id from public.list_share_links('5e000000-0000-0000-0000-0000000000d0') l limit 1));
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform pg_temp.expect_error(format($q$select public.extend_share_link(%L, 0)$q$, gen_random_uuid()), '22023', 'expiry');
  perform pg_temp.expect_error(format($q$select public.extend_share_link(%L, 367)$q$, gen_random_uuid()), '22023', 'expiry');
  perform pg_temp.expect_error(format($q$select public.extend_share_link(%L, 30)$q$, gen_random_uuid()), 'P0002');
  perform pg_temp.expect_error($q$update private.share_links set expires_at = now() + interval '400 days' where revoked_at is null$q$, '22023', 'expiry');
end $$;
reset role;
-- extend_counts_against_the_cap: an expired link brought back by Extend is an active link like any other, so a lead
-- with 3 active links cannot get a 4th that way (the cap trigger runs on a new expiry too).
do $$
begin
  perform set_config('request.jwt.claims', '', false);
  insert into public.companies (id, org_id, name, owner_id) select '5e000000-0000-0000-0000-0000000000d1', o.id,
    'SH Caps extend', '00000000-0000-0000-0000-00000000000a' from public.orgs o where o.name = 'TopStock Wholesale';
end $$;
set role authenticated;
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform set_config('t.caps_old', public.create_share_link('5e000000-0000-0000-0000-0000000000d1', 'en') ->> 'id', false);
end $$;
reset role;
do $$
begin
  perform set_config('request.jwt.claims', '', false);   -- the owner ages the link (fixture; the guard lets postgres)
  update private.share_links set expires_at = now() - interval '1 day' where id = current_setting('t.caps_old')::uuid;
end $$;
set role authenticated;
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform public.create_share_link('5e000000-0000-0000-0000-0000000000d1', 'en');
  perform public.create_share_link('5e000000-0000-0000-0000-0000000000d1', 'en');
  perform public.create_share_link('5e000000-0000-0000-0000-0000000000d1', 'en');
  perform pg_temp.expect_error(format($q$select public.extend_share_link(%L, 30)$q$, current_setting('t.caps_old')), '22023', 'too_many_links');
  -- Extending one of the 3 active links stays allowed (3 is the cap, not past it).
  perform public.extend_share_link((select l.id from public.list_share_links('5e000000-0000-0000-0000-0000000000d1') l limit 1), 30);
  if (select count(*) from public.list_share_links('5e000000-0000-0000-0000-0000000000d1')) <> 3 then
    raise exception 'FAIL: extend_counts_against_the_cap';
  end if;
end $$;
reset role;
do $$
declare
  l record;
begin
  -- A fresh code extends a working link.
  perform set_config('request.jwt.claims', '', false);
  select * into l from private.share_links where token_hash = sha256(convert_to(current_setting('t.tok_rate'), 'UTF8'));
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  set local role authenticated;
  if abs(extract(epoch from (public.extend_share_link(l.id, 200) ->> 'expires_at')::timestamptz - (now() + interval '200 days'))) > 60 then
    raise exception 'FAIL: extend_share_link';
  end if;
end $$;
-- enable_sharing_needs_admin_fresh_code, kill_switch_disables_all
set role authenticated;
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);        -- rep
  perform pg_temp.expect_error('select public.set_sharing_enabled(false)', '42501', 'forbidden');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 900);       -- manager switches it off
  if (public.set_sharing_enabled(false) ->> 'sharing_enabled')::boolean then
    raise exception 'FAIL: a manager could not switch sharing off';
  end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);        -- and not on, even fresh
  perform pg_temp.expect_error('select public.set_sharing_enabled(true)', '42501', 'forbidden');
  perform pg_temp.expect_error($q$update private.inventory_settings set sharing_enabled = true$q$, '42501', 'forbidden');
  perform pg_temp.expect_error($q$update private.inventory_settings set hold_days = 30$q$, '42501', 'forbidden');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 900);       -- admin, stale code
  perform pg_temp.expect_error('select public.set_sharing_enabled(true)', '42501', 'step_up');
  perform pg_temp.expect_error($q$update private.inventory_settings set sharing_enabled = true$q$, '42501', 'step_up');
end $$;
reset role;
set role anon;
do $$
begin
  if public.share_view(current_setting('t.tok'))::text <> '{"status": "inactive"}'
     or public.share_request(current_setting('t.tok'), pg_temp.req('[]'::jsonb, 'Hello there'))::text <> '{"status": "inactive"}' then
    raise exception 'FAIL: kill_switch_disables_all';
  end if;
end $$;
reset role;
do $$
begin
  if (select s.sharing_changed_by from private.inventory_settings s join public.orgs o on o.id = s.org_id
       where o.name = 'TopStock Wholesale') <> '00000000-0000-0000-0000-0000000000a1' then
    raise exception 'FAIL: sharing_changed_by';
  end if;
end $$;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30) \g /dev/null
select public.set_sharing_enabled(true) \g /dev/null
reset role;

-- 10. A deleted lead takes its links; the import's untouched rule counts links; the ledger still matches ------------
do $$
begin
  if exists (select 1 from private.share_links where company_id = '5e000000-0000-0000-0000-0000000000f0') then
    raise exception 'FAIL: a deleted lead kept its links';
  end if;
  if pg_get_functiondef('private.lead_import_untouched(uuid, integer)'::regprocedure) not like '%private.share_links%' then
    raise exception 'FAIL: lead_import_untouched_counts_links';
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
\echo 'share_attack: all checks passed'
