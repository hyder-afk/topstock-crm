-- Day 5c: the Home dashboard's figures (design docs/evidence/day5/design.md sections 3.3, 4.3, 5.8, 6 threats 1, 2, 18
-- and 24, 7.10 and 10; D26 to D30). Read-only: no tables, no views, no materialised views. The file name sorts after
-- main's newest migration when the PR merges; it is renamed at merge time if main moved (D35,
-- scripts/check-migration-order.sh). In plain words:
--  - home_summary: the four KPI figures (open pipeline, won this month, calls today, tasks due) and what the Pipeline,
--    Work queue and Needs attention cards count, in the caller's profile zone (a 23 or 25 hour day stays one day);
--  - home_attention: open deals that are stalled, past their close date or closing within 7 days, worst first;
--  - home_recent_activity: the latest entries and deal changes, never an entry's text or a lost note;
--  - home_today_tasks: the caller's overdue and today's tasks for the Today card;
--  - home_low_stock: a stub answering null until Day 6 (section 10), created only when Day 6 has not made it already.
-- House rules (design section 3): set search_path = '' everywhere; every function is SECURITY INVOKER with static SQL
-- (Mine and Team are separate statements chosen by IF, each with a fixed index condition; no format(), no EXECUTE), so
-- row level security decides every row a figure counts. The scope is checked first: Team is for managers and admins
-- (42501 'scope'), anything else than team or mine is 22023 'bad_scope'. No custom setting is read; "today" and "this
-- month" come from the server clock and the caller's profile zone (private.caller_zone, Day 4b), never the browser.
-- Leakproof rule (Day 5a): deals.value is summed, never compared.
-- REBASE: re-copy after 4c/4d merge. Day 4c (not on this branch) adds public.count_tasks and public.list_tasks. At the
-- 4c rebase: the tasks part of home_summary calls count_tasks('mine') instead of its own counts, and home_today_tasks is
-- removed (the /api/home route calls list_tasks('overdue' / 'today', 'mine', 6) instead). Both blocks are marked
-- "-- REBASE" and listed in docs/evidence/day5c/README.md ("Rebase points").

-- ===========================================================================
-- Part 1. The caller's day and month (design 5.8 variables)
-- ===========================================================================
-- Day and month bounds for an instant in a zone: today's date there, the instants its day starts and ends (the next
-- day's local midnight, so a 23 or 25 hour day stays one day) and the instant the month starts. One definition for
-- every figure; home_attack.sql checks it at fixed instants (31 Oct 2026 in Karachi and Paris, 25 Oct 2026 in Paris).
create function private.home_window(p_at timestamptz, p_tz text)
returns table (today date, day_start timestamptz, day_end timestamptz, month_start timestamptz)
language sql stable set search_path = '' as $$
  select w.today,
         w.today::timestamp at time zone p_tz,
         (w.today + 1)::timestamp at time zone p_tz,
         (w.today - (extract(day from w.today)::integer - 1))::timestamp at time zone p_tz
    from (select (p_at at time zone p_tz)::date as today) w
$$;

-- ===========================================================================
-- Part 2. Open deals in scope, one scan (K1, K1b, K8 and home_attention)
-- ===========================================================================
-- The caller's open deals (p_owner) or the org's (p_owner null), with their stage, value, stall state and close date.
-- Stalled is Day 5a's one rule (deal_cards): neither a stage move nor any activity on the lead for the stage's limit,
-- elapsed in hours. quiet_since is when the deal last moved or its lead was last contacted; the lead is read only when
-- the stage clock alone is past the limit (CASE evaluates the lookup lazily), as pipeline_summary does. over_days: whole
-- days past the limit (meaningful for stalled deals only). Each branch walks one board index.
create function private.home_open_deals(p_owner uuid)
returns table (id uuid, stage text, stage_position smallint, value numeric, expected_close date, is_stalled boolean,
               over_days integer)
