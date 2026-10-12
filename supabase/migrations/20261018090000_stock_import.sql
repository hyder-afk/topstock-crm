-- Day 6c: the stock sheet import (design docs/evidence/day6/design.md sections 3.3, 5.3, 7 and 11; decisions D10, D11,
-- D13, D15). Haider's sheet (CATÉGORIE · PRIX PAR PCS MAX · PRIX PAR PCS · QUANTITÉ · QTY PAR CARTON · PP · REVENTE MIN /
-- MAX · STATUS) is read and cleaned in the browser; only cleaned fields reach these functions. In plain words:
--  - an admin with a fresh code starts a stock import (import_batches.kind = 'stock'), stages the rows, and runs the
--    check (dry run): each product is new, updated, unchanged, or kept because it moved in the CRM since the last sheet
--    (unless "use the sheet" is ticked); bad, repeated and conflicting rows are listed, not imported;
--  - the commit runs in chunks of products (paused and resumed safely): new products are created, prices, cartons and
--    the cost per piece (PP ÷ QUANTITÉ, D15) updated, and quantities set to the sheet's numbers under the stock locks,
--    through the ledger only (import_in / import_out, and a transfer pair for stock the sheet now lists in the
--    warehouse, which moves its holds too);
--  - undo by import_batch_id reverses each product's quantities only where nothing changed them since (the level still
--    has last_onhand_batch_id = the import and nothing is held below), archives the products it created (never
--    deletes: the ledger keeps both the import and the undo rows), and restores prices only where they are unchanged.
-- House rules (design 3.0): search_path = '' everywhere; the RPCs are SECURITY INVOKER with static SQL; one definer
-- helper with no REST endpoint takes the import's locks (lock_stock_import); constant messages with hints.
-- Shared objects of earlier days redefined here (each copied from its newest definition):
--  - private.import_batch_guard (REBASE: from 20261010150000_lead_import.sql, a stock branch first; the lead path's
--    open-imports cap now counts lead imports only, so open stock imports never block a lead import);
--  - the 6a stock engine's private.stock_movement_a_guard, private.stock_movement_b_apply and
--    private.nightly_stock_jobs (from 20261016090000_stock_engine.sql, not merged yet: rebase with 6a).

-- ===========================================================================
-- 1. Batches: kind = 'stock' may be inserted; one writer per organisation and kind (D11)
-- ===========================================================================
grant insert (kind) on public.import_batches to authenticated;
drop index public.import_batches_one_writer_idx;
create unique index import_batches_one_writer_idx on public.import_batches (org_id, kind)
  where status in ('committing', 'rolling_back');

-- ===========================================================================
-- 2. The working copy of the sheet's rows (private: no REST endpoint; admins with a fresh code only)
-- ===========================================================================
-- The first products-table rule a staged row breaks, worked out once when the row arrives (design 7.5). Bounds as the
-- products table and the engine: a name of 1 to 200 characters with a letter or a digit and no control characters,
-- 0 to 50,000,000 pieces, 1 to 1,000,000 pieces per carton, prices 0 to 1,000,000 with min ≤ max, PP 0 to 10^10.
create function private.stock_db_problem(name text, quantity integer, ppc integer, pmin numeric, pmax numeric,
                                         cost numeric) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case
    when name is null or char_length(name) not between 1 and 200 or name <> btrim(name)
         or name ~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]'
         or private.product_name_key(name) = '' then 'db_name'
    when quantity is null or quantity not between 0 and 50000000 then 'db_quantity'
    when ppc is not null and ppc not between 1 and 1000000 then 'db_carton'
    when pmin not between 0 and 1000000 or pmax not between 0 and 1000000 or pmin > pmax then 'db_price'
    when cost not between 0 and 10000000000 then 'db_cost'
  end
$$;

create table private.stock_import_staging (
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  row_no integer not null check (row_no between 2 and 5001),
  org_id uuid not null references public.orgs (id),
  name text check (char_length(name) <= 500),
  name_key text generated always as (private.product_name_key(name)) stored,
  location_kind text check (location_kind in ('warehouse', 'transit')),
  quantity integer,
  pieces_per_carton integer,
  price_min numeric(12,4),
  price_max numeric(12,4),
  total_cost numeric(18,4),                                -- PP as given; REVENTE is never sent
  problems text[] not null default '{}' check (cardinality(problems) <= 16 and problems <@ array[
    'name_missing', 'name_too_long', 'quantity_missing', 'quantity_invalid', 'quantity_negative', 'quantity_not_whole',
    'quantity_too_big', 'carton_invalid', 'price_invalid', 'price_order', 'cost_invalid', 'excel_error',
    'number_mangled', 'columns_extra', 'cell_too_long']),
  fixes text[] not null default '{}' check (cardinality(fixes) <= 16 and fixes <@ array[
    'resale_min_mismatch', 'resale_max_mismatch', 'resale_unreadable', 'cost_above_price', 'cost_missing',
    'cost_kept_sold_out', 'price_missing', 'loose_pieces']),
  db_problem text generated always as
    (private.stock_db_problem(name, quantity, pieces_per_carton, price_min, price_max, total_cost)) stored,
  -- Written by the check (validate_stock_import) and the commit.
  outcome text not null default 'pending'
    check (outcome in ('pending', 'new', 'update', 'moved', 'unchanged', 'rejected', 'repeated', 'applied', 'kept',
                       'skipped')),
  reason text check (reason in ('db_name', 'db_quantity', 'db_carton', 'db_price', 'db_cost', 'carton_conflict',
                                'carton_required', 'below_reserved', 'moved_in_crm', 'added_meanwhile')),
  db_warnings text[] not null default '{}' check (cardinality(db_warnings) <= 4 and db_warnings <@ array[
    'prices_differ', 'carton_kept', 'restored']),
  group_first boolean not null default false,              -- the product's first live row carries the group's values
  match_product_id uuid,                                   -- no foreign key: a product delete never scans this table
  match_row_no integer,
  use_sheet boolean not null default false,                -- "For the kept products, use the sheet's quantities"
  sheet_wh integer, sheet_tr integer,                       -- the product's targets (0 for a place the sheet leaves out)
  final_ppc integer, final_min numeric(12,4), final_max numeric(12,4), final_cost numeric(14,6),
  wh_at_check integer, tr_at_check integer, reserved_at_check integer, moved_at_check boolean,
  primary key (batch_id, row_no)
) with (fillfactor = 60);
create index stock_import_staging_org_idx on private.stock_import_staging (org_id);
create index stock_import_staging_key_idx on private.stock_import_staging (batch_id, name_key);

alter table private.stock_import_staging enable row level security;
create policy require_mfa on private.stock_import_staging as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
-- Staged rows hold costs: even reading them needs an admin with a fresh code (the lead staging's rules, kind 'stock').
create policy staging_select on private.stock_import_staging for select to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_admin())
         and (select private.has_recent_aal2(600)));
create policy staging_insert on private.stock_import_staging for insert to authenticated
  with check (org_id = (select private.current_org_id()) and (select private.is_admin())
              and (select private.has_recent_aal2(600))
              and exists (select 1 from public.import_batches b
                          where b.id = stock_import_staging.batch_id and b.kind = 'stock' and b.status = 'staged'
                            and b.uploaded_by = (select auth.uid())
                            and stock_import_staging.row_no between 2 and b.last_row_no));
create policy staging_update on private.stock_import_staging for update to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_admin())
         and (select private.has_recent_aal2(600)))
  with check (org_id = (select private.current_org_id()) and (select private.is_admin())
              and (select private.has_recent_aal2(600)));
create policy staging_delete on private.stock_import_staging for delete to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_admin())
         and (select private.has_recent_aal2(600)));
revoke all on private.stock_import_staging from public, anon, authenticated;
grant select, delete on private.stock_import_staging to authenticated;
grant insert (batch_id, row_no, org_id, name, location_kind, quantity, pieces_per_carton, price_min, price_max,
              total_cost, problems, fixes) on private.stock_import_staging to authenticated;
grant update (outcome, reason, db_warnings, group_first, match_product_id, match_row_no, use_sheet, sheet_wh, sheet_tr,
              final_ppc, final_min, final_max, final_cost, wh_at_check, tr_at_check, reserved_at_check, moved_at_check)
  on private.stock_import_staging to authenticated;
-- Not audited: the rows are temporary and hold costs.

-- ===========================================================================
-- 3. What an import did to each product, for an exact undo
-- ===========================================================================
create table private.stock_import_changes (
  batch_id uuid not null references public.import_batches (id),
  product_id uuid not null references public.products (id),
  org_id uuid not null references public.orgs (id),
  created boolean not null,                                -- the import made this product
  restored boolean not null default false,                 -- the import brought it back from the archive
  old_price_min numeric(12,4), old_price_max numeric(12,4), old_ppc integer, old_cost numeric(14,6),
  new_price_min numeric(12,4), new_price_max numeric(12,4), new_ppc integer, new_cost numeric(14,6),
  qty_changed boolean not null default false,
  undone_at timestamptz,
  kept_reason text check (kept_reason in ('moved', 'held', 'edited', 'later_import')),
  created_at timestamptz not null default now(),
  primary key (batch_id, product_id)
);
create index stock_import_changes_product_idx on private.stock_import_changes (product_id);
create index stock_import_changes_org_idx on private.stock_import_changes (org_id);

