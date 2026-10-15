-- Day 6d: sales (Warehouse inventory and Supplier Stock), holds from the CRM, client and team stock requests, and the
-- stock automations (design docs/evidence/day6/design.md sections 3.4, 4.5, 5.4, 6.1 to 6.9, 9 and 11).
--
-- * private.orders ("sales"), private.order_lines (pieces, price per piece excluding VAT, below_min flagged by the
--   guard), private.order_line_costs (cost snapshot, managers and admins), private.stock_requests and their lines.
-- * A sale is one transaction (record_sale): the lead locked FOR UPDATE, the order and its lines, then one `ship` row
--   per warehouse line in product order through the stock engine, which uses the lead's holds first (4.5). Undo within
--   120 s by its creator (returns, the holds put back, the lead status put back); cancel later by a manager or admin
--   with a fresh code and a reason (returns only). Sales are never edited.
-- * Holds: placed with post_stock_movement('reserve') as in 6a; extend_reservation changes the end date (90 days at
--   most) with no ledger row.
-- * Automations (definer triggers, owner postgres, revoked from everyone): a Restock task when a CRM movement takes the
--   warehouse available to the reorder point or below; an "Arrived: record the sale" task when Arrived moves a hold to
--   the warehouse. They write through private.insert_system_task with the caller's claims cleared (a system row).
-- * Reads: list_sales, get_sale, get_lead_stock, list_lead_deals_for_stock, list_stock_requests, get_stock_request,
--   stock_alerts.
--
-- Redefines (REBASE when the named migration changes before this one merges):
--   private.stock_movement_a_guard, private.stock_movement_b_apply   (20261018090000_stock_import.sql, 6c, unmerged):
--     the ship and return kinds;
--   private.movement_request_guard and the movement_requests kind check (20261016090000_stock_engine.sql, 6a,
--     unmerged): the sale and stock_request kinds;
--   private.task_guard (20261011120000_activity_hardening.sql; Day 4c may redefine it): the system task links never
--     change and may be set to null by a cascade;
--   private.lead_import_untouched (20261016090000_stock_engine.sql, 6a): a lead with a sale or a request is touched;
--   public.stock_alerts() (20261015150000_home_dashboard.sql, Day 5c, merges first): its null-returning stub gets the
--   real body (create or replace, same signature; decision B, 15 Oct 2026).
-- The client stock link (6e) adds the share branch of stock_request_guard and its request task.