language plpgsql stable set search_path = '' as $$
begin
  if p_owner is not null then
    return query
      select d.id, s.key, s.position::smallint, d.value, d.expected_close,
             q.quiet_since < now() - make_interval(hours => 24 * s.stall_days),
             floor(extract(epoch from now() - make_interval(hours => 24 * s.stall_days) - q.quiet_since) / 86400)::integer
        from public.deals d
        join public.pipeline_stages s on s.id = d.stage_id
        cross join lateral (
          select case when d.stage_entered_at < now() - make_interval(hours => 24 * s.stall_days)
                      then greatest(d.stage_entered_at,
                                    coalesce((select c.last_activity_at from public.companies c where c.id = d.company_id),
                                             '-infinity'::timestamptz))
                      else d.stage_entered_at end as quiet_since) q
       where d.status = 'open' and d.owner_id = p_owner;
  else
    return query
      select d.id, s.key, s.position::smallint, d.value, d.expected_close,
             q.quiet_since < now() - make_interval(hours => 24 * s.stall_days),
             floor(extract(epoch from now() - make_interval(hours => 24 * s.stall_days) - q.quiet_since) / 86400)::integer
        from public.deals d
        join public.pipeline_stages s on s.id = d.stage_id
        cross join lateral (
          select case when d.stage_entered_at < now() - make_interval(hours => 24 * s.stall_days)
                      then greatest(d.stage_entered_at,
                                    coalesce((select c.last_activity_at from public.companies c where c.id = d.company_id),
                                             '-infinity'::timestamptz))
                      else d.stage_entered_at end as quiet_since) q
       where d.status = 'open' and d.org_id = (select private.current_org_id());
  end if;
end;
$$;

-- ===========================================================================
-- Part 3. The figures (design 4.3 and 5.8)
-- ===========================================================================
-- K1 open pipeline (count, value, without a value, stalled) and K1b by stage; K8 attention counts; K2 won this month
-- (current status: a reopened deal leaves it); K3 win rate over 90 days (Opened by mistake left out; the rate only from 5
-- closed deals); the Lost line (30 days, by reason); K4 calls today (and how many reached someone); K5 tasks due (always
-- the caller's own) and K6 meetings today; K7 new leads in 7 days (org-wide: leads are the whole team's).
create function public.home_summary(p_scope text default 'team') returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_me constant uuid := (select auth.uid());
  v_org uuid;
  v_team boolean;
  v_owner uuid;
  v_tz text;
  w record;
  v_open jsonb;
  v_won jsonb;
  v_rate jsonb;
  v_lost jsonb;
  v_calls jsonb;
  v_tasks jsonb;
  v_leads jsonb;
