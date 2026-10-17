-- Bugs audit of 17 Oct 2026, finding L1: releasing a hold from a lead's Stock tab and pressing Undo held the pieces
-- again without the hold's note, because get_lead_stock did not return it. Sorts after
-- 20261024080000_pipeline_board_order. A read-only function only: no table, policy or check changes.
--
-- public.get_lead_stock's holds carry 'note'. It is the same note every signed-in person of the organisation already
-- reads on the product panel (get_product's holds, list_reservations); private.stock_reservations is granted to
-- authenticated in full and its row level security is unchanged. create or replace keeps the signature and its grants.
--
-- Redefines (REBASE when the named migration changes before this one merges):
--   public.get_lead_stock (20261019090000_sales_requests.sql): its body verbatim plus the holds' 'note'.

-- The lead's Stock tab (design 10.4): open requests first (20 at most, with live availability), active holds (with
-- their note), the last 20 sales and the total bought, and whether the caller may sell to this lead.
create or replace function public.get_lead_stock(p_company uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
  v_owner uuid;
  v jsonb;
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  select c.owner_id into v_owner from public.companies c where c.id = p_company;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  select jsonb_build_object(
    'company_id', p_company,
    'can_edit', private.is_manager_or_admin() or v_owner = (select auth.uid()),
    'owner_first_name', (select u.first_name from public.profiles u where u.id = v_owner),
    'requests', (with q as materialized (
                   select r.id, r.created_at, r.status in ('new', 'in_progress') as open
                     from private.stock_requests r where r.company_id = p_company
                    order by r.status in ('new', 'in_progress') desc, r.created_at desc limit 20)
                 select coalesce(jsonb_agg(rj.j order by q.open desc, q.created_at desc), '[]'::jsonb)
                   from q join private.requests_json((select array_agg(q.id) from q)) rj on rj.id = q.id),
    'requests_count', (select count(*) from private.stock_requests r where r.company_id = p_company),
    'holds', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', r.id, 'product_id', r.product_id, 'product_name', p.name, 'location', x.kind,
                       'quantity', r.quantity, 'remaining', r.remaining, 'hold_until', r.hold_until,
                       'ended', r.hold_until < v_today, 'deal_id', r.deal_id, 'created_by', r.created_by,
                       'created_at', r.created_at, 'pieces_per_carton', p.pieces_per_carton, 'price_max', p.price_max,
                       'note', r.note)
                     order by r.hold_until, r.created_at), '[]'::jsonb)
                from private.stock_reservations r
                join public.products p on p.id = r.product_id
                join public.locations x on x.id = r.location_id
               where r.company_id = p_company and r.status = 'active'),
    'sales', (select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc, s.id desc), '[]'::jsonb)
                from public.list_sales(p_company => p_company, p_limit => 20) s),
    'sales_count', (select count(*) from private.orders o where o.company_id = p_company),
    'bought_total', (select coalesce(sum(ol.line_total), 0) from private.orders o
                       join private.order_lines ol on ol.order_id = o.id
                      where o.company_id = p_company and o.status = 'confirmed'))
    into v;
  return v;
end;
$$;