-- ===========================================================================
-- 1. Tables
-- ===========================================================================
create table private.orders (                          -- "sales"
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,   -- shown as "Sale 1042"
  org_id uuid not null references public.orgs (id),
  company_id uuid not null references public.companies (id) on delete restrict,   -- sales are kept records
  deal_id uuid references public.deals (id) on delete set null,
  stock_request_id uuid,                                -- foreign key below
  fulfilment text not null check (fulfilment in ('from_stock', 'direct_from_source')),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  ship_to_country char(2) check (ship_to_country ~ '^[A-Z]{2}$'),
  note text check (char_length(note) <= 1000
                   and note !~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'),
  prev_lead_status text,                                -- set when this sale made the lead a Customer
  created_by uuid not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text check (char_length(cancel_reason) between 3 and 300
                            and cancel_reason !~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'),
  updated_at timestamptz not null default now(),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index orders_company_idx on private.orders (company_id, created_at desc, id desc);
create index orders_org_idx on private.orders (org_id, created_at desc, id desc);
create index orders_deal_idx on private.orders (deal_id) where deal_id is not null;
create index orders_request_idx on private.orders (stock_request_id) where stock_request_id is not null;
create index orders_creator_idx on private.orders (created_by, created_at);

create table private.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references private.orders (id),
  org_id uuid not null references public.orgs (id),
  position smallint not null check (position between 1 and 50),
  product_id uuid references public.products (id),      -- required for from_stock
  product_name text not null check (char_length(product_name) between 1 and 200
                                    and product_name !~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'),
  quantity integer not null check (quantity between 1 and 50000000),   -- pieces
  unit_price numeric(12,4) not null check (unit_price between 0 and 1000000),   -- EUR per piece, excluding VAT
  line_total numeric(14,2) generated always as (round(quantity * unit_price, 2)) stored,
  below_min boolean not null default false,             -- guard-set from price_min at sale time
  unique (order_id, position)
);
create unique index order_lines_product_idx on private.order_lines (order_id, product_id) where product_id is not null;
create index order_lines_product_fk_idx on private.order_lines (product_id) where product_id is not null;
create index order_lines_org_idx on private.order_lines (org_id);

create table private.order_line_costs (                 -- cost snapshot; managers and admins only
  order_line_id uuid primary key references private.order_lines (id),
  org_id uuid not null references public.orgs (id),
  cost_per_piece numeric(14,6) not null
);
create index order_line_costs_org_idx on private.order_line_costs (org_id);

alter table private.stock_movements add constraint stock_movements_order_line_fkey
  foreign key (order_line_id) references private.order_lines (id);
create index movements_order_line_idx on private.stock_movements (order_line_id) where order_line_id is not null;
create unique index movements_ship_once_idx on private.stock_movements (order_line_id) where kind = 'ship';
create unique index movements_return_once_idx on private.stock_movements (order_line_id) where kind = 'return';

create table private.stock_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  company_id uuid not null references public.companies (id) on delete cascade,   -- the client's lead
  share_link_id uuid,                                    -- foreign key added in 6e
  source text not null check (source in ('team', 'share_link')),
  status text not null default 'new' check (status in ('new', 'in_progress', 'done', 'declined')),
  note text check (char_length(note) <= 1000
                   and note !~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'),
  requester_name text check (char_length(requester_name) <= 80
                             and requester_name !~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'),
  language text check (language in ('en', 'fr')),
  idempotency_key uuid,
  created_by uuid,                                       -- null for client requests
  handled_by uuid,
  handled_at timestamptz,
  team_note text check (char_length(team_note) <= 300
                        and team_note !~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source = 'team') = (created_by is not null))
);
create index stock_requests_inbox_idx on private.stock_requests (org_id, status, created_at desc, id desc);
create index stock_requests_company_idx on private.stock_requests (company_id, created_at desc);
create index stock_requests_creator_idx on private.stock_requests (created_by, created_at) where created_by is not null;

create table private.stock_request_lines (
  request_id uuid not null references private.stock_requests (id) on delete cascade,
  position smallint not null check (position between 1 and 20),
  org_id uuid not null references public.orgs (id),
  product_id uuid references public.products (id),
  description text check (char_length(description) between 1 and 200
                          and description !~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'),
  quantity integer not null check (quantity between 1 and 10000000),
  unit text not null check (unit in ('piece', 'carton')),
  pieces integer not null check (pieces between 1 and 50000000),   -- server-computed
  price_shown numeric(12,4),                             -- the max price the client saw; never a promise
  availability text not null check (availability in ('in_warehouse', 'in_transit', 'not_listed')),
  primary key (request_id, position),
  check (product_id is not null or description is not null)
);
create index request_lines_product_idx on private.stock_request_lines (product_id) where product_id is not null;
create index request_lines_org_idx on private.stock_request_lines (org_id);

alter table private.orders add constraint orders_stock_request_fkey
  foreign key (stock_request_id) references private.stock_requests (id) on delete set null;

-- Automation links on tasks (set by the system only; no grant).
alter table public.tasks
  add column source_product_id uuid references public.products (id) on delete set null,
  add column source_request_id uuid references private.stock_requests (id) on delete set null;
create unique index tasks_open_restock_idx on public.tasks (source_product_id)
  where source_product_id is not null and company_id is null and done_at is null and cancelled_at is null;
create unique index tasks_open_request_idx on public.tasks (company_id)
  where source_request_id is not null and done_at is null and cancelled_at is null;
create index tasks_source_request_fk_idx on public.tasks (source_request_id) where source_request_id is not null;

-- Idempotency: a sale and a logged request are RPC requests too (REBASE: 6a's check and guard).
alter table private.movement_requests drop constraint movement_requests_kind_check;
alter table private.movement_requests add constraint movement_requests_kind_check check (kind in (
  'receive', 'adjust_in', 'adjust_out', 'count', 'transfer', 'reserve', 'release', 'create_product', 'sale',
  'stock_request'));
create or replace function private.movement_request_guard() returns trigger
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
                         'create_product', 'sale', 'stock_request') then
    raise exception 'bad request id or kind' using errcode = '22023', hint = 'request';
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- 2. Row level security and grants (deny by default; restrictive require_mfa; column grants only)
-- ===========================================================================
alter table private.orders enable row level security;
alter table private.order_lines enable row level security;
alter table private.order_line_costs enable row level security;
alter table private.stock_requests enable row level security;
alter table private.stock_request_lines enable row level security;
create policy require_mfa on private.orders as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
create policy require_mfa on private.order_lines as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
create policy require_mfa on private.order_line_costs as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
create policy require_mfa on private.stock_requests as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
create policy require_mfa on private.stock_request_lines as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));

-- Sales: seen by their creator, the lead's owner, managers and admins; recorded by an editor of the lead; cancelled by
-- the creator (within 120 s, the guard says) or a manager or admin.
create policy orders_select on private.orders for select to authenticated using (
  org_id = (select private.current_org_id())
  and (created_by = (select auth.uid()) or (select private.is_manager_or_admin())
       or exists (select 1 from public.companies c where c.id = orders.company_id and c.owner_id = (select auth.uid()))));
create policy orders_insert on private.orders for insert to authenticated with check (
  org_id = (select private.current_org_id())
  and exists (select 1 from public.companies c
               where c.id = orders.company_id and c.org_id = orders.org_id
                 and ((select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()))));
create policy orders_update on private.orders for update to authenticated
  using (org_id = (select private.current_org_id())
         and (created_by = (select auth.uid()) or (select private.is_manager_or_admin())))
  with check (org_id = (select private.current_org_id())
              and (created_by = (select auth.uid()) or (select private.is_manager_or_admin())));

create policy order_lines_select on private.order_lines for select to authenticated using (
  org_id = (select private.current_org_id())
  and exists (select 1 from private.orders o where o.id = order_lines.order_id));
create policy order_lines_insert on private.order_lines for insert to authenticated with check (
  org_id = (select private.current_org_id())
  and exists (select 1 from private.orders o where o.id = order_lines.order_id and o.created_by = (select auth.uid())));

create policy order_line_costs_select on private.order_line_costs for select to authenticated using (
  org_id = (select private.current_org_id()) and (select private.is_manager_or_admin()));

-- Requests: seen and handled by the lead's owner, managers and admins (and a team request by the person who logged
-- it); logged by an editor of the lead.
create policy stock_requests_select on private.stock_requests for select to authenticated using (
  org_id = (select private.current_org_id())
  and ((select private.is_manager_or_admin()) or created_by = (select auth.uid())
       or exists (select 1 from public.companies c where c.id = stock_requests.company_id and c.owner_id = (select auth.uid()))));
create policy stock_requests_insert on private.stock_requests for insert to authenticated with check (
  org_id = (select private.current_org_id())
  and exists (select 1 from public.companies c
               where c.id = stock_requests.company_id and c.org_id = stock_requests.org_id
                 and ((select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()))));
create policy stock_requests_update on private.stock_requests for update to authenticated
  using (org_id = (select private.current_org_id())
         and ((select private.is_manager_or_admin())
              or exists (select 1 from public.companies c where c.id = stock_requests.company_id and c.owner_id = (select auth.uid()))))
  with check (org_id = (select private.current_org_id())
              and ((select private.is_manager_or_admin())
                   or exists (select 1 from public.companies c where c.id = stock_requests.company_id and c.owner_id = (select auth.uid()))));

create policy stock_request_lines_select on private.stock_request_lines for select to authenticated using (
  org_id = (select private.current_org_id())
  and exists (select 1 from private.stock_requests r where r.id = stock_request_lines.request_id));
create policy stock_request_lines_insert on private.stock_request_lines for insert to authenticated with check (
  org_id = (select private.current_org_id())
  and exists (select 1 from private.stock_requests r
               where r.id = stock_request_lines.request_id and r.created_by = (select auth.uid())));

revoke all on private.orders, private.order_lines, private.order_line_costs, private.stock_requests,
  private.stock_request_lines from public, anon, authenticated;
grant select on private.orders, private.order_lines, private.order_line_costs, private.stock_requests,
  private.stock_request_lines to authenticated;
grant insert (company_id, deal_id, stock_request_id, fulfilment, ship_to_country, note),
      update (status, cancel_reason) on private.orders to authenticated;
grant insert (order_id, position, product_id, product_name, quantity, unit_price) on private.order_lines to authenticated;
grant insert (company_id, note, idempotency_key), update (status, team_note) on private.stock_requests to authenticated;
grant insert (request_id, position, product_id, description, quantity, unit) on private.stock_request_lines to authenticated;
-- Holds: extend_reservation changes the end date only (the guard below checks who and how far).
grant update (hold_until) on private.stock_reservations to authenticated;
create policy stock_reservations_extend on private.stock_reservations for update to authenticated
  using (org_id = (select private.current_org_id())
         and (created_by = (select auth.uid()) or (select private.is_manager_or_admin())
              or exists (select 1 from public.companies c
                          where c.id = stock_reservations.company_id and c.owner_id = (select auth.uid()))))
  with check (org_id = (select private.current_org_id()));

create trigger set_updated_at before update on private.orders
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on private.stock_requests
  for each row execute function private.set_updated_at();

-- ===========================================================================
-- 3. Guards (invoker; constant messages before the CHECKs, so no typed text reaches an error)
-- ===========================================================================
-- A sale. Insert: who, when and the organisation come from the server; the deal is visible, on this lead and not lost;
-- the lead's status before its first sale is kept (prev_lead_status) so an Undo can put it back; 60 sales a minute per
-- person at most. Update: only confirmed to cancelled, never back: by its creator within 120 s (Undo), or by a manager
-- or admin with a fresh code and a reason of 3 to 300 characters.
create function private.order_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  d record;
  v_status text;
begin
  if caller is null then
    raise exception 'sign in first' using errcode = '42501', hint = 'forbidden';
  end if;
  if tg_op = 'INSERT' then
    new.org_id := private.current_org_id();
    new.created_by := caller;  -- the seller
    new.created_at := now();
    new.status := 'confirmed';
    new.cancelled_at := null;
    new.cancelled_by := null;
    new.cancel_reason := null;
    new.prev_lead_status := null;
    if new.fulfilment is null or new.fulfilment not in ('from_stock', 'direct_from_source') then
      raise exception 'unknown kind of sale' using errcode = '22023', hint = 'fulfilment';
    end if;
    new.note := nullif(btrim(new.note), '');
    if char_length(new.note) > 1000
       or new.note ~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]' then
      raise exception 'the note is too long or has characters that are not allowed' using errcode = '22023', hint = 'note';
    end if;
    if new.ship_to_country is not null and new.ship_to_country !~ '^[A-Z]{2}$' then
      raise exception 'unknown country' using errcode = '22023', hint = 'country';
    end if;
    if new.deal_id is not null then
      select dl.company_id, dl.status into d from public.deals dl where dl.id = new.deal_id;
      if not found or d.company_id is distinct from new.company_id then
        raise exception 'this deal is not on this lead' using errcode = '22023', hint = 'deal_mismatch';
      end if;
      if d.status = 'lost' then
        raise exception 'this deal is lost' using errcode = '22023', hint = 'deal_lost';
      end if;
    end if;
    if new.stock_request_id is not null and not exists (
         select 1 from private.stock_requests r where r.id = new.stock_request_id and r.company_id = new.company_id) then
      raise exception 'this request is not from this lead' using errcode = '22023', hint = 'request_mismatch';
    end if;
    if (select count(*) from (select 1 from private.orders o
                               where o.created_by = caller and o.created_at > now() - interval '60 seconds'
                               limit 60) recent) >= 60 then
      raise exception 'too many sales in a minute' using errcode = '22023', hint = 'rate_limited';
    end if;
    -- The first sale makes the lead a Customer (record_sale changes the status; open question 15).
    select c.lead_status into v_status from public.companies c where c.id = new.company_id;
    if v_status not in ('customer', 'do_not_contact', 'disqualified')
       and not exists (select 1 from private.orders o where o.company_id = new.company_id and o.status = 'confirmed') then
      new.prev_lead_status := v_status;
    end if;
    return new;
  end if;

  -- UPDATE: status and cancel_reason are the only granted columns; the rest never changes.
  if (to_jsonb(new) - array['status', 'cancel_reason', 'cancelled_at', 'cancelled_by', 'updated_at'])
     is distinct from (to_jsonb(old) - array['status', 'cancel_reason', 'cancelled_at', 'cancelled_by', 'updated_at']) then
    raise exception 'a sale cannot be edited: cancel it and record it again' using errcode = '42501', hint = 'not_editable';
  end if;
  if old.status <> 'confirmed' or new.status <> 'cancelled' then
    raise exception 'only a confirmed sale can be cancelled' using errcode = '22023', hint = 'sale_state';
  end if;
  new.cancel_reason := btrim(new.cancel_reason);
  if new.cancel_reason is null or char_length(new.cancel_reason) not between 3 and 300
     or new.cancel_reason ~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]' then
    raise exception 'say why in 3 to 300 characters' using errcode = '22023', hint = 'cancel_reason';
  end if;
  if not (old.created_by = caller and old.created_at > now() - interval '120 seconds' and new.cancel_reason = 'undo') then
    if not private.is_manager_or_admin() then
      raise exception 'only managers and admins cancel a sale' using errcode = '42501', hint = 'forbidden';
    end if;
    if not private.has_recent_aal2(600) then
      raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
    end if;
    if new.cancel_reason = 'undo' then
      raise exception 'say why in 3 to 300 characters' using errcode = '22023', hint = 'cancel_reason';
    end if;
  end if;
  new.cancelled_at := now();
  new.cancelled_by := caller;
  return new;
end;
$$;
create trigger order_guard before insert or update on private.orders
  for each row execute function private.order_guard();

-- A sale line: only for a sale the caller recorded in this transaction. The product's name is copied (a description
-- for a Supplier Stock line with no product); a warehouse line needs an active product; below_min is set from the
-- product's minimum price, and only managers and admins may sell below it.
create function private.order_line_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  o record;
  p record;