begin
  if v_me is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('team', 'mine') then
    raise exception 'unknown scope' using errcode = '22023', hint = 'bad_scope';
  end if;
  if p_scope = 'team' and not (select private.is_manager_or_admin()) then
    raise exception 'only managers and admins see the team''s figures' using errcode = '42501', hint = 'scope';
  end if;
  v_team := p_scope = 'team';
  v_owner := case when v_team then null else v_me end;
  v_org := (select private.current_org_id());
  v_tz := private.caller_zone();
  select * into w from private.home_window(now(), v_tz);

  -- K1, K1b, K8: one pass over the open deals in scope.
  with o as materialized (select * from private.home_open_deals(v_owner)),
       st as (select s.key, s.position from public.pipeline_stages s
               where s.org_id = v_org and s.key in ('lead', 'qualified', 'negotiations'))
  select jsonb_build_object(
           'count', (select count(*) from o),
           'value', (select coalesce(sum(o.value), 0)::numeric(16, 2)::text from o),
           'no_value', (select count(*) from o where o.value is null),
           'stalled', (select count(*) from o where o.is_stalled),
           'closing', (select count(*) from o where o.expected_close between w.today and w.today + 7),
           'close_passed', (select count(*) from o where o.expected_close < w.today),
           'by_stage', (select coalesce(jsonb_agg(jsonb_build_object(
                                 'key', st.key,
                                 'count', (select count(*) from o where o.stage = st.key),
                                 'value', (select coalesce(sum(o.value), 0)::numeric(16, 2)::text from o where o.stage = st.key))
                               order by st.position), '[]'::jsonb)
                          from st))
    into v_open;

  -- K2, K3 and the Lost line: closed deals in scope.
  if v_team then
    select jsonb_build_object('count', count(*), 'value', coalesce(sum(d.value), 0)::numeric(16, 2)::text) into v_won
      from public.deals d
     where d.status <> 'open' and d.org_id = v_org and d.status = 'won' and d.closed_at >= w.month_start;
    select jsonb_build_object('won', count(*) filter (where d.status = 'won'),
                              'lost', count(*) filter (where d.status = 'lost' and d.lost_reason <> 'mistake'))
      into v_rate
      from public.deals d
     where d.status <> 'open' and d.org_id = v_org and d.status in ('won', 'lost')
       and d.closed_at >= now() - interval '90 days';
    select jsonb_build_object('count', coalesce(sum(r.n), 0),
                              'reasons', coalesce(jsonb_agg(jsonb_build_object('code', r.lost_reason, 'count', r.n)
                                                            order by r.n desc, r.lost_reason), '[]'::jsonb))
      into v_lost
      from (select d.lost_reason, count(*) as n from public.deals d
             where d.status <> 'open' and d.org_id = v_org and d.status = 'lost'
               and d.closed_at >= now() - interval '30 days'
             group by d.lost_reason) r;
  else
    select jsonb_build_object('count', count(*), 'value', coalesce(sum(d.value), 0)::numeric(16, 2)::text) into v_won
      from public.deals d
     where d.status <> 'open' and d.owner_id = v_me and d.status = 'won' and d.closed_at >= w.month_start;
    select jsonb_build_object('won', count(*) filter (where d.status = 'won'),
                              'lost', count(*) filter (where d.status = 'lost' and d.lost_reason <> 'mistake'))
      into v_rate
      from public.deals d
     where d.status <> 'open' and d.owner_id = v_me and d.status in ('won', 'lost')
       and d.closed_at >= now() - interval '90 days';
    select jsonb_build_object('count', coalesce(sum(r.n), 0),
                              'reasons', coalesce(jsonb_agg(jsonb_build_object('code', r.lost_reason, 'count', r.n)
                                                            order by r.n desc, r.lost_reason), '[]'::jsonb))
      into v_lost
      from (select d.lost_reason, count(*) as n from public.deals d
             where d.status <> 'open' and d.owner_id = v_me and d.status = 'lost'
               and d.closed_at >= now() - interval '30 days'
             group by d.lost_reason) r;
  end if;
  -- The rate is shown from 5 closed deals in 90 days (D27); below that the app says "Not enough closed deals yet".
  v_rate := v_rate || jsonb_build_object('rate',
    case when (v_rate ->> 'won')::integer + (v_rate ->> 'lost')::integer >= 5
         then round((v_rate ->> 'won')::numeric / ((v_rate ->> 'won')::integer + (v_rate ->> 'lost')::integer), 4) end);

  -- K4: calls since the start of the caller's day. Team: one ordered index range per person in the org (profiles RLS).
  if v_team then
    select jsonb_build_object('count', coalesce(sum(x.n), 0), 'reached', coalesce(sum(x.reached), 0)) into v_calls
      from public.profiles p
      cross join lateral (
        select count(*) as n,
               count(*) filter (where a.outcome in ('connected', 'interested', 'meeting_booked', 'not_interested',
                                                    'do_not_contact')) as reached
          from public.activities a
         where a.user_id = p.id and a.created_at >= w.day_start and a.type = 'call') x;
  else
    select jsonb_build_object('count', count(*),
                              'reached', count(*) filter (where a.outcome in ('connected', 'interested', 'meeting_booked',
                                                                              'not_interested', 'do_not_contact')))
      into v_calls
      from public.activities a
     where a.user_id = v_me and a.created_at >= w.day_start and a.type = 'call';
  end if;

  -- K5 and K6: always the caller's own open tasks (Day 4c's buckets in the profile zone).
  -- REBASE: re-copy after 4c/4d merge. Day 4c's public.count_tasks('mine') gives overdue and today; keep the meetings
  -- count here.
  select jsonb_build_object(
           'overdue', count(*) filter (where t.due_date < w.today or t.due_at < now()),
           'today', count(*) filter (where t.due_date = w.today or (t.due_at >= now() and t.due_at < w.day_end)),
           'meetings', count(*) filter (where t.kind = 'meeting' and t.due_at >= w.day_start and t.due_at < w.day_end))
    into v_tasks
    from public.tasks t
   where t.assignee_id = v_me and t.done_at is null and t.cancelled_at is null;

  -- K7: leads created in the last 7 days, and how many of them came from an import.
  select jsonb_build_object('count', count(*), 'imported', count(*) filter (where c.import_batch_id is not null))
    into v_leads
    from public.companies c
   where c.org_id = v_org and c.created_at >= now() - interval '7 days';

  return jsonb_build_object(
    'scope', p_scope,
    'zone', v_tz,
    'today', w.today,
    'as_of', now(),
    'open', v_open,
    'won_month', v_won,
    'win_rate', v_rate,
    'lost_30', v_lost,
    'calls_today', v_calls,
    'tasks', v_tasks,
    'new_leads', v_leads);
