-- Day 5a: the deals database (design docs/evidence/day5/design.md sections 2, 3.1, 4.1, 5.1 to 5.7, 6 and 10; spikes S6
-- to S9 in docs/log.md). No screens. The file name sorts after main's newest migration when the PR merges; it is renamed
-- at merge time if main moved (D35, scripts/check-migration-order.sh). What changes, in plain words:
--  - pipeline stages get a fixed key (lead, qualified, negotiations, won, lost) and a stall limit; nobody, not even an
--    admin, writes stages until a Settings screen exists (labels come from the app's messages by key);
--  - the database decides a deal's lifecycle: a deal always opens at Lead; its status, stage clock, close time and
--    version number follow its stage; winning needs a value above 0 and how it ships; losing needs a reason from a closed
--    list; won and lost are reached only from an open deal; reopening a won deal needs a fresh code (except one's own
--    undo within 2 minutes); a closed deal keeps its value and reason until it is reopened;
--  - every stage change writes one row of stage history, which only the database writes and nobody edits or deletes;
--    one's own reverse move of the deal's latest change, within 120 s and with nothing changed since, is an undo;
--  - the deal RPCs (open, move, update, delete, read, the board) and the lead following its deal (open question 1);
--  - a deal keeps its lead (no orphan deals), a deleted deal keeps its tasks, deleting a deal needs an admin with a fresh
--    code (or one's own untouched deal opened in the last 2 minutes);
--  - the audit log masks the lost note and does not diff the version number.
-- House rules (design section 3): set search_path = '' everywhere; RPCs are SECURITY INVOKER with static SQL (no format(),
-- no EXECUTE; filters are IF branches); DEFINER code is trigger-only and revoked from everyone; clients get column grants
-- only; every CHECK that input can reach has a pre-check with a constant message first. No custom setting is read.
-- Leakproof rule: numeric comparisons are not leakproof under row level security, so deals.value is never an index
-- condition or a keyset. Queries repeat the partial-index predicate literally (status = 'open' / status <> 'open').
-- Error hints added here (SQLSTATE 22023 unless noted): value, value_required, fulfilment, fulfilment_required,
-- lost_reason_required, lost_note_required, lost_note, deal_title, bounds, closed, state, reopen_first, dnc,
-- lead_required, fields, rate_limited, undo_expired, bad_cursor, bad_order, bad_scope, stage, limit; 42501 step_up,
-- not_editable, stage, source, lead_not_editable, scope, blocked_<code>; P0002 for a deal or lead that is missing or not
-- visible (the same answer for both); 23503 deal_has_order (Day 6).
-- REBASE: this migration recreates two functions from their merged bodies: private.task_guard (Day 4a) and
-- private.audit_row (Day 4b). Day 4c/4d may redefine them; each block is marked "-- REBASE" and listed in
-- docs/evidence/day5a/README.md ("Rebase points").

-- ===========================================================================
-- Part 1. Stages (gap G4, D9)
-- ===========================================================================
alter table public.pipeline_stages
  add column key text,
  add column stall_days smallint;
update public.pipeline_stages set
  key = case position when 1 then 'lead' when 2 then 'qualified' when 3 then 'negotiations' when 4 then 'won'
                      when 5 then 'lost' end,
  stall_days = case position when 1 then 7 when 2 then 14 when 3 then 21 end;
do $$
begin
  if exists (select 1 from public.pipeline_stages where key is null)
     or exists (select 1 from public.pipeline_stages s
                 where (s.key = 'won') <> s.is_won or (s.key = 'lost') <> s.is_lost) then
    raise exception 'an organisation''s pipeline stages are not the five seeded ones; fix them before this migration';
  end if;
end $$;
alter table public.pipeline_stages
  alter column key set not null,
  add constraint pipeline_stages_key_check check (key in ('lead', 'qualified', 'negotiations', 'won', 'lost')),
  add constraint pipeline_stages_key_flags check (is_won = (key = 'won') and is_lost = (key = 'lost')),
  add constraint pipeline_stages_stall_days_check check (stall_days between 1 and 365),
  add constraint pipeline_stages_stall_open_only check (stall_days is null or key in ('lead', 'qualified', 'negotiations')),
  add constraint pipeline_stages_org_key unique (org_id, key);  -- so exactly one won and one lost stage per org
drop policy pipeline_stages_admin_write on public.pipeline_stages;
drop policy pipeline_stages_admin_update on public.pipeline_stages;
drop policy pipeline_stages_admin_delete on public.pipeline_stages;
revoke insert, update, delete on public.pipeline_stages from authenticated;  -- select (own org) and require_mfa stay

-- The caller's stage by key (null when the caller has no organisation); row level security keeps it to one's own org.
create function private.stage_id(p_key text) returns uuid
language sql stable set search_path = '' as $$
  select s.id from public.pipeline_stages s where s.org_id = (select private.current_org_id()) and s.key = p_key
$$;

-- A stage's key; null when the stage is another organisation's or unknown (row level security for signed-in callers).
create function private.stage_key(p_id uuid) returns text
language sql stable set search_path = '' as $$
  select s.key from public.pipeline_stages s where s.id = p_id
$$;

-- ===========================================================================
-- Part 2. Deal columns, constraints, foreign keys, indexes (G1, G2, G5 to G8)
-- ===========================================================================
alter table public.deals
  add column title text,                         -- what is being sold ("Denim jackets, 2 pallets")
  add column lost_note text,                     -- required for the reason "other"; never copied into the audit log
  add column closed_at timestamptz,              -- guard-set
  add column version integer not null default 0, -- guard-set; optimistic concurrency
  add column created_by uuid references public.profiles (id) on delete set null,
  add column source_activity_id uuid references public.activities (id) on delete set null,  -- the Interested call (5b)
  add column request_id uuid;                    -- idempotency of open, unique per creator
alter table public.deals
  alter column company_id set not null,          -- dev: 0 deals (read-only pre-check, docs/log.md)
  alter column value drop not null,              -- null: not estimated yet (no "€0" deals)
  alter column value drop default,
  alter column fulfilment drop not null,         -- chosen at Win (Day 6 order type)
  alter column fulfilment drop default,
  drop constraint deals_company_id_fkey,
  add constraint deals_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict,
  drop constraint deals_check,
  drop constraint deals_lost_reason_check,
  drop constraint deals_value_check,
  drop constraint deals_currency_check,
  -- S6: numeric(14,2) stores 'NaN' and NaN passes value >= 0 (it sorts above every number); Infinity is refused by the
  -- column itself. The bound also refuses NaN; both are written so neither depends on the other.
  add constraint deals_value_bounds check (value is null or (value >= 0 and value <> 'NaN' and value <= 100000000)),
  add constraint deals_currency_eur check (currency = 'EUR'),
  add constraint deals_lost_reason_code check (lost_reason is null or lost_reason in
       ('price', 'timing', 'no_stock', 'competitor', 'no_response', 'shipping', 'mistake', 'other')),
  add constraint deals_lost_has_reason check (status <> 'lost' or lost_reason is not null),
  add constraint deals_other_has_note check (status <> 'lost' or lost_reason <> 'other' or lost_note is not null),
  -- "value is not null and value > 0": a CHECK lets null through (Day 4a deviation 2).
  add constraint deals_won_shape check (status <> 'won' or (value is not null and value > 0 and fulfilment is not null)),
  add constraint deals_closed_at_matches check ((status = 'open') = (closed_at is null)),
  add constraint deals_version_nonneg check (version >= 0),
  add constraint deals_title_safe check (title is null or (char_length(title) between 1 and 120
       and title !~ '[\u0001-\u001F\u007F-\u009F‪-‮⁦-⁩]')),
  add constraint deals_note_safe check (lost_note is null or (char_length(lost_note) between 1 and 500
       and lost_note !~ '[\u0001-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]'));
-- G8: a deleted deal keeps its tasks (the link becomes empty; task_guard below lets that through).
alter table public.tasks
  drop constraint tasks_deal_id_fkey,
  add constraint tasks_deal_id_fkey foreign key (deal_id) references public.deals (id) on delete set null;

-- Indexes, and the query each serves (design 3.1). Kept for their foreign keys (non-partial): deals_owner_idx (owner_id),
-- deals_stage_idx (stage_id), deals_contact_idx (contact_id).
drop index public.deals_org_owner_idx, public.deals_company_idx;
create index deals_owner_board_idx on public.deals (owner_id, stage_id, stage_entered_at desc, id desc) where status = 'open';
create index deals_org_board_idx on public.deals (org_id, stage_id, stage_entered_at desc, id desc) where status = 'open';
create index deals_owner_closed_idx on public.deals (owner_id, status, closed_at desc, id desc) where status <> 'open';
create index deals_org_closed_idx on public.deals (org_id, status, closed_at desc, id desc) where status <> 'open';
create index deals_company_idx on public.deals (company_id, created_at desc, id desc);  -- FK, Deals tab, coupling check
create index deals_created_by_idx on public.deals (created_by, created_at);              -- FK, open rate guard
create index deals_source_activity_idx on public.deals (source_activity_id) where source_activity_id is not null;
create unique index deals_creator_request_idx on public.deals (created_by, request_id) where request_id is not null;
drop index public.activities_deal_idx;
create index activities_deal_idx on public.activities (deal_id, created_at desc, id desc) where deal_id is not null;

-- REBASE: re-copy from the latest merged body after 4c/4d merge. The task guard as Day 4a merged it, with one change:
-- deal_id joins the referential exception (a deleted deal empties the link one trigger level down, spike S5).
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
    -- A referential SET NULL from a contact, deal, entry or profile delete (spike S5), as in the activity guard.
    if pg_trigger_depth() > 1
       and changed <@ array['assignee_id', 'contact_id', 'created_by', 'deal_id', 'source_activity_id']
       and (new.assignee_id is null or new.assignee_id is not distinct from old.assignee_id)
       and (new.contact_id is null or new.contact_id is not distinct from old.contact_id)
       and (new.created_by is null or new.created_by is not distinct from old.created_by)
       and (new.deal_id is null or new.deal_id is not distinct from old.deal_id)
       and (new.source_activity_id is null or new.source_activity_id is not distinct from old.source_activity_id) then
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

-- ===========================================================================
-- Part 3. Stage history, the deal guard, move records, policies, grants, audit
-- ===========================================================================
-- History (D4): append-only, select-only for clients, written by one revoked DEFINER trigger from OLD and NEW. Stages
-- are stored as keys (no stage foreign keys to index). An undo is a new row pointing at the row it undoes.
create table public.deal_stage_history (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id),
  deal_id uuid not null references public.deals (id) on delete cascade,
  actor_id uuid,                                            -- no FK, like audit_log.actor_id
  kind text not null check (kind in ('open', 'move', 'won', 'lost', 'reopen', 'undo')),
  from_stage text check (from_stage in ('lead', 'qualified', 'negotiations', 'won', 'lost')),
  to_stage text not null check (to_stage in ('lead', 'qualified', 'negotiations', 'won', 'lost')),
  prev_stage_entered_at timestamptz,                        -- what an undo restores
  prev_closed_at timestamptz,
  value_before numeric(14, 2),
  value_after numeric(14, 2),                               -- on won rows it feeds analytics
  fulfilment_before text,
  lost_reason text,                                         -- the code on a 'lost' row; never the note
  version_after integer not null,
  undoes bigint references public.deal_stage_history (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint deal_stage_history_undo_pair check ((kind = 'undo') = (undoes is not null)),
  constraint deal_stage_history_open_from check ((kind = 'open') = (from_stage is null))
);
create index deal_stage_history_deal_idx on public.deal_stage_history (deal_id, id desc);
create index deal_stage_history_actor_idx on public.deal_stage_history (actor_id, created_at desc);  -- rate guard, Mine feed
create index deal_stage_history_org_idx on public.deal_stage_history (org_id, created_at desc);      -- Team feed, org FK
create index deal_stage_history_undoes_idx on public.deal_stage_history (undoes) where undoes is not null;
alter table public.deal_stage_history enable row level security;
create policy require_mfa on public.deal_stage_history as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
create policy deal_history_select on public.deal_stage_history for select to authenticated using (
  org_id = (select private.current_org_id())
  and exists (select 1 from public.deals d where d.id = deal_stage_history.deal_id));  -- deals RLS decides
revoke all on public.deal_stage_history from public, anon, authenticated;
grant select on public.deal_stage_history to authenticated;                         -- no insert, update or delete

-- The undo candidate (D6), one definition for the guard and the history trigger (spike S9: both get the same answer in
-- one UPDATE). The deal's latest history row, when it is a move, win, loss or reopen by the caller, made under 120 s ago,
-- going the other way (its "to" is the deal's stage now and its "from" is the target), and nothing changed the deal since
-- (its version_after is the deal's version now). now() is the transaction time, and history for a deal is written only
-- under its row lock, so the answer cannot change inside one statement.
create function private.deal_undo_candidate(p_deal uuid, p_from text, p_to text, p_old_version integer) returns bigint
language sql stable set search_path = '' as $$
  select h.id
    from (select x.id, x.kind, x.actor_id, x.created_at, x.from_stage, x.to_stage, x.version_after
            from public.deal_stage_history x
           where x.deal_id = p_deal
           order by x.id desc
           limit 1) h
   where h.kind in ('move', 'won', 'lost', 'reopen')
     and h.actor_id = (select auth.uid())
     and h.created_at > now() - interval '120 seconds'
     and h.to_stage = p_from
     and h.from_stage = p_to
     and h.version_after = p_old_version
$$;

-- The Day 6 seam (section 10): returns null in 5a. Day 6 replaces it with create or replace, returning 'order', 'sales'
-- or 'reservation' while one blocks reopening a won deal, undoing a win, changing fulfilment or deleting the deal. Day 6
-- never redefines the deal guard.
create function private.deal_closing_blocked(p_deal uuid) returns text
language sql stable set search_path = '' as $$
  select null::text where p_deal is not null
$$;

-- The deal guard (INVOKER; trigger guard_deal BEFORE INSERT OR UPDATE ON deals). The name sorts after
-- enforce_org_and_owner (org set, owner rule run) and before set_updated_at. Sessions with no signed-in user (fixtures,
-- the perf seed, maintenance) are left alone, as Day 3a's and 4a's triggers do. Every raise is a constant message and
-- a hint: no value ever reaches a log.
create function private.deal_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  changed text[];
  v_from text;
  v_to text;
  v_h bigint;
  v_hist record;
  v_block text;
  v_lead_status text;
begin
  if caller is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- 1. Server-set: a deal always opens at Lead, open, version 0, in euros, now, created by and (by default) owned by
    -- the caller (G11: enforce_org_and_owner leaves an admin's ownerless insert empty).
    new.created_by := caller;
    new.version := 0;
    new.status := 'open';
    new.closed_at := null;
    new.lost_reason := null;
    new.lost_note := null;
    new.currency := 'EUR';
    new.created_at := now();
    new.stage_entered_at := now();
    new.owner_id := coalesce(new.owner_id, caller);
    new.stage_id := private.stage_id('lead');
    if new.stage_id is null then
      raise exception 'no pipeline for this account' using errcode = '42501', hint = 'stage';
    end if;
    -- 2. The lead (whether the caller may change it is the policy's job).
    if new.company_id is null then
      raise exception 'a deal needs a lead' using errcode = '22023', hint = 'lead_required';
    end if;
    select c.lead_status into v_lead_status from public.companies c where c.id = new.company_id;
    if v_lead_status = 'do_not_contact' then
      raise exception 'this lead asked not to be contacted' using errcode = '22023', hint = 'dnc';
    end if;
    -- 3. Pre-checks (constant messages before the CHECKs).
    new.title := nullif(btrim(new.title), '');
    if new.title is not null and (char_length(new.title) > 120
                                  or new.title ~ '[\u0001-\u001F\u007F-\u009F‪-‮⁦-⁩]') then
      raise exception 'a deal title needs 1 to 120 characters, without control characters'
        using errcode = '22023', hint = 'deal_title';
    end if;
    if new.value is not null and (new.value = 'NaN' or new.value < 0 or new.value > 100000000) then
      raise exception 'the value must be between 0 and 100,000,000 euros' using errcode = '22023', hint = 'value';
    end if;
    if new.expected_close is not null
       and new.expected_close not between (now() - interval '1 year')::date and (now() + interval '3 years')::date then
      raise exception 'the expected close date is out of range' using errcode = '22023', hint = 'bounds';
    end if;
    if new.fulfilment is not null and new.fulfilment not in ('from_stock', 'direct_from_source') then
      raise exception 'unknown way of shipping' using errcode = '22023', hint = 'fulfilment';
    end if;
    -- 4. A deal opened from a call (5b, inside log_activity): the caller's own Interested or Book meeting call on the
    -- same lead, logged in the last 10 seconds (Day 4's task rule).
    if new.source_activity_id is not null and not exists (
         select 1 from public.activities a
          where a.id = new.source_activity_id and a.user_id = caller and a.company_id = new.company_id
            and a.type = 'call' and a.outcome in ('interested', 'meeting_booked')
            and a.created_at > now() - interval '10 seconds') then
      raise exception 'a deal can only come from your own call on this lead, just logged'
        using errcode = '42501', hint = 'source';
    end if;
    -- 5. Flood guard: at most 30 deals an hour per person (one short range read on deals_created_by_idx).
    if (select count(*) from (select 1 from public.deals d
                               where d.created_by = caller and d.created_at > now() - interval '1 hour'
                               limit 30) recent) >= 30 then
      raise exception 'too many deals opened in an hour' using errcode = '22023', hint = 'rate_limited';
    end if;
    return new;
  end if;

  -- UPDATE. 1. The columns this statement changes (updated_at is kept by its own trigger).
  select coalesce(array_agg(n.key order by n.key), '{}') into changed
    from jsonb_each(to_jsonb(new)) n
    join jsonb_each(to_jsonb(old)) o using (key)
   where n.value is distinct from o.value and n.key <> 'updated_at';
  if changed = '{}' then
    return new;
  end if;
  -- 2. A referential SET NULL from a contact, profile or entry delete runs one trigger level down (spike S5) and only
  -- empties those links. It still counts as a change of the deal (the version moves).
  if pg_trigger_depth() > 1 and changed <@ array['contact_id', 'created_by', 'owner_id', 'source_activity_id']
     and (new.contact_id is null or new.contact_id is not distinct from old.contact_id)
     and (new.created_by is null or new.created_by is not distinct from old.created_by)
     and (new.owner_id is null or new.owner_id is not distinct from old.owner_id)
     and (new.source_activity_id is null or new.source_activity_id is not distinct from old.source_activity_id) then
    new.version := old.version + 1;
    return new;
  end if;
  -- 3. Never change (org_id is held by enforce_org_and_owner).
  if changed && array['company_id', 'created_by', 'created_at', 'source_activity_id', 'request_id', 'currency', 'id'] then
    raise exception 'this part of a deal cannot change' using errcode = '42501', hint = 'not_editable';
  end if;
  -- 4. The server's columns start from the stored row and are worked out below.
  new.status := old.status;
  new.closed_at := old.closed_at;
  new.stage_entered_at := old.stage_entered_at;
  new.version := old.version;

  if new.stage_id is distinct from old.stage_id then
    -- 5a. Keys; another organisation's or an unknown stage is refused (42501, so rls_attack's line stays refused).
    v_from := private.stage_key(old.stage_id);
    v_to := private.stage_key(new.stage_id);
    if v_to is null then
      raise exception 'this stage is not one of your pipeline''s' using errcode = '42501', hint = 'stage';
    end if;
    v_h := private.deal_undo_candidate(new.id, v_from, v_to, old.version);
    if v_h is not null then
      -- 5c. Undo: the clock, close time, value and shipping come back from the history row; status follows the stage;
      -- the lost fields stay as they are; values the client sent are ignored.
      select h.prev_stage_entered_at, h.prev_closed_at, h.value_before, h.fulfilment_before into v_hist
        from public.deal_stage_history h where h.id = v_h;
      new.stage_entered_at := v_hist.prev_stage_entered_at;
      new.closed_at := v_hist.prev_closed_at;
      new.value := v_hist.value_before;
      new.fulfilment := v_hist.fulfilment_before;
      new.lost_reason := old.lost_reason;
      new.lost_note := old.lost_note;
      new.status := case v_to when 'won' then 'won' when 'lost' then 'lost' else 'open' end;
      if v_from = 'won' then
        v_block := private.deal_closing_blocked(new.id);
        if v_block is not null then
          raise exception 'this deal is held by stock records' using errcode = '42501', hint = 'blocked_' || v_block;
        end if;
      end if;
    else
      -- 5d. An ordinary move. Value and shipping change only with a win; the lost fields only with a loss.
      if v_to in ('won', 'lost') and old.status <> 'open' then
        raise exception 'reopen the deal first' using errcode = '22023', hint = 'reopen_first';
      end if;
      if v_to <> 'won' and (new.value is distinct from old.value or new.fulfilment is distinct from old.fulfilment) then
        raise exception 'the value and shipping change on their own or with a win' using errcode = '22023', hint = 'state';
      end if;
      if v_to <> 'lost' and (new.lost_reason is distinct from old.lost_reason
                             or new.lost_note is distinct from old.lost_note) then
        raise exception 'a reason goes with a loss only' using errcode = '22023', hint = 'state';
      end if;
      if v_to = 'won' then
        if new.value is null or new.value <= 0 then
          raise exception 'a won deal needs its final value' using errcode = '22023', hint = 'value_required';
        end if;
        if new.value = 'NaN' or new.value > 100000000 then
          raise exception 'the value must be between 0 and 100,000,000 euros' using errcode = '22023', hint = 'value';
        end if;
        if new.fulfilment is null then
          raise exception 'a won deal needs how it ships' using errcode = '22023', hint = 'fulfilment_required';
        end if;
        if new.fulfilment not in ('from_stock', 'direct_from_source') then
          raise exception 'unknown way of shipping' using errcode = '22023', hint = 'fulfilment';
        end if;
        new.status := 'won';
        new.closed_at := now();
      elsif v_to = 'lost' then
        if new.lost_reason is null or new.lost_reason not in ('price', 'timing', 'no_stock', 'competitor', 'no_response',
                                                              'shipping', 'mistake', 'other') then
          raise exception 'a lost deal needs a reason from the list' using errcode = '22023', hint = 'lost_reason_required';
        end if;
        new.lost_note := nullif(btrim(new.lost_note, E' \t\n'), '');
        if new.lost_reason = 'other' and new.lost_note is null then
          raise exception 'the reason "other" needs a note' using errcode = '22023', hint = 'lost_note_required';
        end if;
        if new.lost_note is not null and (char_length(new.lost_note) > 500
             or new.lost_note ~ '[\u0001-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]') then
          raise exception 'a note needs 1 to 500 characters, without control characters'
            using errcode = '22023', hint = 'lost_note';
        end if;
        new.status := 'lost';
        new.closed_at := now();
      elsif old.status = 'won' then
        -- Reopening a won deal changes the month's sales: a fresh code, and nothing in stock holding it (Day 6).
        if not (select private.has_recent_aal2(600)) then
          raise exception 'confirm it is you first' using errcode = '42501', hint = 'step_up';
        end if;
        v_block := private.deal_closing_blocked(new.id);
        if v_block is not null then
          raise exception 'this deal is held by stock records' using errcode = '42501', hint = 'blocked_' || v_block;
        end if;
        new.status := 'open';
        new.closed_at := null;
      elsif old.status = 'lost' then
        -- Reopening a lost deal keeps its reason and note (undoing this reopen still has them; the next Lose
        -- overwrites them).
        new.status := 'open';
        new.closed_at := null;
      end if;
      new.stage_entered_at := now();
    end if;
    -- 5e. Flood guard: at most 120 stage changes a minute per person (one range read on the history actor index).
    if (select count(*) from (select 1 from public.deal_stage_history h
                               where h.actor_id = caller and h.created_at > now() - interval '60 seconds'
                               limit 120) recent) >= 120 then
      raise exception 'too many stage changes in a minute' using errcode = '22023', hint = 'rate_limited';
    end if;
  else
    -- 6. Same stage. A closed deal changes only its title, contact and owner; an open deal's lost fields change only
    -- with a loss.
    if old.status <> 'open' and not changed <@ array['contact_id', 'owner_id', 'title'] then
      raise exception 'reopen the deal to change this' using errcode = '22023', hint = 'closed';
    end if;
    if changed && array['lost_note', 'lost_reason'] then
      raise exception 'a reason goes with a loss only' using errcode = '22023', hint = 'state';
    end if;
    if new.value is distinct from old.value
       and new.value is not null and (new.value = 'NaN' or new.value < 0 or new.value > 100000000) then
      raise exception 'the value must be between 0 and 100,000,000 euros' using errcode = '22023', hint = 'value';
    end if;
    if new.fulfilment is distinct from old.fulfilment then
      if new.fulfilment is not null and new.fulfilment not in ('from_stock', 'direct_from_source') then
        raise exception 'unknown way of shipping' using errcode = '22023', hint = 'fulfilment';
      end if;
      v_block := private.deal_closing_blocked(new.id);
      if v_block is not null then
        raise exception 'this deal is held by stock records' using errcode = '42501', hint = 'blocked_' || v_block;
      end if;
    end if;
  end if;

  -- Title and expected close, whenever they change (any path).
  if new.title is distinct from old.title then
    new.title := nullif(btrim(new.title), '');
    if new.title is not null and (char_length(new.title) > 120
                                  or new.title ~ '[\u0001-\u001F\u007F-\u009F‪-‮⁦-⁩]') then
      raise exception 'a deal title needs 1 to 120 characters, without control characters'
        using errcode = '22023', hint = 'deal_title';
    end if;
  end if;
  if new.expected_close is distinct from old.expected_close and new.expected_close is not null
     and new.expected_close not between (now() - interval '1 year')::date and (now() + interval '3 years')::date then
    raise exception 'the expected close date is out of range' using errcode = '22023', hint = 'bounds';
  end if;
  -- 7. Every change moves the version, on every path.
  new.version := old.version + 1;
  return new;
end;
$$;
create trigger guard_deal before insert or update on public.deals
  for each row execute function private.deal_guard();

-- The history writer (DEFINER: clients have no insert grant on the history; trigger-only and revoked from everyone).
-- The 'open' row on insert; one row per stage change, its kind from the keys, or 'undo' when the candidate matches.
-- The actor is the signed-in person (null for maintenance sessions). The lost note is never copied.
create function private.deal_history() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_from text;
  v_to text;
  v_h bigint;
  v_kind text;
begin
  if tg_op = 'INSERT' then
    insert into public.deal_stage_history (org_id, deal_id, actor_id, kind, from_stage, to_stage, value_after,
                                           version_after)
    values (new.org_id, new.id, (select auth.uid()), 'open', null, private.stage_key(new.stage_id), new.value,
            new.version);
    return null;
  end if;
  v_from := private.stage_key(old.stage_id);
  v_to := private.stage_key(new.stage_id);
  v_h := private.deal_undo_candidate(new.id, v_from, v_to, old.version);
  v_kind := case when v_h is not null then 'undo'
                 when v_to = 'won' then 'won'
                 when v_to = 'lost' then 'lost'
                 when v_from in ('won', 'lost') then 'reopen'
                 else 'move' end;
  insert into public.deal_stage_history (org_id, deal_id, actor_id, kind, from_stage, to_stage, prev_stage_entered_at,
                                         prev_closed_at, value_before, value_after, fulfilment_before, lost_reason,
                                         version_after, undoes)
  values (new.org_id, new.id, (select auth.uid()), v_kind, v_from, v_to, old.stage_entered_at, old.closed_at, old.value,
          new.value, old.fulfilment, case when v_kind = 'lost' then new.lost_reason end, new.version, v_h);
  return null;
end;
$$;
create trigger history_deal after insert on public.deals
  for each row execute function private.deal_history();
create trigger history_deal_stage after update of stage_id on public.deals
  for each row when (old.stage_id is distinct from new.stage_id) execute function private.deal_history();

-- Move records (replaces a custom-setting marker and a request-id setting): what an RPC open or move did to the lead,
-- for the compare-and-restore on undo, and its request id, for replays. Private schema: no API endpoint. Not audited
-- (no lead text). Every write RPC deletes the caller's rows older than 10 minutes. A direct PATCH writes no row: it
-- changes no lead and has no replay key.
create table private.deal_moves (
  history_id bigint primary key references public.deal_stage_history (id) on delete cascade,
  org_id uuid not null references public.orgs (id),
  user_id uuid not null,
  deal_id uuid not null references public.deals (id) on delete cascade,
  company_id uuid not null,                 -- no FK: a lead with deals cannot be deleted; keeps import_fk_coverage exact
  request_id uuid,
  prev_lead_status text check (prev_lead_status in ('cold', 'warm', 'negotiation', 'customer', 'cool_off',
                                                    'do_not_contact', 'disqualified')),
  new_lead_status text check (new_lead_status in ('cold', 'warm', 'negotiation', 'customer', 'cool_off',
                                                  'do_not_contact', 'disqualified')),
  prev_next_action_at timestamptz,
  new_next_action_at timestamptz,
  created_at timestamptz not null default now(),
  constraint deal_moves_lead_pair check ((prev_lead_status is null) = (new_lead_status is null))
);
create index deal_moves_user_idx on private.deal_moves (user_id, created_at);
create index deal_moves_deal_idx on private.deal_moves (deal_id);
create unique index deal_moves_request_idx on private.deal_moves (user_id, request_id) where request_id is not null;
alter table private.deal_moves enable row level security;
create policy require_mfa on private.deal_moves as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
-- Own rows only. A row can only be written for one's own history row of that deal, on that deal's lead.
create policy deal_moves_own on private.deal_moves for all to authenticated
  using (user_id = (select auth.uid()) and org_id = (select private.current_org_id()))
  with check (user_id = (select auth.uid()) and org_id = (select private.current_org_id())
              and exists (select 1 from public.deal_stage_history h join public.deals d on d.id = h.deal_id
                           where h.id = deal_moves.history_id and h.deal_id = deal_moves.deal_id
                             and h.actor_id = (select auth.uid()) and d.company_id = deal_moves.company_id));
revoke all on private.deal_moves from public, anon, authenticated;
grant select, insert, delete on private.deal_moves to authenticated;  -- no update: a record is used once

-- Policies (replace deals_rw). Who sees a deal is unchanged (D2): the owner, managers and admins.
drop policy deals_rw on public.deals;
create policy deals_select on public.deals for select to authenticated using (
  org_id = (select private.current_org_id())
  and ((select private.is_manager_or_admin()) or owner_id = (select auth.uid())));
-- A deal opens on a lead the caller may change, with a contact of that same lead, at a stage of the org.
create policy deals_insert on public.deals for insert to authenticated with check (
  org_id = (select private.current_org_id())
  and ((select private.is_manager_or_admin()) or owner_id = (select auth.uid()))
  and exists (select 1 from public.companies p where p.id = deals.company_id
              and ((select private.is_manager_or_admin()) or p.owner_id = (select auth.uid())))
  and (contact_id is null or exists (select 1 from public.contacts k
       where k.id = deals.contact_id and k.company_id = deals.company_id))
  and exists (select 1 from public.pipeline_stages s where s.id = deals.stage_id));
create policy deals_update on public.deals for update to authenticated
  using (org_id = (select private.current_org_id())
         and ((select private.is_manager_or_admin()) or owner_id = (select auth.uid())))
  with check (org_id = (select private.current_org_id())
              and ((select private.is_manager_or_admin()) or owner_id = (select auth.uid()))
              and (contact_id is null or exists (select 1 from public.contacts k
                   where k.id = deals.contact_id and k.company_id = deals.company_id))
              and exists (select 1 from public.pipeline_stages s where s.id = deals.stage_id));
-- Deleting: a manager or admin with a fresh code; or, without a code, one's own untouched deal opened under 120 s ago,
-- and one opened from a call only once that call's undo record is consumed (undo_activity, 5b), so the lead comes back
-- first (Day 4's tasks_delete pattern).
create policy deals_delete on public.deals for delete to authenticated using (
  org_id = (select private.current_org_id()) and (
       ((select private.has_recent_aal2(600)) and (select private.is_manager_or_admin()))
    or (created_by = (select auth.uid()) and version = 0 and created_at > now() - interval '120 seconds'
        and (source_activity_id is null
             or not exists (select 1 from private.activity_undo u where u.activity_id = deals.source_activity_id)))));

-- Column grants (G1): status, the clock, the close time, the version, the creator, the currency and the insert stage are
-- the server's. Select and delete stay granted; row level security decides.
revoke insert, update on public.deals from authenticated;
grant insert (company_id, contact_id, title, value, expected_close, fulfilment, owner_id, source_activity_id, request_id),
      update (title, value, expected_close, fulfilment, contact_id, owner_id, stage_id, lost_reason, lost_note)
  on public.deals to authenticated;

-- REBASE: re-copy from the latest merged body after 4c/4d merge. The audit trigger as Day 4b merged it, plus deals:
-- the version number is never diffed (it moves on every change); a lost note change records its lengths, not the text;
-- a new or deleted deal carries lost_note_len instead of the text. Stage, status, value, fulfilment, owner, close time
-- and stage clock stay audited with old and new values. Stage history is its own record and is not audited.
create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  hidden constant text[] := array['search_text', 'email_key', 'phone_key', 'name_key'];
  is_activity constant boolean := tg_table_name = 'activities';
  is_deal constant boolean := tg_table_name = 'deals';
  rec jsonb := (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) - hidden;
  diff jsonb;
begin
  if is_activity and tg_op = 'INSERT' then
    return new;
  end if;
  if is_deal then
    rec := (rec - 'lost_note') || jsonb_build_object('lost_note_len', char_length(rec ->> 'lost_note'));
  end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
      into diff
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value
       and n.key not in ('updated_at', 'last_activity_at', 'next_action_at', 'phone_wrong_at')
       and not n.key = any (hidden)
       and not (is_activity and n.key = 'body')
       and not (is_deal and n.key in ('version', 'lost_note'));
    if is_activity and (to_jsonb(new) -> 'body') is distinct from (to_jsonb(old) -> 'body') then
      diff := coalesce(diff, '{}'::jsonb) || jsonb_build_object('body', jsonb_build_object(
                'changed', true, 'old_len', char_length(to_jsonb(old) ->> 'body'),
                'new_len', char_length(to_jsonb(new) ->> 'body')));
    end if;
    if is_deal and (to_jsonb(new) -> 'lost_note') is distinct from (to_jsonb(old) -> 'lost_note') then
      diff := coalesce(diff, '{}'::jsonb) || jsonb_build_object('lost_note', jsonb_build_object(
                'changed', true, 'old_len', char_length(to_jsonb(old) ->> 'lost_note'),
                'new_len', char_length(to_jsonb(new) ->> 'lost_note')));
    end if;
    if diff is null then
      return new;
    end if;
  elsif tg_op = 'INSERT' and tg_table_name = 'companies' and rec ->> 'import_batch_id' is not null then
    diff := jsonb_build_object('import_batch_id', rec -> 'import_batch_id');
  elsif tg_op = 'INSERT' then
    diff := jsonb_build_object('new', rec);
  elsif tg_table_name = 'companies' and rec ->> 'import_batch_id' is not null
        and rec ->> 'updated_at' = rec ->> 'created_at'
        and exists (select 1 from public.import_batches b
                    where b.id = (rec ->> 'import_batch_id')::uuid and b.status = 'rolling_back') then
    diff := jsonb_build_object('import_batch_id', rec -> 'import_batch_id', 'undo', true);
  elsif is_activity then
    diff := jsonb_build_object('old', (rec - 'body') || jsonb_build_object('body_len', char_length(rec ->> 'body')));
  else
    diff := jsonb_build_object('old', rec);
  end if;
  insert into public.audit_log (org_id, actor_id, action, table_name, record_id, diff_json)
  values ((rec ->> 'org_id')::uuid, (select auth.uid()), lower(tg_op), tg_table_name, rec ->> 'id', diff);
  return coalesce(new, old);
end;
$$;

-- ===========================================================================
-- Part 4. The deal RPCs (design 4.1). All SECURITY INVOKER, static SQL; row level security decides every row.
-- ===========================================================================
-- Cards (design 5.6) for a list of deal ids, in the order given; invisible ids give no row. Stalled (D16, one rule):
-- open, and neither a stage move nor any activity on the lead for the stage's limit. Elapsed time in hours (24 a day),
-- so the answer does not depend on the session's time zone or a clock change.
create function private.deal_cards(p_ids uuid[])
returns table (
  id uuid, stage text, title text, company_id uuid, company_name text, city text, country text, lead_status text,
  contact_id uuid, contact_name text, value text, currency text, status text, stage_entered_at timestamptz,
  closed_at timestamptz, expected_close date, fulfilment text, owner_id uuid, owner_first_name text,
  owner_last_name text, version integer, last_activity_at timestamptz, is_stalled boolean, quiet_days integer,
  lost_reason text, created_at timestamptz, can_edit boolean
)
language sql stable set search_path = '' as $$
  select d.id, s.key, d.title, d.company_id, c.name, c.city, c.country, c.lead_status, d.contact_id,
         nullif(btrim(k.first_name || ' ' || k.last_name), ''), d.value::text, d.currency::text, d.status,
         d.stage_entered_at, d.closed_at, d.expected_close, d.fulfilment, d.owner_id, o.first_name, o.last_name,
         d.version, c.last_activity_at,
         d.status = 'open' and s.stall_days is not null
           and greatest(d.stage_entered_at, coalesce(c.last_activity_at, '-infinity'::timestamptz))
               < now() - make_interval(hours => 24 * s.stall_days),
         case when d.status = 'open' then floor(extract(epoch from now() - greatest(d.stage_entered_at,
                coalesce(c.last_activity_at, '-infinity'::timestamptz))) / 86400)::integer end,
         d.lost_reason, d.created_at,
         (select private.is_manager_or_admin()) or d.owner_id = (select auth.uid())
    from unnest(p_ids) with ordinality as u (deal_id, n)
    join public.deals d on d.id = u.deal_id
    join public.pipeline_stages s on s.id = d.stage_id
    join public.companies c on c.id = d.company_id
    left join public.contacts k on k.id = d.contact_id
    left join public.profiles o on o.id = d.owner_id
   order by u.n
$$;

-- One card as JSON (every write RPC's answer); null when the deal is not visible.
create function private.deal_card(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(x) from private.deal_cards(array[p_id]) x
$$;

-- One page of a column, as ids in order (design 5.6): one static statement per path (owner or org x open newest first,
-- open oldest first, closed newest first). The cursor defaults to the far end, so the index condition is always there.
-- p_cutoff is 'infinity' unless only stalled deals are asked for (then it is the stall limit's start: a necessary
-- condition on the stage clock, kept as an index range, plus the lead's last activity, read only then: with a custom
-- plan "p_cutoff = 'infinity'" folds to true and the lead is never looked up). p_since bounds closed deals
-- (the Won column's 30 days); '-infinity' for "See all". p_owner null means the whole org.
create function private.stage_deal_ids(p_owner uuid, p_stage uuid, p_closed text, p_oldest boolean,
                                       p_cutoff timestamptz, p_since timestamptz, p_after_at timestamptz,
                                       p_after_id uuid, p_limit integer) returns uuid[]
language plpgsql stable set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  v_org constant uuid := (select private.current_org_id());
  v_ids uuid[];
begin
  if p_closed is not null and p_owner is not null then
    select coalesce(array_agg(x.id order by x.closed_at desc, x.id desc), '{}') into v_ids from (
      select d.id, d.closed_at from public.deals d
       where d.status <> 'open' and d.owner_id = p_owner and d.status = p_closed
         and d.closed_at >= p_since
         and (d.closed_at, d.id) < (coalesce(p_after_at, 'infinity'::timestamptz),
                                    coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
       order by d.closed_at desc, d.id desc
       limit p_limit) x;
  elsif p_closed is not null then
    select coalesce(array_agg(x.id order by x.closed_at desc, x.id desc), '{}') into v_ids from (
      select d.id, d.closed_at from public.deals d
       where d.status <> 'open' and d.org_id = v_org and d.status = p_closed
         and d.closed_at >= p_since
         and (d.closed_at, d.id) < (coalesce(p_after_at, 'infinity'::timestamptz),
                                    coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
       order by d.closed_at desc, d.id desc
       limit p_limit) x;
  elsif p_owner is not null and not p_oldest then
    select coalesce(array_agg(x.id order by x.stage_entered_at desc, x.id desc), '{}') into v_ids from (
      select d.id, d.stage_entered_at from public.deals d
       where d.status = 'open' and d.owner_id = p_owner and d.stage_id = p_stage
         and (d.stage_entered_at, d.id) < (coalesce(p_after_at, 'infinity'::timestamptz),
                                           coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
         and d.stage_entered_at < p_cutoff
         and (p_cutoff = 'infinity'::timestamptz
              or exists (select 1 from public.companies c
                          where c.id = d.company_id and coalesce(c.last_activity_at, '-infinity'::timestamptz) < p_cutoff))
       order by d.stage_entered_at desc, d.id desc
       limit p_limit) x;
  elsif p_owner is not null then
    select coalesce(array_agg(x.id order by x.stage_entered_at, x.id), '{}') into v_ids from (
      select d.id, d.stage_entered_at from public.deals d
       where d.status = 'open' and d.owner_id = p_owner and d.stage_id = p_stage
         and (d.stage_entered_at, d.id) > (coalesce(p_after_at, '-infinity'::timestamptz),
                                           coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
         and d.stage_entered_at < p_cutoff
         and (p_cutoff = 'infinity'::timestamptz
              or exists (select 1 from public.companies c
                          where c.id = d.company_id and coalesce(c.last_activity_at, '-infinity'::timestamptz) < p_cutoff))
       order by d.stage_entered_at, d.id
       limit p_limit) x;
  elsif not p_oldest then
    select coalesce(array_agg(x.id order by x.stage_entered_at desc, x.id desc), '{}') into v_ids from (
      select d.id, d.stage_entered_at from public.deals d
       where d.status = 'open' and d.org_id = v_org and d.stage_id = p_stage
         and (d.stage_entered_at, d.id) < (coalesce(p_after_at, 'infinity'::timestamptz),
                                           coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
         and d.stage_entered_at < p_cutoff
         and (p_cutoff = 'infinity'::timestamptz
              or exists (select 1 from public.companies c
                          where c.id = d.company_id and coalesce(c.last_activity_at, '-infinity'::timestamptz) < p_cutoff))
       order by d.stage_entered_at desc, d.id desc
       limit p_limit) x;
  else
    select coalesce(array_agg(x.id order by x.stage_entered_at, x.id), '{}') into v_ids from (
      select d.id, d.stage_entered_at from public.deals d
       where d.status = 'open' and d.org_id = v_org and d.stage_id = p_stage
         and (d.stage_entered_at, d.id) > (coalesce(p_after_at, '-infinity'::timestamptz),
                                           coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
         and d.stage_entered_at < p_cutoff
         and (p_cutoff = 'infinity'::timestamptz
              or exists (select 1 from public.companies c
                          where c.id = d.company_id and coalesce(c.last_activity_at, '-infinity'::timestamptz) < p_cutoff))
       order by d.stage_entered_at, d.id
       limit p_limit) x;
  end if;
  return v_ids;
end;
$$;

-- The value parameter of every RPC (S6): not NaN, 0 to 100,000,000, at most 2 decimals (the column would round), so
-- Infinity never reaches the column and nothing is silently changed.
create function private.deal_value_ok(p_value numeric) returns boolean
language sql immutable set search_path = '' as $$
  select p_value is null
      or (p_value <> 'NaN' and p_value >= 0 and p_value <= 100000000 and p_value = round(p_value, 2))
$$;

-- The scope a caller gets (D21): 'team' and another person's deals are for managers and admins. Returns the owner to
-- filter on, or null for the whole org. p_strict: raise 42501 'scope' (list_stage_deals, pipeline_summary); otherwise a
-- rep's team or colleague silently becomes their own (pipeline_board's first paint never errors).
create function private.deal_scope_owner(p_scope text, p_owner uuid, p_strict boolean) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
begin
  if p_scope is null or p_scope not in ('team', 'mine') then
    raise exception 'unknown scope' using errcode = '22023', hint = 'bad_scope';
  end if;
  if (select private.is_manager_or_admin()) then
    return case when p_owner is not null then p_owner when p_scope = 'mine' then caller end;
  end if;
  if p_strict and (p_scope = 'team' or p_owner is distinct from caller and p_owner is not null) then
    raise exception 'only managers and admins see the team''s deals' using errcode = '42501', hint = 'scope';
  end if;
  return caller;
end;
$$;

-- What open_deal answers (also for a replay): the card, how many open deals the caller sees on the lead, the lead
-- before and after (from the move record), and until when the open can be undone (delete_deal without a code).
create function private.opened_deal(p_id uuid, p_replayed boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'deal', private.deal_card(d.id),
    'open_deal_count', (select count(*) from public.deals x where x.company_id = d.company_id and x.status = 'open'),
    'replayed', p_replayed,
    'lead_status_before', m.prev_lead_status,
    'lead_status_after', m.new_lead_status,
    'undo_until', d.created_at + interval '120 seconds')
  from public.deals d
  left join public.deal_stage_history h on h.deal_id = d.id and h.kind = 'open'
  left join private.deal_moves m on m.history_id = h.id
  where d.id = p_id
$$;

-- What move_deal answers for a stored move (a replay): the card now, the history row, and the lead before and after.
create function private.moved_deal(p_history bigint, p_replayed boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'result', 'moved',
    'deal', private.deal_card(h.deal_id),
    'history_id', h.id,
    'undone', h.kind = 'undo',
    'undo_until', case when h.kind <> 'undo' then h.created_at + interval '120 seconds' end,
    'lead_status_before', m.prev_lead_status,
    'lead_status_after', m.new_lead_status,
    'replayed', p_replayed)
  from public.deal_stage_history h
  left join private.deal_moves m on m.history_id = h.id
  where h.id = p_history
$$;

-- What a conflict answers (D5): the deal as it is now and who last moved it. A result, not an error.
create function private.deal_conflict(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'result', 'conflict',
    'deal', private.deal_card(p_id),
    'changed_by_first_name', (select p.first_name from public.deal_stage_history h
                               left join public.profiles p on p.id = h.actor_id
                              where h.deal_id = p_id order by h.id desc limit 1))
$$;

-- Open a deal on a lead (design 5.1). Lead editors only (the lead lock answers that). The guard sets the stage, clock,
-- creator, owner and version; the history trigger writes the 'open' row. A cold or cooling-off lead becomes warm
-- (5.4). A replayed p_request_id answers the stored deal again and changes nothing.
create function public.open_deal(
  p_company uuid,
  p_title text default null,
  p_value numeric default null,
  p_expected_close date default null,
  p_fulfilment text default null,
  p_contact uuid default null,
  p_owner uuid default null,
  p_request_id uuid default null
) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_title constant text := nullif(btrim(p_title), '');
  v_lead record;
  v_id uuid;
  v_history bigint;
  v_status text;
  v_constraint text;
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  -- 1. Validate before any write (the guard checks again).
  if v_title is not null and (char_length(v_title) > 120
                              or v_title ~ '[\u0001-\u001F\u007F-\u009F‪-‮⁦-⁩]') then
    raise exception 'a deal title needs 1 to 120 characters, without control characters'
      using errcode = '22023', hint = 'deal_title';
  end if;
  if not private.deal_value_ok(p_value) then
    raise exception 'the value must be between 0 and 100,000,000 euros, with at most 2 decimals'
      using errcode = '22023', hint = 'value';
  end if;
  if p_fulfilment is not null and p_fulfilment not in ('from_stock', 'direct_from_source') then
    raise exception 'unknown way of shipping' using errcode = '22023', hint = 'fulfilment';
  end if;
  if p_expected_close not between (now() - interval '1 year')::date and (now() + interval '3 years')::date then
    raise exception 'the expected close date is out of range' using errcode = '22023', hint = 'bounds';
  end if;
  if p_company is null then
    raise exception 'a deal needs a lead' using errcode = '22023', hint = 'lead_required';
  end if;
  -- 2. A replay answers the stored deal.
  if p_request_id is not null then
    select d.id into v_id from public.deals d where d.created_by = caller and d.request_id = p_request_id;
    if found then
      return private.opened_deal(v_id, true);
    end if;
  end if;
  -- 3. The lead (the whole team sees it), then its lock: a row comes back only to people who may change it (S7). The
  -- lock serialises opens on one lead.
  if not exists (select 1 from public.companies c where c.id = p_company) then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if p_contact is not null and not exists (select 1 from public.contacts k
                                            where k.id = p_contact and k.company_id = p_company) then
    raise exception 'contact not found on this lead' using errcode = 'P0002';
  end if;
  select c.lead_status, c.next_action_at into v_lead from public.companies c where c.id = p_company for update;
  if not found then
    raise exception 'only the lead''s owner, a manager or an admin can open a deal on it'
      using errcode = '42501', hint = 'lead_not_editable';
  end if;
  if p_request_id is not null then  -- the same request may have been saved while this one waited for the lock
    select d.id into v_id from public.deals d where d.created_by = caller and d.request_id = p_request_id;
    if found then
      return private.opened_deal(v_id, true);
    end if;
  end if;
  -- 4. The deal.
  begin
    insert into public.deals (company_id, contact_id, title, value, expected_close, fulfilment, owner_id, request_id)
    values (p_company, p_contact, v_title, p_value, p_expected_close, p_fulfilment, p_owner, p_request_id)
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'deals_creator_request_idx' then
      raise;
    end if;
    select d.id into v_id from public.deals d where d.created_by = caller and d.request_id = p_request_id;
    return private.opened_deal(v_id, true);
  end;
  -- 5. The lead follows (5.4): cold or cool off becomes warm; Do not contact and Disqualified are never touched.
  v_status := case when v_lead.lead_status in ('cold', 'cool_off') then 'warm' end;
  if v_status is not null then
    update public.companies c set lead_status = v_status where c.id = p_company;
  end if;
  -- 6. The move record of the 'open' row (lead before and after; the request id for replays); old records go.
  select h.id into v_history from public.deal_stage_history h where h.deal_id = v_id and h.kind = 'open';
  insert into private.deal_moves (history_id, org_id, user_id, deal_id, company_id, request_id, prev_lead_status,
                                  new_lead_status)
  values (v_history, (select private.current_org_id()), caller, v_id, p_company, p_request_id,
          case when v_status is not null then v_lead.lead_status end, v_status);
  delete from private.deal_moves m where m.user_id = caller and m.created_at < now() - interval '10 minutes';
  return private.opened_deal(v_id, false);
end;
$$;

-- Every stage change: move, win, lose, reopen and undo (design 5.2, one transaction). The guard decides the rules and
-- whether the change is an undo; this function locks in the global order (lead, then deal), compares the version, and
-- makes the lead follow (5.4) or puts it back (undo, compare-and-restore). A version that moved gives a conflict result.
create function public.move_deal(
  p_id uuid,
  p_stage text,
  p_expected_version integer,
  p_value numeric default null,
  p_fulfilment text default null,
  p_lost_reason text default null,
  p_lost_note text default null,
  p_undo_of bigint default null,
  p_request_id uuid default null
) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_deal record;
  v_from text;
  v_h0 bigint;
  v_h bigint;
  v_touch boolean;
  v_lead record;
  v_lead_editable boolean := false;
  v_history bigint;
  v_move private.deal_moves%rowtype;
  v_status text;
  v_next timestamptz;
  v_set_next boolean := false;
  v_before text;
  v_after text;
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  -- 1. Validate the stage and the parameter mix (constant messages; nothing written yet).
  if p_stage is null or p_stage not in ('lead', 'qualified', 'negotiations', 'won', 'lost') then
    raise exception 'unknown stage' using errcode = '22023', hint = 'stage';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'the deal''s version is needed' using errcode = '22023', hint = 'fields';
  end if;
  if (p_stage <> 'won' and (p_value is not null or p_fulfilment is not null))
     or (p_stage <> 'lost' and (p_lost_reason is not null or p_lost_note is not null)) then
    raise exception 'the value and shipping go with a win, a reason with a loss' using errcode = '22023', hint = 'state';
  end if;
  if not private.deal_value_ok(p_value) then
    raise exception 'the value must be between 0 and 100,000,000 euros, with at most 2 decimals'
      using errcode = '22023', hint = 'value';
  end if;
  if p_fulfilment is not null and p_fulfilment not in ('from_stock', 'direct_from_source') then
    raise exception 'unknown way of shipping' using errcode = '22023', hint = 'fulfilment';
  end if;
  if p_lost_reason is not null and p_lost_reason not in ('price', 'timing', 'no_stock', 'competitor', 'no_response',
                                                         'shipping', 'mistake', 'other') then
    raise exception 'a lost deal needs a reason from the list' using errcode = '22023', hint = 'lost_reason_required';
  end if;
  if char_length(btrim(p_lost_note, E' \t\n')) > 500
     or p_lost_note ~ '[\u0001-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]' then
    raise exception 'a note needs 1 to 500 characters, without control characters' using errcode = '22023', hint = 'lost_note';
  end if;
  -- 2. A replay answers the stored outcome and writes nothing.
  if p_request_id is not null then
    select m.history_id into v_history from private.deal_moves m where m.user_id = caller and m.request_id = p_request_id;
    if found then
      return private.moved_deal(v_history, true);
    end if;
  end if;
  -- 3. The deal, without a lock (P0002 when missing or not visible). Already there: unchanged.
  select d.company_id, d.version, d.status, s.key as stage into v_deal
    from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = p_id;
  if not found then
    raise exception 'deal not found' using errcode = 'P0002';
  end if;
  if v_deal.stage = p_stage then
    return jsonb_build_object('result', 'unchanged', 'deal', private.deal_card(p_id));
  end if;
  v_from := v_deal.stage;
  -- 4. Locks: lead first (only when the change will touch it), then the deal. Whether it is an undo is read once
  -- without the lock (to know whether the lead is needed) and again under it (authoritative): when the version still
  -- matches, nothing changed in between, so both reads agree.
  v_h0 := private.deal_undo_candidate(p_id, v_from, p_stage, v_deal.version);
  v_touch := case when v_h0 is not null
                  then exists (select 1 from private.deal_moves m where m.history_id = v_h0 and m.prev_lead_status is not null)
                  else p_stage in ('negotiations', 'won', 'lost') or v_from = 'lost' end;
  if v_touch then
    select c.lead_status, c.next_action_at into v_lead from public.companies c where c.id = v_deal.company_id for update;
    v_lead_editable := found;
  end if;
  -- (No join here: under READ COMMITTED a row changed by a concurrent move is re-checked on its new version against the
  -- joined stage row read before the wait, which would drop it. The key is read after the lock.)
  select d.company_id, d.version, d.status, private.stage_key(d.stage_id) as stage into v_deal
    from public.deals d where d.id = p_id for no key update;
  if not found then
    raise exception 'deal not found' using errcode = 'P0002';
  end if;
  -- 5. Someone changed the deal since the caller read it: the deal as it is now, and who moved it last.
  if v_deal.version <> p_expected_version then
    if p_request_id is not null then
      select m.history_id into v_history from private.deal_moves m where m.user_id = caller and m.request_id = p_request_id;
      if found then
        return private.moved_deal(v_history, true);
      end if;
    end if;
    return private.deal_conflict(p_id);
  end if;
  if v_deal.stage = p_stage then
    return jsonb_build_object('result', 'unchanged', 'deal', private.deal_card(p_id));
  end if;
  v_from := v_deal.stage;
  -- 6. Undo or not, under the lock. A stale Undo button is refused before anything is written.
  v_h := private.deal_undo_candidate(p_id, v_from, p_stage, v_deal.version);
  if p_undo_of is not null and v_h is distinct from p_undo_of then
    raise exception 'this can no longer be undone' using errcode = '22023', hint = 'undo_expired';
  end if;
  if v_h is null then
    if p_stage in ('won', 'lost') and v_deal.status <> 'open' then
      raise exception 'reopen the deal first' using errcode = '22023', hint = 'reopen_first';
    end if;
    if p_stage = 'lost' and p_lost_reason is null then
      raise exception 'a lost deal needs a reason from the list' using errcode = '22023', hint = 'lost_reason_required';
    end if;
    if v_from = 'won' and not (select private.has_recent_aal2(600)) then
      raise exception 'confirm it is you first' using errcode = '42501', hint = 'step_up';
    end if;
  end if;
  -- 7. The change. The guard derives status, times and version (or restores them on undo); the history trigger writes
  -- the row.
  update public.deals d
     set stage_id = private.stage_id(p_stage),
         value = coalesce(p_value, d.value),
         fulfilment = coalesce(p_fulfilment, d.fulfilment),
         lost_reason = case when p_stage = 'lost' and v_h is null then p_lost_reason else d.lost_reason end,
         lost_note = case when p_stage = 'lost' and v_h is null then nullif(btrim(p_lost_note, E' \t\n'), '')
                          else d.lost_note end
   where d.id = p_id;
  -- 8. The row just written (safe: the deal's row lock is held).
  select h.id into v_history from public.deal_stage_history h where h.deal_id = p_id order by h.id desc limit 1;
  -- 9. The lead.
  if v_h is not null then
    -- Undo: each lead field goes back only while it still holds what the change wrote.
    delete from private.deal_moves m where m.history_id = v_h returning m.* into v_move;
    if found and v_move.prev_lead_status is not null and v_lead_editable then
      update public.companies c
         set lead_status = case when c.lead_status = v_move.new_lead_status then v_move.prev_lead_status
                                else c.lead_status end,
             next_action_at = case when v_move.new_next_action_at is distinct from v_move.prev_next_action_at
                                        and c.next_action_at is not distinct from v_move.new_next_action_at
                                   then v_move.prev_next_action_at else c.next_action_at end
       where c.id = v_deal.company_id
         and (c.lead_status = v_move.new_lead_status
              or (v_move.new_next_action_at is distinct from v_move.prev_next_action_at
                  and c.next_action_at is not distinct from v_move.new_next_action_at));
      v_before := v_move.new_lead_status;
      v_after := (select c.lead_status from public.companies c where c.id = v_deal.company_id);
    end if;
  else
    -- The lead follows its deal (5.4), for lead editors only; Do not contact and Disqualified are never touched.
    if v_lead_editable then
      v_status := v_lead.lead_status;
      v_next := v_lead.next_action_at;
      if p_stage = 'negotiations' and v_lead.lead_status in ('cold', 'warm', 'cool_off') then
        v_status := 'negotiation';
      elsif p_stage = 'won' and v_lead.lead_status in ('cold', 'warm', 'negotiation', 'cool_off') then
        v_status := 'customer';
      elsif p_stage = 'lost' and v_lead.lead_status in ('warm', 'negotiation')
            and not exists (select 1 from public.deals x
                             where x.company_id = v_deal.company_id and x.id <> p_id and x.status = 'open') then
        v_status := 'cool_off';
        v_next := now() + interval '90 days';
        v_set_next := true;
      elsif v_from = 'lost' and p_stage in ('lead', 'qualified') and v_lead.lead_status = 'cool_off' then
        v_status := 'warm';
      end if;
      if v_status is distinct from v_lead.lead_status or v_set_next then
        update public.companies c
           set lead_status = v_status, next_action_at = case when v_set_next then v_next else c.next_action_at end
         where c.id = v_deal.company_id
        returning c.next_action_at into v_next;
        v_before := v_lead.lead_status;
        v_after := v_status;
      end if;
    end if;
    if v_after is not null or p_request_id is not null then
      insert into private.deal_moves (history_id, org_id, user_id, deal_id, company_id, request_id, prev_lead_status,
                                      new_lead_status, prev_next_action_at, new_next_action_at)
      values (v_history, (select private.current_org_id()), caller, p_id, v_deal.company_id, p_request_id,
              v_before, v_after, case when v_after is not null then v_lead.next_action_at end,
              case when v_after is not null then v_next end);
    end if;
  end if;
  delete from private.deal_moves m where m.user_id = caller and m.created_at < now() - interval '10 minutes';
  return private.moved_deal(v_history, false)
         || jsonb_build_object('lead_status_before', v_before, 'lead_status_after', v_after);
end;
$$;

-- A patch of the deal's own fields (only those named in p_fields change). Owner changes are for managers and admins
-- (enforce_org_and_owner). A version that moved gives a conflict result.
create function public.update_deal(
  p_id uuid,
  p_expected_version integer,
  p_fields text[],
  p_title text default null,
  p_value numeric default null,
  p_expected_close date default null,
  p_fulfilment text default null,
  p_contact uuid default null,
  p_owner uuid default null
) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_title constant text := nullif(btrim(p_title), '');
  v_deal record;
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_fields is null or cardinality(p_fields) = 0
     or not p_fields <@ array['title', 'value', 'expected_close', 'fulfilment', 'contact_id', 'owner_id']
     or array_position(p_fields, null) is not null then
    raise exception 'name the fields to change' using errcode = '22023', hint = 'fields';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'the deal''s version is needed' using errcode = '22023', hint = 'fields';
  end if;
  if 'title' = any (p_fields) and v_title is not null
     and (char_length(v_title) > 120 or v_title ~ '[\u0001-\u001F\u007F-\u009F‪-‮⁦-⁩]') then
    raise exception 'a deal title needs 1 to 120 characters, without control characters'
      using errcode = '22023', hint = 'deal_title';
  end if;
  if 'value' = any (p_fields) and not private.deal_value_ok(p_value) then
    raise exception 'the value must be between 0 and 100,000,000 euros, with at most 2 decimals'
      using errcode = '22023', hint = 'value';
  end if;
  if 'fulfilment' = any (p_fields) and p_fulfilment is not null
     and p_fulfilment not in ('from_stock', 'direct_from_source') then
    raise exception 'unknown way of shipping' using errcode = '22023', hint = 'fulfilment';
  end if;
  if 'expected_close' = any (p_fields)
     and p_expected_close not between (now() - interval '1 year')::date and (now() + interval '3 years')::date then
    raise exception 'the expected close date is out of range' using errcode = '22023', hint = 'bounds';
  end if;
  select d.version, d.company_id into v_deal from public.deals d where d.id = p_id for no key update;
  if not found then
    raise exception 'deal not found' using errcode = 'P0002';
  end if;
  if v_deal.version <> p_expected_version then
    return private.deal_conflict(p_id);
  end if;
  if 'contact_id' = any (p_fields) and p_contact is not null
     and not exists (select 1 from public.contacts k where k.id = p_contact and k.company_id = v_deal.company_id) then
    raise exception 'contact not found on this lead' using errcode = 'P0002';
  end if;
  update public.deals d
     set title = case when 'title' = any (p_fields) then v_title else d.title end,
         value = case when 'value' = any (p_fields) then p_value else d.value end,
         expected_close = case when 'expected_close' = any (p_fields) then p_expected_close else d.expected_close end,
         fulfilment = case when 'fulfilment' = any (p_fields) then p_fulfilment else d.fulfilment end,
         contact_id = case when 'contact_id' = any (p_fields) then p_contact else d.contact_id end,
         owner_id = case when 'owner_id' = any (p_fields) then p_owner else d.owner_id end
   where d.id = p_id;
  return jsonb_build_object('result', 'updated', 'deal', private.deal_card(p_id));
end;
$$;

-- Delete a deal (design 4.1, D8 and threat 15). Lead lock first (5.7). Inside the creator's window (own untouched deal,
-- opened under 120 s ago): no code, and the lead is put back from the open's move record (compare-and-restore).
-- Otherwise a fresh code (hint step_up), then a manager or admin (42501). Day 6's stock records can block it.
create function public.delete_deal(p_id uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_deal record;
  v_creator_window boolean;
  v_move private.deal_moves%rowtype;
  v_lead_editable boolean;
  v_block text;
  n integer;
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  select d.company_id, d.created_by, d.version, d.created_at, d.source_activity_id into v_deal
    from public.deals d where d.id = p_id;
  if not found then
    raise exception 'deal not found' using errcode = 'P0002';
  end if;
  v_creator_window := v_deal.created_by = caller and v_deal.version = 0
                      and v_deal.created_at > now() - interval '120 seconds';
  if not v_creator_window then
    if not (select private.has_recent_aal2(600)) then
      raise exception 'confirm it is you first' using errcode = '42501', hint = 'step_up';
    end if;
    if not (select private.is_manager_or_admin()) then
      raise exception 'only a manager or an admin can delete a deal' using errcode = '42501';
    end if;
  end if;
  v_block := private.deal_closing_blocked(p_id);
  if v_block is not null then
    raise exception 'this deal is held by stock records' using errcode = '42501', hint = 'blocked_' || v_block;
  end if;
  perform 1 from public.companies c where c.id = v_deal.company_id for update;
  v_lead_editable := found;
  select m.* into v_move from private.deal_moves m
    join public.deal_stage_history h on h.id = m.history_id
   where h.deal_id = p_id and h.kind = 'open';
  begin
    delete from public.deals d where d.id = p_id;
    get diagnostics n = row_count;
  exception when foreign_key_violation then
    raise exception 'this deal has an order; cancel the order first' using errcode = '23503', hint = 'deal_has_order';
  end;
  if n = 0 then
    raise exception 'deal not found' using errcode = 'P0002';
  end if;
  if v_creator_window and v_move.prev_lead_status is not null and v_lead_editable then
    update public.companies c set lead_status = v_move.prev_lead_status
     where c.id = v_deal.company_id and c.lead_status = v_move.new_lead_status;
  end if;
end;
$$;

-- One deal for the deal sheet; null when it is missing or not visible. Activities are listed without their text.
create function public.get_deal(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select private.deal_card(d.id) || jsonb_build_object(
    'lead', jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city, 'country', c.country,
                               'lead_status', c.lead_status,
                               'can_edit', (select private.is_manager_or_admin()) or c.owner_id = (select auth.uid())),
    'contact', case when k.id is not null then jsonb_build_object('id', k.id, 'first_name', k.first_name,
                                                                  'last_name', k.last_name) end,
    'owner', case when o.id is not null then jsonb_build_object('id', o.id, 'first_name', o.first_name,
                                                                'last_name', o.last_name) end,
    'can_delete', ((select private.has_recent_aal2(600)) and (select private.is_manager_or_admin()))
                  or (d.created_by = (select auth.uid()) and d.version = 0
                      and d.created_at > now() - interval '120 seconds'
                      and (d.source_activity_id is null
                           or not exists (select 1 from private.activity_undo u where u.activity_id = d.source_activity_id))),
    'stall_days', s.stall_days,
    'undo', (select jsonb_build_object('history_id', h.id, 'to_stage', h.from_stage,
                                       'until', h.created_at + interval '120 seconds')
               from (select x.* from public.deal_stage_history x where x.deal_id = d.id order by x.id desc limit 1) h
              where h.kind in ('move', 'won', 'lost', 'reopen') and h.actor_id = (select auth.uid())
                and h.created_at > now() - interval '120 seconds' and h.version_after = d.version),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('id', h.id, 'kind', h.kind, 'from_stage', h.from_stage,
                                          'to_stage', h.to_stage, 'actor_id', h.actor_id,
                                          'actor_first_name', p.first_name, 'created_at', h.created_at,
                                          'undoes', h.undoes, 'undone', h.undone,
                                          'value', case when h.kind = 'won' then h.value_after::text end,
                                          'lost_reason', h.lost_reason) order by h.id desc)
        from (select x.*, exists (select 1 from public.deal_stage_history u where u.undoes = x.id) as undone
                from public.deal_stage_history x where x.deal_id = d.id order by x.id desc limit 50) h
        left join public.profiles p on p.id = h.actor_id), '[]'::jsonb),
    'activities', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'type', a.type, 'outcome', a.outcome,
                                          'user_first_name', p.first_name, 'created_at', a.created_at)
                       order by a.created_at desc, a.id desc)
        from (select x.id, x.type, x.outcome, x.user_id, x.created_at from public.activities x
               where x.deal_id = d.id order by x.created_at desc, x.id desc limit 5) a
        left join public.profiles p on p.id = a.user_id), '[]'::jsonb))
  from public.deals d
  join public.pipeline_stages s on s.id = d.stage_id
  join public.companies c on c.id = d.company_id
  left join public.contacts k on k.id = d.contact_id
  left join public.profiles o on o.id = d.owner_id
  where d.id = p_id
$$;

-- One page of a column (design 5.6). 'team' and another person's deals are for managers and admins (42501 'scope').
-- Open stages page by (stage_entered_at, id): 'recent' (newest first, the default) or 'oldest'; won and lost page by
-- (closed_at, id), newest first, with no age limit ("See all won", "See lost deals").
create function public.list_stage_deals(
  p_stage text,
  p_scope text default 'team',
  p_owner uuid default null,
  p_stalled_only boolean default false,
  p_order text default 'recent',
  p_after_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid, stage text, title text, company_id uuid, company_name text, city text, country text, lead_status text,
  contact_id uuid, contact_name text, value text, currency text, status text, stage_entered_at timestamptz,
  closed_at timestamptz, expected_close date, fulfilment text, owner_id uuid, owner_first_name text,
  owner_last_name text, version integer, last_activity_at timestamptz, is_stalled boolean, quiet_days integer,
  lost_reason text, created_at timestamptz, can_edit boolean
)
language plpgsql stable set search_path = '' as $$
declare
  v_owner uuid;
  v_stage uuid;
  v_stall smallint;
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_stage is null or p_stage not in ('lead', 'qualified', 'negotiations', 'won', 'lost') then
    raise exception 'unknown stage' using errcode = '22023', hint = 'stage';
  end if;
  if p_order is null or p_order not in ('recent', 'oldest') then
    raise exception 'unknown order' using errcode = '22023', hint = 'bad_order';
  end if;
  if (p_after_at is null) <> (p_after_id is null) then
    raise exception 'a cursor needs both its time and its id' using errcode = '22023', hint = 'bad_cursor';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'between 1 and 100 deals' using errcode = '22023', hint = 'limit';
  end if;
  v_owner := private.deal_scope_owner(p_scope, p_owner, true);
  select s.id, s.stall_days into v_stage, v_stall from public.pipeline_stages s
   where s.org_id = (select private.current_org_id()) and s.key = p_stage;
  return query select * from private.deal_cards(private.stage_deal_ids(
    v_owner, v_stage,
    case when p_stage in ('won', 'lost') then p_stage end,
    p_order = 'oldest',
    case when coalesce(p_stalled_only, false) and v_stall is not null
         then now() - make_interval(hours => 24 * v_stall) else 'infinity'::timestamptz end,
    '-infinity'::timestamptz, p_after_at, p_after_id, p_limit));
end;
$$;

-- The summary part of the board (design 4.1; the 30 s refresh): per open stage the count, total value, deals with no
-- value and stalled deals; Won and Lost in the last 30 days (Lost by reason); the open total. Same scope rule as the
-- lists (42501 'scope'). One static statement per path (owner or org).
create function public.pipeline_summary(p_scope text default 'team', p_owner uuid default null) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_owner uuid;
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  v_owner := private.deal_scope_owner(p_scope, p_owner, true);
  return private.pipeline_summary_for(v_owner);
end;
$$;

create function private.pipeline_summary_for(p_owner uuid) returns jsonb
language plpgsql stable set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  v_org constant uuid := (select private.current_org_id());
  v_stages jsonb;
  v_won jsonb;
  v_lost jsonb;
begin
  if p_owner is not null then
    select jsonb_agg(jsonb_build_object('key', s.key, 'stall_days', s.stall_days, 'count', coalesce(x.n, 0),
                                        'value', coalesce(x.total, 0)::numeric(16, 2)::text,
                                        'no_value', coalesce(x.no_value, 0), 'stalled', coalesce(x.stalled, 0))
                     order by s.position)
      into v_stages
      from public.pipeline_stages s
      left join (select d.stage_id, count(*) as n, sum(d.value) as total,
                        count(*) filter (where d.value is null) as no_value,
                        count(*) filter (where greatest(d.stage_entered_at, coalesce(c.last_activity_at, '-infinity'::timestamptz))
                                               < now() - make_interval(hours => 24 * st.stall_days)) as stalled
                   from public.deals d
                   join public.pipeline_stages st on st.id = d.stage_id
                   join public.companies c on c.id = d.company_id
                  where d.status = 'open' and d.owner_id = p_owner
                  group by d.stage_id) x on x.stage_id = s.id
     where s.org_id = v_org and s.key in ('lead', 'qualified', 'negotiations');
    select jsonb_build_object('count', count(*), 'value', coalesce(sum(d.value), 0)::numeric(16, 2)::text) into v_won
      from public.deals d
     where d.status <> 'open' and d.owner_id = p_owner and d.status = 'won' and d.closed_at >= now() - interval '30 days';
    select jsonb_build_object('count', coalesce(sum(r.n), 0),
                              'reasons', coalesce(jsonb_agg(jsonb_build_object('code', r.lost_reason, 'count', r.n)
                                                            order by r.n desc, r.lost_reason), '[]'::jsonb))
      into v_lost
      from (select d.lost_reason, count(*) as n from public.deals d
             where d.status <> 'open' and d.owner_id = p_owner and d.status = 'lost'
               and d.closed_at >= now() - interval '30 days'
             group by d.lost_reason) r;
  else
    select jsonb_agg(jsonb_build_object('key', s.key, 'stall_days', s.stall_days, 'count', coalesce(x.n, 0),
                                        'value', coalesce(x.total, 0)::numeric(16, 2)::text,
                                        'no_value', coalesce(x.no_value, 0), 'stalled', coalesce(x.stalled, 0))
                     order by s.position)
      into v_stages
      from public.pipeline_stages s
      left join (select d.stage_id, count(*) as n, sum(d.value) as total,
                        count(*) filter (where d.value is null) as no_value,
                        count(*) filter (where greatest(d.stage_entered_at, coalesce(c.last_activity_at, '-infinity'::timestamptz))
                                               < now() - make_interval(hours => 24 * st.stall_days)) as stalled
                   from public.deals d
                   join public.pipeline_stages st on st.id = d.stage_id
                   join public.companies c on c.id = d.company_id
                  where d.status = 'open' and d.org_id = v_org
                  group by d.stage_id) x on x.stage_id = s.id
     where s.org_id = v_org and s.key in ('lead', 'qualified', 'negotiations');
    select jsonb_build_object('count', count(*), 'value', coalesce(sum(d.value), 0)::numeric(16, 2)::text) into v_won
      from public.deals d
     where d.status <> 'open' and d.org_id = v_org and d.status = 'won' and d.closed_at >= now() - interval '30 days';
    select jsonb_build_object('count', coalesce(sum(r.n), 0),
                              'reasons', coalesce(jsonb_agg(jsonb_build_object('code', r.lost_reason, 'count', r.n)
                                                            order by r.n desc, r.lost_reason), '[]'::jsonb))
      into v_lost
      from (select d.lost_reason, count(*) as n from public.deals d
             where d.status <> 'open' and d.org_id = v_org and d.status = 'lost'
               and d.closed_at >= now() - interval '30 days'
             group by d.lost_reason) r;
  end if;
  return jsonb_build_object(
    'scope', case when p_owner is null then 'team' else 'mine' end,
    'owner_id', p_owner,
    'stages', coalesce(v_stages, '[]'::jsonb),
    'won', v_won,
    'lost', v_lost,
    'open_total', jsonb_build_object(
      'count', (select coalesce(sum((e ->> 'count')::bigint), 0) from jsonb_array_elements(coalesce(v_stages, '[]')) e),
      'value', (select coalesce(sum((e ->> 'value')::numeric), 0)::numeric(16, 2)::text
                  from jsonb_array_elements(coalesce(v_stages, '[]')) e)));
end;
$$;

-- The board's first paint in one call (D21): the summary plus up to p_per_stage cards per open column (newest in stage
-- first) and the Won column (last 30 days, newest first), each with the cursor of its next page (null at the end). A
-- rep asking for the team or a colleague silently gets their own deals here only.
create function public.pipeline_board(p_scope text default 'team', p_owner uuid default null,
                                      p_per_stage integer default 50) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_owner uuid;
  v_summary jsonb;
  v_stages jsonb := '[]'::jsonb;
  v_all uuid[] := '{}';
  v_more jsonb := '{}'::jsonb;
  v_cards jsonb;
  v_col jsonb;
  v_next jsonb;
  v_ids uuid[];
  s record;
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_per_stage is null or p_per_stage not between 1 and 100 then
    raise exception 'between 1 and 100 deals' using errcode = '22023', hint = 'limit';
  end if;
  v_owner := private.deal_scope_owner(p_scope, p_owner, false);
  v_summary := private.pipeline_summary_for(v_owner);
  -- One index walk per column (one more row than shown tells whether a next page exists), then every card in one call.
  for s in select st.id, st.key from public.pipeline_stages st
            where st.org_id = (select private.current_org_id()) and st.key in ('lead', 'qualified', 'negotiations', 'won')
            order by st.position loop
    v_ids := private.stage_deal_ids(v_owner, s.id, case when s.key = 'won' then 'won' end, false, 'infinity'::timestamptz,
                                    case when s.key = 'won' then now() - interval '30 days'
                                         else '-infinity'::timestamptz end,
                                    null, null, p_per_stage + 1);
    v_all := v_all || v_ids[1:p_per_stage];
    v_more := v_more || jsonb_build_object(s.key, cardinality(v_ids) > p_per_stage);
  end loop;
  select coalesce(jsonb_object_agg(x.stage, x.cards), '{}'::jsonb) into v_cards
    from (select c.stage, jsonb_agg(to_jsonb(c) - 'ordinality' order by c.ordinality) as cards
            from private.deal_cards(v_all) with ordinality as c
           group by c.stage) x;
  for s in select k.key from unnest(array['lead', 'qualified', 'negotiations', 'won']) as k (key) loop
    v_col := coalesce(v_cards -> s.key, '[]'::jsonb);
    v_next := case when (v_more ->> s.key)::boolean then  -- the last card shown is where the next page starts
                jsonb_build_object('after_at', v_col -> -1 -> case when s.key = 'won' then 'closed_at' else 'stage_entered_at' end,
                                   'after_id', v_col -> -1 -> 'id') end;
    if s.key = 'won' then
      v_summary := jsonb_set(v_summary, '{won}', (v_summary -> 'won') || jsonb_build_object('cards', v_col, 'next', v_next));
    else
      v_stages := v_stages || jsonb_build_array(
        coalesce((select e from jsonb_array_elements(v_summary -> 'stages') e where e ->> 'key' = s.key),
                 jsonb_build_object('key', s.key)) || jsonb_build_object('cards', v_col, 'next', v_next));
    end if;
  end loop;
  return jsonb_set(v_summary, '{stages}', v_stages);
end;
$$;

-- A lead's deals for its Deals tab: open ones first (newest in stage first), then closed ones (newest close first).
create function public.list_lead_deals(p_company uuid, p_limit integer default 20)
returns table (
  id uuid, stage text, title text, company_id uuid, company_name text, city text, country text, lead_status text,
  contact_id uuid, contact_name text, value text, currency text, status text, stage_entered_at timestamptz,
  closed_at timestamptz, expected_close date, fulfilment text, owner_id uuid, owner_first_name text,
  owner_last_name text, version integer, last_activity_at timestamptz, is_stalled boolean, quiet_days integer,
  lost_reason text, created_at timestamptz, can_edit boolean
)
language plpgsql stable set search_path = '' as $$
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'between 1 and 100 deals' using errcode = '22023', hint = 'limit';
  end if;
  return query select * from private.deal_cards(array(
    select d.id from public.deals d
     where d.company_id = p_company
     order by d.status <> 'open', case when d.status = 'open' then d.stage_entered_at else d.closed_at end desc, d.id desc
     limit p_limit));
end;
$$;

-- ===========================================================================
-- Function privileges: trigger functions are never callable; the helpers the RPCs use are callable by signed-in people
-- (private has no API endpoint); every RPC is revoked from public and anon and granted to authenticated.
-- ===========================================================================
revoke all on function private.deal_guard(), private.deal_history() from public, anon, authenticated;
revoke all on function private.stage_id(text), private.stage_key(uuid),
  private.deal_undo_candidate(uuid, text, text, integer), private.deal_closing_blocked(uuid),
  private.deal_cards(uuid[]), private.deal_card(uuid),
  private.stage_deal_ids(uuid, uuid, text, boolean, timestamptz, timestamptz, timestamptz, uuid, integer),
  private.deal_value_ok(numeric), private.deal_scope_owner(text, uuid, boolean), private.opened_deal(uuid, boolean),
  private.moved_deal(bigint, boolean), private.deal_conflict(uuid), private.pipeline_summary_for(uuid)
  from public, anon;
grant execute on function private.stage_id(text), private.stage_key(uuid),
  private.deal_undo_candidate(uuid, text, text, integer), private.deal_closing_blocked(uuid),
  private.deal_cards(uuid[]), private.deal_card(uuid),
  private.stage_deal_ids(uuid, uuid, text, boolean, timestamptz, timestamptz, timestamptz, uuid, integer),
  private.deal_value_ok(numeric), private.deal_scope_owner(text, uuid, boolean), private.opened_deal(uuid, boolean),
  private.moved_deal(bigint, boolean), private.deal_conflict(uuid), private.pipeline_summary_for(uuid)
  to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.open_deal(uuid, text, numeric, date, text, uuid, uuid, uuid)',
    'public.move_deal(uuid, text, integer, numeric, text, text, text, bigint, uuid)',
    'public.update_deal(uuid, integer, text[], text, numeric, date, text, uuid, uuid)',
    'public.delete_deal(uuid)',
    'public.get_deal(uuid)',
    'public.list_stage_deals(text, text, uuid, boolean, text, timestamptz, uuid, integer)',
    'public.pipeline_summary(text, uuid)',
    'public.pipeline_board(text, uuid, integer)',
    'public.list_lead_deals(uuid, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