begin
  select ord.org_id, ord.fulfilment, ord.status, ord.created_by, ord.created_at into o
    from private.orders ord where ord.id = new.order_id;
  if not found or o.created_by is distinct from caller or o.created_at <> now() or o.status <> 'confirmed' then
    raise exception 'lines are added with their sale only' using errcode = '42501', hint = 'forbidden';
  end if;
  new.org_id := o.org_id;
  if new.position is null or new.position not between 1 and 50 then
    raise exception 'a sale has 1 to 50 lines' using errcode = '22023', hint = 'lines';
  end if;
  if new.quantity is null or new.quantity not between 1 and 50000000 then
    raise exception 'the quantity must be 1 to 50,000,000 pieces' using errcode = '22023', hint = 'quantity';
  end if;
  if new.unit_price is null or new.unit_price not between 0 and 1000000 or new.unit_price <> round(new.unit_price, 4) then
    raise exception 'the price must be 0 to 1,000,000 with 4 decimals at most' using errcode = '22023', hint = 'price';
  end if;
  new.below_min := false;
  if new.product_id is not null then
    select pr.name, pr.price_min, pr.archived_at into p from public.products pr where pr.id = new.product_id;
    if not found then
      raise exception 'product not found' using errcode = 'P0002';
    end if;
    if o.fulfilment = 'from_stock' and p.archived_at is not null then
      raise exception 'this product is archived' using errcode = '22023', hint = 'product_archived';
    end if;
    new.product_name := left(p.name, 200);
    if o.fulfilment = 'from_stock' and p.price_min is not null and new.unit_price < p.price_min then
      new.below_min := true;
      if not private.is_manager_or_admin() then
        raise exception 'only managers and admins sell below the minimum price' using errcode = '42501', hint = 'below_min';
      end if;
    end if;
  else
    if o.fulfilment = 'from_stock' then
      raise exception 'a warehouse line needs a product' using errcode = '22023', hint = 'lines';
    end if;
    new.product_name := btrim(new.product_name);
    if new.product_name is null or char_length(new.product_name) not between 1 and 200
       or new.product_name ~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]' then
      raise exception 'describe the item in 1 to 200 characters' using errcode = '22023', hint = 'description';
    end if;
  end if;
  return new;
end;
$$;
create trigger order_line_guard before insert on private.order_lines
  for each row execute function private.order_line_guard();

-- The cost per piece at sale time, for margins (managers and admins read it). Definer: reps cannot read costs.
create function private.order_line_cost_snapshot() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.product_id is not null then
    insert into private.order_line_costs (order_line_id, org_id, cost_per_piece)
    select new.id, new.org_id, c.cost_per_piece from private.product_costs c where c.product_id = new.product_id;
  end if;
  return null;
end;
$$;
create trigger order_line_cost_snapshot after insert on private.order_lines
  for each row execute function private.order_line_cost_snapshot();

-- A stock request logged by the team (the client link's branch comes with 6e). Insert: source, author, status and
-- organisation from the server; 60 a minute per person. Update: status and the team note only; who handled it and
-- when are set on the first move out of "new".
create function private.stock_request_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
begin
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
       or new.note ~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]' then
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
     or new.team_note ~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]' then
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
create trigger stock_request_guard before insert or update on private.stock_requests
  for each row execute function private.stock_request_guard();

-- A request line: only for a request the caller logged in this transaction. Pieces, the price shown (the max price
-- per piece) and the availability at that moment come from the server.
create function private.stock_request_line_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  r record;
  p record;
begin
  select rq.org_id, rq.created_by, rq.created_at into r from private.stock_requests rq where rq.id = new.request_id;
  if not found or r.created_by is distinct from caller or r.created_at <> now() then
    raise exception 'lines are added with their request only' using errcode = '42501', hint = 'forbidden';
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
     or new.description ~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]' then
    raise exception 'describe the item in 1 to 200 characters' using errcode = '22023', hint = 'description';
  end if;
  if new.product_id is not null then
    select pr.pieces_per_carton, pr.price_max, pr.archived_at,
           coalesce((select l.on_hand - l.reserved from public.stock_levels l join public.locations x on x.id = l.location_id
                      where l.product_id = pr.id and x.kind = 'warehouse'), 0) as wh_available,
           coalesce((select l.on_hand from public.stock_levels l join public.locations x on x.id = l.location_id
                      where l.product_id = pr.id and x.kind = 'transit'), 0) as tr_on_hand
      into p from public.products pr where pr.id = new.product_id;
    if not found then
      raise exception 'product not found' using errcode = 'P0002';
    end if;
    new.pieces := new.quantity * (case when new.unit = 'carton' then p.pieces_per_carton else 1 end);
    new.price_shown := p.price_max;
    new.availability := case when p.archived_at is not null then 'not_listed' when p.wh_available > 0 then 'in_warehouse'
                             when p.tr_on_hand > 0 then 'in_transit' else 'not_listed' end;
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
create trigger stock_request_line_guard before insert on private.stock_request_lines
  for each row execute function private.stock_request_line_guard();

-- Extending a hold: its end date only, today to today + 90 (Europe/Paris), while it is active. The engine's own
-- updates run as postgres (the definer apply step) and are left alone.
create function private.reservation_extend_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
begin
  if current_user = 'postgres' then
    return new;
  end if;
  if (to_jsonb(new) - 'hold_until') is distinct from (to_jsonb(old) - 'hold_until') then
    raise exception 'only the end date of a hold changes' using errcode = '42501', hint = 'not_editable';
  end if;
  if old.status <> 'active' then
    raise exception 'this hold cannot change' using errcode = '22023', hint = 'reservation_state';
  end if;
  if new.hold_until is null or new.hold_until not between v_today and v_today + 90 then
    raise exception 'a hold ends today or within 90 days' using errcode = '22023', hint = 'hold_until';
  end if;
  return new;
end;
$$;
create trigger reservation_extend_guard before update on private.stock_reservations
  for each row execute function private.reservation_extend_guard();

-- ===========================================================================
-- 4. System tasks and the stock automations (definer, owner postgres, revoked from everyone; called by triggers only)
-- ===========================================================================
-- Constant titles in the assignee's language, with French typography (a narrow no-break space before ":"). No text a
-- client typed ever reaches a title; product names are cut to 200 characters.
create function private.stock_task_title(p_key text, p_lang text, p_arg text) returns text
language sql immutable set search_path = '' as $$
  select case p_key
    when 'restock' then case when p_lang = 'fr' then 'Réapprovisionner : ' else 'Restock: ' end || left(coalesce(p_arg, ''), 200)
    when 'request' then case when p_lang = 'fr' then 'Demande de stock (lien client)' else 'Stock request (client link)' end
    when 'arrived' then case when p_lang = 'fr' then 'Arrivé : enregistrer la vente de ' else 'Arrived: record the sale of ' end
                        || left(coalesce(p_arg, ''), 200)
    when 'integrity' then case when p_lang = 'fr' then 'Le contrôle du stock a trouvé un écart' else 'Stock check found a difference' end
  end
$$;