alter table private.stock_import_changes enable row level security;
create policy require_mfa on private.stock_import_changes as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
create policy changes_select on private.stock_import_changes for select to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_admin()));
-- Written by the commit (the uploader of a committing stock import) and the undo (any admin, fresh code).
create policy changes_insert on private.stock_import_changes for insert to authenticated
  with check (org_id = (select private.current_org_id()) and (select private.is_admin())
              and (select private.has_recent_aal2(600))
              and exists (select 1 from public.import_batches b
                          where b.id = stock_import_changes.batch_id and b.kind = 'stock' and b.status = 'committing'
                            and b.uploaded_by = (select auth.uid())));
create policy changes_update on private.stock_import_changes for update to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_admin())
         and (select private.has_recent_aal2(600)))
  with check (org_id = (select private.current_org_id()) and (select private.is_admin())
              and (select private.has_recent_aal2(600)));
revoke all on private.stock_import_changes from public, anon, authenticated;
grant select, insert (batch_id, product_id, org_id, created, restored, old_price_min, old_price_max, old_ppc, old_cost,
                      new_price_min, new_price_max, new_ppc, new_cost, qty_changed)
  on private.stock_import_changes to authenticated;
grant update (qty_changed, undone_at, kept_reason) on private.stock_import_changes to authenticated;
create trigger enforce_org_and_owner before insert or update on private.stock_import_changes
  for each row execute function private.enforce_org_and_owner();

-- ===========================================================================
-- 4. Products: the only way to set import_batch_id (insert only, the companies_import_columns pattern)
-- ===========================================================================
grant insert (import_batch_id) on public.products to authenticated;
create policy products_import_column on public.products as restrictive for insert to authenticated with check (
  import_batch_id is null
  or ((select private.is_admin()) and (select private.has_recent_aal2(600))
      and exists (select 1 from public.import_batches b
                  where b.id = products.import_batch_id and b.kind = 'stock' and b.status = 'committing'
                    and b.uploaded_by = (select auth.uid()))));

-- ===========================================================================
-- 5. Counts of a stock batch (written to issue_counts by the guard at the check)
-- ===========================================================================
-- Rows by outcome and reason, products (group-first rows) by outcome, and one key per problem and warning code (warnings
-- only on rows that are or will be imported).
create function private.stock_import_tally(p_batch uuid) returns jsonb
language sql stable set search_path = '' as $$
  with s as (
    select outcome, reason, problems, fixes, db_warnings, group_first
      from private.stock_import_staging where batch_id = p_batch
  )
  select jsonb_build_object(
           'rows', count(*),
           'rejected', count(*) filter (where outcome = 'rejected'),
           'repeated', count(*) filter (where outcome = 'repeated'),
           'products_new', count(*) filter (where group_first and outcome = 'new'),
           'products_update', count(*) filter (where group_first and outcome = 'update'),
           'products_moved', count(*) filter (where group_first and outcome = 'moved'),
           'products_unchanged', count(*) filter (where group_first and outcome = 'unchanged'),
           'products_below_reserved', count(*) filter (where group_first and reason = 'below_reserved'))
         || coalesce((select jsonb_object_agg(code, n)
                        from (select code, count(*) as n
                                from s, unnest(s.problems || case when s.outcome not in ('rejected', 'repeated')
                                                                  then s.fixes || s.db_warnings else '{}' end) as code
                               group by code) x), '{}')
         || coalesce((select jsonb_object_agg(reason, n)
                        from (select s.reason, count(*) as n from s where s.reason is not null group by s.reason) y), '{}')
    from s
$$;

-- ===========================================================================
-- 6. The batch guard's stock branch (design 7.5)
-- ===========================================================================
-- Every move of a stock batch goes through here (the update grant is on status only). Each update also needs the
-- transaction-local marker topstock.stock_batch_op = the batch id, set only by the stock RPCs below: so a lead RPC (or a
-- direct PATCH) given a stock batch is refused with bad_transition (defence in depth; the structural rules are the
-- primary layer). Invoker; called by private.import_batch_guard after its "no signed-in user" early return.
create function private.stock_batch_step(o public.import_batches, n public.import_batches, op text)
returns public.import_batches
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  tally jsonb;
  n_total integer;
  n_pending integer;
begin
  if op = 'INSERT' then
    if not coalesce(private.is_admin(), false) then
      raise exception 'admins only' using errcode = '42501', hint = 'forbidden';
    end if;
    if not private.has_recent_aal2(600) then
      raise exception 'a fresh two-factor code is needed' using errcode = '42501', hint = 'step_up';
    end if;
    n.uploaded_by := caller;
    if n.row_count < 1 or n.row_count > 5000 or n.last_row_no <= n.row_count or n.last_row_no > 5001 then
      raise exception 'row counts out of range' using errcode = '22023', hint = 'row_count';
    end if;
    if (select count(*) from public.import_batches b
         where b.org_id = n.org_id and b.kind = 'stock' and b.status in ('staged', 'dry_run')) >= 3 then
      raise exception 'too many open stock imports' using errcode = '22023', hint = 'too_many_open';
    end if;
    return n;
  end if;

  if n.kind is distinct from o.kind or n.uploaded_by is distinct from o.uploaded_by then
    raise exception 'this change is not allowed' using errcode = '22023', hint = 'bad_transition';
  end if;
  if current_setting('topstock.stock_batch_op', true) is distinct from n.id::text then
    raise exception 'this change is not allowed' using errcode = '22023', hint = 'bad_transition';
  end if;
  if n.status = o.status and n.status <> 'dry_run' then
    return n;
  end if;

  if o.status in ('staged', 'dry_run') and n.status = 'dry_run' then
    if o.uploaded_by is distinct from caller then
      raise exception 'only the person who started this import can check it' using errcode = '42501';
    end if;
    select count(*), count(*) filter (where s.outcome = 'pending') into n_total, n_pending
      from private.stock_import_staging s where s.batch_id = n.id;
    if n_total <> o.row_count or n_pending > 0 then
      raise exception 'rows are missing or not checked' using errcode = '22023', hint = 'incomplete';
    end if;
    tally := private.stock_import_tally(n.id);
    n.imported := 0;
    n.rejected := (tally ->> 'rejected')::integer;
    n.duplicates := (tally ->> 'repeated')::integer;
    n.issue_counts := tally;
    n.checked_at := now();
  elsif o.status in ('staged', 'dry_run') and n.status = 'discarded' then
    null;  -- any admin (the update policy asks for a fresh code)
  elsif o.status = 'dry_run' and n.status = 'committing' then
    if o.uploaded_by is distinct from caller then
      raise exception 'only the person who started this import can import it' using errcode = '42501';
    end if;
  elsif o.status = 'committing' and n.status = 'imported' then
    if o.uploaded_by is distinct from caller then
      raise exception 'only the person who started this import can import it' using errcode = '42501';
    end if;
    if exists (select 1 from private.stock_import_staging s
                where s.batch_id = n.id and s.group_first and s.outcome in ('new', 'update', 'moved')) then
      raise exception 'products are still waiting' using errcode = '22023', hint = 'not_ready';
    end if;
    n.imported := (select count(*) from private.stock_import_changes c where c.batch_id = n.id);
    n.imported_at := now();
  elsif o.status in ('committing', 'imported') and n.status = 'rolling_back' then
    n.rolled_back_by := caller;
    if o.status = 'committing' then
      n.imported := (select count(*) from private.stock_import_changes c where c.batch_id = n.id);
    end if;
  elsif o.status = 'rolling_back' and n.status = 'rolled_back' then
    if exists (select 1 from private.stock_import_changes c
                where c.batch_id = n.id and c.undone_at is null and c.kept_reason is null) then
      raise exception 'some products are still waiting' using errcode = '22023', hint = 'not_ready';
    end if;
    n.kept := (select count(*) from private.stock_import_changes c where c.batch_id = n.id and c.kept_reason is not null);
    n.rolled_back_at := now();
  else
    raise exception 'this change is not allowed' using errcode = '22023', hint = 'bad_transition';
  end if;
  -- A move that closes the import deletes its working rows (they hold costs), however it was made.
  if n.status in ('discarded', 'imported', 'rolling_back', 'rolled_back') then
    delete from private.stock_import_staging s where s.batch_id = n.id;
  end if;
  return n;
end;
$$;

-- The batch guard, with the stock branch first.
-- REBASE: copied from 20261010150000_lead_import.sql; re-copy from the newest definition before merge
create or replace function private.import_batch_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  tally jsonb;
  n_total integer;
  n_pending integer;