end;
$$;

-- Needs attention (design 4.3): open deals in scope that are past their close date, stalled, or closing within 7 days.
-- Order: close date passed first, then most days over the stall limit, then soonest close. Each item is the deal's card
-- (Day 5a deal_cards) plus its reason ('overdue', 'stalled' or 'closing', in that priority); total counts them all.
create function public.home_attention(p_scope text default 'team', p_limit integer default 5) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_me constant uuid := (select auth.uid());
  v_today date;
  v_ids uuid[];
  v_reasons text[];
  v_total integer;
begin
  if v_me is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('team', 'mine') then
    raise exception 'unknown scope' using errcode = '22023', hint = 'bad_scope';
  end if;
  if p_scope = 'team' and not (select private.is_manager_or_admin()) then
    raise exception 'only managers and admins see the team''s figures' using errcode = '42501', hint = 'scope';
  end if;
  if p_limit is null or p_limit not between 1 and 20 then
    raise exception 'between 1 and 20 deals' using errcode = '22023', hint = 'limit';
  end if;
  v_today := (select h.today from private.home_window(now(), private.caller_zone()) h);
  with o as materialized (
    select x.id, x.expected_close, x.is_stalled, x.over_days,
           case when x.expected_close < v_today then 'overdue'
                when x.is_stalled then 'stalled'
                else 'closing' end as reason
      from private.home_open_deals(case when p_scope = 'team' then null else v_me end) x
     where x.expected_close < v_today or x.is_stalled or x.expected_close between v_today and v_today + 7),
  ranked as (
    select o.id, o.reason,
           row_number() over (order by (o.expected_close < v_today) is true desc,
                                       case when o.is_stalled then o.over_days end desc nulls last,
                                       o.expected_close nulls last, o.id) as rn
      from o)
  select (select count(*) from o),
         coalesce((select array_agg(r.id order by r.rn) from ranked r where r.rn <= p_limit), '{}'),
         coalesce((select array_agg(r.reason order by r.rn) from ranked r where r.rn <= p_limit), '{}')
    into v_total, v_ids, v_reasons;
  return jsonb_build_object(
    'total', v_total,
    'items', coalesce((select jsonb_agg((to_jsonb(c) - 'n') || jsonb_build_object('reason', v_reasons[c.n]) order by c.n)
                         from private.deal_cards(v_ids) with ordinality as c (id, stage, title, company_id, company_name,
                              city, country, lead_status, contact_id, contact_name, value, currency, status,
                              stage_entered_at, closed_at, expected_close, fulfilment, owner_id, owner_first_name,
                              owner_last_name, version, last_activity_at, is_stalled, quiet_days, lost_reason, created_at,
                              can_edit, n)), '[]'::jsonb));