-- A task written by the system: no creator, due today in the assignee's time zone, at most one open per subject (the
-- partial unique indexes). The caller's claims are cleared for the insert (so the task guards treat it as system work)
-- and put back after it.
create function private.insert_system_task(p_org uuid, p_assignee uuid, p_title_key text, p_title_arg text,
                                           p_company uuid, p_product uuid, p_request uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_lang text;
  v_tz text;
  v_id uuid;
begin
  if p_assignee is null then
    return null;
  end if;
  select coalesce(p.language, 'en'), coalesce(nullif(p.timezone, ''), 'Europe/Paris') into v_lang, v_tz
    from public.profiles p where p.id = p_assignee and p.org_id = p_org;
  if not found then
    return null;
  end if;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  insert into public.tasks (org_id, assignee_id, created_by, kind, title, due_date, company_id, source_product_id,
                            source_request_id)
  values (p_org, p_assignee, null, 'todo', private.stock_task_title(p_title_key, v_lang, p_title_arg),
          (now() at time zone v_tz)::date, p_company, p_product, p_request)
  on conflict do nothing
  returning id into v_id;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  return v_id;
end;
$$;

-- Restock (design 6.7): a CRM movement that takes the warehouse available from above the reorder point to it or below
-- opens one task for the alert assignee (none while one is open). Imports, their undo and expiry never do.
create function private.stock_low_automation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_rp integer;
  v_name text;
  v_after integer := new.on_hand_after - new.reserved_after;
  v_before integer := (new.on_hand_after - new.reserved_after) - (new.d_on_hand - new.d_reserved);
begin
  if new.kind in ('import_in', 'import_out', 'undo_in', 'undo_out', 'expire') or v_after >= v_before then
    return null;
  end if;
  if not exists (select 1 from public.locations l where l.id = new.location_id and l.kind = 'warehouse') then
    return null;
  end if;
  select p.reorder_point, p.name into v_rp, v_name from public.products p where p.id = new.product_id;
  if v_rp is null or not (v_before > v_rp and v_rp >= v_after) then
    return null;
  end if;
  perform private.insert_system_task(new.org_id, (select s.alert_assignee_id from private.inventory_settings s
                                                   where s.org_id = new.org_id),
                                     'restock', v_name, null, new.product_id, null);
  return null;
end;
$$;
create trigger stock_low_automation after insert on private.stock_movements
  for each row execute function private.stock_low_automation();

-- Arrived (design 6.4 step 4): a hold moved to the warehouse (whole, or the part split from it) gives its creator a task
-- "Arrived: record the sale of {product}" on the hold's lead, due today.
create function private.hold_arrived_task() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  if not exists (select 1 from public.locations l where l.id = new.location_id and l.kind = 'warehouse') then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.location_id = new.location_id then
    return null;
  end if;
  select p.name into v_name from public.products p where p.id = new.product_id;
  perform private.insert_system_task(new.org_id, new.created_by, 'arrived', v_name, new.company_id, null, null);
  return null;
end;
$$;
create trigger hold_arrived_task_moved after update of location_id on private.stock_reservations
  for each row execute function private.hold_arrived_task();
create trigger hold_arrived_task_split after insert on private.stock_reservations
  for each row when (new.split_from is not null) execute function private.hold_arrived_task();

revoke all on function private.stock_task_title(text, text, text), private.insert_system_task(uuid, uuid, text, text, uuid, uuid, uuid),
  private.stock_low_automation(), private.hold_arrived_task(), private.order_line_cost_snapshot()
  from public, anon, authenticated;

-- The task guard (REBASE: from 20261011120000_activity_hardening.sql; Day 4c may redefine it): the system links
-- (source_product_id, source_request_id) never change, except to null by a cascade from a deleted product or request.
create or replace function private.task_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  changed text[];
  check_title boolean := true;
  check_due boolean := true;
begin
  if caller is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := caller;
    new.done_at := null;
    new.completed_by := null;
    new.cancelled_at := null;
    new.source_product_id := null;
    new.source_request_id := null;
    new.assignee_id := coalesce(new.assignee_id, caller);
    if new.kind is null or new.kind not in ('todo', 'call', 'meeting') then
      raise exception 'unknown kind of task' using errcode = '22023', hint = 'task_kind';
    end if;
    -- A follow-up made from an entry: the caller's own entry, on the same lead, logged in the last 10 seconds
    -- (log_activity, 4b, makes both in one transaction).
    if new.source_activity_id is not null and not exists (
         select 1 from public.activities a
          where a.id = new.source_activity_id and a.user_id = caller and a.company_id = new.company_id
            and a.created_at > now() - interval '10 seconds') then
      raise exception 'a task can only come from your own entry on this lead, just logged'
        using errcode = '42501', hint = 'source';
    end if;
    -- Flood guard: at most 60 tasks a minute per person.
    if (select count(*) from (select 1 from public.tasks t
                               where t.created_by = caller and t.created_at > now() - interval '60 seconds'
                               limit 60) recent) >= 60 then
      raise exception 'too many tasks in a minute' using errcode = '22023', hint = 'rate_limited';
    end if;
  else
    select coalesce(array_agg(n.key order by n.key), '{}') into changed
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value and n.key <> 'updated_at';
    -- A referential SET NULL from a contact, entry, profile, product or request delete (spike S5).
    if pg_trigger_depth() > 1
       and changed <@ array['assignee_id', 'contact_id', 'created_by', 'source_activity_id', 'source_product_id',
                            'source_request_id']
       and (new.assignee_id is null or new.assignee_id is not distinct from old.assignee_id)
       and (new.contact_id is null or new.contact_id is not distinct from old.contact_id)
       and (new.created_by is null or new.created_by is not distinct from old.created_by)
       and (new.source_activity_id is null or new.source_activity_id is not distinct from old.source_activity_id)
       and (new.source_product_id is null or new.source_product_id is not distinct from old.source_product_id)
       and (new.source_request_id is null or new.source_request_id is not distinct from old.source_request_id) then
      return new;
    end if;
    -- Only the granted fields may change; who made the task, its lead, kind, source and request never do.
    if not changed <@ array['assignee_id', 'cancelled_at', 'completed_by', 'contact_id', 'done_at', 'due_at',
                            'due_date', 'title'] then
      raise exception 'this part of a task cannot change' using errcode = '42501', hint = 'not_editable';
    end if;
    -- Done and dismissed are switches: the client turns them on or off, the server sets the time and who did it.
    if old.done_at is null and new.done_at is not null then
      new.done_at := now();
      new.completed_by := caller;
    elsif old.done_at is not null and new.done_at is null then
      new.completed_by := null;
    else
      new.done_at := old.done_at;
      new.completed_by := old.completed_by;
    end if;
    if old.cancelled_at is null and new.cancelled_at is not null then
      new.cancelled_at := now();
    elsif not (old.cancelled_at is not null and new.cancelled_at is null) then
      new.cancelled_at := old.cancelled_at;
    end if;
    if new.done_at is not null and new.cancelled_at is not null then
      raise exception 'a task cannot be done and dismissed at once' using errcode = '22023', hint = 'state';
    end if;
    check_title := new.title is distinct from old.title;
    check_due := new.due_date is distinct from old.due_date or new.due_at is distinct from old.due_at;
  end if;

  -- Constant messages before the CHECKs, so a title never reaches the logs.
  if check_title then
    new.title := btrim(new.title);
    if new.title is null or char_length(new.title) not between 1 and 300
       or new.title ~ '[\u0001-\u001F\u007F-\u009F‪-‮⁦-⁩]' then
      raise exception 'a task title needs 1 to 300 characters, without control characters'
        using errcode = '22023', hint = 'task_title';
    end if;
  end if;
  if check_due then
    if new.due_date is not null and new.due_at is not null then
      raise exception 'a task has a date or a time, not both' using errcode = '22023', hint = 'task_due';
    end if;
    if new.kind = 'meeting' and new.due_at is null then
      raise exception 'a meeting needs a time' using errcode = '22023', hint = 'task_due';
    end if;
    if new.due_date not between (now() - interval '5 years')::date and (now() + interval '5 years')::date
       or new.due_at not between now() - interval '5 years' and now() + interval '5 years' then
      raise exception 'the date is out of range' using errcode = '22023', hint = 'bounds';
    end if;
  end if;
  return new;
end;
$$;

-- A lead with a sale or a stock request has history: an import undo keeps it (REBASE: 6a's definition).
create or replace function private.lead_import_untouched(p_batch uuid, p_limit integer) returns setof uuid
language sql stable set search_path = '' as $$
  select c.id from public.companies c
   where c.import_batch_id = p_batch and c.updated_at = c.created_at
     and not exists (select 1 from public.activities a where a.company_id = c.id)
     and not exists (select 1 from public.contacts k where k.company_id = c.id)
     and not exists (select 1 from public.deals d where d.company_id = c.id)
     and not exists (select 1 from public.tasks t where t.company_id = c.id)
     and not exists (select 1 from private.stock_reservations r where r.company_id = c.id)
     and not exists (select 1 from private.orders o where o.company_id = c.id)
     and not exists (select 1 from private.stock_requests q where q.company_id = c.id)
   order by c.id
   limit p_limit
$$;

-- ===========================================================================
-- 5. The stock engine learns ship and return (REBASE: copied from 20261018090000_stock_import.sql, 6c, unmerged)
-- ===========================================================================
-- The guard: ship and return need a sale line of a warehouse sale (recorded, or cancelled, by the caller in this
-- transaction). The apply step: ship uses the lead's holds first and records each use; return puts pieces back.
create or replace function private.stock_movement_a_guard() returns trigger
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
  bt record;
  sl record;
begin
  -- Server-set columns: whatever the row says, these come from the server and the engine.
  new.created_at := now();
  new.user_id := case when new.kind = 'expire' then null else caller end;
  new.d_on_hand := 0;
  new.d_reserved := 0;
  new.on_hand_after := 0;
  new.reserved_after := 0;
  new.level_version := 0;

  -- Kinds that can be posted. 6c adds the stock sheet's import_* and undo_* (only with their import); 6d adds ship and
  -- return (only with their sale line).
  if new.kind is null or new.kind not in ('receive', 'adjust_in', 'adjust_out', 'count', 'transfer_out', 'transfer_in',
                                          'reserve', 'release', 'expire', 'import_in', 'import_out', 'undo_in',
                                          'undo_out', 'ship', 'return')
     or (new.kind in ('import_in', 'import_out', 'undo_in', 'undo_out') and new.import_batch_id is null)
     or (new.kind in ('ship', 'return') and new.order_line_id is null) then
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
  if (new.order_line_id is not null) <> (new.kind in ('ship', 'return'))
     or (new.import_batch_id is not null
         and new.kind not in ('import_in', 'import_out', 'undo_in', 'undo_out', 'transfer_out', 'transfer_in')) then
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
     or (new.kind = 'transfer_in' and v_place <> 'warehouse')
     or (new.kind in ('ship', 'return') and v_place <> 'warehouse') then
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

  -- A stock sheet import (6c, design 4.3 and 7.5): a stock batch of this organisation; its uploader admin with a fresh
  -- code while it is committing (import rows and the transfers of products that arrived), any admin with a fresh code
  -- while it is being undone (undo rows); the commit or undo RPC's transaction marker for that batch; and a
  -- compare-and-set on hand for every import and undo row.
  if new.import_batch_id is not null then
    select b.kind, b.status, b.uploaded_by, b.org_id into bt from public.import_batches b where b.id = new.import_batch_id;
    if not found or bt.kind <> 'stock' or bt.org_id <> v_org then
      raise exception 'this document is not available' using errcode = '22023', hint = 'document';
    end if;
    if not trusted then
      if not private.is_admin() then
        raise exception 'only admins import stock sheets' using errcode = '42501', hint = 'forbidden';
      end if;
      if not private.has_recent_aal2(600) then
        raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
      end if;
      if current_setting('topstock.stock_batch_op', true) is distinct from new.import_batch_id::text then
        raise exception 'this document is not available' using errcode = '22023', hint = 'document';
      end if;
    end if;
    if new.kind in ('undo_in', 'undo_out') then
      if bt.status <> 'rolling_back' then
        raise exception 'this import is not being undone' using errcode = '22023', hint = 'document';
      end if;
    elsif bt.status <> 'committing' or (not trusted and bt.uploaded_by is distinct from caller) then
      raise exception 'only the person importing this sheet can post its rows' using errcode = '42501', hint = 'forbidden';
    end if;
    if new.kind in ('import_in', 'import_out', 'undo_in', 'undo_out') and new.expected_on_hand is null then
      raise exception 'an import row needs the stock it expects' using errcode = '22023', hint = 'document';
    end if;
  end if;

  -- Who may post it, and its document (design 4.3, the table per kind).
  if new.kind in ('import_in', 'import_out', 'undo_in', 'undo_out') then
    new.reason := case when new.kind in ('undo_in', 'undo_out') then 'import_undo' else 'import' end;
    new.company_id := null;
    new.deal_id := null;
    new.reservation_id := null;
  elsif new.kind in ('ship', 'return') then
    -- A sale (6d, design 4.3): the line of a warehouse sale, same product and quantity, read under the caller's row level
    -- security. Ship: the sale is confirmed and was recorded by the caller in this transaction. Return: the sale was
    -- cancelled by the caller in this transaction. The lead and the deal come from the sale, never from the row.
    select ol.product_id, ol.quantity, o.fulfilment, o.status, o.created_by, o.created_at, o.cancelled_by,
           o.cancelled_at, o.cancel_reason, o.company_id, o.deal_id
      into sl from private.order_lines ol join private.orders o on o.id = ol.order_id where ol.id = new.order_line_id;
    if not found or sl.product_id is distinct from new.product_id or sl.quantity is distinct from new.qty
       or sl.fulfilment <> 'from_stock' then
      raise exception 'this document is not available' using errcode = '22023', hint = 'document';
    end if;
    if new.kind = 'ship' then
      if trusted or sl.status <> 'confirmed' or sl.created_by is distinct from caller or sl.created_at <> now() then
        raise exception 'stock leaves only with a sale recorded now' using errcode = '42501', hint = 'forbidden';
      end if;
      new.reason := 'sold';
    else
      if trusted or sl.status <> 'cancelled' or sl.cancelled_by is distinct from caller or sl.cancelled_at <> now() then
        raise exception 'stock comes back only with a sale cancelled now' using errcode = '42501', hint = 'forbidden';
      end if;
      new.reason := case when sl.cancel_reason = 'undo' then 'sale_undone' else 'sale_cancelled' end;
    end if;
    new.company_id := sl.company_id;
    new.deal_id := sl.deal_id;
    new.reservation_id := null;
  elsif new.kind in ('receive', 'adjust_in', 'adjust_out', 'count') then
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
    -- An import-tagged transfer (a product the sheet now lists in the warehouse) was checked above.
    if not trusted and new.import_batch_id is null and not private.is_manager_or_admin() then
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
            and m.import_batch_id is not distinct from new.import_batch_id
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
  -- A transfer_in is not checked: it pairs with a transfer_out posted by the same person in this transaction, which was.
  -- A stock sheet's rows (an import posts hundreds in one call) are not counted either: they need an admin's fresh code
  -- and the import's own transaction marker.
  if not trusted and new.kind <> 'transfer_in' and new.import_batch_id is null and (select count(*) from (select 1 from private.stock_movements m
                                             where m.user_id = caller and m.created_at > now() - interval '60 seconds'
                                               and (m.kind <> 'release' or m.reason = 'manual')
                                             limit 120) recent) >= 120 then
    raise exception 'too many stock changes in a minute' using errcode = '22023', hint = 'rate_limited';
  end if;
  return new;
end;
$$;

-- The apply step: an undo row is a CRM change (crm_moved true, last_onhand_batch_id cleared); import rows and import
-- transfers set the level "as the sheet says". Copied from 20261016090000_stock_engine.sql (6a).
create or replace function private.stock_movement_b_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
  -- An import row or an import-tagged transfer sets the stock "as the sheet says" (crm_moved false, the batch as the last
  -- to change on hand); an undo row is a CRM change like any other (6c).
  is_import constant boolean := new.import_batch_id is not null and new.kind not in ('undo_in', 'undo_out');
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
  v_use integer;
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
    select array_agg(l.id order by l.id), (array_agg(l.id) filter (where l.kind = 'warehouse'))[1] into v_locs, v_wh
      from public.locations l where l.org_id = new.org_id;
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
    when 'ship' then
      -- A sale uses the lead's holds at this level first (design 4.5): those for the sale's deal, then the lead's holds
      -- with no deal, oldest first, up to the quantity. Each one used gives a stock_hold_uses row (an Undo puts it back).
      d_on := -q;
      v_left := q;
      for h in select r.* from private.stock_reservations r
                where r.product_id = new.product_id and r.location_id = new.location_id and r.status = 'active'
                  and r.company_id = new.company_id and (r.deal_id is null or r.deal_id = new.deal_id)
                order by (r.deal_id is not null) desc, r.created_at, r.id
                  for update loop
        exit when v_left = 0;
        v_use := least(v_left, h.remaining);
        update private.stock_reservations r
           set remaining = r.remaining - v_use,
               status = case when r.remaining - v_use = 0 then 'fulfilled' else r.status end,
               closed_at = case when r.remaining - v_use = 0 then now() end,
               closed_by = case when r.remaining - v_use = 0 then new.user_id end,
               close_reason = case when r.remaining - v_use = 0 then 'sold' end
         where r.id = h.id;
        insert into private.stock_hold_uses (movement_id, reservation_id, org_id, pieces)
        values (new.id, h.id, new.org_id, v_use);
        v_left := v_left - v_use;
        d_res := d_res - v_use;
      end loop;
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


-- ===========================================================================
-- 6. Audit: sales and requests, without the notes (a client's words never reach the audit log)
-- ===========================================================================
create function private.audit_sales_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  hidden constant text[] := array['note', 'requester_name', 'idempotency_key'];
  rec jsonb := to_jsonb(new) - hidden;
  diff jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value)) into diff
      from jsonb_each(to_jsonb(new) - hidden) n
      join jsonb_each(to_jsonb(old) - hidden) o using (key)
     where n.value is distinct from o.value and n.key <> 'updated_at';
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
create trigger audit_sales_row after insert or update on private.orders
  for each row execute function private.audit_sales_row();
create trigger audit_sales_row after insert or update on private.stock_requests
  for each row execute function private.audit_sales_row();
revoke all on function private.audit_sales_row() from public, anon, authenticated;

-- ===========================================================================
-- 7. RPCs (design 5.4 and 6): SECURITY INVOKER, static SQL; the guards, the policies and the engine decide.
--    Errors: 42501 hint forbidden / step_up / below_min; 22023 with a hint (lines, duplicate_line, below_min, fulfilment,
--    deal_mismatch, deal_lost, undo_window, sale_state, cancel_reason, request, ...); P0002 (not found).
-- ===========================================================================
-- Records a sale in one transaction (design 6.1). A retry with the same request id returns the first result.
create function public.record_sale(
  p_company uuid,
  p_fulfilment text,                       -- 'from_stock' (Warehouse inventory) | 'direct_from_source' (Supplier Stock);
                                           -- null: the deal's, else from_stock
  p_lines jsonb,                           -- [{product_id, description, quantity, unit_price}], 1 to 50
  p_deal uuid default null,
  p_note text default null,
  p_ship_to_country text default null,     -- Supplier Stock; default: the lead's country
  p_stock_request uuid default null,       -- the request this sale answers (it becomes done)
  p_allow_below_min boolean default false, -- "Below your minimum price: sell anyway?" (managers and admins)
  p_request_id uuid default null
) returns jsonb
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_org constant uuid := private.current_org_id();
  v_group constant uuid := gen_random_uuid();
  v_fulfil text := p_fulfilment;
  v_country text := nullif(upper(btrim(p_ship_to_country)), '');
  v_note text := nullif(btrim(p_note), '');
  v_lead_country text;
  v_wh uuid;
  v_order uuid;
  v_number bigint;
  v_prev text;
  v_new boolean;
  v_prev_kind text;
  v_result jsonb;
  v_lines jsonb := '[]'::jsonb;
  d record;
  ln record;
  mv record;
  pid uuid;
begin
  if (select auth.uid()) is null or v_org is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_company is null then
    raise exception 'which lead?' using errcode = '22023', hint = 'document';
  end if;
  -- The lines, checked as text first (one constant error, never a value in a message).
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 50
     or exists (select 1 from jsonb_array_elements(p_lines) e
                 where jsonb_typeof(e) <> 'object'
                    or (e - array['product_id', 'description', 'quantity', 'unit_price']) <> '{}'::jsonb
                    or e ->> 'quantity' is null or e ->> 'quantity' !~ '^[0-9]{1,8}$'
                    or (e ->> 'quantity')::integer not between 1 and 50000000
                    or e ->> 'unit_price' is null or e ->> 'unit_price' !~ '^[0-9]{1,7}(\.[0-9]{1,4})?$'
                    or (e ->> 'product_id' is not null
                        and e ->> 'product_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                    or (e ->> 'description' is not null
                        and (char_length(btrim(e ->> 'description')) not between 1 and 200
                             or e ->> 'description' ~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'))
                    or (e ->> 'product_id' is null and e ->> 'description' is null)) then
    raise exception 'check the lines' using errcode = '22023', hint = 'lines';
  end if;
  if (select count(e ->> 'product_id') - count(distinct e ->> 'product_id') from jsonb_array_elements(p_lines) e) > 0 then
    raise exception 'a product appears twice' using errcode = '22023', hint = 'duplicate_line';
  end if;
  if v_fulfil is not null and v_fulfil not in ('from_stock', 'direct_from_source') then
    raise exception 'unknown kind of sale' using errcode = '22023', hint = 'fulfilment';
  end if;
  if char_length(v_note) > 1000
     or v_note ~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]' then
    raise exception 'the note is too long or has characters that are not allowed' using errcode = '22023', hint = 'note';
  end if;
  if v_country is not null and v_country !~ '^[A-Z]{2}$' then
    raise exception 'unknown country' using errcode = '22023', hint = 'country';
  end if;

  -- Idempotency: a replay returns the stored result and changes nothing.
  if p_request_id is not null then
    insert into private.movement_requests (request_id, kind) values (p_request_id, 'sale')
    on conflict do nothing
    returning true into v_new;
    if v_new is null then
      select r.kind, r.result into v_prev_kind, v_result from private.movement_requests r
       where r.user_id = (select auth.uid()) and r.request_id = p_request_id;
      if v_prev_kind is distinct from 'sale' or v_result is null then
        raise exception 'this request id was used for something else' using errcode = '22023', hint = 'request';
      end if;
      return v_result;
    end if;
  end if;

  -- The lead, locked: no row means the caller cannot change it (the update policy applies to FOR UPDATE). The lock also
  -- serialises the first-sale status change.
  select c.country into v_lead_country from public.companies c where c.id = p_company for update;
  if not found then
    raise exception 'you cannot sell to this lead' using errcode = '42501', hint = 'forbidden';
  end if;
  -- The deal, if given: visible, on this lead, not lost; the sale follows its fulfilment unless told otherwise.
  if p_deal is not null then
    select dl.company_id, dl.status, dl.fulfilment into d from public.deals dl where dl.id = p_deal;
    if not found or d.company_id is null or d.company_id <> p_company then
      raise exception 'this deal is not on this lead' using errcode = '22023', hint = 'deal_mismatch';
    end if;
    if d.status = 'lost' then
      raise exception 'this deal is lost' using errcode = '22023', hint = 'deal_lost';
    end if;
    v_fulfil := coalesce(v_fulfil, d.fulfilment);
  end if;
  v_fulfil := coalesce(v_fulfil, 'from_stock');
  if v_fulfil = 'from_stock' and exists (select 1 from jsonb_array_elements(p_lines) e where e ->> 'product_id' is null) then
    raise exception 'a warehouse line needs a product' using errcode = '22023', hint = 'lines';
  end if;
  -- Below the minimum price per piece (warehouse lines): reps never; managers and admins only when they confirm.
  if v_fulfil = 'from_stock' and exists (
       select 1 from jsonb_array_elements(p_lines) e join public.products p on p.id = (e ->> 'product_id')::uuid
        where p.price_min is not null and (e ->> 'unit_price')::numeric < p.price_min) then
    if not private.is_manager_or_admin() then
      raise exception 'only managers and admins sell below the minimum price' using errcode = '42501', hint = 'below_min';
    end if;
    if not coalesce(p_allow_below_min, false) then
      raise exception 'below the minimum price' using errcode = '22023', hint = 'below_min';
    end if;
  end if;

  insert into private.orders (company_id, deal_id, stock_request_id, fulfilment, ship_to_country, note)
  values (p_company, p_deal, p_stock_request, v_fulfil,
          case when v_fulfil = 'direct_from_source' then coalesce(v_country, v_lead_country) else v_country end, v_note)
  returning id, number, prev_lead_status into v_order, v_number, v_prev;
  insert into private.order_lines (order_id, position, product_id, product_name, quantity, unit_price)
  select v_order, e.n, (e.v ->> 'product_id')::uuid, coalesce(btrim(e.v ->> 'description'), '-'),
         (e.v ->> 'quantity')::integer, (e.v ->> 'unit_price')::numeric
    from jsonb_array_elements(p_lines) with ordinality as e (v, n);

  -- Warehouse sale: ended holds of these products go first (a hold for the deal locks the deal first), then one ship row
  -- per line in product order. Any shortage rolls the whole sale back.
  if v_fulfil = 'from_stock' then
    select l.id into v_wh from public.locations l where l.org_id = v_org and l.kind = 'warehouse';
    for pid in select ol.product_id from private.order_lines ol where ol.order_id = v_order order by ol.product_id loop
      perform private.expire_due_holds(pid, v_wh, p_deal);
    end loop;
    for ln in select ol.id, ol.product_id, ol.quantity from private.order_lines ol
               where ol.order_id = v_order order by ol.product_id loop
      insert into private.stock_movements (group_id, product_id, location_id, kind, qty, order_line_id)
      values (v_group, ln.product_id, v_wh, 'ship', ln.quantity, ln.id)
      returning d_reserved, on_hand_after, reserved_after into mv;
      v_lines := v_lines || jsonb_build_object('product_id', ln.product_id, 'pieces', ln.quantity,
                                               'used_held', -mv.d_reserved,
                                               'available_after', mv.on_hand_after - mv.reserved_after);
    end loop;
  end if;

  -- The request this sale answers is done; its task too, if the caller may change it.
  if p_stock_request is not null then
    update private.stock_requests r set status = 'done' where r.id = p_stock_request and r.status <> 'done';
    update public.tasks t set done_at = now()
     where t.source_request_id = p_stock_request and t.done_at is null and t.cancelled_at is null;
  end if;
  -- The first sale makes the lead a Customer (the order guard kept the status before it).
  if v_prev is not null then
    update public.companies c set lead_status = 'customer' where c.id = p_company;
  end if;

  v_result := jsonb_build_object(
    'order_id', v_order, 'number', v_number, 'fulfilment', v_fulfil,
    'total', (select coalesce(sum(ol.line_total), 0) from private.order_lines ol where ol.order_id = v_order),
    'line_count', jsonb_array_length(p_lines), 'lines', v_lines, 'became_customer', v_prev is not null);
  if p_request_id is not null then
    update private.movement_requests r set result = v_result
     where r.user_id = (select auth.uid()) and r.request_id = p_request_id;
  end if;
  return v_result;
end;
$$;

-- Undo (design 6.6): the sale's creator, within 120 s, while it is confirmed, no code. Returns are posted, the holds
-- the sale used are put back (when their end date has not passed), and the lead's status goes back if this sale made
-- it a Customer and it has no other sale.
create function public.undo_sale(p_order uuid) returns jsonb
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
  v_group constant uuid := gen_random_uuid();
  o record;
  ln record;
  h record;
  v_wh uuid;
  v_restored integer := 0;
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  select ord.* into o from private.orders ord where ord.id = p_order for update;
  if not found then
    raise exception 'sale not found' using errcode = 'P0002';
  end if;
  if o.status <> 'confirmed' then
    raise exception 'this sale is already cancelled' using errcode = '22023', hint = 'sale_state';
  end if;
  if o.created_by is distinct from (select auth.uid()) or o.created_at <= now() - interval '120 seconds' then
    raise exception 'the time to undo has passed' using errcode = '22023', hint = 'undo_window';
  end if;
  -- Lock order: the deals of the holds to put back, before any level.
  perform 1 from public.deals dl
   where dl.id in (select r.deal_id from private.stock_hold_uses u
                     join private.stock_movements m on m.id = u.movement_id
                     join private.order_lines ol on ol.id = m.order_line_id
                     join private.stock_reservations r on r.id = u.reservation_id
                    where ol.order_id = p_order and m.kind = 'ship' and r.deal_id is not null)
   order by dl.id
     for share;
  update private.orders set status = 'cancelled', cancel_reason = 'undo' where id = p_order;
  if o.fulfilment = 'from_stock' then
    select l.id into v_wh from public.locations l where l.org_id = o.org_id and l.kind = 'warehouse';
    for ln in select ol.id, ol.product_id, ol.quantity from private.order_lines ol
               where ol.order_id = p_order order by ol.product_id loop
      insert into private.stock_movements (group_id, product_id, location_id, kind, qty, order_line_id)
      values (v_group, ln.product_id, v_wh, 'return', ln.quantity, ln.id);
    end loop;
    for h in select r.product_id, r.company_id, r.hold_until, r.note, u.pieces,
                    case when dl.status = 'open' and dl.fulfilment = 'from_stock' then r.deal_id end as deal_id
               from private.stock_hold_uses u
               join private.stock_movements m on m.id = u.movement_id
               join private.order_lines ol on ol.id = m.order_line_id
               join private.stock_reservations r on r.id = u.reservation_id
               left join public.deals dl on dl.id = r.deal_id
              where ol.order_id = p_order and m.kind = 'ship' and r.hold_until >= v_today
              order by r.product_id, r.created_at, r.id loop
      insert into private.stock_movements (group_id, product_id, location_id, kind, qty, note, company_id, deal_id,
                                           hold_until)
      values (v_group, h.product_id, v_wh, 'reserve', h.pieces, h.note, h.company_id, h.deal_id, h.hold_until);
      v_restored := v_restored + 1;
    end loop;
  end if;
  if o.prev_lead_status is not null
     and exists (select 1 from public.companies c where c.id = o.company_id and c.lead_status = 'customer')
     and not exists (select 1 from private.orders x where x.company_id = o.company_id and x.status = 'confirmed') then
    update public.companies c set lead_status = o.prev_lead_status where c.id = o.company_id;
  end if;
  return jsonb_build_object('order_id', p_order, 'status', 'cancelled', 'holds_restored', v_restored);
end;
$$;

-- Cancel (design 6.6): after the Undo window, or someone else's sale: a manager or admin with a fresh code and a
-- reason. Returns are posted; holds are not recreated; the lead's status is left as it is.
create function public.cancel_sale(p_order uuid, p_reason text) returns jsonb
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  v_group constant uuid := gen_random_uuid();
  v_reason text := btrim(p_reason);
  o record;
  ln record;
  v_wh uuid;
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if not private.is_manager_or_admin() then
    raise exception 'only managers and admins cancel a sale' using errcode = '42501', hint = 'forbidden';
  end if;
  if not private.has_recent_aal2(600) then
    raise exception 'enter a fresh two-factor code' using errcode = '42501', hint = 'step_up';
  end if;
  if v_reason is null or char_length(v_reason) not between 3 and 300 or v_reason = 'undo'
     or v_reason ~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]' then
    raise exception 'say why in 3 to 300 characters' using errcode = '22023', hint = 'cancel_reason';
  end if;
  select ord.* into o from private.orders ord where ord.id = p_order for update;
  if not found then
    raise exception 'sale not found' using errcode = 'P0002';
  end if;
  if o.status <> 'confirmed' then
    raise exception 'this sale is already cancelled' using errcode = '22023', hint = 'sale_state';
  end if;
  update private.orders set status = 'cancelled', cancel_reason = v_reason where id = p_order;
  if o.fulfilment = 'from_stock' then
    select l.id into v_wh from public.locations l where l.org_id = o.org_id and l.kind = 'warehouse';
    for ln in select ol.id, ol.product_id, ol.quantity from private.order_lines ol
               where ol.order_id = p_order order by ol.product_id loop
      insert into private.stock_movements (group_id, product_id, location_id, kind, qty, order_line_id)
      values (v_group, ln.product_id, v_wh, 'return', ln.quantity, ln.id);
    end loop;
  end if;
  return jsonb_build_object('order_id', p_order, 'status', 'cancelled');
end;
$$;

-- A new end date for a hold (no ledger row): its creator or an editor of its lead; today to today + 90.
create function public.extend_reservation(p_id uuid, p_hold_until date) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
  v_until date;
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_hold_until is null or p_hold_until not between v_today and v_today + 90 then
    raise exception 'a hold ends today or within 90 days' using errcode = '22023', hint = 'hold_until';
  end if;
  update private.stock_reservations r set hold_until = p_hold_until where r.id = p_id returning r.hold_until into v_until;
  if not found then
    raise exception 'hold not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', p_id, 'hold_until', v_until);
