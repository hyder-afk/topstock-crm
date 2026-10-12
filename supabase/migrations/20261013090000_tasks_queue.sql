-- Day 4c: tasks and the work queue (design docs/evidence/day4/design.md sections 3.3, 4.2, 5.4 to 5.6 and 6; Haider's
-- answers of 11 Oct to open questions 1 to 5 and 10). What changes, in plain words:
--  - every lead knows whether one of its contacts has a working number (kept by a trigger on contacts), and carries
--    two values the database works out itself: its calling zone (call_zone) and its place in the queue (queue_rank);
--    a lead with no number to dial, a Do not contact, Disqualified or Customer lead, or a Cool off lead with no date
--    has no rank and is never offered;
--  - calling hours: Monday to Friday, 09:00 to 18:00 on the lead's side; a country with several zones is called only
--    while both of its ends are in hours; an optional switch skips 12:00 to 14:00 for European zones;
--  - the work queue offers one lead at a time, best first (follow-ups due, Negotiation, Warm, retries, first calls),
--    and each lead goes to one person at a time: a claim lasts 10 minutes, can be renewed, and nobody holds more than 3;
--    claims live in the private schema (no API endpoint);
--  - the Tasks page lists Overdue, Today, Upcoming and Done in each person's own time zone, which the database now
--    checks;
--  - the lead page shows who is working a lead in the queue (get_lead's worked_by).
-- House rules (design section 3): every function sets search_path = ''; every RPC is SECURITY INVOKER with static SQL
-- (row level security decides every row; no format(), no EXECUTE); the guards are INVOKER triggers, and the only
-- DEFINER code is trigger-only and revoked; every CHECK that user input can reach has a pre-check with a constant
-- message first; clients get column grants only.
-- Error hints added here (SQLSTATE 22023 unless noted): busy (a fourth live claim), timezone (a profile zone the
-- database does not know), bad_bucket; 42501 scope (a queue or task scope reserved to managers and admins). Reused:
-- bounds, bad_cursor, task_title, task_due, 42501 step_up and not_editable (a claim's fields other than its end).
--
-- The leakproof rule (queue and task queries). Under row level security PostgreSQL may use only leakproof operators as
-- index conditions (any other condition must wait until the policy has filtered the row). The queue therefore filters
-- with = any (text[]) on the stored call_zone, uuid and timestamptz comparisons, smallint equality, IS NULL and row
-- comparisons, and never with AT TIME ZONE per row, @> or LIKE. (Checked in PostgreSQL 16's catalog: texteq, int2eq,
-- uuid_eq, uuid_ne and timestamptz_le are leakproof; timezone(), arraycontains and array_eq are not.)

-- ===========================================================================
-- Part 1. Audit: as Day 4b, plus the two values the database works out (call_zone, queue_rank) are never stored in the
-- audit log, and has_contact_phone joins the columns an update diff leaves out (the contact change is the record).
-- Redefined first, so the backfill below writes no audit rows.
-- ===========================================================================
create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  hidden constant text[] := array['search_text', 'email_key', 'phone_key', 'name_key', 'call_zone', 'queue_rank'];
  is_activity constant boolean := tg_table_name = 'activities';
  rec jsonb := (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) - hidden;
  diff jsonb;
begin
  if is_activity and tg_op = 'INSERT' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
      into diff
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value
       and n.key not in ('updated_at', 'last_activity_at', 'next_action_at', 'phone_wrong_at', 'has_contact_phone')
       and not n.key = any (hidden)
       and not (is_activity and n.key = 'body');
    if is_activity and (to_jsonb(new) -> 'body') is distinct from (to_jsonb(old) -> 'body') then
      diff := coalesce(diff, '{}'::jsonb) || jsonb_build_object('body', jsonb_build_object(
                'changed', true, 'old_len', char_length(to_jsonb(old) ->> 'body'),
                'new_len', char_length(to_jsonb(new) ->> 'body')));
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
-- Part 2. A contact with a working number (design 3.3)
-- ===========================================================================
alter table public.companies
  add column has_contact_phone boolean not null default false;  -- one of the lead's contacts has a working number

-- Kept by the database: after a contact is added, removed, moved to another lead, or its number or wrong-number mark
-- changes, each lead concerned gets has_contact_phone again, written only where the value changes. A working number
-- has at least one digit and no wrong-number mark. DEFINER because nobody is granted the column (only this trigger
-- writes it); trigger-only and revoked. Lock order: the contact (locked by the statement that fired this), then the
-- lead, as in log_activity and undo_activity; two leads (a contact moved) are taken in id order. Known limit: deleting a
-- lead locks the lead, then its contacts (the cascade), so a contact number changed on that same lead at that same
-- moment can end in a deadlock error for one of the two (nothing is half-written; the person retries).
create function private.sync_contact_phone() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_lead uuid;
begin
  for v_lead in
    select distinct x.id
      from unnest(array[case when tg_op <> 'INSERT' then old.company_id end,
                        case when tg_op <> 'DELETE' then new.company_id end]) as x (id)
     where x.id is not null
     order by x.id
  loop
    -- The lead first, then a statement of its own: two contacts of one lead changed at once take turns here, and the
    -- second one sees the first one's committed change (without the lock each would miss the other's and the flag
    -- could stay true with no number left).
    perform 1 from public.companies c where c.id = v_lead for no key update;
    update public.companies c
       set has_contact_phone = s.has_phone
      from (select exists (select 1 from public.contacts k
                            where k.company_id = v_lead and k.phone ~ '[0-9]' and k.phone_wrong_at is null) as has_phone) s
     where c.id = v_lead and c.has_contact_phone is distinct from s.has_phone;
  end loop;
  return null;
end;
$$;
create trigger sync_contact_phone after insert or delete or update of phone, phone_wrong_at, company_id
  on public.contacts for each row execute function private.sync_contact_phone();

-- Backfill: leads that already have a contact with a working number (they already count as worked on, so Day 3b's
-- import undo, which keeps every lead with a contact, is unaffected). The audit trigger above writes nothing for it.
update public.companies c set has_contact_phone = true
 where exists (select 1 from public.contacts k
                where k.company_id = c.id and k.phone ~ '[0-9]' and k.phone_wrong_at is null)
   and not c.has_contact_phone;

-- ===========================================================================
-- Part 3. Calling zone and queue rank, worked out by the database (design 3.3, D4, D5)
-- ===========================================================================
-- Adding the two stored columns rewrites the table without firing triggers (updated_at and Day 3b's "untouched" rule
-- are unaffected). call_zone needs EXECUTE on private.lead_call_zone for whoever writes a lead (granted in 4b);
-- queue_rank uses no function. PostgreSQL recomputes each one when a column it reads is in the UPDATE (and after the
-- BEFORE triggers, so lead_guard's changes count); call_zone_matches_map in queue_attack.sql checks the stored values.
--   rank 0: Negotiation; 1: Warm; 2: a retry or a due date (Cold with a date, Cool off with a date); 3: a first call
--   (Cold with no date); null: never served (Customer, Do not contact, Disqualified, nothing to dial, Cool off with no
--   date). Something to dial: the main number (at least one digit, not marked wrong) or a contact's working number.
alter table public.companies
  add column call_zone text generated always as (private.lead_call_zone(timezone, country)) stored,
  add column queue_rank smallint generated always as (
    case
      when not ((coalesce(phone ~ '[0-9]', false) and phone_wrong_at is null) or has_contact_phone) then null
      when lead_status = 'negotiation' then 0
      when lead_status = 'warm' then 1
      when lead_status = 'cold' then case when next_action_at is null then 3 else 2 end
      when lead_status = 'cool_off' and next_action_at is not null then 2
    end) stored;
-- The queue walks one rank at a time down these (Mine on the first, Team on the second); a lead with no rank is not in
-- them at all. Within a rank: the due date (oldest first; none last), then never-called leads first, then id.
create index companies_queue_owner_idx on public.companies
  (org_id, owner_id, queue_rank, next_action_at, last_activity_at nulls first, id) where queue_rank is not null;
create index companies_queue_team_idx on public.companies
  (org_id, queue_rank, next_action_at, last_activity_at nulls first, id) where queue_rank is not null;
-- Mine + unassigned reads the caller's half from the owner index and the unassigned half from this one, each in queue
-- order, merged under one ORDER BY (Merge Append). A third index, not in the design: "owner_id is null" on the owner
-- index does not give its rows in queue order (PostgreSQL treats IS NULL as a filter on that column, not a constant),
-- so that half would be read whole and sorted.
create index companies_queue_unassigned_idx on public.companies
  (org_id, queue_rank, next_action_at, last_activity_at nulls first, id) where queue_rank is not null and owner_id is null;

-- ===========================================================================
-- Part 4. Calling hours (design 5.1; Haider 11 Oct: Monday to Friday 09:00 to 18:00 lead time, lunch switch off by
-- default). The browser has the same rules (src/lib/timezones.ts); the cases between the call-window markers in
-- tests/unit/call-window.spec.ts and supabase/tests/queue_attack.sql are the same list.
-- ===========================================================================
-- Every value private.lead_call_zone can return: each country's zone or span key, each zone a person may pick, and
-- Europe/Paris (no country). Written out as a literal when the migration runs, from the zone-map functions themselves
-- (every two-letter code), so it always matches them; queue_attack.sql recomputes it and compares.
do $$
declare
  v_keys text[];
begin
  select array_agg(distinct k order by k) into v_keys
    from (select private.country_call_zone(chr(a) || chr(b)) as k
            from generate_series(65, 90) a, generate_series(65, 90) b
          union all
          select unnest(private.country_zone_choices(chr(a) || chr(b)))
            from generate_series(65, 90) a, generate_series(65, 90) b
          union all
          select 'Europe/Paris') z
   where k is not null;
  execute format('create or replace function private.call_zone_keys() returns text[] '
                 'language sql immutable parallel safe set search_path = '''' as %L',
                 format('select %L::text[]', v_keys));
end;
$$;

-- Whether a calling zone is in calling hours at p_at: Monday to Friday, 09:00 (included) to 18:00 (excluded) local
-- time; a span key needs both its ends in hours; the lunch switch skips 12:00 to 14:00 for Europe/* zones only (a
-- span's shared window is short already).
create function private.call_zone_open(p_key text, p_at timestamptz, p_skip_lunch boolean) returns boolean
language plpgsql stable parallel safe set search_path = '' as $$
declare
  v_ends constant text[] := private.span_zones(p_key);
  z text;
  l timestamp;
  m integer;
begin
  if p_key is null or p_at is null then
    return false;
  end if;
  foreach z in array coalesce(v_ends, array[p_key]) loop
    l := p_at at time zone z;
    if extract(isodow from l) > 5 then
      return false;
    end if;
    m := extract(hour from l)::integer * 60 + extract(minute from l)::integer;
    if m < 540 or m >= 1080 then
      return false;
    end if;
    if v_ends is null and coalesce(p_skip_lunch, false) and z like 'Europe/%' and m >= 720 and m < 840 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- The calling zones in hours at p_at (about 250 checks), worked out once per queue call and then used as
-- call_zone = any (...), a leakproof condition.
create function private.open_call_zones(p_at timestamptz, p_skip_lunch boolean) returns text[]
language sql stable parallel safe set search_path = '' as $$
  select coalesce(array_agg(k order by k), '{}'::text[])
    from unnest(private.call_zone_keys()) k
   where private.call_zone_open(k, p_at, p_skip_lunch)
$$;

-- ===========================================================================
-- Part 5. Queue claims (design 5.4, threats 13 to 15). Private schema: no API endpoint. Not audited (short-lived, no
-- lead data).
-- ===========================================================================
create table private.queue_claims (
  company_id uuid primary key references public.companies (id) on delete cascade,  -- one live claim per lead
  org_id uuid not null references public.orgs (id),
  user_id uuid not null references public.profiles (id) on delete cascade,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index queue_claims_user_idx on private.queue_claims (user_id, claimed_at);
alter table private.queue_claims enable row level security;
create policy require_mfa on private.queue_claims as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
-- The team sees who is on which lead ("Henri is on this lead").
create policy claims_select on private.queue_claims for select to authenticated
  using (org_id = (select private.current_org_id()));
-- Only a lead the caller may change (owner, manager, admin): nobody can lock a teammate out of their own leads.
create policy claims_insert on private.queue_claims for insert to authenticated with check (
  org_id = (select private.current_org_id()) and user_id = (select auth.uid())
  and exists (select 1 from public.companies c where c.id = queue_claims.company_id
              and ((select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()))));
create policy claims_update on private.queue_claims for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- Own claims, or anyone's once expired (so a lead left by a closed laptop is served again).
create policy claims_delete on private.queue_claims for delete to authenticated using (
  org_id = (select private.current_org_id()) and (user_id = (select auth.uid()) or expires_at <= now()));
revoke all on private.queue_claims from public, anon, authenticated;
grant select, insert (company_id), update (expires_at), delete on private.queue_claims to authenticated;

-- The claim guard (INVOKER, BEFORE INSERT OR UPDATE). For a signed-in person: the organisation, the person, the time
-- claimed and the end (now + 10 minutes) are the server's, on every insert and renewal, so a client can neither choose
-- a claim's length nor claim for someone else; nothing else of a claim ever changes; and nobody holds more than 3 live
-- claims (a fourth, or renewing an expired claim beyond 3, gives 22023 busy). A person's claims take turns (advisory
-- lock per person, also taken first by the queue functions), so two tabs cannot pass the limit together. Sessions with
-- no signed-in user (fixtures, maintenance) are left alone.
create function private.claim_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
begin
  if caller is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('queue_claims:' || caller::text, 0));
  if tg_op = 'INSERT' then
    new.org_id := (select private.current_org_id());
    if new.org_id is null then
      raise exception 'no profile for caller' using errcode = '42501';
    end if;
    new.user_id := caller;
    new.claimed_at := now();
  elsif row(new.company_id, new.org_id, new.user_id, new.claimed_at)
        is distinct from row(old.company_id, old.org_id, old.user_id, old.claimed_at) then
    raise exception 'only the end of a claim can change' using errcode = '42501', hint = 'not_editable';
  end if;
  new.expires_at := now() + interval '10 minutes';
  if (tg_op = 'INSERT' or old.expires_at <= now())
     and (select count(*) from private.queue_claims q
           where q.user_id = caller and q.expires_at > now() and q.company_id <> new.company_id) >= 3 then
    raise exception 'you are already working on 3 leads' using errcode = '22023', hint = 'busy';
  end if;
  return new;
end;
$$;
create trigger claim_guard before insert or update on private.queue_claims
  for each row execute function private.claim_guard();

-- ===========================================================================
-- Part 6. Tasks and profiles (design 3.3, 5.6)
-- ===========================================================================
-- A person's open tasks by due date (the Tasks buckets), their done tasks newest first (keyset), and their open call
-- tasks (the queue's follow-ups). The old (org, assignee, due_at) index is replaced by these; tasks_assignee_idx stays
-- for the foreign key.
create index tasks_assignee_open_idx on public.tasks (assignee_id, due_date, due_at, id)
  where done_at is null and cancelled_at is null;
create index tasks_assignee_done_idx on public.tasks (assignee_id, done_at desc, id desc) where done_at is not null;
create index tasks_queue_idx on public.tasks (assignee_id, due_date, due_at)
  where kind = 'call' and done_at is null and cancelled_at is null;
drop index public.tasks_org_assignee_idx;

-- A person's time zone ("Today" on the Tasks page, the queue's follow-ups) must be one PostgreSQL knows. Constant
-- message: the value never reaches a log.
create function private.check_profile_timezone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.timezone is distinct from old.timezone
     and (new.timezone is null
          or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone)) then
    raise exception 'unknown time zone' using errcode = '22023', hint = 'timezone';
  end if;
  return new;
end;
$$;
create trigger check_profile_timezone before update of timezone on public.profiles
  for each row execute function private.check_profile_timezone();

-- ===========================================================================
-- Part 7. The work queue API (design 4.2, 5.4). All SECURITY INVOKER, static SQL.
-- ===========================================================================
-- One queue card: what the queue screen shows for a lead the caller has just claimed. p_reason null: worked out from
-- the lead's rank (negotiation, warm, returning for Cool off, retry, first_call for a lead never called).
create function private.queue_card(p_id uuid, p_reason text, p_skip_lunch boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'name', c.name, 'lead_status', c.lead_status,
    'owner', case when o.id is null then null
                  else jsonb_build_object('id', o.id, 'first_name', o.first_name, 'last_name', o.last_name) end,
    'phone', c.phone, 'phone_wrong', c.phone_wrong_at is not null, 'email', c.email, 'city', c.city,
    'country', c.country, 'timezone', c.timezone, 'call_zone', c.call_zone,
    'local_time_open', private.call_zone_open(c.call_zone, now(), p_skip_lunch),
    'next_action_at', c.next_action_at, 'last_activity_at', c.last_activity_at,
    'reason', coalesce(p_reason, case c.queue_rank
                                   when 0 then 'negotiation'
                                   when 1 then 'warm'
                                   when 2 then case when c.lead_status = 'cool_off' then 'returning' else 'retry' end
                                   else case when c.last_activity_at is null then 'first_call' else 'retry' end
                                 end),
    'attempts', private.call_attempts(c.id),
    'claimed_until', (select q.expires_at from private.queue_claims q
                       where q.company_id = c.id and q.user_id = (select auth.uid())),
    'can_edit', (select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', k.id, 'first_name', k.first_name, 'last_name', k.last_name, 'title', k.title, 'email', k.email,
               'phone', k.phone, 'phone_wrong', k.phone_wrong_at is not null) order by k.created_at, k.id)
        from (select x.* from public.contacts x where x.company_id = c.id order by x.created_at, x.id limit 10) k),
      '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'type', a.type, 'outcome', a.outcome, 'body', left(a.body, 500),
               'truncated', char_length(a.body) > 500, 'created_at', a.created_at, 'user_first_name', p.first_name)
               order by a.created_at desc, a.id desc)
        from (select x.id, x.type, x.outcome, x.body, x.created_at, x.user_id from public.activities x
               where x.company_id = c.id order by x.created_at desc, x.id desc limit 3) a
        left join public.profiles p on p.id = a.user_id),
      '[]'::jsonb),
    'my_open_tasks', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'kind', t.kind, 'due_date', t.due_date,
                                          'due_at', t.due_at) order by t.n)
        from (select x.id, x.title, x.kind, x.due_date, x.due_at,
                     row_number() over (order by coalesce(x.due_at, x.due_date::timestamp at time zone z.tz) nulls last,
                                                 x.id) as n
                from public.tasks x
               where x.company_id = c.id and x.assignee_id = (select auth.uid())
                 and x.done_at is null and x.cancelled_at is null
               order by n
               limit 3) t),
      '[]'::jsonb))
  from public.companies c
  left join public.profiles o on o.id = c.owner_id
  cross join lateral (select private.caller_zone() as tz offset 0) z  -- worked out once
  where c.id = p_id
$$;

-- The next candidates in one part of the queue order (design 5.4), best first, for one claim attempt each:
--   segment 0: the caller's open call tasks due by the end of their today (or within 5 minutes), on a lead with a
--              rank, by due time (the task is the reason: the lead's next call date is ignored);
--   1 and 2:   rank 0 (Negotiation), dated and due, then undated; 3 and 4: rank 1 (Warm), the same;
--   5:         rank 2 (retries and due dates), next_action_at <= now() as an index range that stops at now;
--   6:         rank 3 (first calls), never-called leads first.
-- Every part leaves out leads outside calling hours (p_open null: any hours), leads in p_skip (this session's skips,
-- the cards kept, the leads already tried) and leads with a live claim. Mine walks companies_queue_owner_idx, Team
-- companies_queue_team_idx, Mine + unassigned two ordered halves (the owner index and the unassigned index), each with
-- its own ORDER BY and LIMIT, under one ORDER BY and LIMIT (Merge Append). One static query per part and scope; the
-- ORDER BY always names next_action_at first so it follows the index (an undated part has it null throughout).
create function private.queue_candidates(
  p_segment integer,
  p_scope text,
  p_open text[],
  p_skip uuid[],
  p_today date,
  p_tz text,
  p_limit integer
) returns setof uuid
language plpgsql stable set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_rank constant smallint := case p_segment when 1 then 0 when 2 then 0 when 3 then 1 when 4 then 1
                                             when 5 then 2 when 6 then 3 end;
begin
  -- The same scope rule as claim_next_lead, for a direct call (private has no API endpoint, but a database login does).
  if p_scope is null or (p_scope <> 'mine' and not (select private.is_manager_or_admin())) then
    raise exception 'only managers and admins can work beyond their own leads' using errcode = '42501', hint = 'scope';
  end if;
  if p_segment = 0 then
    if p_scope = 'mine' then
      return query
        select f.company_id
          from (select t.company_id, min(coalesce(t.due_at, t.due_date::timestamp at time zone p_tz)) as due
                  from public.tasks t
                 where t.assignee_id = caller and t.kind = 'call' and t.done_at is null and t.cancelled_at is null
                   and t.company_id is not null
                   and (t.due_date <= p_today or t.due_at <= now() + interval '5 minutes')
                 group by t.company_id) f
          join public.companies c on c.id = f.company_id
         where c.owner_id = caller and c.queue_rank is not null
           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))
           and not exists (select 1 from private.queue_claims q where q.company_id = c.id and q.expires_at > now())
         order by f.due, c.id
         limit p_limit;
    elsif p_scope = 'team' then
      return query
        select f.company_id
          from (select t.company_id, min(coalesce(t.due_at, t.due_date::timestamp at time zone p_tz)) as due
                  from public.tasks t
                 where t.assignee_id = caller and t.kind = 'call' and t.done_at is null and t.cancelled_at is null
                   and t.company_id is not null
                   and (t.due_date <= p_today or t.due_at <= now() + interval '5 minutes')
                 group by t.company_id) f
          join public.companies c on c.id = f.company_id
         where c.queue_rank is not null
           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))
           and not exists (select 1 from private.queue_claims q where q.company_id = c.id and q.expires_at > now())
         order by f.due, c.id
         limit p_limit;
    else
      return query
        select f.company_id
          from (select t.company_id, min(coalesce(t.due_at, t.due_date::timestamp at time zone p_tz)) as due
                  from public.tasks t
                 where t.assignee_id = caller and t.kind = 'call' and t.done_at is null and t.cancelled_at is null
                   and t.company_id is not null
                   and (t.due_date <= p_today or t.due_at <= now() + interval '5 minutes')
                 group by t.company_id) f
          join public.companies c on c.id = f.company_id
         where (c.owner_id = caller or c.owner_id is null) and c.queue_rank is not null
           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))
           and not exists (select 1 from private.queue_claims q where q.company_id = c.id and q.expires_at > now())
         order by f.due, c.id
         limit p_limit;
    end if;
  elsif p_segment in (1, 3, 5) then
    -- Dated and due: an index range on next_action_at that stops at now.
    if p_scope = 'mine' then
      return query
        select c.id from public.companies c
         where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at <= now()
           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))
           and not exists (select 1 from private.queue_claims q where q.company_id = c.id and q.expires_at > now())
         order by c.next_action_at, c.last_activity_at nulls first, c.id
         limit p_limit;
    elsif p_scope = 'team' then
      return query
        select c.id from public.companies c
         where c.queue_rank = v_rank and c.next_action_at <= now()
           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))
           and not exists (select 1 from private.queue_claims q where q.company_id = c.id and q.expires_at > now())
         order by c.next_action_at, c.last_activity_at nulls first, c.id
         limit p_limit;
    else
      return query
        select u.id
          from ((select c.id, c.next_action_at, c.last_activity_at from public.companies c
                 where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at <= now()
                   and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))
                   and not exists (select 1 from private.queue_claims q
                                    where q.company_id = c.id and q.expires_at > now())
                 order by c.next_action_at, c.last_activity_at nulls first, c.id
                 limit p_limit)
                union all
                (select c.id, c.next_action_at, c.last_activity_at from public.companies c
                 where c.owner_id is null and c.queue_rank = v_rank and c.next_action_at <= now()
                   and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))
                   and not exists (select 1 from private.queue_claims q
                                    where q.company_id = c.id and q.expires_at > now())
                 order by c.next_action_at, c.last_activity_at nulls first, c.id
                 limit p_limit)) u
         order by u.next_action_at, u.last_activity_at nulls first, u.id
         limit p_limit;
    end if;
  elsif p_segment in (2, 4, 6) then
    -- Undated: next_action_at is null; never-called leads first.
    if p_scope = 'mine' then
      return query
        select c.id from public.companies c
         where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at is null
           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))
           and not exists (select 1 from private.queue_claims q where q.company_id = c.id and q.expires_at > now())
         order by c.next_action_at, c.last_activity_at nulls first, c.id
         limit p_limit;
    elsif p_scope = 'team' then
      return query
        select c.id from public.companies c
         where c.queue_rank = v_rank and c.next_action_at is null
           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))
           and not exists (select 1 from private.queue_claims q where q.company_id = c.id and q.expires_at > now())
         order by c.next_action_at, c.last_activity_at nulls first, c.id
         limit p_limit;
    else
      return query
        select u.id
          from ((select c.id, c.next_action_at, c.last_activity_at from public.companies c
                 where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at is null
                   and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))
                   and not exists (select 1 from private.queue_claims q
                                    where q.company_id = c.id and q.expires_at > now())
                 order by c.next_action_at, c.last_activity_at nulls first, c.id
                 limit p_limit)
                union all
                (select c.id, c.next_action_at, c.last_activity_at from public.companies c
                 where c.owner_id is null and c.queue_rank = v_rank and c.next_action_at is null
                   and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))
                   and not exists (select 1 from private.queue_claims q
                                    where q.company_id = c.id and q.expires_at > now())
                 order by c.next_action_at, c.last_activity_at nulls first, c.id
                 limit p_limit)) u
         order by u.next_action_at, u.last_activity_at nulls first, u.id
         limit p_limit;
    end if;
  end if;
end;
$$;

-- Counts for the queue's start screen (design 4.2), from one pass over the leads in scope:
--   callable_now: a rank, due (no next call date, or it has passed), its zone in hours, no live claim by someone else;
--   follow_ups_due: leads where the caller has a call task due today, with a rank, in hours, not claimed by others;
--   later_today: a rank, not claimed by others, next call date later in the caller's today;
--   no_number: Cold, Warm, Negotiation or Cool off with nothing to dial;
--   claimed_by_others: due leads someone else is working on now;
--   waiting_by_zone: due leads outside calling hours by calling zone, largest first, at most 50 zones (the browser
--   works out when each zone next opens).
create function public.queue_summary(p_scope text default 'mine', p_skip_lunch boolean default false) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_open text[];
  v_tz text;
  v_today date;
  v_end timestamptz;
  v jsonb;
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('mine', 'mine_unassigned', 'team') or p_skip_lunch is null then
    raise exception 'queue request out of bounds' using errcode = '22023', hint = 'bounds';
  end if;
  if p_scope <> 'mine' and not (select private.is_manager_or_admin()) then
    raise exception 'only managers and admins can work beyond their own leads' using errcode = '42501', hint = 'scope';
  end if;
  v_open := private.open_call_zones(now(), p_skip_lunch);
  v_tz := private.caller_zone();
  v_today := (now() at time zone v_tz)::date;
  v_end := (v_today + 1)::timestamp at time zone v_tz;
  with per_zone as (
    -- One pass: the live claims of others joined once (a hash of a few hundred rows), each count a filter.
    select c.call_zone,
           count(*) filter (where c.queue_rank is not null and (c.next_action_at is null or c.next_action_at <= now())
                              and q.company_id is null) as due_free,
           count(*) filter (where c.queue_rank is not null and c.next_action_at > now() and c.next_action_at < v_end
                              and q.company_id is null) as later,
           count(*) filter (where c.queue_rank is not null and (c.next_action_at is null or c.next_action_at <= now())
                              and q.company_id is not null) as taken,
           count(*) filter (where c.queue_rank is null and c.lead_status in ('cold', 'warm', 'negotiation', 'cool_off')
                              and not ((coalesce(c.phone ~ '[0-9]', false) and c.phone_wrong_at is null)
                                       or c.has_contact_phone)) as no_number
      from public.companies c
      left join (select x.company_id from private.queue_claims x
                  where x.expires_at > now() and x.user_id <> caller) q on q.company_id = c.id
     where p_scope = 'team' or c.owner_id = caller or (p_scope = 'mine_unassigned' and c.owner_id is null)
     group by c.call_zone)
  select jsonb_build_object(
           'callable_now', coalesce(sum(z.due_free) filter (where z.call_zone = any (v_open)), 0),
           'later_today', coalesce(sum(z.later), 0),
           'no_number', coalesce(sum(z.no_number), 0),
           'claimed_by_others', coalesce(sum(z.taken), 0),
           'waiting_by_zone', coalesce((
             select jsonb_agg(jsonb_build_object('key', w.call_zone, 'count', w.due_free)
                              order by w.due_free desc, w.call_zone)
               from (select y.call_zone, y.due_free from per_zone y
                      where not (y.call_zone = any (v_open)) and y.due_free > 0
                      order by y.due_free desc, y.call_zone
                      limit 50) w), '[]'::jsonb))
    into v
    from per_zone z;
  return v || jsonb_build_object('follow_ups_due', (
    select count(distinct c.id)
      from public.tasks t
      join public.companies c on c.id = t.company_id
     where t.assignee_id = caller and t.kind = 'call' and t.done_at is null and t.cancelled_at is null
       and (t.due_date <= v_today or t.due_at <= now() + interval '5 minutes')
       and c.queue_rank is not null and c.call_zone = any (v_open)
       and (p_scope = 'team' or c.owner_id = caller or (p_scope = 'mine_unassigned' and c.owner_id is null))
       and not exists (select 1 from private.queue_claims q
                        where q.company_id = c.id and q.expires_at > now() and q.user_id <> caller)));
end;
$$;

-- The next lead(s) to call, claimed for the caller (design 5.4). Scopes: mine (everyone), mine_unassigned and team
-- (managers and admins; 42501 scope otherwise). p_keep: the cards the screen still holds (at most 2; their claims are
-- renewed, every other claim of the caller goes); null on Start or a reload, when the caller's own live claims that are
-- still eligible come back first (renewed) and the others go. p_exclude: this session's skips (at most 200). p_count:
-- 1 or 2 new cards, and the caller never holds more than 3 claims. p_any_hours: "Show leads outside calling hours".
-- Each candidate's expired claim is removed, then INSERT ... ON CONFLICT DO NOTHING: a row back means the lead is the
-- caller's; nothing back means a teammate won it, so the next one is tried. Nothing locks the lead itself.
-- Answers {cards: [card...], kept: [the p_keep ids still claimed], summary: queue_summary when no card was found}.
create function public.claim_next_lead(
  p_scope text default 'mine',
  p_keep uuid[] default null,
  p_exclude uuid[] default '{}',
  p_count integer default 1,
  p_any_hours boolean default false,
  p_skip_lunch boolean default false
) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_exclude constant uuid[] := coalesce(p_exclude, '{}'::uuid[]);
  v_open text[];
  v_tz text;
  v_today date;
  v_skip uuid[];
  v_cards jsonb := '[]'::jsonb;
  v_kept uuid[] := '{}'::uuid[];
  v_won integer := 0;
  v_want integer;
  v_fetched integer;
  v_seg integer := 0;
  v_cand uuid;
  v_got uuid;
  r record;
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('mine', 'mine_unassigned', 'team')
     or p_count is null or p_count not between 1 and 2
     or coalesce(cardinality(p_keep), 0) > 2 or cardinality(v_exclude) > 200
     or coalesce(cardinality(p_keep), 0) + p_count > 3
     or array_position(p_keep, null) is not null or array_position(v_exclude, null) is not null
     or p_any_hours is null or p_skip_lunch is null then
    raise exception 'queue request out of bounds' using errcode = '22023', hint = 'bounds';
  end if;
  if p_scope <> 'mine' and not (select private.is_manager_or_admin()) then
    raise exception 'only managers and admins can work beyond their own leads' using errcode = '42501', hint = 'scope';
  end if;
  -- The caller's claims take turns (the claim guard takes the same lock), so two tabs never pass the limit together.
  perform pg_advisory_xact_lock(hashtextextended('queue_claims:' || caller::text, 0));
  v_open := case when p_any_hours then null else private.open_call_zones(now(), p_skip_lunch) end;
  v_tz := private.caller_zone();
  v_today := (now() at time zone v_tz)::date;
  v_skip := v_exclude || coalesce(p_keep, '{}'::uuid[]);

  if p_keep is null then
    -- Start or reload: own live claims still eligible come back first (renewed), up to p_count; the others go.
    for r in
      select q.company_id, q.expires_at > now() as live, f.follow_up,
             (c.queue_rank is not null
              and (v_open is null or c.call_zone = any (v_open))
              and not (c.id = any (v_exclude))
              and (p_scope = 'team' or c.owner_id = caller or (p_scope = 'mine_unassigned' and c.owner_id is null))
              and (c.next_action_at is null or c.next_action_at <= now() or f.follow_up)) as eligible
        from private.queue_claims q
        join public.companies c on c.id = q.company_id
        cross join lateral (
          select exists (select 1 from public.tasks t
                          where t.company_id = c.id and t.assignee_id = caller and t.kind = 'call'
                            and t.done_at is null and t.cancelled_at is null
                            and (t.due_date <= v_today or t.due_at <= now() + interval '5 minutes')) as follow_up) f
       where q.user_id = caller
       order by f.follow_up desc, c.queue_rank nulls last, c.next_action_at nulls last, c.last_activity_at nulls first,
                c.id  -- the queue order (Start claims two at the same instant)
    loop
      if v_won < p_count and r.live and r.eligible then
        update private.queue_claims q set expires_at = now() where q.company_id = r.company_id and q.user_id = caller;
        v_cards := v_cards || jsonb_build_array(
                     private.queue_card(r.company_id, case when r.follow_up then 'follow_up' end, p_skip_lunch));
        v_skip := v_skip || r.company_id;
        v_won := v_won + 1;
      else
        delete from private.queue_claims q where q.company_id = r.company_id and q.user_id = caller;
      end if;
    end loop;
  else
    -- The screen keeps these cards: their claims are renewed, every other claim of the caller goes.
    delete from private.queue_claims q
     where q.user_id = caller and (not (q.company_id = any (p_keep)) or q.expires_at <= now());
    with renewed as (
      update private.queue_claims q set expires_at = now()
       where q.user_id = caller and q.company_id = any (p_keep)
      returning q.company_id)
    select coalesce(array_agg(renewed.company_id order by renewed.company_id), '{}'::uuid[]) into v_kept from renewed;
  end if;

  -- The walk: one part of the order at a time, a few spares per attempt (a teammate may win some).
  while v_won < p_count and v_seg <= 6 loop
    v_want := p_count - v_won + 5;
    v_fetched := 0;
    for v_cand in select x from private.queue_candidates(v_seg, p_scope, v_open, v_skip, v_today, v_tz, v_want) x loop
      v_fetched := v_fetched + 1;
      v_skip := v_skip || v_cand;
      delete from private.queue_claims q where q.company_id = v_cand and q.expires_at <= now();
      v_got := null;
      begin
        insert into private.queue_claims (company_id) values (v_cand)
        on conflict (company_id) do nothing
        returning company_id into v_got;
      exception when insufficient_privilege then
        v_got := null;  -- the lead changed hands since it was read: not the caller's to claim any more
      end;
      -- The candidates were read before this claim: meanwhile a teammate may have claimed the lead, called it and let
      -- it go (its next call date moved). A second look, in a statement of its own, sees what they committed.
      if v_got is not null and not exists (
           select 1 from public.companies c
            where c.id = v_got and c.queue_rank is not null
              and (v_open is null or c.call_zone = any (v_open))
              and (p_scope = 'team' or c.owner_id = caller or (p_scope = 'mine_unassigned' and c.owner_id is null))
              and (c.next_action_at is null or c.next_action_at <= now()
                   or exists (select 1 from public.tasks t
                               where t.company_id = c.id and t.assignee_id = caller and t.kind = 'call'
                                 and t.done_at is null and t.cancelled_at is null
                                 and (t.due_date <= v_today or t.due_at <= now() + interval '5 minutes')))) then
        delete from private.queue_claims q where q.company_id = v_got and q.user_id = caller;
        v_got := null;
      end if;
      if v_got is not null then
        v_cards := v_cards || jsonb_build_array(
                     private.queue_card(v_got, case when v_seg = 0 then 'follow_up' end, p_skip_lunch));
        v_won := v_won + 1;
        exit when v_won >= p_count;
      end if;
    end loop;
    if v_won < p_count and v_fetched < v_want then
      v_seg := v_seg + 1;  -- this part of the order is used up
    end if;
  end loop;

  return jsonb_build_object(
    'cards', v_cards,
    'kept', to_jsonb(v_kept),
    'summary', case when v_won = 0 then public.queue_summary(p_scope, p_skip_lunch) end);
end;
$$;

-- Claim one lead again (Undo in the queue puts the lead back on the screen). The lead's owner, a manager or an admin
-- (42501 scope otherwise; P0002 when missing or not visible). True when the caller holds the claim afterwards, false
-- when a teammate holds a live one.
create function public.claim_lead(p_company uuid) returns boolean
language plpgsql volatile set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_owner uuid;
  v_got uuid;
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  select c.owner_id into v_owner from public.companies c where c.id = p_company;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if not ((select private.is_manager_or_admin()) or v_owner is not distinct from caller) then
    raise exception 'only the lead''s owner, a manager or an admin can claim it' using errcode = '42501', hint = 'scope';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('queue_claims:' || caller::text, 0));
  update private.queue_claims q set expires_at = now()
   where q.company_id = p_company and q.user_id = caller
  returning q.company_id into v_got;
  if v_got is not null then
    return true;
  end if;
  delete from private.queue_claims q where q.company_id = p_company and q.expires_at <= now();
  insert into private.queue_claims (company_id) values (p_company)
  on conflict (company_id) do nothing
  returning company_id into v_got;
  return v_got is not null;
end;
$$;

-- Keep the caller's live claims for 10 more minutes (the queue page, every 4 minutes while in use). Answers the new
-- end, or null when the caller holds no live claim.
create function public.renew_claims() returns timestamptz
language plpgsql volatile set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_until timestamptz;
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('queue_claims:' || caller::text, 0));
  with renewed as (
    update private.queue_claims q set expires_at = now()
     where q.user_id = caller and q.expires_at > now()
    returning q.expires_at)
  select max(renewed.expires_at) into v_until from renewed;
  return v_until;
end;
$$;

-- Let go of the caller's claims: these leads (at most 10), or all of them (null). Answers how many went.
create function public.release_claims(p_ids uuid[] default null) returns integer
language plpgsql volatile set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  n integer;
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if cardinality(p_ids) > 10 or array_position(p_ids, null) is not null then
    raise exception 'at most 10 leads at a time' using errcode = '22023', hint = 'bounds';
  end if;
  delete from private.queue_claims q where q.user_id = caller and (p_ids is null or q.company_id = any (p_ids));
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ===========================================================================
-- Part 8. The lead page and log_activity, redefined (same signatures): get_lead says who is working the lead in the
-- queue; log_activity releases the caller's queue claim when the call came from the queue (step 9) and locks the lead
-- FOR NO KEY UPDATE (step 3). Everything else is Day 4b's text unchanged.
-- ===========================================================================
-- One lead, as Day 4b, plus worked_by (design 4.1: 4c adds it). Null when it is missing or not visible.
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
    -- 4c: a teammate working this lead in the queue right now ("Henri is on this lead until 10:24"); never the caller.
    'worked_by', (select jsonb_build_object('first_name', w.first_name, 'until', q.expires_at)
                    from private.queue_claims q
                    join public.profiles w on w.id = q.user_id
                   where q.company_id = c.id and q.expires_at > now() and q.user_id <> (select auth.uid()))
  )
  from public.companies c
  left join public.profiles o on o.id = c.owner_id
  cross join lateral (select (select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()) as can_edit) e
  cross join lateral (select private.caller_zone() as tz offset 0) z  -- offset 0: worked out once, not once per task
  where c.id = p_id
$$;

-- Log a call, email, WhatsApp message, meeting or note (design 5.2 and 5.5), in one transaction. Anyone in the team may
-- log on any lead; the lead changes only for people who may change it (owner, manager, admin), found out by locking it.
-- Follow-ups: Interested needs a date or a time, Book meeting a time, Spoke and the other kinds of entry take one
-- optionally, the other outcomes none. p_task_title (the follow-up's title in the caller's language) is needed whenever
-- a task may be made: Interested, Book meeting, Wrong number, and any entry with a follow-up. p_dialled says which
-- number a call went to ('lead' or 'contact', with p_contact); Wrong number needs it. A replayed p_request_id answers
-- the first result again and changes nothing. p_from_queue: the caller's queue claim on this lead is released (4c).
create or replace function public.log_activity(
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
  p_from_queue boolean default false
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
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;

  -- 1. Validate (constant messages: no value reaches a log).
  if p_from_queue is null then
    raise exception 'say whether the call came from the queue' using errcode = '22023', hint = 'bounds';
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
      return private.logged_activity(v_id, true);
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
    -- (4c: FOR NO KEY UPDATE, not FOR UPDATE: it still makes outcomes on one lead take turns, and it no longer blocks
    -- the key-share lock a foreign key check takes, so a teammate claiming this lead in the queue never waits for the
    -- call being saved, nor deadlocks with its claim release in step 9.)
    select c.id, c.owner_id, c.lead_status, c.phone, c.phone_wrong_at, c.next_action_at, c.timezone, c.country
      into v_lead from public.companies c where c.id = p_company for no key update;
    v_editable := found;
    if not v_editable then
      select c.id, c.owner_id, c.lead_status, c.phone, c.phone_wrong_at, c.next_action_at, c.timezone, c.country
        into v_lead from public.companies c where c.id = p_company;
    end if;
    -- The same request may have been saved while this one waited for the lock.
    if p_request_id is not null then
      select a.id into v_id from public.activities a where a.user_id = caller and a.request_id = p_request_id;
      if found then
        return private.logged_activity(v_id, true);
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
    insert into public.activities (company_id, contact_id, type, outcome, body, request_id)
    values (p_company, p_contact, p_type, p_outcome, v_body, p_request_id)
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'activities_author_request_idx' then
      raise;
    end if;
    select a.id into v_id from public.activities a where a.user_id = caller and a.request_id = p_request_id;
    return private.logged_activity(v_id, true);
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

  -- 8. The undo record; the caller's records older than 10 minutes go.
  insert into private.activity_undo (activity_id, org_id, user_id, prev_status, new_status, prev_next_action_at,
                                     new_next_action_at, prev_owner_id, new_owner_id, owner_changed, wrong_company,
                                     wrong_contact_id, created_task_id, completed_task_ids, cancelled_task_ids)
  values (v_id, (select private.current_org_id()), caller,
          case when v_editable then v_lead.lead_status end, case when v_editable then v_status end,
          case when v_editable then v_lead.next_action_at end, case when v_editable then v_next end,
          case when v_editable then v_lead.owner_id end, case when v_editable then v_owner end,
          v_editable and v_owner is distinct from v_lead.owner_id, v_mark_company, v_wrong_contact, v_task,
          v_completed, v_cancelled);
  delete from private.activity_undo u where u.user_id = caller and u.created_at < now() - interval '10 minutes';

  -- 9. From the queue: the caller's claim on this lead is released (the next card is claimed by claim_next_lead).
  if p_from_queue then
    delete from private.queue_claims q where q.company_id = p_company and q.user_id = caller;
  end if;
  return private.logged_activity(v_id, false);
end;
$$;

-- ===========================================================================
-- Part 9. The Tasks page API (design 4.2, 5.6). All SECURITY INVOKER, static SQL; the task guard and policies (4a and
-- 4b) decide every write. Buckets in the caller's own zone (profiles.timezone, read in SQL):
--   overdue:  open, and a date before today or a time already past;
--   today:    open, and today's date or a time later today;
--   upcoming: open, and a later date or a time from tomorrow on, or no date at all (last);
--   done:     done, newest first. Dismissed tasks are listed nowhere.
-- Open buckets sort on sort_at (the time, or the start of the all-day date in the caller's zone), then id; done on
-- done_at desc, id desc. Keyset cursor: the last row's (sort_at, id); in Upcoming, once the undated tasks start, the
-- last row's sort_at is null and the cursor is (null, id). Scope: mine (assigned to the caller) or team (managers and
-- admins: every task they can see; 42501 scope otherwise).
-- ===========================================================================
create function public.list_tasks(
  p_bucket text,
  p_scope text default 'mine',
  p_after_sort timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid,
  title text,
  kind text,
  due_date date,
  due_at timestamptz,
  done_at timestamptz,
  assignee_id uuid,
  assignee_first_name text,
  assignee_last_name text,
  company_id uuid,
  company_name text,
  company_call_zone text,
  company_lead_status text,
  contact_id uuid,
  contact_name text,
  created_by uuid,
  sort_at timestamptz,
  can_edit boolean
)
language plpgsql stable set search_path = '' as $$
#variable_conflict use_column
declare
  caller constant uuid := (select auth.uid());
  v_mgr boolean;
  v_tz text;
  v_today date;
  v_tomorrow timestamptz;
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_bucket is null or p_bucket not in ('overdue', 'today', 'upcoming', 'done') then
    raise exception 'unknown list of tasks' using errcode = '22023', hint = 'bad_bucket';
  end if;
  if p_scope is null or p_scope not in ('mine', 'team') or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'task list request out of bounds' using errcode = '22023', hint = 'bounds';
  end if;
  if (p_after_sort is not null and p_after_id is null)
     or (p_after_id is not null and p_after_sort is null and p_bucket <> 'upcoming') then
    raise exception 'a cursor needs its time and its id' using errcode = '22023', hint = 'bad_cursor';
  end if;
  v_mgr := (select private.is_manager_or_admin());
  if p_scope = 'team' and not v_mgr then
    raise exception 'only managers and admins see the team''s tasks' using errcode = '42501', hint = 'scope';
  end if;
  v_tz := private.caller_zone();
  v_today := (now() at time zone v_tz)::date;
  v_tomorrow := (v_today + 1)::timestamp at time zone v_tz;

  if p_bucket = 'overdue' then
    return query
      select t.id, t.title, t.kind, t.due_date, t.due_at, t.done_at, t.assignee_id, p.first_name, p.last_name,
             t.company_id, c.name, c.call_zone, c.lead_status, t.contact_id,
             nullif(btrim(k.first_name || ' ' || k.last_name), ''), t.created_by, t.sort_at,
             v_mgr or t.assignee_id = caller or t.created_by = caller
        from (select x.id, x.title, x.kind, x.due_date, x.due_at, x.done_at, x.assignee_id, x.company_id, x.contact_id,
                     x.created_by, s.sort_at
                from public.tasks x
                cross join lateral (select coalesce(x.due_at, x.due_date::timestamp at time zone v_tz) as sort_at) s
               where (p_scope = 'team' or x.assignee_id = caller) and x.done_at is null and x.cancelled_at is null
                 and (x.due_date < v_today or x.due_at < now())
                 and (p_after_id is null or (s.sort_at, x.id) > (p_after_sort, p_after_id))
               order by s.sort_at, x.id
               limit p_limit) t
        left join public.profiles p on p.id = t.assignee_id
        left join public.companies c on c.id = t.company_id
        left join public.contacts k on k.id = t.contact_id
       order by t.sort_at, t.id;
  elsif p_bucket = 'today' then
    return query
      select t.id, t.title, t.kind, t.due_date, t.due_at, t.done_at, t.assignee_id, p.first_name, p.last_name,
             t.company_id, c.name, c.call_zone, c.lead_status, t.contact_id,
             nullif(btrim(k.first_name || ' ' || k.last_name), ''), t.created_by, t.sort_at,
             v_mgr or t.assignee_id = caller or t.created_by = caller
        from (select x.id, x.title, x.kind, x.due_date, x.due_at, x.done_at, x.assignee_id, x.company_id, x.contact_id,
                     x.created_by, s.sort_at
                from public.tasks x
                cross join lateral (select coalesce(x.due_at, x.due_date::timestamp at time zone v_tz) as sort_at) s
               where (p_scope = 'team' or x.assignee_id = caller) and x.done_at is null and x.cancelled_at is null
                 and (x.due_date = v_today or (x.due_at >= now() and x.due_at < v_tomorrow))
                 and (p_after_id is null or (s.sort_at, x.id) > (p_after_sort, p_after_id))
               order by s.sort_at, x.id
               limit p_limit) t
        left join public.profiles p on p.id = t.assignee_id
        left join public.companies c on c.id = t.company_id
        left join public.contacts k on k.id = t.contact_id
       order by t.sort_at, t.id;
  elsif p_bucket = 'upcoming' then
    return query
      select t.id, t.title, t.kind, t.due_date, t.due_at, t.done_at, t.assignee_id, p.first_name, p.last_name,
             t.company_id, c.name, c.call_zone, c.lead_status, t.contact_id,
             nullif(btrim(k.first_name || ' ' || k.last_name), ''), t.created_by, t.sort_at,
             v_mgr or t.assignee_id = caller or t.created_by = caller
        from (select x.id, x.title, x.kind, x.due_date, x.due_at, x.done_at, x.assignee_id, x.company_id, x.contact_id,
                     x.created_by, s.sort_at
                from public.tasks x
                cross join lateral (select coalesce(x.due_at, x.due_date::timestamp at time zone v_tz) as sort_at) s
               where (p_scope = 'team' or x.assignee_id = caller) and x.done_at is null and x.cancelled_at is null
                 and (x.due_date > v_today or x.due_at >= v_tomorrow or (x.due_date is null and x.due_at is null))
                 and (p_after_id is null
                      or (p_after_sort is not null and (s.sort_at is null or (s.sort_at, x.id) > (p_after_sort, p_after_id)))
                      or (p_after_sort is null and s.sort_at is null and x.id > p_after_id))
               order by s.sort_at nulls last, x.id
               limit p_limit) t
        left join public.profiles p on p.id = t.assignee_id
        left join public.companies c on c.id = t.company_id
        left join public.contacts k on k.id = t.contact_id
       order by t.sort_at nulls last, t.id;
  else
    return query
      select t.id, t.title, t.kind, t.due_date, t.due_at, t.done_at, t.assignee_id, p.first_name, p.last_name,
             t.company_id, c.name, c.call_zone, c.lead_status, t.contact_id,
             nullif(btrim(k.first_name || ' ' || k.last_name), ''), t.created_by, t.sort_at,
             v_mgr or t.assignee_id = caller or t.created_by = caller
        from (select x.id, x.title, x.kind, x.due_date, x.due_at, x.done_at, x.assignee_id, x.company_id, x.contact_id,
                     x.created_by, s.sort_at
                from public.tasks x
                cross join lateral (select x.done_at as sort_at) s
               where (p_scope = 'team' or x.assignee_id = caller) and x.done_at is not null
                 and (p_after_id is null or (x.done_at, x.id) < (p_after_sort, p_after_id))
               order by x.done_at desc, x.id desc
               limit p_limit) t
        left join public.profiles p on p.id = t.assignee_id
        left join public.companies c on c.id = t.company_id
        left join public.contacts k on k.id = t.contact_id
       order by t.done_at desc, t.id desc;
  end if;
end;
$$;

-- The tab counts: {overdue, today, upcoming}, one pass over the open tasks in scope.
create function public.count_tasks(p_scope text default 'mine') returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  v_tz text;
  v_today date;
  v_tomorrow timestamptz;
  v jsonb;
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('mine', 'team') then
    raise exception 'task list request out of bounds' using errcode = '22023', hint = 'bounds';
  end if;
  if p_scope = 'team' and not (select private.is_manager_or_admin()) then
    raise exception 'only managers and admins see the team''s tasks' using errcode = '42501', hint = 'scope';
  end if;
  v_tz := private.caller_zone();
  v_today := (now() at time zone v_tz)::date;
  v_tomorrow := (v_today + 1)::timestamp at time zone v_tz;
  select jsonb_build_object(
           'overdue', count(*) filter (where t.due_date < v_today or t.due_at < now()),
           'today', count(*) filter (where t.due_date = v_today or (t.due_at >= now() and t.due_at < v_tomorrow)),
           'upcoming', count(*) filter (where t.due_date > v_today or t.due_at >= v_tomorrow
                                              or (t.due_date is null and t.due_at is null)))
    into v
    from public.tasks t
   where (p_scope = 'team' or t.assignee_id = caller) and t.done_at is null and t.cancelled_at is null;
  return v;
end;
$$;

-- Edit a task: title, date or time, who it is for (null keeps the current person), and the contact (null: none; it
-- must belong to the task's lead). The task guard checks the title, the dates and what may change; reps keep tasks to
-- themselves (enforce_org_and_owner). Answers the stored task.
create function public.update_task(
  p_id uuid,
  p_title text,
  p_due_date date,
  p_due_at timestamptz,
  p_assignee uuid,
  p_contact uuid
) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_company uuid;
  v jsonb;
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  select t.company_id into v_company from public.tasks t where t.id = p_id;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  if p_contact is not null and not exists (select 1 from public.contacts k
                                            where k.id = p_contact and k.company_id = v_company) then
    raise exception 'contact not found on this lead' using errcode = 'P0002';
  end if;
  update public.tasks t
     set title = p_title, due_date = p_due_date, due_at = p_due_at,
         assignee_id = coalesce(p_assignee, t.assignee_id), contact_id = p_contact
   where t.id = p_id
  returning jsonb_build_object('id', t.id, 'title', t.title, 'kind', t.kind, 'due_date', t.due_date,
                               'due_at', t.due_at, 'assignee_id', t.assignee_id, 'contact_id', t.contact_id,
                               'done_at', t.done_at, 'cancelled_at', t.cancelled_at, 'updated_at', t.updated_at)
    into v;
  if v is null then
    raise exception 'task not yours to change' using errcode = '42501';
  end if;
  return v;
end;
$$;

-- Delete a task: a fresh code first (hint step_up), then the policy (assignee, creator, manager or admin).
create function public.delete_task(p_id uuid) returns void
language plpgsql volatile set search_path = '' as $$
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if not (select private.has_recent_aal2(600)) then
    raise exception 'confirm it is you first' using errcode = '42501', hint = 'step_up';
  end if;
  if not exists (select 1 from public.tasks t where t.id = p_id) then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  delete from public.tasks t where t.id = p_id;
  if not found then
    raise exception 'task not yours to delete' using errcode = '42501';
  end if;
end;
$$;

-- The caller's own time zone ("Today" on the Tasks page). One PostgreSQL knows, or 22023 timezone with a constant
-- message (check_profile_timezone is the backstop for a direct update).
create function public.set_my_timezone(p_timezone text) returns jsonb
language plpgsql volatile set search_path = '' as $$
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_timezone is null or char_length(p_timezone) > 64
     or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
    raise exception 'unknown time zone' using errcode = '22023', hint = 'timezone';
  end if;
  update public.profiles p set timezone = p_timezone where p.id = (select auth.uid());
  if not found then
    raise exception 'no profile for caller' using errcode = '42501';
  end if;
  return jsonb_build_object('timezone', p_timezone);
end;
$$;

-- ===========================================================================
-- Function privileges: trigger functions are never callable; the helpers the RPCs use are callable by signed-in
-- people (private has no API endpoint); every RPC is revoked from public and anon and granted to authenticated.
-- get_lead and log_activity keep their Day 4b grants (create or replace).
-- ===========================================================================
revoke all on function private.sync_contact_phone(), private.claim_guard(), private.check_profile_timezone()
  from public, anon, authenticated;
revoke all on function private.call_zone_keys(), private.call_zone_open(text, timestamptz, boolean),
  private.open_call_zones(timestamptz, boolean), private.queue_card(uuid, text, boolean),
  private.queue_candidates(integer, text, text[], uuid[], date, text, integer) from public, anon;
grant execute on function private.call_zone_keys(), private.call_zone_open(text, timestamptz, boolean),
  private.open_call_zones(timestamptz, boolean), private.queue_card(uuid, text, boolean),
  private.queue_candidates(integer, text, text[], uuid[], date, text, integer) to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.claim_next_lead(text, uuid[], uuid[], integer, boolean, boolean)',
    'public.claim_lead(uuid)',
    'public.renew_claims()',
    'public.release_claims(uuid[])',
    'public.queue_summary(text, boolean)',
    'public.list_tasks(text, text, timestamptz, uuid, integer)',
    'public.count_tasks(text)',
    'public.update_task(uuid, text, date, timestamptz, uuid, uuid)',
    'public.delete_task(uuid)',
    'public.set_my_timezone(text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- ===========================================================================
-- Zone-map change procedure (design 3.3). A later change to the zone map is a new migration that:
--   1. redefines the zone-map functions (scripts/make-zone-map.mjs writes them) and, the same way as Part 4 above,
--      private.call_zone_keys();
--   2. recomputes the stored calling zones without touching anything else:
--        alter table public.companies disable trigger set_updated_at, disable trigger audit_row;
--        update public.companies set country = country;
--        alter table public.companies enable trigger set_updated_at, enable trigger audit_row;
--   3. checks call_zone_matches_map, which must return 0 (it runs in supabase/tests/queue_attack.sql and is one of
--      the Gate 1 checks):
--        select count(*) from public.companies where call_zone <> private.lead_call_zone(timezone, country);
-- ===========================================================================