end;
$$;

-- Recent activity (design 5.8): the latest entries and deal changes merged, newest first. Entries: Mine is the caller's
-- (one ordered index range); Team is one ordered index range per person in the org, then the top rows (never a sort
-- over every entry). Deal changes: the caller's or the org's history rows that the caller sees (deals RLS), without
-- undo pairs (an undo row and the row it undoes are both left out). Columns are fixed by the return type and hold no
-- entry text (body) and no lost note: the feed shows who did what on which lead, and a won deal's value.
create function public.home_recent_activity(p_scope text default 'team', p_limit integer default 8)
returns table (item_id text, kind text, type text, outcome text, to_stage text, value text, company_id uuid,
               company_name text, user_first_name text, at timestamptz)
language plpgsql stable set search_path = '' as $$
declare
  v_me constant uuid := (select auth.uid());
begin
  if v_me is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('team', 'mine') then
    raise exception 'unknown scope' using errcode = '22023', hint = 'bad_scope';
  end if;
  if p_scope = 'team' and not (select private.is_manager_or_admin()) then
    raise exception 'only managers and admins see the team''s figures' using errcode = '42501', hint = 'scope';
  end if;
  if p_limit is null or p_limit not between 1 and 20 then
    raise exception 'between 1 and 20 rows' using errcode = '22023', hint = 'limit';
  end if;
  if p_scope = 'team' then
    return query
      select f.item_id, f.kind, f.type, f.outcome, f.to_stage, f.value, f.company_id, c.name, p.first_name, f.at
        from (
          (select 'a:' || a.id::text as item_id, 'activity'::text as kind, a.type, a.outcome, null::text as to_stage,
                  null::text as value, a.company_id, a.user_id, a.created_at as at
             from public.profiles pr
             cross join lateral (select x.id, x.type, x.outcome, x.company_id, x.user_id, x.created_at
                                   from public.activities x
                                  where x.user_id = pr.id
                                  order by x.created_at desc
                                  limit p_limit) a
            order by a.created_at desc
            limit p_limit)
          union all
          (select 'h:' || h.id::text, h.kind, null, null, h.to_stage,
                  case when h.kind = 'won' then h.value_after::text end, d.company_id, h.actor_id, h.created_at
             from public.deal_stage_history h
             join public.deals d on d.id = h.deal_id
            where h.org_id = (select private.current_org_id()) and h.kind <> 'undo'
              and not exists (select 1 from public.deal_stage_history u where u.undoes = h.id)
            order by h.created_at desc
            limit p_limit)) f
        left join public.companies c on c.id = f.company_id
        left join public.profiles p on p.id = f.user_id
       order by f.at desc, f.item_id desc
       limit p_limit;
  else
    return query
      select f.item_id, f.kind, f.type, f.outcome, f.to_stage, f.value, f.company_id, c.name, p.first_name, f.at
        from (
          (select 'a:' || a.id::text as item_id, 'activity'::text as kind, a.type, a.outcome, null::text as to_stage,
                  null::text as value, a.company_id, a.user_id, a.created_at as at
             from public.activities a
            where a.user_id = v_me
            order by a.created_at desc
            limit p_limit)
          union all
          (select 'h:' || h.id::text, h.kind, null, null, h.to_stage,
                  case when h.kind = 'won' then h.value_after::text end, d.company_id, h.actor_id, h.created_at
             from public.deal_stage_history h
             join public.deals d on d.id = h.deal_id
            where h.actor_id = v_me and h.kind <> 'undo'
              and not exists (select 1 from public.deal_stage_history u where u.undoes = h.id)
            order by h.created_at desc
            limit p_limit)) f
        left join public.companies c on c.id = f.company_id
        left join public.profiles p on p.id = f.user_id
       order by f.at desc, f.item_id desc
       limit p_limit;
  end if;