end;
$$;

-- Sales, newest first (keyset on created_at, id), with their totals; filters by lead, kind, seller and dates
-- (Europe/Paris days). Rows the caller may see only (the orders policy).
create function public.list_sales(
  p_company uuid default null,
  p_fulfilment text default null,
  p_user uuid default null,
  p_from date default null,
  p_to date default null,
  p_before_created timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns table (id uuid, number bigint, company_id uuid, company_name text, deal_id uuid, fulfilment text, status text,
                 total numeric, line_count integer, items text, created_at timestamptz, created_by uuid,
                 created_by_first_name text, cancelled_at timestamptz, cancel_reason text)
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = 'force_custom_plan' as $$
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_before_created is null) <> (p_before_id is null)
     or (p_fulfilment is not null and p_fulfilment not in ('from_stock', 'direct_from_source'))
     or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'invalid page' using errcode = '22023', hint = 'bounds';
  end if;
  return query
    with page as materialized (
      select o.* from private.orders o
       where (p_company is null or o.company_id = p_company)
         and (p_fulfilment is null or o.fulfilment = p_fulfilment)
         and (p_user is null or o.created_by = p_user)
         and (p_from is null or o.created_at >= (p_from::timestamp at time zone 'Europe/Paris'))
         and (p_to is null or o.created_at < ((p_to + 1)::timestamp at time zone 'Europe/Paris'))
         and (p_before_id is null or (o.created_at, o.id) < (p_before_created, p_before_id))
       order by o.created_at desc, o.id desc
       limit p_limit)
    select pg.id, pg.number, pg.company_id, c.name, pg.deal_id, pg.fulfilment, pg.status,
           coalesce(t.total, 0), coalesce(t.n, 0)::integer, t.items, pg.created_at, pg.created_by, u.first_name,
           pg.cancelled_at, pg.cancel_reason
      from page pg
      join public.companies c on c.id = pg.company_id
      left join public.profiles u on u.id = pg.created_by
      left join lateral (select sum(ol.line_total) as total, count(*) as n,
                                string_agg(ol.product_name, ' · ' order by ol.position) filter (where ol.position <= 3) as items
                           from private.order_lines ol where ol.order_id = pg.id) t on true
     order by pg.created_at desc, pg.id desc;
