-- Day 5b: deals meet the work where selling happens (design docs/evidence/day5/design.md sections 3.2, 4.2, 5.1, 5.3,
-- 5.7, 6 and 8; Day 5a's migration 20261015090000_deals_pipeline.sql). The file name sorts after main's newest migration
-- when the PR merges; it is renamed at merge time if main moved (D35, scripts/check-migration-order.sh). In plain words:
--  - an entry may name a deal again (deal_id back in the insert grant, Day 4a took it out), but only a deal the caller
--    sees on the same lead (insert policy); activity_guard already keeps deal_id fixed after the insert;
--  - log_activity takes four more defaulted parameters: p_deal (link the entry to a deal), and p_open_deal with an
--    optional title and value: Interested and Book meeting open a deal in the same transaction (D17), for people who may
--    change the lead; a Do not contact lead or a caller over the open limit skips the deal and keeps the call;
--  - undo_activity removes the deal the call opened while nobody touched it (one Undo takes back both), after the lead
--    lock (global order contact, lead, deal);
--  - get_lead says how many open deals the caller sees on the lead, the newest one, and whether the caller may open one.
-- House rules as Day 5a: set search_path = '' everywhere; SECURITY INVOKER with static SQL; constant messages; no custom
-- setting is read. Error hints added here: 22023 state (a deal with the wrong outcome, or a link and an open together),
-- bounds (p_open_deal null), deal_title, value; P0002 "deal not found on this lead".
-- REBASE: re-copy after 4c/4d merge. This migration recreates three Day 4b functions from their merged bodies:
-- public.log_activity (dropped and recreated with four new parameters), public.undo_activity and public.get_lead. Day 4c
-- redefines log_activity (p_from_queue releases the queue claim) and get_lead (queue fields), and adds
-- claim_next_lead, whose cards gain open_deal {count, latest} in 5b (design 3.2): that part waits for the 4c rebase
-- (claim_next_lead does not exist on this branch). Each block is marked "-- REBASE" and listed in
-- docs/evidence/day5b/README.md ("Rebase points").

-- ===========================================================================
-- Part 1. Entries name a deal again (gap G9; threat 17)
-- ===========================================================================
grant insert (deal_id) on public.activities to authenticated;
drop policy activities_insert on public.activities;
-- The author is the caller, the contact belongs to the same lead (Day 4a), and a deal must be one the caller sees
-- (deals RLS inside the policy) on that same lead.
create policy activities_insert on public.activities for insert to authenticated with check (
  org_id = (select private.current_org_id()) and user_id = (select auth.uid())
  and exists (select 1 from public.companies c where c.id = activities.company_id)
  and (contact_id is null or exists (select 1 from public.contacts k
       where k.id = activities.contact_id and k.company_id = activities.company_id))
  and (deal_id is null or exists (select 1 from public.deals d
       where d.id = activities.deal_id and d.company_id = activities.company_id)));

-- The deal a call opened (log_activity), so undo_activity can take it back. No foreign key: a deal deleted since leaves a
-- dangling id that matches nothing (the record lives 10 minutes at most).
alter table private.activity_undo add column created_deal_id uuid;

-- ===========================================================================
-- Part 2. log_activity, undo_activity, get_lead (design 3.2 and 5.1)
-- ===========================================================================
-- The deal part of log_activity's answer for a replayed request (the first answer's link and opened deal; a skipped
-- open's reason is not stored, so a replay says null there).
create function private.logged_activity_deal(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'deal_id', a.deal_id,
    'deal', case when u.created_deal_id is not null
                 then jsonb_build_object('id', u.created_deal_id, 'opened', true,
                                         'open_deal_count', (select count(*) from public.deals x
                                                              where x.company_id = a.company_id and x.status = 'open')) end)
  from public.activities a
  left join private.activity_undo u on u.activity_id = a.id
  where a.id = p_id
$$;

-- REBASE: re-copy after 4c/4d merge. Day 4b's log_activity as merged, plus Day 5b: p_deal (the entry names a deal of
-- this lead), p_open_deal with p_deal_title and p_deal_value (Interested or Book meeting opens a deal, step 7b), and
-- the deal part of the answer: {deal_id, deal: {id, opened: true, open_deal_count} | {opened: false, reason} | null}.
drop function public.log_activity(uuid, text, text, text, uuid, text, date, timestamptz, text, uuid, boolean);
create function public.log_activity(
  p_company uuid,
  p_type text,
  p_outcome text default null,
  p_body text default null,
  p_contact uuid default null,
  p_dialled text default null,
  p_follow_up_date date default null,
  p_follow_up_at timestamptz default null,
  p_task_title text default null,
  p_request_id uuid default null,
  p_from_queue boolean default false,
  p_deal uuid default null,
  p_open_deal boolean default false,
  p_deal_title text default null,
  p_deal_value numeric default null
) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_follow constant boolean := p_follow_up_date is not null or p_follow_up_at is not null;
  v_body text := replace(p_body, E'\r\n', E'\n');
  v_lead record;
  v_contact_phone text;
  v_contact_wrong timestamptz;
  v_editable boolean := false;
  v_contact_locked boolean := false;
  v_key text;
  v_east text;
  v_status text;
  v_next timestamptz;
  v_owner uuid;
  v_mark_company boolean := false;
  v_wrong_contact uuid;
  v_task_kind text;
  v_task uuid;
  v_assignee uuid;
  v_due_date date;
  v_due_at timestamptz;
  v_tz text;
  v_today date;
  v_completed uuid[] := '{}'::uuid[];
  v_cancelled uuid[] := '{}'::uuid[];
  v_id uuid;
  v_constraint text;
  v_deal_title constant text := nullif(btrim(p_deal_title), '');
  v_deal uuid;
  v_deal_answer jsonb;
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;

  -- 1. Validate (constant messages: no value reaches a log).
  if p_from_queue is null then
    raise exception 'say whether the call came from the queue' using errcode = '22023', hint = 'bounds';
  end if;
  -- Day 5b (design 3.2 and 5.1): a deal to link the entry to, or a deal to open from an Interested or Book meeting call.
  -- Checked before any write, with constant messages; the deal guard checks the deal again.
  if p_open_deal is null then
    raise exception 'say whether to open a deal' using errcode = '22023', hint = 'bounds';
  end if;
  if (p_open_deal and (p_type is distinct from 'call' or p_outcome is null
                       or p_outcome not in ('interested', 'meeting_booked') or p_deal is not null))
     or (not p_open_deal and (p_deal_title is not null or p_deal_value is not null)) then
    raise exception 'a deal opens from an Interested or Book meeting call, not with a linked deal'
      using errcode = '22023', hint = 'state';
  end if;
  if v_deal_title is not null and (char_length(v_deal_title) > 120
                                   or v_deal_title ~ '[\u0001-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]') then
    raise exception 'a deal title needs 1 to 120 characters, without control characters'
      using errcode = '22023', hint = 'deal_title';
  end if;
  if not private.deal_value_ok(p_deal_value) then
    raise exception 'the value must be between 0 and 100,000,000 euros, with at most 2 decimals'
      using errcode = '22023', hint = 'value';
  end if;
  if p_type is null or not coalesce(
       (p_type = 'call' and p_outcome in ('no_answer', 'voicemail', 'wrong_number', 'not_interested', 'interested',
                                          'meeting_booked', 'do_not_contact', 'connected'))
    or (p_type in ('email', 'whatsapp') and (p_outcome is null or p_outcome = 'sent'))
    or (p_type = 'meeting' and (p_outcome is null or p_outcome in ('held', 'no_show')))
    or (p_type = 'note' and p_outcome is null), false) then
    raise exception 'this outcome does not fit this kind of entry' using errcode = '22023', hint = 'outcome';
  end if;
  if v_body is not null and btrim(v_body, E' \t\n') = '' then
    v_body := null;
  end if;
  if p_type = 'note' and v_body is null then
    raise exception 'a note needs text' using errcode = '22023', hint = 'body_required';
  end if;
  if (p_dialled is not null and (p_type <> 'call' or p_dialled not in ('lead', 'contact')))
     or (p_outcome = 'wrong_number' and p_dialled is null)
     or (p_dialled = 'contact' and p_contact is null) then
    raise exception 'say which number was dialled: the lead''s or the contact''s' using errcode = '22023', hint = 'dialled';
  end if;
  if p_follow_up_date is not null and p_follow_up_at is not null then
    raise exception 'a follow-up has a date or a time, not both' using errcode = '22023', hint = 'follow_up_range';
  end if;
  if p_type = 'call' then
    if p_outcome = 'interested' then
      if not v_follow then
        raise exception 'Interested needs a follow-up date' using errcode = '22023', hint = 'follow_up_required';
      end if;
      v_task_kind := 'call';
    elsif p_outcome = 'meeting_booked' then
      if p_follow_up_at is null then
        raise exception 'a meeting needs a date and a time' using errcode = '22023', hint = 'follow_up_required';
      end if;
      v_task_kind := 'meeting';
    elsif p_outcome = 'connected' then
      if v_follow then
        v_task_kind := 'call';
      end if;
    elsif v_follow then
      raise exception 'this outcome takes no follow-up' using errcode = '22023', hint = 'follow_up_range';
    end if;
  elsif v_follow then
    -- A follow-up after an email, a message, a meeting or a note is a call; a meeting entry with no outcome and a
    -- time is a meeting being booked.
    v_task_kind := case when p_type = 'meeting' and p_outcome is null then 'meeting' else 'call' end;
    if v_task_kind = 'meeting' and p_follow_up_at is null then
      raise exception 'a meeting needs a date and a time' using errcode = '22023', hint = 'follow_up_required';
    end if;
  end if;
  -- A date from today (anywhere on earth: UTC-12) to a year ahead (anywhere: UTC+14); a time from 5 minutes ago.
  if p_follow_up_date not between ((now() at time zone 'UTC') - interval '12 hours')::date
                              and ((now() at time zone 'UTC') + interval '14 hours')::date + 366
     or p_follow_up_at not between now() - interval '5 minutes' and now() + interval '366 days' then
    raise exception 'the follow-up must be between now and a year ahead' using errcode = '22023', hint = 'follow_up_range';
  end if;
  if (v_task_kind is not null or p_outcome = 'wrong_number') and (p_task_title is null or btrim(p_task_title) = '') then
    raise exception 'the follow-up needs a title' using errcode = '22023', hint = 'task_title';
  end if;

  -- 2. A replay answers the first result and changes nothing.
  if p_request_id is not null then
    select a.id into v_id from public.activities a where a.user_id = caller and a.request_id = p_request_id;
    if found then
      return private.logged_activity(v_id, true) || private.logged_activity_deal(v_id);
    end if;
  end if;

  -- The lead (the whole team sees it) and the contact (it must belong to this lead).
  select c.id, c.owner_id, c.lead_status, c.phone, c.phone_wrong_at, c.next_action_at, c.timezone, c.country
    into v_lead from public.companies c where c.id = p_company;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if p_contact is not null then
    select k.phone, k.phone_wrong_at into v_contact_phone, v_contact_wrong
      from public.contacts k where k.id = p_contact and k.company_id = p_company;
    if not found then
      raise exception 'contact not found on this lead' using errcode = 'P0002';
    end if;
  end if;
  -- A linked deal must be one the caller sees on this same lead (the insert policy says the same).
  if p_deal is not null and not exists (select 1 from public.deals d where d.id = p_deal and d.company_id = p_company) then
    raise exception 'deal not found on this lead' using errcode = 'P0002';
  end if;
  if (p_dialled = 'lead' and v_lead.phone is null) or (p_dialled = 'contact' and v_contact_phone is null) then
    raise exception 'the dialled number is empty' using errcode = '22023', hint = 'dialled';
  end if;

  -- 3. Locks, contact then lead (the order of a contact edit whose trigger updates the lead, and of the insert lock,
  -- private.lock_activity_lead). FOR UPDATE returns a row only to people who may change it (row level security), which
  -- is how a call learns whether it may change the lead. A call naming a contact it does not mark still takes the
  -- contact first, FOR KEY SHARE (what the insert lock takes later): otherwise it would hold the lead while waiting for
  -- a contact a wrong number holds FOR UPDATE, while that wrong number waits for the lead (a deadlock).
  if p_type = 'call' then
    if p_outcome = 'wrong_number' and p_dialled = 'contact' then
      select k.phone, k.phone_wrong_at into v_contact_phone, v_contact_wrong
        from public.contacts k where k.id = p_contact for update;
      v_contact_locked := found;
    elsif p_contact is not null then
      perform 1 from public.contacts k where k.id = p_contact for key share;
    end if;
    select c.id, c.owner_id, c.lead_status, c.phone, c.phone_wrong_at, c.next_action_at, c.timezone, c.country
      into v_lead from public.companies c where c.id = p_company for update;
    v_editable := found;
    if not v_editable then
      select c.id, c.owner_id, c.lead_status, c.phone, c.phone_wrong_at, c.next_action_at, c.timezone, c.country
        into v_lead from public.companies c where c.id = p_company;
    end if;
    -- The same request may have been saved while this one waited for the lock.
    if p_request_id is not null then
      select a.id into v_id from public.activities a where a.user_id = caller and a.request_id = p_request_id;
      if found then
        return private.logged_activity(v_id, true) || private.logged_activity_deal(v_id);
      end if;
    end if;
  else
    v_editable := (select private.is_manager_or_admin()) or v_lead.owner_id = caller;
  end if;

  -- 4. The lead's new state (design 5.5), for a call by someone who may change the lead.
  v_status := v_lead.lead_status;
  v_next := v_lead.next_action_at;
  v_owner := v_lead.owner_id;
  if p_type = 'call' and v_editable then
    v_key := private.lead_call_zone(v_lead.timezone, v_lead.country);
    v_east := coalesce((private.span_zones(v_key))[1], v_key);
    if p_outcome in ('no_answer', 'voicemail') then
      if private.call_attempts(p_company) >= 5 then  -- this is the 6th call in a row without reaching anyone
        if v_status in ('cold', 'warm') then
          v_status := 'cool_off';
        end if;
        v_next := now() + interval '30 days';
      else
        v_next := private.next_working_day(now(), case when p_outcome = 'no_answer' then 1 else 2 end, v_key);
      end if;
    elsif p_outcome = 'wrong_number' then
      v_mark_company := p_dialled = 'lead' and v_lead.phone_wrong_at is null;
    elsif p_outcome = 'not_interested' then
      if v_status in ('cold', 'warm', 'cool_off') then
        v_status := 'cool_off';
      end if;
      v_next := now() + interval '90 days';
    elsif p_outcome in ('interested', 'meeting_booked', 'connected') then
      if p_outcome = 'interested' and v_status in ('cold', 'cool_off') then
        v_status := 'warm';
      elsif p_outcome = 'meeting_booked' and v_status in ('cold', 'cool_off', 'warm') then
        v_status := 'warm';
      end if;
      -- Back the day after the follow-up (its task brings the lead back first), or in 30 days after Spoke without one.
      v_next := case when p_follow_up_at is not null then p_follow_up_at + interval '1 day'
                     when p_follow_up_date is not null then ((p_follow_up_date + 1) + time '09:00') at time zone v_east
                     else now() + interval '30 days' end;
      if p_outcome <> 'connected' and v_owner is null then
        v_owner := caller;  -- an unassigned lead becomes the caller's (open question 5)
      end if;
    elsif p_outcome = 'do_not_contact' then
      v_status := 'do_not_contact';
      v_next := null;
    end if;
  end if;

  -- 5. The entry. The guard sets the author and the previous date; the touch trigger moves the last activity.
  begin
    insert into public.activities (company_id, contact_id, deal_id, type, outcome, body, request_id)
    values (p_company, p_contact, p_deal, p_type, p_outcome, v_body, p_request_id)
    returning id into v_id;
  exception when foreign_key_violation then
    -- the linked deal (or the contact) was deleted after the checks above
    raise exception 'deal not found on this lead' using errcode = 'P0002';
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'activities_author_request_idx' then
      raise;
    end if;
    select a.id into v_id from public.activities a where a.user_id = caller and a.request_id = p_request_id;
    return private.logged_activity(v_id, true) || private.logged_activity_deal(v_id);
  end;

  -- 6. The lead and the dialled contact, for people who may change them (both rows are locked).
  if p_type = 'call' and v_editable
     and (row(v_status, v_next, v_owner) is distinct from row(v_lead.lead_status, v_lead.next_action_at, v_lead.owner_id)
          or v_mark_company) then
    update public.companies c
       set lead_status = v_status, next_action_at = v_next, owner_id = v_owner,
           phone_wrong_at = case when v_mark_company then now() else c.phone_wrong_at end
     where c.id = p_company;
  end if;
  if v_contact_locked and v_contact_wrong is null then
    update public.contacts k set phone_wrong_at = now() where k.id = p_contact;
    v_wrong_contact := p_contact;
  end if;

  -- 7. Tasks. A call completes the caller's call tasks on this lead due by the end of their today (Not interested: all
  -- of them); Do not contact also dismisses the lead's other open tasks the caller may change.
  v_tz := private.caller_zone();
  v_today := (now() at time zone v_tz)::date;
  if p_type = 'call' then
    with picked as (
      select t.id from public.tasks t
       where t.company_id = p_company and t.assignee_id = caller and t.kind = 'call'
         and t.done_at is null and t.cancelled_at is null
         and (p_outcome = 'not_interested' or t.due_date <= v_today
              or t.due_at < ((v_today + 1)::timestamp at time zone v_tz))
       order by t.id
       limit 20
    ), done as (
      update public.tasks t set done_at = now() from picked where t.id = picked.id returning t.id
    )
    select coalesce(array_agg(done.id order by done.id), '{}') into v_completed from done;
    if p_outcome = 'do_not_contact' then
      with picked as (
        select t.id from public.tasks t
         where t.company_id = p_company and t.done_at is null and t.cancelled_at is null
         order by t.id
         limit 50
      ), gone as (
        update public.tasks t set cancelled_at = now() from picked where t.id = picked.id returning t.id
      )
      select coalesce(array_agg(gone.id order by gone.id), '{}') into v_cancelled from gone;
    end if;
  end if;
  -- The task this entry makes: the follow-up or the meeting (the caller's), or after a wrong number with no other
  -- working number, "find the right number" for today, for the owner when the caller may assign it. Made even when the
  -- caller may not change the lead: they had the conversation.
  if p_outcome = 'wrong_number' then
    if not ((v_lead.phone is not null and v_lead.phone_wrong_at is null and p_dialled <> 'lead')
            or exists (select 1 from public.contacts k
                        where k.company_id = p_company and k.phone is not null and k.phone_wrong_at is null
                          and not (p_dialled = 'contact' and k.id = p_contact))) then
      v_task_kind := 'todo';
      v_due_date := v_today;
      v_assignee := case when (select private.is_manager_or_admin()) and v_lead.owner_id is not null
                         then v_lead.owner_id else caller end;
    end if;
  elsif v_task_kind is not null then
    v_due_date := p_follow_up_date;
    v_due_at := p_follow_up_at;
    v_assignee := caller;
  end if;
  if v_task_kind is not null then
    insert into public.tasks (company_id, contact_id, title, kind, due_date, due_at, assignee_id, source_activity_id)
    values (p_company, p_contact, p_task_title, v_task_kind, v_due_date, v_due_at, v_assignee, v_id)
    returning id into v_task;
  end if;

  -- 7b. Day 5b (design 5.1, D17): Interested or Book meeting opens a deal in the same transaction, for people who may
  -- change the lead (the lead is locked: global order contact, lead, deal). A Do not contact lead, or a caller over the
  -- 30-an-hour open limit (the guard's own count of private.deal_opens), skips the deal and keeps the call. The deal
  -- opens at Lead, owned by the caller, linked to this call (the guard's source rule); the lead change is the outcome's
  -- (already in the undo record), so the deal adds none.
  if p_open_deal then
    if not v_editable then
      v_deal_answer := jsonb_build_object('opened', false, 'reason', 'not_editable');
    elsif v_status = 'do_not_contact' then
      v_deal_answer := jsonb_build_object('opened', false, 'reason', 'dnc');
    elsif (select count(*) from (select 1 from private.deal_opens o
                                  where o.user_id = caller and o.created_at > now() - interval '1 hour'
                                  limit 30) recent) >= 30 then
      v_deal_answer := jsonb_build_object('opened', false, 'reason', 'rate_limited');
    else
      insert into public.deals (company_id, contact_id, title, value, source_activity_id)
      values (p_company, p_contact, v_deal_title, p_deal_value, v_id)
      returning id into v_deal;
      v_deal_answer := jsonb_build_object(
        'id', v_deal, 'opened', true,
        'open_deal_count', (select count(*) from public.deals x where x.company_id = p_company and x.status = 'open'));
    end if;
  end if;

  -- 8. The undo record (with the deal it opened); the caller's records older than 10 minutes go.
  insert into private.activity_undo (activity_id, org_id, user_id, prev_status, new_status, prev_next_action_at,
                                     new_next_action_at, prev_owner_id, new_owner_id, owner_changed, wrong_company,
                                     wrong_contact_id, created_task_id, completed_task_ids, cancelled_task_ids,
                                     created_deal_id)
  values (v_id, (select private.current_org_id()), caller,
          case when v_editable then v_lead.lead_status end, case when v_editable then v_status end,
          case when v_editable then v_lead.next_action_at end, case when v_editable then v_next end,
          case when v_editable then v_lead.owner_id end, case when v_editable then v_owner end,
          v_editable and v_owner is distinct from v_lead.owner_id, v_mark_company, v_wrong_contact, v_task,
          v_completed, v_cancelled, v_deal);
  delete from private.activity_undo u where u.user_id = caller and u.created_at < now() - interval '10 minutes';

  -- 9. (4c: when p_from_queue, the caller's claim on this lead is released here.)
  return private.logged_activity(v_id, false)
         || jsonb_build_object('deal_id', p_deal, 'deal', v_deal_answer);
end;
$$;

-- REBASE: re-copy after 4c/4d merge. Day 4b's undo_activity as merged, plus Day 5b: the deal the call opened is removed
-- while untouched (answer 'deal': 'removed' | 'kept' | null), after the lead lock.
create or replace function public.undo_activity(p_id uuid) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_company uuid;
  v_created timestamptz;
  u private.activity_undo%rowtype;
  v_lead record;
  r_status boolean := false;
  r_next boolean := false;
  v_next_after timestamptz;
  r_owner boolean := false;
  r_phone boolean := false;
  r_contact boolean := false;
  v_task_deleted boolean := false;
  v_reopened integer := 0;
  v_deal text;
  n integer;
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  select a.company_id, a.created_at into v_company, v_created
    from public.activities a
   where a.id = p_id and a.user_id = caller and a.created_at > now() - interval '120 seconds';
  if not found then
    raise exception 'this can no longer be undone' using errcode = '22023', hint = 'undo_expired';
  end if;
  delete from private.activity_undo d where d.activity_id = p_id returning d.* into u;
  if not found then
    raise exception 'this can no longer be undone' using errcode = '22023', hint = 'undo_expired';
  end if;

  if u.wrong_contact_id is not null then
    update public.contacts k set phone_wrong_at = null
     where k.id = u.wrong_contact_id and k.phone_wrong_at = v_created;
    r_contact := found;
  end if;
  if u.prev_status is not null then
    select c.lead_status, c.next_action_at, c.owner_id, c.phone_wrong_at into v_lead
      from public.companies c where c.id = v_company for update;
    if found then
      r_status := u.new_status is distinct from u.prev_status and v_lead.lead_status = u.new_status;
      r_next := u.new_next_action_at is distinct from u.prev_next_action_at
                and v_lead.next_action_at is not distinct from u.new_next_action_at;
      r_owner := u.owner_changed and v_lead.owner_id is not distinct from u.new_owner_id;
      r_phone := u.wrong_company and v_lead.phone_wrong_at = v_created;
      if r_status or r_next or r_owner or r_phone then
        update public.companies c
           set lead_status = case when r_status then u.prev_status else c.lead_status end,
               next_action_at = case when r_next then u.prev_next_action_at else c.next_action_at end,
               owner_id = case when r_owner then u.prev_owner_id else c.owner_id end,
               phone_wrong_at = case when r_phone then null else c.phone_wrong_at end
         where c.id = v_company
        returning c.next_action_at into v_next_after;
        -- lead_guard rule 5 may replace a restored empty date with +90 days: report what was actually kept
        r_next := r_next and v_next_after is not distinct from u.prev_next_action_at;
      end if;
    end if;
  end if;

  -- Day 5b (design 3.2): the deal this call opened goes too while nobody touched it (version 0, still the caller's
  -- own), through the delete policy's creator branch (the undo record is consumed above). Global lock order: the lead
  -- first (contact, lead, deal), even when the lead needed no restore.
  if u.created_deal_id is not null then
    if u.prev_status is null then
      perform 1 from public.companies c where c.id = v_company for update;
    end if;
    delete from public.deals d where d.id = u.created_deal_id and d.version = 0 and d.created_by = caller;
    v_deal := case when found then 'removed' else 'kept' end;
  end if;

  if u.created_task_id is not null then
    delete from public.tasks t
     where t.id = u.created_task_id and t.updated_at = t.created_at and t.done_at is null and t.cancelled_at is null;
    v_task_deleted := found;
  end if;
  update public.tasks t set done_at = null
   where t.id = any (u.completed_task_ids) and t.done_at = v_created and t.completed_by = caller;
  get diagnostics n = row_count;
  v_reopened := n;
  update public.tasks t set cancelled_at = null
   where t.id = any (u.cancelled_task_ids) and t.cancelled_at = v_created;
  get diagnostics n = row_count;
  v_reopened := v_reopened + n;

  delete from public.activities a where a.id = p_id;
  if not found then
    raise exception 'this can no longer be undone' using errcode = '22023', hint = 'undo_expired';
  end if;
  return (select jsonb_build_object(
            'activity_id', p_id,
            'restored', jsonb_build_object('status', r_status, 'next_action_at', r_next, 'owner', r_owner,
                                           'phone_wrong', r_phone, 'contact_phone_wrong', r_contact),
            'task_deleted', v_task_deleted,
            'tasks_reopened', v_reopened,
            'deal', v_deal,
            'lead', jsonb_build_object('lead_status', c.lead_status, 'next_action_at', c.next_action_at,
                                       'owner_id', c.owner_id, 'last_activity_at', c.last_activity_at))
            from public.companies c where c.id = v_company);
end;
$$;

-- REBASE: re-copy after 4c/4d merge. Day 4b's get_lead as merged (same signature), plus Day 5b: deals {open_count,
-- latest_open {id, title, stage, value, stage_entered_at, is_stalled, version}} under deals RLS, and can_open_deal.
create or replace function public.get_lead(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'name', c.name, 'lead_status', c.lead_status, 'phone', c.phone, 'email', c.email,
    'city', c.city, 'country', c.country, 'last_activity_at', c.last_activity_at, 'created_at', c.created_at,
    'owner', case when o.id is null then null
                  else jsonb_build_object('id', o.id, 'first_name', o.first_name, 'last_name', o.last_name) end,
    'can_edit', e.can_edit,
    'timezone', c.timezone,
    'call_zone_key', private.lead_call_zone(c.timezone, c.country),
    'can_set_timezone', e.can_edit and private.country_zone_choices(c.country) is not null,
    'next_action_at', c.next_action_at,
    'phone_wrong_at', c.phone_wrong_at,
    'attempts', private.call_attempts(c.id),
    'open_task_count', (select count(*) from public.tasks t
                         where t.company_id = c.id and t.done_at is null and t.cancelled_at is null),
    'next_task', (select jsonb_build_object('id', t.id, 'title', t.title, 'kind', t.kind, 'due_date', t.due_date,
                                            'due_at', t.due_at, 'assignee_id', t.assignee_id)
                    from public.tasks t
                   where t.company_id = c.id and t.done_at is null and t.cancelled_at is null
                   order by coalesce(t.due_at, t.due_date::timestamp at time zone z.tz) nulls last, t.created_at, t.id
                   limit 1),
    -- Admins only: import_batches is readable by admins alone.
    'import', (select jsonb_build_object('id', b.id, 'filename', b.filename, 'created_at', b.created_at)
                 from public.import_batches b where b.id = c.import_batch_id),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', k.id, 'first_name', k.first_name, 'last_name', k.last_name, 'title', k.title,
               'email', k.email, 'phone', k.phone, 'phone_wrong_at', k.phone_wrong_at) order by k.created_at, k.id)
      from public.contacts k where k.company_id = c.id), '[]'::jsonb),
    -- Day 5b (design 3.2): the lead's open deals the caller sees (deals RLS) and the newest in stage; whether the caller
    -- may open one (an editor, and the lead is not Do not contact).
    'deals', (select jsonb_build_object(
                       'open_count', o.n,
                       'latest_open', (select jsonb_build_object('id', x.id, 'title', x.title, 'stage', x.stage,
                                                                 'value', x.value, 'stage_entered_at', x.stage_entered_at,
                                                                 'is_stalled', x.is_stalled, 'version', x.version)
                                         from private.deal_cards(array[o.latest]) x))
                from (select count(*) as n, (array_agg(d.id order by d.stage_entered_at desc, d.id desc))[1] as latest
                        from public.deals d where d.company_id = c.id and d.status = 'open') o),
    'can_open_deal', e.can_edit and c.lead_status <> 'do_not_contact'
  )
  from public.companies c
  left join public.profiles o on o.id = c.owner_id
  cross join lateral (select (select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()) as can_edit) e
  cross join lateral (select private.caller_zone() as tz offset 0) z  -- offset 0: worked out once, not once per task
  where c.id = p_id
$$;

-- ===========================================================================
-- Function privileges (the Day 3a loop). log_activity was dropped and recreated, so it is revoked and granted again;
-- create or replace keeps undo_activity's and get_lead's.
-- ===========================================================================
revoke all on function private.logged_activity_deal(uuid) from public, anon;
grant execute on function private.logged_activity_deal(uuid) to authenticated;
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.log_activity(uuid, text, text, text, uuid, text, date, timestamptz, text, uuid, boolean, uuid, boolean, text, numeric)',
    'public.undo_activity(uuid)',
    'public.get_lead(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