end;
$$;

-- REBASE: re-copy after 4c/4d merge. A stand-in for Day 4c's list_tasks('overdue' / 'today', 'mine', 6), which is not
-- on this branch: remove this function at the 4c rebase (and its grant, tests and mutation rows). The caller's open
-- tasks that are overdue or due today (Day 4c's buckets in the profile zone), overdue first, then today's meetings by
-- time, then the rest by when they are due (an all-day task at the start of its day); overdue_days counts whole days in
-- the profile zone (0: earlier today). total and overdue count them all.
create function public.home_today_tasks(p_limit integer default 6) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_me constant uuid := (select auth.uid());
  v_tz text;
  w record;
  v jsonb;
begin
  if v_me is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 20 then
    raise exception 'between 1 and 20 tasks' using errcode = '22023', hint = 'limit';
  end if;
  v_tz := private.caller_zone();
  select * into w from private.home_window(now(), v_tz);
  with t as materialized (
    select t.id, t.title, t.kind, t.due_date, t.due_at, t.company_id, c.name as company_name,
           (t.due_date < w.today or t.due_at < now()) is true as overdue,
           case when (t.due_date < w.today or t.due_at < now()) is true
                then w.today - coalesce(t.due_date, (t.due_at at time zone v_tz)::date) end as overdue_days,
           coalesce(t.due_at, t.due_date::timestamp at time zone v_tz) as sort_at
      from public.tasks t
      left join public.companies c on c.id = t.company_id
     where t.assignee_id = v_me and t.done_at is null and t.cancelled_at is null
       and (t.due_date <= w.today or t.due_at < w.day_end))
  select jsonb_build_object(
           'total', (select count(*) from t),
           'overdue', (select count(*) from t where t.overdue),
           'items', coalesce((select jsonb_agg(to_jsonb(x) order by x.overdue desc, (x.kind = 'meeting') desc, x.sort_at, x.id)
                                from (select * from t
                                       order by t.overdue desc, (t.kind = 'meeting') desc, t.sort_at, t.id
                                       limit p_limit) x), '[]'::jsonb))
    into v;
  return v;
end;
$$;

-- ===========================================================================
-- Part 4. Low stock before Day 6 (D30; contract in design section 10)
-- ===========================================================================
-- Answers null ("not set up yet": the Home card shows its calm placeholder). Created only when absent, so it works
-- whichever of 5c and Day 6 merges first; Day 6 replaces it (create or replace, INVOKER, under stock RLS) with exactly
-- {low, out, deals_waiting, items: [{product_id, name, available, reorder_point, in_transit, next_eta, state}] (at most
-- 5)}; the purchase cost (PP) never appears in it.
do $$
begin
  if to_regprocedure('public.home_low_stock(integer)') is null then
    create function public.home_low_stock(p_limit integer default 5) returns jsonb
    language sql stable set search_path = '' as $f$
      select null::jsonb
    $f$;
    revoke all on function public.home_low_stock(integer) from public, anon;
    grant execute on function public.home_low_stock(integer) to authenticated;
  end if;
end;
$$;

-- ===========================================================================
-- Function privileges: the helpers are callable by signed-in people only (private has no API endpoint); every RPC is
-- revoked from public and anon and granted to authenticated (the Day 3a loop).
-- ===========================================================================
revoke all on function private.home_window(timestamptz, text), private.home_open_deals(uuid) from public, anon;
grant execute on function private.home_window(timestamptz, text), private.home_open_deals(uuid) to authenticated;
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.home_summary(text)',
    'public.home_attention(text, integer)',
    'public.home_recent_activity(text, integer)',
    'public.home_today_tasks(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