end;
$$;

-- One sale with its lines (the cost per piece only for managers and admins, through the costs policy).
create function public.get_sale(p_id uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v jsonb;
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  select jsonb_build_object(
           'id', o.id, 'number', o.number, 'company_id', o.company_id, 'company_name', c.name, 'deal_id', o.deal_id,
           'fulfilment', o.fulfilment, 'status', o.status, 'ship_to_country', o.ship_to_country, 'note', o.note,
           'created_at', o.created_at, 'created_by', o.created_by, 'created_by_first_name', u.first_name,
           'cancelled_at', o.cancelled_at, 'cancel_reason', o.cancel_reason,
           'can_undo', o.status = 'confirmed' and o.created_by = (select auth.uid()) and o.created_at > now() - interval '120 seconds',
           'total', (select coalesce(sum(ol.line_total), 0) from private.order_lines ol where ol.order_id = o.id),
           'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                              'position', ol.position, 'product_id', ol.product_id, 'product_name', ol.product_name,
                              'quantity', ol.quantity, 'unit_price', ol.unit_price, 'line_total', ol.line_total,
                              'below_min', ol.below_min, 'cost_per_piece', k.cost_per_piece) order by ol.position), '[]'::jsonb)
                       from private.order_lines ol left join private.order_line_costs k on k.order_line_id = ol.id
                      where ol.order_id = o.id))
    into v
    from private.orders o
    join public.companies c on c.id = o.company_id
    left join public.profiles u on u.id = o.created_by
   where o.id = p_id;
  if v is null then
    raise exception 'sale not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