begin
  if caller is null then
    return new;
  end if;
  -- 6c: a stock import follows its own steps (private.stock_batch_step); everything below is the lead path.
  if new.kind = 'stock' or (tg_op = 'UPDATE' and old.kind = 'stock') then
    return private.stock_batch_step(old, new, tg_op);
  end if;

  if tg_op = 'INSERT' then
    -- Before-insert triggers run before the insert policy: refuse non-admins here first, so nothing else is said.
    if not coalesce(private.is_admin(), false) or not private.has_recent_aal2(600) then
      raise exception 'admins with a fresh two-factor code only' using errcode = '42501';
    end if;
    new.uploaded_by := caller;
    if new.row_count < 1 or new.row_count > 50000 or new.last_row_no <= new.row_count or new.last_row_no > 50001 then
      raise exception 'row counts out of range' using errcode = '22023';
    end if;
    -- 6c: open imports are counted per kind (D11's rule for writers, applied to the open cap too), so open stock
    -- imports never block a lead import. The only change to the lead path.
    if (select count(*) from public.import_batches b
         where b.org_id = new.org_id and b.kind = 'leads' and b.status in ('staged', 'dry_run')) >= 3 then
      raise exception 'too many open imports' using errcode = '22023', hint = 'too_many_open';
    end if;
    return new;
  end if;

  if new.status = old.status and new.status <> 'dry_run' then
    return new;
  end if;

  if old.status in ('staged', 'dry_run') and new.status = 'dry_run' then
    if old.uploaded_by is distinct from caller then
      raise exception 'only the person who started this import can check it' using errcode = '42501';
    end if;
    select count(*), count(*) filter (where s.outcome = 'pending') into n_total, n_pending
      from private.lead_import_staging s where s.batch_id = new.id;
    if n_total <> old.row_count or n_pending > 0 then
      raise exception 'rows are missing or not checked' using errcode = '22023', hint = 'incomplete';
    end if;
    tally := private.lead_import_tally(new.id);
    new.imported := 0;
    new.checked_at := now();
  elsif old.status in ('staged', 'dry_run') and new.status = 'discarded' then
    null;  -- any admin, nothing to check
  elsif old.status = 'dry_run' and new.status = 'committing' then
    if old.uploaded_by is distinct from caller then
      raise exception 'only the person who started this import can import it' using errcode = '42501';
    end if;
  elsif old.status = 'committing' and new.status = 'imported' then
    if old.uploaded_by is distinct from caller then
      raise exception 'only the person who started this import can import it' using errcode = '42501';
    end if;
    if exists (select 1 from private.lead_import_staging s where s.batch_id = new.id and s.outcome <> all
               (array['imported', 'rejected', 'duplicate_file', 'duplicate_existing'])) then
      raise exception 'rows are still waiting' using errcode = '22023', hint = 'not_ready';
    end if;
    tally := private.lead_import_tally(new.id);
    new.imported := (tally ->> 'imported')::integer;
    new.imported_at := now();
  elsif old.status in ('committing', 'imported') and new.status = 'rolling_back' then
    new.rolled_back_by := caller;
    if old.status = 'committing' then
      tally := private.lead_import_tally(new.id);
      new.imported := (select count(*) from public.companies c where c.import_batch_id = new.id);
    end if;
  elsif old.status = 'rolling_back' and new.status = 'rolled_back' then
    if exists (select 1 from private.lead_import_untouched(new.id, 1)) then
      raise exception 'some leads are still waiting to be removed' using errcode = '22023', hint = 'not_ready';
    end if;
    new.kept := (select count(*) from public.companies c where c.import_batch_id = new.id);
    new.rolled_back_at := now();
  else
    raise exception 'this change is not allowed' using errcode = '22023', hint = 'bad_transition';
  end if;

  if tally is not null then
    new.duplicates := (tally ->> 'duplicate_file')::integer + (tally ->> 'duplicate_existing')::integer;
    new.rejected := (tally ->> 'rejected')::integer;
    new.issue_counts := tally;
    if new.status = 'imported' and new.imported + new.duplicates + new.rejected <> new.row_count then
      raise exception 'import counts do not add up' using errcode = '22023', hint = 'not_ready';
    end if;
  end if;
  -- After the counts above (they read the working rows). The caller passed the update policy, so it is an admin of
  -- this organisation with a fresh code: the staging delete policy lets it delete these rows.
  if new.status in ('discarded', 'imported', 'rolling_back', 'rolled_back') then
    delete from private.lead_import_staging s where s.batch_id = new.id;
  end if;
  return new;
end;
$$;
-- ===========================================================================
-- 7. The import's locks (design 3.3 and 4.6): definer, owner postgres, no REST endpoint
-- ===========================================================================
-- Product by product in id order: the product row FOR UPDATE, any missing level created at zero, then the levels FOR
-- UPDATE in location order (the engine's global order: product, levels; a sale of another product is never blocked).
-- Definer because clients have no UPDATE on stock_levels (FOR UPDATE needs it) and may not create levels. It checks
-- the caller first: a stock batch of their organisation with a fresh code, and either the uploader of a committing
-- batch or an admin undoing it; every product must be one this batch staged or changed. Granted to authenticated (the
-- invoker RPCs call it).
create function private.lock_stock_import(p_batch uuid, p_products uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org constant uuid := private.current_org_id();
  b record;
  pid uuid;
begin
  select ib.kind, ib.status, ib.uploaded_by, ib.org_id into b from public.import_batches ib where ib.id = p_batch;
  if not found or b.org_id is distinct from v_org or b.kind <> 'stock' then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if not private.has_recent_aal2(600) then
    raise exception 'a fresh two-factor code is needed' using errcode = '42501', hint = 'step_up';
  end if;
  if not ((b.status = 'committing' and b.uploaded_by = (select auth.uid()))
          or (b.status = 'rolling_back' and coalesce(private.is_admin(), false))) then
    raise exception 'this import cannot take locks now' using errcode = '42501', hint = 'forbidden';
  end if;
  if exists (select 1 from unnest(p_products) x(id)
              where x.id is null
                 or (not exists (select 1 from private.stock_import_staging s
                                  where s.batch_id = p_batch and s.match_product_id = x.id)
                     and not exists (select 1 from private.stock_import_changes c
                                      where c.batch_id = p_batch and c.product_id = x.id))) then
    raise exception 'a product is not part of this import' using errcode = '22023', hint = 'document';
  end if;
  for pid in select distinct x.id from unnest(p_products) x(id) order by x.id loop
    perform 1 from public.products p where p.id = pid and p.org_id = v_org for update;
    insert into public.stock_levels (org_id, product_id, location_id)
    select v_org, pid, l.id from public.locations l where l.org_id = v_org order by l.id
    on conflict do nothing;
    perform 1 from public.stock_levels l where l.product_id = pid order by l.location_id for update;
  end loop;
end;
$$;

-- What an undo would do to one product of the batch, read from the current state (design 7.8); the undo calls it
-- again under the locks. Quantities: 'reverse' when every level the batch changed still has last_onhand_batch_id = the
-- batch and reversing goes below neither zero nor what is held, 'none' when it changed none, else the reason it is
-- kept ('later_import', 'moved', 'held'). Fields: 'restore' when prices and carton still equal what the import set,
-- 'none' when it changed none, else 'edited'. Archive (a product the import created or brought back): 'archive' when
-- its quantities go (or never came), it has no holds and its fields are as the import left them, else the reason kept.
create function private.stock_undo_plan(p_batch uuid, p_product uuid)
returns table (qty text, fields text, archive text, wh_net integer, tr_net integer)
language plpgsql stable set search_path = '' as $$
declare
  c private.stock_import_changes%rowtype;
  p record;
  lv record;
  v_qty text := 'none';
  v_fields text := 'none';
  v_archive text := 'none';
  v_wh integer := 0;
  v_tr integer := 0;
begin
  select * into c from private.stock_import_changes x where x.batch_id = p_batch and x.product_id = p_product;
  if not found then
    return;
  end if;
  select pr.price_min, pr.price_max, pr.pieces_per_carton, pr.archived_at into p from public.products pr where pr.id = p_product;
  -- The batch's net change at each level, from the ledger (import rows and the transfers it posted).
  for lv in select l.kind, s.on_hand, s.reserved, s.last_onhand_batch_id,
                   coalesce((select sum(m.d_on_hand) from private.stock_movements m
                              where m.import_batch_id = p_batch and m.product_id = p_product and m.location_id = l.id
                                and m.kind in ('import_in', 'import_out', 'transfer_out', 'transfer_in')), 0)::integer as net
              from public.locations l
              left join public.stock_levels s on s.location_id = l.id and s.product_id = p_product
             where l.org_id = c.org_id loop
    if lv.kind = 'warehouse' then v_wh := lv.net; else v_tr := lv.net; end if;
    if lv.net <> 0 then
      if v_qty = 'none' then v_qty := 'reverse'; end if;
      if lv.last_onhand_batch_id is distinct from p_batch then
        v_qty := case when lv.last_onhand_batch_id is not null then 'later_import' else 'moved' end;
      elsif coalesce(lv.on_hand, 0) - lv.net < coalesce(lv.reserved, 0) and v_qty = 'reverse' then
        v_qty := 'held';
      end if;
    end if;
  end loop;
  if (c.new_price_min, c.new_price_max, c.new_ppc) is distinct from (c.old_price_min, c.old_price_max, c.old_ppc)
     or c.created then
    v_fields := case when (p.price_min, p.price_max, p.pieces_per_carton)
                          is not distinct from (c.new_price_min, c.new_price_max, c.new_ppc)
                     then 'restore' else 'edited' end;
  end if;
  if c.created or c.restored then
    v_archive := case
      when v_qty not in ('reverse', 'none') then v_qty
      when exists (select 1 from private.stock_reservations r where r.product_id = p_product) then 'held'
      when v_fields = 'edited' then 'edited'
      else 'archive' end;
  end if;
  return query select v_qty, v_fields, v_archive, v_wh, v_tr;
end;
$$;

-- ===========================================================================
-- 8. The stock import RPCs (design 7.5 to 7.8): SECURITY INVOKER, static SQL; the guard, the policies and the engine
--    decide. Error contract (as Day 3b): 42501 hint step_up / forbidden, 22023 with hint incomplete / not_staged /
--    not_ready / too_many_open / bad_transition / busy / row_count, 22023 without hint (bad input), P0002 (no such
--    stock import). Messages never carry row values.
-- ===========================================================================
-- A stock batch of the caller's organisation, locked for this transaction, with the marker set for it.
create function private.stock_batch_for(p_batch uuid, p_lock boolean) returns public.import_batches
language plpgsql set search_path = '' as $$
declare
  b public.import_batches%rowtype;
begin
  if p_lock then
    select * into b from public.import_batches where id = p_batch for update;
  else
    select * into b from public.import_batches where id = p_batch;
  end if;
  if not found then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if b.kind <> 'stock' then
    raise exception 'this is not a stock import' using errcode = '22023', hint = 'bad_transition';
  end if;
  perform set_config('topstock.stock_batch_op', p_batch::text, true);
  return b;
end;
$$;

-- Starts a stock import (admin, fresh code). Also tidies up: the caller's open stock imports untouched for 24 hours are
-- discarded (the guard deletes their working rows).
create function public.create_stock_import(p_filename text, p_file_sha256 text, p_row_count integer,
                                           p_last_row_no integer) returns uuid
language plpgsql volatile security invoker set search_path = '' as $$
declare
  old_id uuid;
  new_id uuid;
begin
  perform private.assert_import_admin(true);
  if p_filename is null or char_length(btrim(p_filename)) not between 1 and 255
     or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid file' using errcode = '22023';
  end if;
  for old_id in select b.id from public.import_batches b
                 where b.kind = 'stock' and b.status in ('staged', 'dry_run') and b.uploaded_by = (select auth.uid())
                   and b.updated_at < now() - interval '24 hours'
                 order by b.id loop
    perform set_config('topstock.stock_batch_op', old_id::text, true);
    update public.import_batches set status = 'discarded' where id = old_id;
  end loop;
  insert into public.import_batches (kind, filename, file_sha256, row_count, last_row_no)
  values ('stock', btrim(p_filename), p_file_sha256, p_row_count, p_last_row_no)
  returning id into new_id;
  return new_id;
end;
$$;

-- Adds up to 1,000 cleaned rows. Every value is checked as text first (one constant error, never "invalid input syntax
-- for type numeric: <value>"); decimals in canonical form. Sending the same rows again does nothing (safe retries).
create function public.stage_stock_import_rows(p_batch uuid, p_rows jsonb) returns integer
language plpgsql volatile security invoker set search_path = '' as $$
declare
  b public.import_batches%rowtype;
  n integer;
begin
  perform private.assert_import_admin(true);
  b := private.stock_batch_for(p_batch, false);
  if b.uploaded_by is distinct from (select auth.uid()) then
    raise exception 'only the person who started this import can add rows' using errcode = '42501';
  end if;
  if b.status <> 'staged' then
    raise exception 'this import is not taking rows' using errcode = '22023', hint = 'not_staged';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 1000
     or octet_length(p_rows::text) > 1048576
     or exists (select 1 from jsonb_array_elements(p_rows) e where jsonb_typeof(e) <> 'object'
                   or not (e - array['row_no', 'name', 'location_kind', 'quantity', 'pieces_per_carton', 'price_min',
                                     'price_max', 'total_cost', 'problems', 'fixes']) = '{}'::jsonb) then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_to_recordset(p_rows) as r(row_no text, name text, location_kind text, quantity text,
                                           pieces_per_carton text, price_min text, price_max text, total_cost text,
                                           problems jsonb, fixes jsonb)
     where r.row_no is null or r.row_no !~ '^[0-9]{1,4}$' or r.row_no::integer not between 2 and b.last_row_no
        or char_length(r.name) > 500
        or (r.location_kind is not null and r.location_kind not in ('warehouse', 'transit'))
        or (r.quantity is not null and r.quantity !~ '^[0-9]{1,9}$')
        or (r.pieces_per_carton is not null and r.pieces_per_carton !~ '^[0-9]{1,9}$')
        or (r.price_min is not null and r.price_min !~ '^[0-9]{1,8}(\.[0-9]{1,4})?$')
        or (r.price_max is not null and r.price_max !~ '^[0-9]{1,8}(\.[0-9]{1,4})?$')
        or (r.total_cost is not null and r.total_cost !~ '^[0-9]{1,13}(\.[0-9]{1,4})?$')
        or (r.problems is not null and (jsonb_typeof(r.problems) <> 'array' or jsonb_array_length(r.problems) > 16
            or exists (select 1 from jsonb_array_elements(r.problems) p
                        where jsonb_typeof(p) <> 'string' or not (p #>> '{}') = any (array[
                          'name_missing', 'name_too_long', 'quantity_missing', 'quantity_invalid', 'quantity_negative',
                          'quantity_not_whole', 'quantity_too_big', 'carton_invalid', 'price_invalid', 'price_order',
                          'cost_invalid', 'excel_error', 'number_mangled', 'columns_extra', 'cell_too_long']))))
        or (r.fixes is not null and (jsonb_typeof(r.fixes) <> 'array' or jsonb_array_length(r.fixes) > 16
            or exists (select 1 from jsonb_array_elements(r.fixes) f
                        where jsonb_typeof(f) <> 'string' or not (f #>> '{}') = any (array[
                          'resale_min_mismatch', 'resale_max_mismatch', 'resale_unreadable', 'cost_above_price',
                          'cost_missing', 'cost_kept_sold_out', 'price_missing', 'loose_pieces']))))
  ) then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  insert into private.stock_import_staging (batch_id, row_no, org_id, name, location_kind, quantity, pieces_per_carton,
                                            price_min, price_max, total_cost, problems, fixes)
  select p_batch, r.row_no::integer, b.org_id, r.name, r.location_kind,
         r.quantity::integer, r.pieces_per_carton::integer, r.price_min::numeric, r.price_max::numeric,
         r.total_cost::numeric,
         array(select jsonb_array_elements_text(coalesce(r.problems, '[]'))),
         array(select jsonb_array_elements_text(coalesce(r.fixes, '[]')))
    from jsonb_to_recordset(p_rows) as r(row_no text, name text, location_kind text, quantity text,
                                         pieces_per_carton text, price_min text, price_max text, total_cost text,
                                         problems jsonb, fixes jsonb)
  on conflict (batch_id, row_no) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- The check (dry run, design 7.6): one set-based statement with window aggregates over the staged rows (no join between
-- two unanalysed row sets, the Day 3b lesson), then each product's current state read by its unique name key. Writes
-- each row's outcome back by primary key and moves the batch to dry_run (the guard counts). Nothing is written to the
-- products or the stock. Can run again (after rows changed in the CRM, or with the other "moved" policy).
--  rejected   a problem from the browser, a products-table rule (db_*), no place, a carton conflict between the
--             product's two rows, or a new product with no pieces per carton (carton_required), or final prices out of
--             order (db_price)
--  repeated   an earlier good row with the same name key and place (match_row_no points at it; open question 2)
--  per product (the first live row carries the group's values, group_first):
--  new        no product with this name key (archived ones count: an archived match is restored, warning "restored")
--  moved      moved in the CRM since the last sheet (crm_moved at either level) and the policy keeps the CRM's numbers:
--             prices and carton still update at commit
--  unchanged  quantities, prices, carton and cost already as the sheet says
--  update     anything else (reason below_reserved when a target is under what is held there: quantities skipped)
-- A blank price, carton or PP keeps the product's value (warning carton_kept for the carton); a place the sheet leaves
-- out counts as 0 there, for products it lists (open question 3).
create function public.validate_stock_import(p_batch uuid, p_moved_policy text default 'keep_crm') returns jsonb
language plpgsql volatile security invoker set search_path = '' set work_mem = '32MB' as $$
declare
  b public.import_batches%rowtype;
  v_wh uuid;
  v_tr uuid;
  v_use_sheet boolean;
  v_summary jsonb;
begin
  perform private.assert_import_admin(true);
  if p_moved_policy is null or p_moved_policy not in ('keep_crm', 'use_sheet') then
    raise exception 'unknown policy' using errcode = '22023';
  end if;
  v_use_sheet := p_moved_policy = 'use_sheet';
  b := private.stock_batch_for(p_batch, true);
  if b.uploaded_by is distinct from (select auth.uid()) then
    raise exception 'only the person who started this import can check it' using errcode = '42501';
  end if;
  if b.status not in ('staged', 'dry_run') then
    raise exception 'this import cannot be checked now' using errcode = '22023', hint = 'not_ready';
  end if;
  if (select count(*) from private.stock_import_staging s where s.batch_id = p_batch) <> b.row_count then
    raise exception 'some rows have not arrived' using errcode = '22023', hint = 'incomplete';
  end if;
  select l.id into v_wh from public.locations l where l.org_id = b.org_id and l.kind = 'warehouse';
  select l.id into v_tr from public.locations l where l.org_id = b.org_id and l.kind = 'transit';

  with s as (
    select st.row_no, st.name, st.name_key, st.location_kind, st.quantity, st.pieces_per_carton as ppc, st.price_min,
           st.price_max, st.total_cost, st.problems, st.db_problem
      from private.stock_import_staging st
     where st.batch_id = p_batch
  ), r as (
    select s.*, (cardinality(s.problems) > 0 or s.db_problem is not null or s.location_kind is null) as bad from s
  ), f as materialized (
    select r.*,
           case when not r.bad then min(r.row_no) filter (where not r.bad) over (partition by r.name_key, r.location_kind)
           end as first_same
      from r
  ), l as (
    select f.*, (not f.bad and f.first_same = f.row_no) as live from f
  ), g as materialized (
    select l.*,
           min(l.row_no) filter (where l.live) over w as gfirst,
           max(l.quantity) filter (where l.live and l.location_kind = 'warehouse') over w as q_wh,
           max(l.quantity) filter (where l.live and l.location_kind = 'transit') over w as q_tr,
           min(l.ppc) filter (where l.live) over w as ppc_lo,
           max(l.ppc) filter (where l.live) over w as ppc_hi,
           max(l.price_min) filter (where l.live and l.location_kind = 'warehouse') over w as wmin,
           max(l.price_max) filter (where l.live and l.location_kind = 'warehouse') over w as wmax,
           max(l.price_min) filter (where l.live and l.location_kind = 'transit') over w as tmin,
           max(l.price_max) filter (where l.live and l.location_kind = 'transit') over w as tmax,
           sum(l.total_cost) filter (where l.live and l.quantity > 0 and l.total_cost is not null) over w as cost_sum,
           sum(l.quantity) filter (where l.live and l.quantity > 0 and l.total_cost is not null) over w as cost_qty
      from l
    window w as (partition by l.name_key)
  ), m as materialized (
    -- The product and its two levels, read once per product (on its first live row) by the unique name key.
    select g.*,
           pr.id as pid, pr.archived_at is not null as archived, pr.pieces_per_carton as p_ppc, pr.price_min as p_min,
           pr.price_max as p_max, pc.cost_per_piece as p_cost,
           coalesce(lw.on_hand, 0) as wh_on, coalesce(lw.reserved, 0) as wh_res, coalesce(lw.crm_moved, false) as wh_moved,
           coalesce(lt.on_hand, 0) as tr_on, coalesce(lt.reserved, 0) as tr_res, coalesce(lt.crm_moved, false) as tr_moved
      from g
      left join public.products pr on g.live and g.row_no = g.gfirst and pr.org_id = b.org_id and pr.name_key = g.name_key
      left join private.product_costs pc on pc.product_id = pr.id
      left join public.stock_levels lw on lw.product_id = pr.id and lw.location_id = v_wh
      left join public.stock_levels lt on lt.product_id = pr.id and lt.location_id = v_tr
  ), v as (
    select m.*,
           coalesce(m.q_wh, 0) as sheet_wh, coalesce(m.q_tr, 0) as sheet_tr,
           coalesce(m.ppc_hi, m.p_ppc) as fppc,
           coalesce(coalesce(m.wmin, m.tmin), m.p_min) as fmin,
           coalesce(coalesce(m.wmax, m.tmax), m.p_max) as fmax,
           coalesce(round(m.cost_sum / nullif(m.cost_qty, 0), 6), m.p_cost) as fcost,
           round(m.cost_sum / nullif(m.cost_qty, 0), 6) as sheet_cost
      from m
  ), t as (
    -- The transfer a commit would post (stock the sheet moved from transit to the warehouse), and the held pieces it
    -- moves with it, to check each target against what is held there afterwards.
    select v.*,
           least(greatest(v.tr_on - v.sheet_tr, 0), greatest(v.sheet_wh - v.wh_on, 0)) as tq
      from v
  ), o as (
    select t.row_no, t.gfirst, t.pid,
           case
             when t.bad then 'rejected'
             when not t.live then 'repeated'
             when t.ppc_lo is distinct from t.ppc_hi then 'rejected'
             when t.row_no <> t.gfirst then null                               -- filled from the group's first row below
             when t.pid is null and t.fppc is null then 'rejected'
             when t.fmin > t.fmax then 'rejected'
             when t.pid is null then 'new'
             when (t.wh_moved or t.tr_moved) and not v_use_sheet then 'moved'
             when t.sheet_wh = t.wh_on and t.sheet_tr = t.tr_on and not t.archived
                  and t.fppc is not distinct from t.p_ppc and t.fmin is not distinct from t.p_min
                  and t.fmax is not distinct from t.p_max and t.fcost is not distinct from t.p_cost then 'unchanged'
             else 'update'
           end as outcome,
           case
             when t.bad then t.db_problem
             when not t.live then null
             when t.ppc_lo is distinct from t.ppc_hi then 'carton_conflict'
             when t.row_no <> t.gfirst then null
             when t.pid is null and t.fppc is null then 'carton_required'
             when t.fmin > t.fmax then 'db_price'
             when t.pid is null then null
             when (t.wh_moved or t.tr_moved) and not v_use_sheet then 'moved_in_crm'
             when t.sheet_wh < t.wh_res + least(t.tq, t.tr_res) or t.sheet_tr < t.tr_res - least(t.tq, t.tr_res)
               then 'below_reserved'
           end as reason,
           case when not t.bad and t.live then
             array_remove(array[
               case when (t.wmin is not null and t.tmin is not null and t.wmin <> t.tmin)
                         or (t.wmax is not null and t.tmax is not null and t.wmax <> t.tmax) then 'prices_differ' end,
               case when t.row_no = t.gfirst and t.pid is not null and t.ppc_hi is null then 'carton_kept' end,
               case when t.row_no = t.gfirst and t.archived then 'restored' end], null)
           else '{}'::text[] end as warnings,
           case when not t.live then t.first_same end as match_row_no,
           t.sheet_wh, t.sheet_tr, t.fppc, t.fmin, t.fmax, t.fcost, t.wh_on, t.tr_on, t.wh_res + t.tr_res as res,
           (t.wh_moved or t.tr_moved) as moved, t.live, t.bad
      from t
  ), x as (
    -- Every live row of a product takes its group's outcome, reason and product (from the group's first row); a
    -- below_reserved product whose fields do not change either is "unchanged".
    select o.row_no, o.live, o.bad, o.warnings, o.match_row_no,
           coalesce(o.outcome, first_value(o.outcome) over p) as outcome0,
           case when o.outcome = 'rejected' and o.reason = 'carton_conflict' then o.reason
                when o.outcome is null then first_value(o.reason) over p else o.reason end as reason,
           first_value(o.pid) over p as pid, o.row_no = o.gfirst as gfirst,
           first_value(o.sheet_wh) over p as sheet_wh, first_value(o.sheet_tr) over p as sheet_tr,
           first_value(o.fppc) over p as fppc, first_value(o.fmin) over p as fmin, first_value(o.fmax) over p as fmax,
           first_value(o.fcost) over p as fcost, first_value(o.wh_on) over p as wh_on, first_value(o.tr_on) over p as tr_on,
           first_value(o.res) over p as res, first_value(o.moved) over p as moved
      from o
    window p as (partition by o.gfirst order by o.row_no = o.gfirst desc, o.row_no
                 rows between unbounded preceding and unbounded following)
  )
  update private.stock_import_staging s
     set outcome = case when x.bad then 'rejected' when not x.live then 'repeated' else x.outcome0 end,
         reason = case when not x.live and not x.bad then null else x.reason end,
         db_warnings = x.warnings,
         group_first = x.live and x.gfirst and x.outcome0 <> 'rejected',
         match_product_id = case when x.live then x.pid end,
         match_row_no = x.match_row_no,
         use_sheet = v_use_sheet,
         sheet_wh = case when x.live then x.sheet_wh end, sheet_tr = case when x.live then x.sheet_tr end,
         final_ppc = case when x.live then x.fppc end, final_min = case when x.live then x.fmin end,
         final_max = case when x.live then x.fmax end, final_cost = case when x.live then x.fcost end,
         wh_at_check = case when x.live then x.wh_on end, tr_at_check = case when x.live then x.tr_on end,
         reserved_at_check = case when x.live then x.res end, moved_at_check = case when x.live then x.moved end
    from x
   where s.batch_id = p_batch and s.row_no = x.row_no;

  update public.import_batches set status = 'dry_run' where id = p_batch returning * into b;

  -- The screen's summary (design 7.9): pieces before and after per place for the products in the sheet, the products
  -- with stock that the sheet does not list (left as they are), and the counts.
  select jsonb_build_object(
           'wh_before', coalesce(sum(s.wh_at_check) filter (where s.group_first), 0),
           'tr_before', coalesce(sum(s.tr_at_check) filter (where s.group_first), 0),
           'wh_after', coalesce(sum(case when s.outcome in ('new', 'update') and s.reason is null then s.sheet_wh
                                         else s.wh_at_check end) filter (where s.group_first), 0),
           'tr_after', coalesce(sum(case when s.outcome in ('new', 'update') and s.reason is null then s.sheet_tr
                                         else s.tr_at_check end) filter (where s.group_first), 0))
    into v_summary
    from private.stock_import_staging s
   where s.batch_id = p_batch;
  return jsonb_build_object('status', b.status, 'row_count', b.row_count, 'rejected', b.rejected,
                            'repeated', b.duplicates, 'issue_counts', b.issue_counts,
                            'not_in_sheet', (select count(*) from public.products p
                                              where p.org_id = b.org_id and p.archived_at is null
                                                and exists (select 1 from public.stock_levels l
                                                             where l.product_id = p.id and l.on_hand > 0)
                                                and not exists (select 1 from private.stock_import_staging s
                                                                 where s.batch_id = p_batch and s.name_key = p.name_key
                                                                   and s.outcome not in ('rejected', 'repeated'))),
                            'use_sheet', v_use_sheet) || v_summary;
end;
$$;

-- The rows a check did not mark plainly good (rejected, repeated, warnings, kept or skipped), for the Check screen and
-- the "rows not imported" file. No staged values beyond the codes: the browser still holds the file.
create function public.list_stock_import_issues(p_batch uuid, p_after_row integer default 0, p_limit integer default 1000)
returns table (row_no integer, outcome text, problems text[], fixes text[], db_warnings text[], reason text,
               match_row_no integer)
language plpgsql stable security invoker set search_path = '' as $$
begin
  perform private.assert_import_admin(true);
  if p_limit is null or p_limit not between 1 and 1000 or p_after_row is null or p_after_row < 0 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  perform private.stock_batch_for(p_batch, false);
  return query
    select s.row_no, s.outcome, s.problems, s.fixes, s.db_warnings, s.reason, s.match_row_no
      from private.stock_import_staging s
     where s.batch_id = p_batch and s.row_no > p_after_row
       and (s.outcome in ('rejected', 'repeated', 'moved', 'kept', 'skipped') or s.reason is not null
            or cardinality(s.fixes) > 0 or cardinality(s.db_warnings) > 0)
     order by s.row_no
     limit p_limit;
end;
$$;

-- The change table (design 7.9): one line per product of the sheet, by its first row: before and after per place,
-- prices before and after, the outcome. Before the import from the staged rows; after it, from the changes ledger.
create function public.list_stock_import_changes(p_batch uuid, p_after_row integer default 0, p_limit integer default 200)
returns table (row_no integer, product_id uuid, product_name text, outcome text, reason text, wh_before integer,
               wh_after integer, tr_before integer, tr_after integer, price_min_before numeric, price_max_before numeric,
               price_min_after numeric, price_max_after numeric, created boolean)
language plpgsql stable security invoker set search_path = '' as $$
declare
  b public.import_batches%rowtype;
begin
  perform private.assert_import_admin(true);
  if p_limit is null or p_limit not between 1 and 200 or p_after_row is null or p_after_row < 0 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  b := private.stock_batch_for(p_batch, false);
  if b.status in ('staged', 'dry_run', 'committing') then
    return query
      select s.row_no, s.match_product_id, coalesce(p.name, s.name), s.outcome, s.reason, s.wh_at_check,
             case when s.outcome in ('new', 'update', 'applied') and s.reason is null then s.sheet_wh else s.wh_at_check end,
             s.tr_at_check,
             case when s.outcome in ('new', 'update', 'applied') and s.reason is null then s.sheet_tr else s.tr_at_check end,
             p.price_min, p.price_max, s.final_min, s.final_max, s.match_product_id is null
        from private.stock_import_staging s
        left join public.products p on p.id = s.match_product_id
       where s.batch_id = p_batch and s.group_first and s.row_no > p_after_row
       order by s.row_no
       limit p_limit;
  else
    -- After the import there are no staged rows: the products it changed, in product-number order (row_no carries the
    -- product's reference number as the cursor).
    return query
      select p.number, c.product_id, p.name, case when c.undone_at is not null then 'undone'
                                                  when c.kept_reason is not null then 'kept' else 'applied' end,
             c.kept_reason, null::integer, null::integer, null::integer, null::integer,
             c.old_price_min, c.old_price_max, c.new_price_min, c.new_price_max, c.created
        from private.stock_import_changes c
        join public.products p on p.id = c.product_id
       where c.batch_id = p_batch and p.number > p_after_row
       order by p.number
       limit p_limit;
  end if;
end;
$$;

-- Imports the next products (up to p_max_rows) and says how many remain; call again until status is 'imported'
-- (design 7.7). Each call is one transaction: new products are created first (a name taken meanwhile is skipped as
-- added_meanwhile); then lock_stock_import locks every product of the chunk (product, then its levels); then, product
-- by product in id order, the old values are kept in stock_import_changes, the fields and the cost updated, the
-- archived restored, and the quantities set to the sheet's targets under the lock, unless the product moved in the CRM
-- (kept, with the default policy) or a target is under what is held there (skipped). A product's staged rows are marked
-- in the same transaction, so a retry after a dropped connection never applies anything twice; on a timeout the
-- browser halves p_max_rows and calls again.
create function public.commit_stock_import(p_batch uuid, p_max_rows integer default 250) returns jsonb
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  b public.import_batches%rowtype;
  v_wh uuid;
  v_tr uuid;
  g record;
  v_id uuid;
  v_hint text;
  v_ids uuid[];
  p record;
  lw record;
  lt record;
  v_cost numeric;
  v_new_min numeric;
  v_new_max numeric;
  v_new_ppc integer;
  v_t integer;
  v_held integer;
  v_d integer;
  v_out_id bigint;
  v_group uuid;
  v_out text;
  v_reason text;
  v_moved_rows boolean;
  v_created integer := 0;
  v_done integer := 0;
  v_remaining integer;
begin
  perform private.assert_import_admin(true);
  if p_max_rows is null or p_max_rows not between 1 and 1000 then
    raise exception 'invalid chunk size' using errcode = '22023';
  end if;
  b := private.stock_batch_for(p_batch, true);
  if b.uploaded_by is distinct from (select auth.uid()) then
    raise exception 'only the person who started this import can import it' using errcode = '42501';
  end if;
  if b.status = 'imported' then
    return jsonb_build_object('status', 'imported', 'done_now', 0, 'remaining', 0,
                              'products_total', (select count(*) from private.stock_import_changes c where c.batch_id = p_batch));
  elsif b.status = 'dry_run' then
    begin
      update public.import_batches set status = 'committing' where id = p_batch;
    exception when unique_violation then
      raise exception 'another stock import or undo is running' using errcode = '22023', hint = 'busy';
    end;
  elsif b.status <> 'committing' then
    raise exception 'this import cannot be imported now' using errcode = '22023', hint = 'not_ready';
  end if;
  select l.id into v_wh from public.locations l where l.org_id = b.org_id and l.kind = 'warehouse';
  select l.id into v_tr from public.locations l where l.org_id = b.org_id and l.kind = 'transit';

  -- 1. New products of this chunk, in name key order.
  for g in select s.row_no, s.name, s.name_key, s.final_ppc, s.final_min, s.final_max, s.final_cost
             from private.stock_import_staging s
            where s.batch_id = p_batch and s.group_first and s.outcome = 'new' and s.match_product_id is null
            order by s.name_key, s.row_no
            limit p_max_rows
              for update loop
    v_id := null;
    begin
      insert into public.products (name, pieces_per_carton, price_min, price_max, import_batch_id)
      values (g.name, g.final_ppc, g.final_min, g.final_max, p_batch)
      returning id into v_id;
    exception when sqlstate '22023' or unique_violation then
      get stacked diagnostics v_hint = pg_exception_hint;
      if v_hint is distinct from 'name_taken' and sqlstate <> '23505' then
        raise;
      end if;
    end;
    if v_id is null then
      -- Someone added a product with this name since the check: its rows are skipped (the next check matches it).
      update private.stock_import_staging s set outcome = 'skipped', reason = 'added_meanwhile'
       where s.batch_id = p_batch and s.name_key = g.name_key and s.outcome = 'new';
      continue;
    end if;
    if g.final_cost is not null then
      insert into private.product_costs (product_id, cost_per_piece, source) values (v_id, g.final_cost, 'import');
    end if;
    insert into private.stock_import_changes (batch_id, product_id, created, new_price_min, new_price_max, new_ppc,
                                              new_cost)
    values (p_batch, v_id, true, g.final_min, g.final_max, g.final_ppc, g.final_cost);
    update private.stock_import_staging s set match_product_id = v_id
     where s.batch_id = p_batch and s.name_key = g.name_key and s.outcome = 'new';
    v_created := v_created + 1;
  end loop;

  -- 2. The chunk's products, locked in id order (product, then its levels).
  v_ids := array(select s.match_product_id from private.stock_import_staging s
                  where s.batch_id = p_batch and s.group_first and s.outcome in ('new', 'update', 'moved')
                    and s.match_product_id is not null
                  order by s.match_product_id
                  limit p_max_rows);
  if cardinality(v_ids) > 0 then
    perform private.lock_stock_import(p_batch, v_ids);
  end if;

  -- 3. Product by product.
  for g in select s.* from private.stock_import_staging s
            where s.batch_id = p_batch and s.group_first and s.match_product_id = any (v_ids)
            order by s.match_product_id loop
    select pr.price_min, pr.price_max, pr.pieces_per_carton, pr.archived_at into p
      from public.products pr where pr.id = g.match_product_id;
    select pc.cost_per_piece into v_cost from private.product_costs pc where pc.product_id = g.match_product_id;
    -- Blank cells keep the product's value; the sheet's prices replace both only when the result stays in order.
    v_new_ppc := coalesce(g.final_ppc, p.pieces_per_carton);
    v_new_min := g.final_min;
    v_new_max := g.final_max;
    if v_new_min > v_new_max then
      v_new_min := p.price_min;
      v_new_max := p.price_max;
    end if;
    if g.outcome <> 'new' then
      insert into private.stock_import_changes (batch_id, product_id, created, restored, old_price_min, old_price_max,
                                                old_ppc, old_cost, new_price_min, new_price_max, new_ppc, new_cost)
      values (p_batch, g.match_product_id, false, p.archived_at is not null, p.price_min, p.price_max,
              p.pieces_per_carton, v_cost, v_new_min, v_new_max, v_new_ppc, coalesce(g.final_cost, v_cost))
      on conflict (batch_id, product_id) do nothing;
      if p.archived_at is not null then
        update public.products pr set archived_at = null where pr.id = g.match_product_id;
      end if;
      if (v_new_min, v_new_max, v_new_ppc) is distinct from (p.price_min, p.price_max, p.pieces_per_carton) then
        update public.products pr set price_min = v_new_min, price_max = v_new_max, pieces_per_carton = v_new_ppc
         where pr.id = g.match_product_id;
      end if;
      if g.final_cost is not null and g.final_cost is distinct from v_cost then
        insert into private.product_costs (product_id, cost_per_piece, source)
        values (g.match_product_id, g.final_cost, 'import')
        on conflict (product_id) do update set cost_per_piece = excluded.cost_per_piece, source = excluded.source;
      end if;
    end if;
    -- Quantities, read under the lock (the CRM may have moved them since the check).
    select l.on_hand, l.reserved, l.crm_moved into lw from public.stock_levels l
     where l.product_id = g.match_product_id and l.location_id = v_wh;
    select l.on_hand, l.reserved, l.crm_moved into lt from public.stock_levels l
     where l.product_id = g.match_product_id and l.location_id = v_tr;
    v_out := 'applied';
    v_reason := null;
    v_moved_rows := false;
    if (lw.crm_moved or lt.crm_moved) and not g.use_sheet then
      v_out := 'kept';
      v_reason := 'moved_in_crm';
    else
      v_t := least(greatest(lt.on_hand - g.sheet_tr, 0), greatest(g.sheet_wh - lw.on_hand, 0));
      v_held := least(v_t, lt.reserved);
      if g.sheet_wh < lw.reserved + v_held or g.sheet_tr < lt.reserved - v_held then
        v_out := 'skipped';
        v_reason := 'below_reserved';
      else
        v_group := gen_random_uuid();
        if v_t > 0 then
          -- Stock the sheet now lists in the warehouse arrived: a transfer pair (its holds move with it, design 6.4).
          insert into private.stock_movements (group_id, product_id, location_id, kind, qty, import_batch_id)
          values (v_group, g.match_product_id, v_tr, 'transfer_out', v_t, p_batch)
          returning id into v_out_id;
          insert into private.stock_movements (group_id, product_id, location_id, kind, qty, import_batch_id, pair_id)
          values (v_group, g.match_product_id, v_wh, 'transfer_in', v_t, p_batch, v_out_id);
          v_moved_rows := true;
        end if;
        v_d := g.sheet_wh - (lw.on_hand + v_t);
        if v_d <> 0 then
          insert into private.stock_movements (group_id, product_id, location_id, kind, qty, expected_on_hand,
                                               import_batch_id)
          values (v_group, g.match_product_id, v_wh, case when v_d > 0 then 'import_in' else 'import_out' end, abs(v_d),
                  lw.on_hand + v_t, p_batch);
          v_moved_rows := true;
        end if;
        v_d := g.sheet_tr - (lt.on_hand - v_t);
        if v_d <> 0 then
          insert into private.stock_movements (group_id, product_id, location_id, kind, qty, expected_on_hand,
                                               import_batch_id)
          values (v_group, g.match_product_id, v_tr, case when v_d > 0 then 'import_in' else 'import_out' end, abs(v_d),
                  lt.on_hand - v_t, p_batch);
          v_moved_rows := true;
        end if;
        -- A product that ran out in transit has no expected date any more (design 6.4).
        if g.sheet_tr = 0 then
          update public.products pr set transit_eta = null where pr.id = g.match_product_id and pr.transit_eta is not null;
        end if;
      end if;
    end if;
    if v_moved_rows then
      update private.stock_import_changes c set qty_changed = true
       where c.batch_id = p_batch and c.product_id = g.match_product_id;
    end if;
    update private.stock_import_staging s set outcome = v_out, reason = v_reason
     where s.batch_id = p_batch and s.match_product_id = g.match_product_id and s.outcome in ('new', 'update', 'moved');
    v_done := v_done + 1;
  end loop;

  select count(*) into v_remaining from private.stock_import_staging s
   where s.batch_id = p_batch and s.group_first and s.outcome in ('new', 'update', 'moved');
  if v_remaining = 0 then
    update public.import_batches set status = 'imported' where id = p_batch;  -- the guard deletes the working rows
  end if;
  return jsonb_build_object('status', case when v_remaining = 0 then 'imported' else 'committing' end,
                            'done_now', v_done, 'created_now', v_created, 'remaining', v_remaining,
                            'products_total', (select count(*) from private.stock_import_changes c where c.batch_id = p_batch));
end;
$$;

-- What an undo would do (design 7.8): products whose quantities go back or stay (and why), new products archived or
-- kept, prices restored or kept.
create function public.preview_stock_import_rollback(p_batch uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
  perform private.assert_import_admin(false);
  perform private.stock_batch_for(p_batch, false);
  return (
    select jsonb_build_object(
             'products', count(*),
             'qty_reverse', count(*) filter (where u.qty = 'reverse'),
             'qty_kept', count(*) filter (where u.qty in ('moved', 'held', 'later_import')),
             'archive', count(*) filter (where u.archive = 'archive'),
             'archive_kept', count(*) filter (where u.archive not in ('archive', 'none')),
             'fields_restore', count(*) filter (where u.fields = 'restore' and not c.created),
             'fields_kept', count(*) filter (where u.fields = 'edited' and not c.created))
      from private.stock_import_changes c
      cross join lateral private.stock_undo_plan(p_batch, c.product_id) u
     where c.batch_id = p_batch and c.undone_at is null and c.kept_reason is null);
end;
$$;

-- Undo (design 7.8): any admin with a fresh code, chunks of products, the same locks as the commit. Per product:
-- quantities reversed with undo_in / undo_out rows (expected on hand set) when stock_undo_plan says so; a product the
-- import created or brought back is archived when nothing else uses it; prices and carton restored when unchanged since,
-- and the cost when it is still the import's. Each product is marked undone or kept (with the reason) in the same
-- transaction; call again until status is 'rolled_back'.
create function public.rollback_stock_import(p_batch uuid, p_max_rows integer default 250) returns jsonb
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s' as $$
declare
  b public.import_batches%rowtype;
  v_ids uuid[];
  c record;
  u record;
  lv record;
  v_group uuid;
  v_kept text;
  v_done integer := 0;
  v_left boolean;
begin
  perform private.assert_import_admin(true);
  if p_max_rows is null or p_max_rows not between 1 and 1000 then
    raise exception 'invalid chunk size' using errcode = '22023';
  end if;
  b := private.stock_batch_for(p_batch, true);
  if b.status = 'rolled_back' then
    return jsonb_build_object('status', 'rolled_back', 'done_now', 0, 'kept', b.kept);
  elsif b.status in ('imported', 'committing') then
    begin
      update public.import_batches set status = 'rolling_back' where id = p_batch;  -- the guard deletes the working rows
    exception when unique_violation then
      raise exception 'another stock import or undo is running' using errcode = '22023', hint = 'busy';
    end;
  elsif b.status <> 'rolling_back' then
    raise exception 'this import cannot be undone now' using errcode = '22023', hint = 'not_ready';
  end if;

  v_ids := array(select x.product_id from private.stock_import_changes x
                  where x.batch_id = p_batch and x.undone_at is null and x.kept_reason is null
                  order by x.product_id
                  limit p_max_rows);
  if cardinality(v_ids) > 0 then
    perform private.lock_stock_import(p_batch, v_ids);
  end if;
  for c in select x.* from private.stock_import_changes x
            where x.batch_id = p_batch and x.product_id = any (v_ids)
            order by x.product_id loop
    select * into u from private.stock_undo_plan(p_batch, c.product_id);
    v_kept := null;
    if u.qty = 'reverse' then
      v_group := gen_random_uuid();
      for lv in select l.id, l.kind, s.on_hand,
                       case l.kind when 'warehouse' then u.wh_net else u.tr_net end as net
                  from public.locations l
                  join public.stock_levels s on s.location_id = l.id and s.product_id = c.product_id
                 where l.org_id = c.org_id
                 order by l.id loop
        if lv.net <> 0 then
          insert into private.stock_movements (group_id, product_id, location_id, kind, qty, expected_on_hand,
                                               import_batch_id)
          values (v_group, c.product_id, lv.id, case when lv.net > 0 then 'undo_out' else 'undo_in' end, abs(lv.net),
                  lv.on_hand, p_batch);
        end if;
      end loop;
    elsif u.qty <> 'none' then
      v_kept := u.qty;
    end if;
    if u.fields = 'restore' and not c.created then
      update public.products pr
         set price_min = c.old_price_min, price_max = c.old_price_max, pieces_per_carton = c.old_ppc
       where pr.id = c.product_id;
      if c.old_cost is not null and c.new_cost is distinct from c.old_cost then
        update private.product_costs pc set cost_per_piece = c.old_cost, source = 'manual'
         where pc.product_id = c.product_id and pc.cost_per_piece = c.new_cost;
      end if;
    elsif u.fields = 'edited' then
      v_kept := coalesce(v_kept, 'edited');
    end if;
    if u.archive = 'archive' then
      update public.products pr set archived_at = now() where pr.id = c.product_id and pr.archived_at is null;
    elsif u.archive <> 'none' then
      v_kept := coalesce(v_kept, u.archive);
    end if;
    update private.stock_import_changes x
       set undone_at = case when v_kept is null then now() end, kept_reason = v_kept
     where x.batch_id = p_batch and x.product_id = c.product_id;
    v_done := v_done + 1;
  end loop;
  v_left := exists (select 1 from private.stock_import_changes x
                     where x.batch_id = p_batch and x.undone_at is null and x.kept_reason is null);
  if not v_left then
    update public.import_batches set status = 'rolled_back' where id = p_batch returning * into b;
  end if;
  return jsonb_build_object('status', case when v_left then 'rolling_back' else 'rolled_back' end, 'done_now', v_done,
                            'kept', case when not v_left then b.kept end);
end;
$$;

-- Gives up a stock import that was not imported (fresh code: it deletes the working rows). The history row stays.
create function public.discard_stock_import(p_batch uuid) returns void
language plpgsql volatile security invoker set search_path = '' as $$
declare
  b public.import_batches%rowtype;
begin
  perform private.assert_import_admin(true);
  b := private.stock_batch_for(p_batch, true);
  if b.status not in ('staged', 'dry_run') then
    raise exception 'this import cannot be discarded' using errcode = '22023', hint = 'not_ready';
  end if;
  update public.import_batches set status = 'discarded' where id = p_batch;  -- the guard deletes the working rows
end;
$$;

-- Stock import history, newest first (keyset on created_at, id). Admins, without a fresh code. p_id: one import.
create function public.list_stock_imports(
  p_limit integer default 20,
  p_before_created timestamptz default null,
  p_before_id uuid default null,
  p_id uuid default null
) returns table (id uuid, filename text, file_sha256 text, status text, row_count integer, last_row_no integer,
                 imported integer, duplicates integer, rejected integer, kept integer, issue_counts jsonb,
                 created_at timestamptz, checked_at timestamptz, imported_at timestamptz, rolled_back_at timestamptz,
                 uploaded_by uuid, uploader_first_name text, uploader_last_name text, undone_by_first_name text)
language plpgsql stable security invoker set search_path = '' as $$
begin
  perform private.assert_import_admin(false);
  if p_limit is null or p_limit not between 1 and 50 or (p_before_created is null) <> (p_before_id is null) then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  return query
    select b.id, b.filename, b.file_sha256, b.status, b.row_count, b.last_row_no,
           case when b.status in ('committing', 'rolling_back')
                then (select count(*)::integer from private.stock_import_changes c where c.batch_id = b.id)
                else b.imported end,
           b.duplicates, b.rejected, b.kept, b.issue_counts, b.created_at, b.checked_at, b.imported_at,
           b.rolled_back_at, b.uploaded_by, u.first_name, u.last_name, r.first_name
      from public.import_batches b
      left join public.profiles u on u.id = b.uploaded_by
      left join public.profiles r on r.id = b.rolled_back_by
     where b.kind = 'stock'
       and (p_id is null or b.id = p_id)
       and (p_before_id is null or (b.created_at, b.id) < (p_before_created, p_before_id))
     order by b.created_at desc, b.id desc
     limit p_limit;
end;
$$;

-- ===========================================================================
-- 9. The stock engine (6a) learns the import's rows, and the nightly job its clean-up
-- ===========================================================================
-- The guard: import_in / import_out / undo_in / undo_out and import-tagged transfers, with their batch's rules (see the
-- block "A stock sheet import"); they are not counted by the per-person rate guard. Copied from
-- 20261016090000_stock_engine.sql (6a, not merged yet: rebase with it).
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
begin
  -- Server-set columns: whatever the row says, these come from the server and the engine.
  new.created_at := now();
  new.user_id := case when new.kind = 'expire' then null else caller end;
  new.d_on_hand := 0;
  new.d_reserved := 0;
  new.on_hand_after := 0;
  new.reserved_after := 0;
  new.level_version := 0;

  -- Kinds that can be posted. 6c adds the stock sheet's import_* and undo_* (only with their import); ship and return
  -- (6d) get their document checks with their PR.
  if new.kind is null or new.kind not in ('receive', 'adjust_in', 'adjust_out', 'count', 'transfer_out', 'transfer_in',
                                          'reserve', 'release', 'expire', 'import_in', 'import_out', 'undo_in',
                                          'undo_out')
     or (new.kind in ('import_in', 'import_out', 'undo_in', 'undo_out') and new.import_batch_id is null) then
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
  if new.order_line_id is not null
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

-- The nightly job: also discards stock imports left open for 24 hours. Copied from 20261016090000_stock_engine.sql (6a).
create or replace function private.nightly_stock_jobs() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o record;
  n integer;
  v_expired integer := 0;
  v_diffs integer := 0;
  v_tasks integer := 0;
  v_pruned integer;
  v_discarded integer;
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
  -- 6c: stock imports left open for 24 hours are discarded and their working rows (which hold costs) deleted. As the
  -- system (no claims) the batch guard leaves the row alone, so the rows are deleted here.
  update public.import_batches b set status = 'discarded'
   where b.kind = 'stock' and b.status in ('staged', 'dry_run') and b.updated_at < now() - interval '24 hours';
  get diagnostics v_discarded = row_count;
  delete from private.stock_import_staging s
   using public.import_batches b
   where b.id = s.batch_id and b.status in ('discarded', 'imported', 'rolling_back', 'rolled_back');
  return jsonb_build_object('expired', v_expired, 'integrity_rows', v_diffs, 'tasks', v_tasks,
                            'requests_pruned', v_pruned, 'stock_imports_discarded', v_discarded);
end;
$$;

-- ===========================================================================
-- 10. Function privileges
-- ===========================================================================
revoke all on function private.stock_db_problem(text, integer, integer, numeric, numeric, numeric) from public, anon;
grant execute on function private.stock_db_problem(text, integer, integer, numeric, numeric, numeric) to authenticated;
revoke all on function private.stock_import_tally(uuid), private.stock_batch_step(public.import_batches, public.import_batches, text),
  private.lock_stock_import(uuid, uuid[]), private.stock_undo_plan(uuid, uuid), private.stock_batch_for(uuid, boolean)
  from public, anon;
grant execute on function private.stock_import_tally(uuid), private.stock_batch_step(public.import_batches, public.import_batches, text),
  private.lock_stock_import(uuid, uuid[]), private.stock_undo_plan(uuid, uuid), private.stock_batch_for(uuid, boolean)
  to authenticated;
revoke all on function private.import_batch_guard(), private.stock_movement_a_guard(), private.stock_movement_b_apply(),
  private.nightly_stock_jobs() from public, anon, authenticated;
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.create_stock_import(text, text, integer, integer)',
    'public.stage_stock_import_rows(uuid, jsonb)',
    'public.validate_stock_import(uuid, text)',
    'public.list_stock_import_issues(uuid, integer, integer)',
    'public.list_stock_import_changes(uuid, integer, integer)',
    'public.commit_stock_import(uuid, integer)',
    'public.preview_stock_import_rollback(uuid)',
    'public.rollback_stock_import(uuid, integer)',
    'public.discard_stock_import(uuid)',
    'public.list_stock_imports(integer, timestamptz, uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
