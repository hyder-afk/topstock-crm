-- Day 6: stock records hold a deal (Day 5 design docs/evidence/day5/design.md section 10, D8 and open question 7;
-- Haider, 11 Oct 2026: Day 6 replaces the seam so stock records block reopening a won deal, undoing a win, changing
-- the fulfilment and deleting the deal).
--
-- * private.deal_closing_blocked(p_deal): Day 5's seam (null in 5a), filled in. Day 5's guard (private.deal_guard) and
--   public.delete_deal call it and raise 42501 with hint 'blocked_' || the answer; the app maps blocked_sales and
--   blocked_reservation (src/lib/db-errors.ts). It answers:
--     'sales'        while a confirmed (not cancelled) sale in private.orders names the deal;
--     'reservation'  while an active hold in private.stock_reservations names the deal (and no confirmed sale does);
--     null           otherwise, and for an open deal whose shipping is not chosen yet (see below).
--   Day 5 also reserved 'order'; Day 6's orders table is the sale record (shown as "Sale"), so 'sales' covers it and
--   'order' is never returned (db-errors keeps the mapping, harmless).
--   It sees every row in the deal's organisation whatever the caller's role (SECURITY DEFINER, owned by postgres,
--   search_path ''): a rep's guard must be stopped by a manager's sale. A signed-in caller of another organisation gets
--   null (no probing by id). Day 5's grants stay (revoked from public and anon, executable by authenticated, because
--   the guard and delete_deal run as the caller; the private schema has no API endpoint).
-- * An open deal with no shipping chosen (fulfilment null) has nothing to undo: Day 6d lets it take holds and either
--   kind of sale, and its Win (or a shipping choice while open) is the first decision. Day 5's guard calls the seam on
--   that first choice too (a change from null), without the new value, so the seam answers null there and the AFTER
--   UPDATE trigger fit_deal_fulfilment_to_stock checks the chosen value against the records instead: a confirmed sale
--   of the other kind gives blocked_sales; Supplier Stock while an active hold names the deal gives blocked_reservation.
--   A choice that fits the records (the usual Win after a hold or a warehouse sale) goes through.
-- * Deleting: delete_deal (the user path) is blocked by the seam; an undecided deal, and a direct DELETE through the
--   API (deals_delete lets an admin with a fresh code, or the creator in the first 120 s, delete), are blocked by the
--   BEFORE DELETE trigger block_deal_delete_on_stock for any signed-in session. A session with no signed-in user
--   (maintenance, service role) is not blocked: Day 6a's release_deal_holds_deleted then releases the holds
--   ('deal_deleted', no person) and the sales lose the link (on delete set null). The block trigger sorts before the
--   release trigger, so it sees the holds still active. That set null used to be refused by the sale guard (any deal
--   named by a sale, even a cancelled one, could not be deleted, maintenance included); order_guard now lets the foreign
--   key's action empty deal_id and nothing else (below).
-- * A sale must fit its deal: private.orders gains the BEFORE INSERT trigger order_guard_deal_fit (after order_guard,
--   which checks the deal is visible, on this lead and not lost): a sale whose kind differs from the deal's chosen
--   shipping is refused (22023 'fulfilment', the existing hint: "Choose Warehouse inventory or Supplier Stock (it must
--   match the deal)"). It locks the deal row (FOR SHARE) so a concurrent shipping change and sale are ordered: whichever
--   waits sees the other's committed row.
--
-- Redefines (REBASE when the named migration changes before this one merges):
--   private.deal_closing_blocked (20261015090000_deals_pipeline.sql, Day 5's null seam). Day 5's guard and delete_deal
--   are unchanged;
--   private.order_guard (20261019090000_sales_requests.sql, 6d): the deal-delete branch first, the rest verbatim.

-- What holds a deal, in its own organisation: a confirmed sale first, then an active hold. Called only by the definer
-- functions below (as their owner); nobody else may call it.
create function private.deal_stock_records(p_deal uuid) returns text
language sql stable set search_path = '' as $$
  select case
           when exists (select 1 from private.orders o
                         where o.deal_id = d.id and o.org_id = d.org_id and o.status = 'confirmed') then 'sales'
           when exists (select 1 from private.stock_reservations r
                         where r.deal_id = d.id and r.org_id = d.org_id and r.status = 'active') then 'reservation'
         end
    from public.deals d
   where d.id = p_deal
$$;

create or replace function private.deal_closing_blocked(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when d.status = 'open' and d.fulfilment is null then null
              else private.deal_stock_records(d.id) end
    from public.deals d
   where d.id = p_deal
     and ((select auth.uid()) is null or d.org_id = (select private.current_org_id()))
$$;
alter function private.deal_closing_blocked(uuid) owner to postgres;

-- The first shipping choice of a deal (null to a value), checked against what holds it.
create function private.deal_fulfilment_fits_stock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from private.orders o
              where o.deal_id = new.id and o.org_id = new.org_id and o.status = 'confirmed'
                and o.fulfilment <> new.fulfilment) then
    raise exception 'this deal is held by stock records' using errcode = '42501', hint = 'blocked_sales';
  end if;
  if new.fulfilment = 'direct_from_source' and exists (
       select 1 from private.stock_reservations r
        where r.deal_id = new.id and r.org_id = new.org_id and r.status = 'active') then
    raise exception 'this deal is held by stock records' using errcode = '42501', hint = 'blocked_reservation';
  end if;
  return null;
end;
$$;
create trigger fit_deal_fulfilment_to_stock after update on public.deals
  for each row when (old.fulfilment is null and new.fulfilment is not null)
  execute function private.deal_fulfilment_fits_stock();

-- A signed-in session never deletes a deal that stock records hold (delete_deal or a direct DELETE).
create function private.deal_delete_stock_block() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_block text;
begin
  if (select auth.uid()) is null then
    return old;  -- maintenance: release_deal_holds_deleted releases the holds
  end if;
  v_block := private.deal_stock_records(old.id);
  if v_block is not null then
    raise exception 'this deal is held by stock records' using errcode = '42501', hint = 'blocked_' || v_block;
  end if;
  return old;
end;
$$;
create trigger block_deal_delete_on_stock before delete on public.deals
  for each row execute function private.deal_delete_stock_block();

-- A sale names a deal only when its kind fits the deal's chosen shipping (an undecided deal takes either kind).
create function private.order_deal_fit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_fulfilment text;
begin
  if new.deal_id is null then
    return new;
  end if;
  select d.fulfilment into v_fulfilment from public.deals d
   where d.id = new.deal_id and d.org_id = new.org_id
     for share;
  if v_fulfilment is not null and v_fulfilment <> new.fulfilment then
    raise exception 'this sale does not match how the deal ships' using errcode = '22023', hint = 'fulfilment';
  end if;
  return new;
end;
$$;
create trigger order_guard_deal_fit before insert on private.orders
  for each row execute function private.order_deal_fit();

-- The sale guard (20261019090000_sales_requests.sql, 6d), copied unchanged except the first branch: a deal delete's
-- on delete set null reached the UPDATE branch and was refused (not_editable, or 'sign in first' for maintenance), so
-- no deal named by a sale (even a cancelled one) could ever be deleted. Now a cancelled sale's deal can be deleted (the
-- sale keeps its lines and ledger rows and loses the link); a confirmed sale still blocks a signed-in delete (above).
create or replace function private.order_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  d record;
  v_status text;
begin
  -- Day 6 (deal_stock_blocks): a deleted deal empties the link of the sales naming it (on delete set null) and nothing
  -- else. deal_id is not granted to clients, so only the foreign key's action (a trigger, so depth 2 here) changes it.
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1 and old.deal_id is not null and new.deal_id is null
     and (to_jsonb(new) - 'deal_id') = (to_jsonb(old) - 'deal_id') then
    return new;
  end if;
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
       or new.note ~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
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
     or new.cancel_reason ~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
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

-- Privileges: Day 5's on the seam, restated (create or replace keeps them); the rest are callable by nobody.
revoke all on function private.deal_closing_blocked(uuid) from public, anon;
grant execute on function private.deal_closing_blocked(uuid) to authenticated;
revoke all on function private.deal_stock_records(uuid), private.deal_fulfilment_fits_stock(),
  private.deal_delete_stock_block(), private.order_deal_fit() from public, anon, authenticated;