-- Live availability of one product, for request lines and the lead's Stock tab.
-- Requests with their lines and live availability per line (design 10.4), set-based: one read of the requests, one of
-- their lines and one of the levels of the products they name, whatever the number of requests (the lead's Stock tab
-- asks for 20 at once; perf I8).
create function private.requests_json(p_ids uuid[]) returns table (id uuid, j jsonb)
language sql stable set search_path = '' as $$
  with ln as materialized (
    select ln.request_id, ln.position, ln.product_id, ln.description, ln.quantity, ln.unit, ln.pieces, ln.price_shown,
           ln.availability, p.name, p.price_max, p.pieces_per_carton, p.transit_eta, p.archived_at
      from private.stock_request_lines ln left join public.products p on p.id = ln.product_id
     where ln.request_id = any (p_ids)),
  av as (
    select l.product_id,
           coalesce(sum(l.on_hand - l.reserved) filter (where x.kind = 'warehouse'), 0) as warehouse_available,
           coalesce(sum(l.on_hand) filter (where x.kind = 'transit'), 0) as transit_on_hand
      from public.stock_levels l join public.locations x on x.id = l.location_id
     where l.product_id in (select ln.product_id from ln where ln.product_id is not null)
     group by l.product_id),
  lines as (
    select ln.request_id,
           jsonb_agg(jsonb_build_object(
             'position', ln.position, 'product_id', ln.product_id, 'product_name', coalesce(ln.name, ln.description),
             'quantity', ln.quantity, 'unit', ln.unit, 'pieces', ln.pieces, 'price_shown', ln.price_shown,
             'price_max', ln.price_max, 'pieces_per_carton', ln.pieces_per_carton, 'availability_then', ln.availability,
             'now', case when ln.product_id is not null then jsonb_build_object(
                      'warehouse_available', coalesce(av.warehouse_available, 0),
                      'transit_on_hand', coalesce(av.transit_on_hand, 0),
                      'transit_eta', ln.transit_eta, 'archived', ln.archived_at is not null) end)
             order by ln.position) as lines
      from ln left join av on av.product_id = ln.product_id
     group by ln.request_id)
  select r.id, jsonb_build_object(
           'id', r.id, 'company_id', r.company_id, 'company_name', c.name, 'source', r.source, 'status', r.status,
           'note', r.note, 'requester_name', r.requester_name, 'language', r.language, 'created_at', r.created_at,
           'created_by', r.created_by, 'handled_by', r.handled_by, 'handled_at', r.handled_at, 'team_note', r.team_note,
           'lines', coalesce(lines.lines, '[]'::jsonb))
    from private.stock_requests r
    join public.companies c on c.id = r.company_id
    left join lines on lines.request_id = r.id
   where r.id = any (p_ids)
$$;
grant execute on function private.requests_json(uuid[]) to authenticated;
revoke all on function private.requests_json(uuid[]) from public, anon;

-- The lead's Stock tab (design 10.4): open requests first (20 at most, with live availability), active holds, the last
-- 20 sales and the total bought, and whether the caller may sell to this lead.
create function public.get_lead_stock(p_company uuid) returns jsonb
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
                       'created_at', r.created_at, 'pieces_per_carton', p.pieces_per_carton, 'price_max', p.price_max)
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

-- Open, from-stock deals of the lead that the caller can see (the sale sheet's deal picker; empty until Day 5).
create function public.list_lead_deals_for_stock(p_company uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', d.id, 'value', d.value, 'currency', d.currency, 'expected_close', d.expected_close,
                   'stage', s.name, 'fulfilment', d.fulfilment,
                   'held', (select coalesce(sum(r.remaining), 0) from private.stock_reservations r
                             where r.deal_id = d.id and r.status = 'active'))
                 order by d.created_at desc), '[]'::jsonb)
            from public.deals d left join public.pipeline_stages s on s.id = d.stage_id
           where d.company_id = p_company and d.status = 'open');
end;
$$;

-- A request the team logs (from a call or a chat; design 6.9): no task (the person logging it is on it). A retry with
-- the same request id returns the first result.
create function public.log_stock_request(p_company uuid, p_lines jsonb, p_note text default null,
                                         p_request_id uuid default null) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_id uuid;
  v_new boolean;
  v_prev_kind text;
  v_result jsonb;
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_company is null then
    raise exception 'which lead?' using errcode = '22023', hint = 'document';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 20
     or exists (select 1 from jsonb_array_elements(p_lines) e
                 where jsonb_typeof(e) <> 'object'
                    or (e - array['product_id', 'description', 'quantity', 'unit']) <> '{}'::jsonb
                    or e ->> 'quantity' is null or e ->> 'quantity' !~ '^[0-9]{1,8}$'
                    or (e ->> 'quantity')::integer not between 1 and 10000000
                    or e ->> 'unit' is null or e ->> 'unit' not in ('piece', 'carton')
                    or (e ->> 'product_id' is not null
                        and e ->> 'product_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                    or (e ->> 'description' is not null
                        and (char_length(btrim(e ->> 'description')) not between 1 and 200
                             or e ->> 'description' ~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'))
                    or (e ->> 'product_id' is null and e ->> 'description' is null)) then
    raise exception 'check the lines' using errcode = '22023', hint = 'lines';
  end if;
  if p_request_id is not null then
    insert into private.movement_requests (request_id, kind) values (p_request_id, 'stock_request')
    on conflict do nothing
    returning true into v_new;
    if v_new is null then
      select r.kind, r.result into v_prev_kind, v_result from private.movement_requests r
       where r.user_id = (select auth.uid()) and r.request_id = p_request_id;
      if v_prev_kind is distinct from 'stock_request' or v_result is null then
        raise exception 'this request id was used for something else' using errcode = '22023', hint = 'request';
      end if;
      return v_result;
    end if;
  end if;
  insert into private.stock_requests (company_id, note) values (p_company, p_note) returning id into v_id;
  insert into private.stock_request_lines (request_id, position, product_id, description, quantity, unit)
  select v_id, e.n, (e.v ->> 'product_id')::uuid, e.v ->> 'description', (e.v ->> 'quantity')::integer, e.v ->> 'unit'
    from jsonb_array_elements(p_lines) with ordinality as e (v, n);
  v_result := jsonb_build_object('request_id', v_id);
  if p_request_id is not null then
    update private.movement_requests r set result = v_result
     where r.user_id = (select auth.uid()) and r.request_id = p_request_id;
  end if;
  return v_result;
end;
$$;

-- Moves a request along (Asking the supplier, Done, Declined with a team note, or back to New).
create function public.set_stock_request_status(p_id uuid, p_status text, p_team_note text default null) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_status text;
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_status is null or p_status not in ('new', 'in_progress', 'done', 'declined') then
    raise exception 'unknown status' using errcode = '22023', hint = 'request_status';
  end if;
  update private.stock_requests r set status = p_status, team_note = coalesce(p_team_note, r.team_note)
   where r.id = p_id returning r.status into v_status;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', p_id, 'status', v_status);
end;
$$;

-- The requests inbox, newest first (keyset on created_at, id), by status.
create function public.list_stock_requests(p_status text[] default null, p_before_created timestamptz default null,
                                           p_before_id uuid default null, p_limit integer default 50)
returns table (id uuid, company_id uuid, company_name text, source text, status text, note text, requester_name text,
               line_count integer, items text, created_at timestamptz, created_by uuid, created_by_first_name text,
               handled_at timestamptz)
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = 'force_custom_plan' as $$
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_before_created is null) <> (p_before_id is null)
     or (p_status is not null and (cardinality(p_status) not between 1 and 4
         or not p_status <@ array['new', 'in_progress', 'done', 'declined'])) then
    raise exception 'invalid page' using errcode = '22023', hint = 'bounds';
  end if;
  return query
    with page as materialized (
      select r.* from private.stock_requests r
       where (p_status is null or r.status = any (p_status))
         and (p_before_id is null or (r.created_at, r.id) < (p_before_created, p_before_id))
       order by r.created_at desc, r.id desc
       limit p_limit)
    select pg.id, pg.company_id, c.name, pg.source, pg.status, pg.note, pg.requester_name, coalesce(t.n, 0)::integer,
           t.items, pg.created_at, pg.created_by, u.first_name, pg.handled_at
      from page pg
      join public.companies c on c.id = pg.company_id
      left join public.profiles u on u.id = pg.created_by
      left join lateral (select count(*) as n,
                                string_agg(coalesce(p.name, ln.description), ' · ' order by ln.position)
                                  filter (where ln.position <= 3) as items
                           from private.stock_request_lines ln left join public.products p on p.id = ln.product_id
                          where ln.request_id = pg.id) t on true
     order by pg.created_at desc, pg.id desc;
end;
$$;

create function public.get_stock_request(p_id uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v jsonb;
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  select rj.j into v from private.requests_json(array[p_id]) rj;
  if v is null then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

-- The Home card (Day 5): counts read live, and up to 5 low products.
-- create or replace (Haider's decision B, 15 Oct 2026: the Home card reads this contract): Day 5c's migration
-- (20261015150000_home_dashboard.sql, which merges first) may already have created a null-returning stub with this
-- exact signature, language, volatility, SECURITY INVOKER, search_path and two-factor check; this replaces its body and
-- keeps its grants (the loop in section 8 sets them again either way). Without Day 5c it simply creates the function.
create or replace function public.stock_alerts() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_today constant date := (now() at time zone 'Europe/Paris')::date;
begin
  if (select auth.uid()) is null or not private.has_aal2() then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  return (
    with s as (
      select r.id, r.name, r.status_key, r.wh_available, r.reorder_point, r.tr_on_hand, r.transit_eta
        from private.stock_rows r where r.status_key <> 'archived')
    select jsonb_build_object(
      'low', (select count(*) from s where s.status_key = 'low'),
      'sold_out', (select count(*) from s where s.status_key = 'sold_out'),
      'arriving_late', (select count(*) from s where s.tr_on_hand > 0 and s.transit_eta < v_today),
      'requests_new', (select count(*) from private.stock_requests q where q.status = 'new'),
      'holds_ending_soon', (select count(*) from private.stock_reservations h
                             where h.status = 'active' and h.hold_until between v_today and v_today + 2),
      'deals_waiting', (select count(distinct h.deal_id) from private.stock_reservations h
                          join public.locations x on x.id = h.location_id
                         where h.status = 'active' and h.deal_id is not null and x.kind = 'transit'),
      'sample', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'available', s.wh_available,
                                                              'reorder_point', s.reorder_point, 'arriving', s.tr_on_hand)
                                           order by s.wh_available, s.name), '[]'::jsonb)
                   from (select * from s where s.status_key = 'low' order by s.wh_available, s.name limit 5) s)));
end;
$$;

-- ===========================================================================
-- 8. Function privileges: the Day 3a revoke/grant loop (authenticated only)
-- ===========================================================================
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.record_sale(uuid, text, jsonb, uuid, text, text, uuid, boolean, uuid)',
    'public.undo_sale(uuid)',
    'public.cancel_sale(uuid, text)',
    'public.extend_reservation(uuid, date)',
    'public.list_sales(uuid, text, uuid, date, date, timestamptz, uuid, integer)',
    'public.get_sale(uuid)',
    'public.get_lead_stock(uuid)',
    'public.list_lead_deals_for_stock(uuid)',
    'public.log_stock_request(uuid, jsonb, text, uuid)',
    'public.set_stock_request_status(uuid, text, text)',
    'public.list_stock_requests(text[], timestamptz, uuid, integer)',
    'public.get_stock_request(uuid)',
    'public.stock_alerts()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
revoke all on function private.order_guard(), private.order_line_guard(), private.stock_request_guard(),
  private.stock_request_line_guard(), private.reservation_extend_guard() from public, anon;
