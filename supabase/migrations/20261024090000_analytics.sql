-- Analytics v1, P1 (design docs/evidence/analytics/design.md sections 1, 3.1 to 3.4 and 3.8): the database half of the
-- Analytics page. Read-only: no tables, no views, no materialised views, no triggers. The file name sorts after main's
-- newest migration; it is renamed at merge time if main moves (D35, scripts/check-migration-order.sh). In plain words:
--  - seven functions, one per block of the page (activity, pipeline, speed-to-lead, best time to call, sales, coverage,
--    list quality per import); each answers totals and buckets as jsonb, never rows of leads, entries or sales;
--  - two helpers from the design (who the figures are for; the date range as instants) plus one that lists the buckets,
--    and four source helpers (one per source table), so the team and person statements are separate, each with a fixed
--    index condition, and every block function reads its source rows once (one pass, design 3.7);
--  - activities_no_author_idx, so the team totals include a deleted author's entries without a full scan.
-- House rules (design 3.1): every function is SECURITY INVOKER with static SQL (no dynamic statements, no string
-- building), set search_path = '' and plan_cache_mode = force_custom_plan, so row level security decides every row a
-- figure counts and each call is planned for its own range. Two-factor sign-in is required (42501 'forbidden'). A rep
-- always gets their own figures (42501 'scope' when asking for a colleague's); managers and admins get the team (p_user
-- null) or one member of their organisation (P0002 'rep' for anyone else). Ranges are Paris dates: from 00:00 Paris on
-- the first day to 00:00 Paris after the last (a 23 or 25 hour day stays one day), at most 366 days, never after Paris
-- today (22023 'bounds'). No entry text, lost note, cancel reason, sale note or cost is ever read. deals.value is summed,
-- never compared (the Day 5a leakproof rule). What the role rule protects (design 3.2): per-person deal and sale figures
-- are locked by row level security; per-person activity and lead counts are a product rule only (activities and leads
-- are readable by the whole organisation).

-- ===========================================================================
-- Part 1. Shared helpers (design 3.2)
-- ===========================================================================
-- Who the figures are for. null = the whole team (managers and admins only); a rep always gets their own id.
create function private.analytics_owner(p_user uuid) returns uuid
language plpgsql stable security invoker set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if (select private.is_manager_or_admin()) then
    -- profiles row level security shows the caller's organisation only: anyone else is "no such member".
    if p_user is not null and not exists (select 1 from public.profiles p where p.id = p_user) then
      raise exception 'no such team member' using errcode = 'P0002', hint = 'rep';
    end if;
    return p_user;
  end if;
  if p_user is not null and p_user <> caller then
    raise exception 'only managers and admins see a colleague''s figures' using errcode = '42501', hint = 'scope';
  end if;
  return caller;
end;
$$;

-- The range as instants and the bucket size; refuses a bad range (22023 'bounds'). Ranges of 31 days or fewer use day
-- buckets, longer ones ISO weeks (Monday start).
create function private.analytics_window(p_from date, p_to date)
returns table (t_from timestamptz, t_to timestamptz, bucket text)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 365
     or p_to > (now() at time zone 'Europe/Paris')::date then
    raise exception 'the range must be 1 to 366 days, ending today at the latest' using errcode = '22023', hint = 'bounds';
  end if;
  return query
    select p_from::timestamp at time zone 'Europe/Paris',
           (p_to + 1)::timestamp at time zone 'Europe/Paris',
           case when p_to - p_from < 31 then 'day' else 'week' end;
end;
$$;

-- Every bucket of a range, empty ones included, so charts never skip a day: days, or ISO weeks from the Monday of the
-- first day's week; a week that starts before the first day or ends after the last is partial.
create function private.analytics_buckets(p_from date, p_to date, p_bucket text)
returns table (start date, partial boolean)
language sql immutable security invoker set search_path = '' as $$
  select g::date,
         p_bucket = 'week' and (g::date < p_from or g::date + 6 > p_to)
    from generate_series(case when p_bucket = 'week' then date_trunc('week', p_from::timestamp) else p_from::timestamp end,
                         p_to::timestamp,
                         case when p_bucket = 'week' then interval '7 days' else interval '1 day' end) as g
$$;

-- ===========================================================================
-- Part 2. Source helpers: one per source table, team and person as separate statements (design 3.3)
-- ===========================================================================
-- Entries in [p_from, p_to): the person's (activities_user_created_idx), or the team's: one index range per member of
-- the organisation (profiles row level security), as home_summary does, plus entries whose author was deleted
-- (user_id null, activities_no_author_idx). Notes are never activity. p_calls_only: calls only (best time to call).
create function private.analytics_activity_rows(p_owner uuid, p_from timestamptz, p_to timestamptz, p_calls_only boolean)
returns table (r_user uuid, r_type text, r_outcome text, r_at timestamptz)
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = force_custom_plan as $$
begin
  if p_owner is not null then
    return query
      select x.user_id, x.type, x.outcome, x.created_at
        from public.activities x
       where x.user_id = p_owner and x.created_at >= p_from and x.created_at < p_to
         and x.type <> 'note' and (not p_calls_only or x.type = 'call');
  else
    return query
      select a.user_id, a.type, a.outcome, a.created_at
        from public.profiles pr
        cross join lateral (select x.user_id, x.type, x.outcome, x.created_at
                              from public.activities x
                             where x.user_id = pr.id and x.created_at >= p_from and x.created_at < p_to
                               and x.type <> 'note' and (not p_calls_only or x.type = 'call')) a
      union all
      select x.user_id, x.type, x.outcome, x.created_at
        from public.activities x
       where x.user_id is null and x.org_id = (select private.current_org_id())
         and x.created_at >= p_from and x.created_at < p_to
         and x.type <> 'note' and (not p_calls_only or x.type = 'call');
  end if;
end;
$$;

-- Deals in scope that the pipeline block reads: opened in the range, closed in the range, or with a stage change in the
-- range (days in stage). Scope: the person's deals (current owner) or the organisation's; row level security also
-- limits a rep to their own deals.
create function private.analytics_deal_rows(p_owner uuid, p_from timestamptz, p_to timestamptz)
returns table (d_id uuid, d_owner uuid, d_status text, d_value numeric, d_created timestamptz, d_closed timestamptz,
               d_reason text)
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  v_org constant uuid := (select private.current_org_id());
begin
  if p_owner is not null then
    return query
      select d.id, d.owner_id, d.status, d.value, d.created_at, d.closed_at, d.lost_reason
        from public.deals d
       where d.owner_id = p_owner
         and ((d.created_at >= p_from and d.created_at < p_to)
              or (d.status <> 'open' and d.closed_at >= p_from and d.closed_at < p_to)
              or d.id in (select h.deal_id from public.deal_stage_history h
                           where h.org_id = v_org and h.created_at >= p_from and h.created_at < p_to));
  else
    return query
      select d.id, d.owner_id, d.status, d.value, d.created_at, d.closed_at, d.lost_reason
        from public.deals d
       where d.org_id = v_org
         and ((d.created_at >= p_from and d.created_at < p_to)
              or (d.status <> 'open' and d.closed_at >= p_from and d.closed_at < p_to)
              or d.id in (select h.deal_id from public.deal_stage_history h
                           where h.org_id = v_org and h.created_at >= p_from and h.created_at < p_to));
  end if;
end;
$$;

-- Leads added by hand (import_batch_id null) created in the range: the person's (lead owner) or the organisation's.
create function private.analytics_lead_rows(p_owner uuid, p_from timestamptz, p_to timestamptz)
returns table (l_id uuid, l_created timestamptz)
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  v_org constant uuid := (select private.current_org_id());
begin
  if p_owner is not null then
    return query
      select c.id, c.created_at
        from public.companies c
       where c.org_id = v_org and c.owner_id = p_owner and c.created_at >= p_from and c.created_at < p_to
         and c.import_batch_id is null;
  else
    return query
      select c.id, c.created_at
        from public.companies c
       where c.org_id = v_org and c.created_at >= p_from and c.created_at < p_to and c.import_batch_id is null;
  end if;
end;
$$;

-- Confirmed sales created in the range, one row per line (an order without lines keeps one row with null line
-- columns): the ones the person recorded (created_by, as list_sales(p_user)) or the organisation's. Row level security
-- limits a rep to sales they recorded or on leads they own.
create function private.analytics_sale_lines(p_owner uuid, p_from timestamptz, p_to timestamptz)
returns table (o_id uuid, o_at timestamptz, o_fulfilment text, l_id uuid, l_name text, l_qty integer, l_total numeric)
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = force_custom_plan as $$
begin
  if p_owner is not null then
    return query
      select o.id, o.created_at, o.fulfilment, l.id, l.product_name, l.quantity, l.line_total
        from private.orders o
        left join private.order_lines l on l.order_id = o.id
       where o.created_by = p_owner and o.created_at >= p_from and o.created_at < p_to and o.status = 'confirmed';
  else
    return query
      select o.id, o.created_at, o.fulfilment, l.id, l.product_name, l.quantity, l.line_total
        from private.orders o
        left join private.order_lines l on l.order_id = o.id
       where o.org_id = (select private.current_org_id()) and o.created_at >= p_from and o.created_at < p_to
         and o.status = 'confirmed';
  end if;
end;
$$;

-- ===========================================================================
-- Part 3. The seven blocks (design 1.1 to 1.7, 3.3)
-- ===========================================================================
-- 1.1 Activity: per bucket calls, reached calls, emails, WhatsApp messages and meetings; totals (and meetings held);
-- the team view adds one row per person (user_id null: former team members). "Reached" is Home's K4 list.
create function public.analytics_activity(p_from date, p_to date, p_user uuid default null) returns jsonb
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  v_owner uuid;
  w record;
  v jsonb;
begin
  v_owner := private.analytics_owner(p_user);
  select * into w from private.analytics_window(p_from, p_to);
  with a as materialized (
    select r.r_user, r.r_type, r.r_outcome,
           case when w.bucket = 'day' then (r.r_at at time zone 'Europe/Paris')::date
                else date_trunc('week', r.r_at at time zone 'Europe/Paris')::date end as b
      from private.analytics_activity_rows(v_owner, w.t_from, w.t_to, false) r),
  g as (
    select a.b,
           count(*) filter (where a.r_type = 'call') as calls,
           count(*) filter (where a.r_type = 'call'
                              and a.r_outcome in ('connected', 'interested', 'meeting_booked', 'not_interested', 'do_not_contact')) as reached,
           count(*) filter (where a.r_type = 'email') as emails,
           count(*) filter (where a.r_type = 'whatsapp') as whatsapp,
           count(*) filter (where a.r_type = 'meeting') as meetings,
           count(*) filter (where a.r_type = 'meeting' and a.r_outcome = 'held') as held
      from a group by a.b),
  p as (
    select a.r_user,
           count(*) filter (where a.r_type = 'call') as calls,
           count(*) filter (where a.r_type = 'call'
                              and a.r_outcome in ('connected', 'interested', 'meeting_booked', 'not_interested', 'do_not_contact')) as reached,
           count(*) filter (where a.r_type = 'email') as emails,
           count(*) filter (where a.r_type = 'whatsapp') as whatsapp,
           count(*) filter (where a.r_type = 'meeting') as meetings
      from a group by a.r_user)
  select jsonb_build_object(
           'scope', case when v_owner is null then 'team' else 'person' end,
           'owner_id', v_owner,
           'bucket', w.bucket,
           'buckets', (select jsonb_agg(jsonb_build_object(
                                 'start', s.start, 'partial', s.partial,
                                 'calls', coalesce(g.calls, 0), 'reached', coalesce(g.reached, 0),
                                 'emails', coalesce(g.emails, 0), 'whatsapp', coalesce(g.whatsapp, 0),
                                 'meetings', coalesce(g.meetings, 0)) order by s.start)
                         from private.analytics_buckets(p_from, p_to, w.bucket) s left join g on g.b = s.start),
           'totals', (select jsonb_build_object(
                               'calls', coalesce(sum(g.calls), 0)::bigint, 'reached', coalesce(sum(g.reached), 0)::bigint,
                               'emails', coalesce(sum(g.emails), 0)::bigint, 'whatsapp', coalesce(sum(g.whatsapp), 0)::bigint,
                               'meetings', coalesce(sum(g.meetings), 0)::bigint,
                               'meetings_held', coalesce(sum(g.held), 0)::bigint)
                        from g))
         || case when v_owner is null then jsonb_build_object(
              'by_person', (select coalesce(jsonb_agg(jsonb_build_object(
                                      'user_id', p.r_user, 'calls', p.calls, 'reached', p.reached, 'emails', p.emails,
                                      'whatsapp', p.whatsapp, 'meetings', p.meetings) order by p.r_user nulls last), '[]'::jsonb)
                              from p))
            else '{}'::jsonb end
    into v;
  return v;
end;
$$;

-- 1.2 Pipeline: opened, won, lost (Opened by mistake apart), win rate (from 5 closed deals), cycle (median from 3 won
-- deals), the funnel of the deals opened in the range, days in stage, lost reasons, and per owner in the team view.
-- Only non-undone history rows count: a row is undone when it is an undo row or another row undoes it.
create function public.analytics_pipeline(p_from date, p_to date, p_user uuid default null) returns jsonb
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  v_owner uuid;
  w record;
  v jsonb;
begin
  v_owner := private.analytics_owner(p_user);
  select * into w from private.analytics_window(p_from, p_to);
  with d as materialized (
    select r.*,
           r.d_created >= w.t_from and r.d_created < w.t_to as opened,
           r.d_status <> 'open' and r.d_closed >= w.t_from and r.d_closed < w.t_to as closed
      from private.analytics_deal_rows(v_owner, w.t_from, w.t_to) r),
  h as materialized (
    select x.deal_id, x.id, x.kind, x.to_stage, x.created_at
      from d join public.deal_stage_history x on x.deal_id = d.d_id
     where x.kind <> 'undo'
       and not exists (select 1 from public.deal_stage_history u where u.undoes = x.id)),
  -- Funnel rules: an open or move row reaches its stage and every earlier open stage (lead 1, qualified 2,
  -- negotiations 3); a won row or the current status won reaches all three and Won; lost and reopen rows reach nothing.
  f as (
    select d.d_id, d.d_status, d.d_reason,
           coalesce(max(case when h.kind in ('open', 'move') then
                          case h.to_stage when 'lead' then 1 when 'qualified' then 2 when 'negotiations' then 3 end end), 0) as reach,
           coalesce(bool_or(h.kind = 'won'), false) or d.d_status = 'won' as won
      from d left join h on h.deal_id = d.d_id
     where d.opened
     group by d.d_id, d.d_status, d.d_reason),
  fx as (select f.*, case when f.won then 4 else f.reach end as reach_all from f),
  sd as (
    select n.to_stage, extract(epoch from n.next_at - n.created_at) / 86400 as days
      from (select h.to_stage, h.created_at, lead(h.created_at) over (partition by h.deal_id order by h.id) as next_at
              from h) n
     where n.next_at >= w.t_from and n.next_at < w.t_to and n.to_stage in ('lead', 'qualified', 'negotiations')),
  cyc as (
    select extract(epoch from d.d_closed - d.d_created) / 86400 as days
      from d where d.closed and d.d_status = 'won')
  select jsonb_build_object(
    'opened', (select jsonb_build_object('count', count(*), 'value', coalesce(sum(d.d_value), 0)::numeric(16, 2)::text,
                                         'no_value', count(*) filter (where d.d_value is null))
                 from d where d.opened),
    'won', (select jsonb_build_object('count', count(*), 'value', coalesce(sum(d.d_value), 0)::numeric(16, 2)::text)
              from d where d.closed and d.d_status = 'won'),
    'lost', (select jsonb_build_object('count', count(*) filter (where d.d_reason <> 'mistake'),
                                       'mistake', count(*) filter (where d.d_reason = 'mistake'))
               from d where d.closed and d.d_status = 'lost'),
    'win_rate', (select jsonb_build_object('won', x.won, 'lost', x.lost,
                                           'rate', case when x.won + x.lost >= 5 then round(x.won::numeric / (x.won + x.lost), 4) end)
                   from (select count(*) filter (where d.d_status = 'won') as won,
                                count(*) filter (where d.d_status = 'lost' and d.d_reason <> 'mistake') as lost
                           from d where d.closed) x),
    'cycle', (select jsonb_build_object(
                       'n', count(*),
                       'median_days', case when count(*) >= 3 then round((percentile_cont(0.5) within group (order by cyc.days))::numeric, 1) end,
                       'mean_days', case when count(*) >= 3 then round(avg(cyc.days)::numeric, 1) end)
                from cyc),
    'funnel', (select jsonb_build_object(
                        'cohort', count(*),
                        'lead', count(*) filter (where fx.reach_all >= 1),
                        'qualified', count(*) filter (where fx.reach_all >= 2),
                        'negotiations', count(*) filter (where fx.reach_all >= 3),
                        'won', count(*) filter (where fx.won),
                        'still_open', count(*) filter (where fx.d_status = 'open'),
                        'lost', count(*) filter (where fx.d_status = 'lost' and fx.d_reason <> 'mistake'),
                        'mistake', count(*) filter (where fx.d_status = 'lost' and fx.d_reason = 'mistake'))
                 from fx),
    'stage_days', (select jsonb_agg(jsonb_build_object(
                            'key', k.key, 'n', coalesce(s.n, 0),
                            'median_days', round(s.median::numeric, 1)) order by k.pos)
                     from (values ('lead', 1), ('qualified', 2), ('negotiations', 3)) as k (key, pos)
                     left join (select sd.to_stage, count(*) as n,
                                       percentile_cont(0.5) within group (order by sd.days) as median
                                  from sd group by sd.to_stage) s on s.to_stage = k.key),
    'lost_reasons', (select coalesce(jsonb_agg(jsonb_build_object('code', r.code, 'count', r.n) order by r.n desc, r.code), '[]'::jsonb)
                       from (select d.d_reason as code, count(*) as n from d
                              where d.closed and d.d_status = 'lost' and d.d_reason <> 'mistake'
                              group by d.d_reason) r))
    || case when v_owner is null then jsonb_build_object(
         'by_person', (select coalesce(jsonb_agg(jsonb_build_object(
                                 'user_id', x.d_owner, 'opened', x.opened, 'won', x.won, 'won_value', x.won_value,
                                 'lost', x.lost,
                                 'rate', case when x.won + x.lost >= 5 then round(x.won::numeric / (x.won + x.lost), 4) end)
                                 order by x.d_owner), '[]'::jsonb)
                         from (select d.d_owner,
                                      count(*) filter (where d.opened) as opened,
                                      count(*) filter (where d.closed and d.d_status = 'won') as won,
                                      coalesce(sum(d.d_value) filter (where d.closed and d.d_status = 'won'), 0)::numeric(16, 2)::text as won_value,
                                      count(*) filter (where d.closed and d.d_status = 'lost' and d.d_reason <> 'mistake') as lost
                                 from d where d.d_owner is not null and (d.opened or d.closed)
                                group by d.d_owner) x))
       else '{}'::jsonb end
    into v;
  return v;
end;
$$;

-- 1.3 Speed-to-lead: leads added by hand in the range; first touch = the earliest call, email, WhatsApp message or
-- meeting on the lead at or after its creation, by anyone (activities_company_keyset_idx); wall-clock minutes.
create function public.analytics_speed(p_from date, p_to date, p_user uuid default null) returns jsonb
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  v_owner uuid;
  w record;
  v jsonb;
begin
  v_owner := private.analytics_owner(p_user);
  select * into w from private.analytics_window(p_from, p_to);
  with c as materialized (
    select l.l_id, extract(epoch from ft.at - l.l_created) / 60 as mins
      from private.analytics_lead_rows(v_owner, w.t_from, w.t_to) l
      left join lateral (select x.created_at as at
                           from public.activities x
                          where x.company_id = l.l_id and x.created_at >= l.l_created
                            and x.type in ('call', 'email', 'whatsapp', 'meeting')
                          order by x.created_at
                          limit 1) ft on true)
  select jsonb_build_object(
           'leads', count(*),
           'touched', count(c.mins),
           'median_minutes', round((percentile_cont(0.5) within group (order by c.mins))::numeric)::bigint,
           'within_1h', count(*) filter (where c.mins < 60),
           'within_24h', count(*) filter (where c.mins < 1440),
           'buckets', jsonb_build_array(
             jsonb_build_object('key', 'lt1h', 'count', count(*) filter (where c.mins < 60)),
             jsonb_build_object('key', 'lt24h', 'count', count(*) filter (where c.mins >= 60 and c.mins < 1440)),
             jsonb_build_object('key', 'lt3d', 'count', count(*) filter (where c.mins >= 1440 and c.mins < 4320)),
             jsonb_build_object('key', 'gte3d', 'count', count(*) filter (where c.mins >= 4320)),
             jsonb_build_object('key', 'none', 'count', count(*) filter (where c.mins is null))))
    into v
    from c;
  return v;
end;
$$;

-- 1.6 Best time to call: weekday (ISO 1 = Monday) x hour of the call in Paris time; only cells with calls.
create function public.analytics_call_times(p_from date, p_to date, p_user uuid default null) returns jsonb
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  v_owner uuid;
  w record;
  v jsonb;
begin
  v_owner := private.analytics_owner(p_user);
  select * into w from private.analytics_window(p_from, p_to);
  select jsonb_build_object(
           'min_calls', 5,
           'cells', coalesce(jsonb_agg(jsonb_build_object('dow', c.dow, 'hour', c.hr, 'calls', c.calls, 'reached', c.reached)
                                       order by c.dow, c.hr), '[]'::jsonb))
    into v
    from (select a.dow, a.hr, count(*) as calls,
                 count(*) filter (where a.r_outcome in ('connected', 'interested', 'meeting_booked', 'not_interested', 'do_not_contact')) as reached
            from (select extract(isodow from r.r_at at time zone 'Europe/Paris')::integer as dow,
                         extract(hour from r.r_at at time zone 'Europe/Paris')::integer as hr,
                         r.r_outcome
                    from private.analytics_activity_rows(v_owner, w.t_from, w.t_to, true) r) a
           group by a.dow, a.hr) c;
  return v;
end;
$$;

-- 1.7 Sales: revenue (sum of line totals, excluding VAT) and sales per bucket of confirmed sales; totals with the split
-- by fulfilment (revenue); top 10 products by revenue, grouped by lower(product_name) whether or not the line names a
-- product, shown with the spelling on the newest sale. Cancelled (and undone) sales are left out.
create function public.analytics_sales(p_from date, p_to date, p_user uuid default null) returns jsonb
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  v_owner uuid;
  w record;
  v jsonb;
begin
  v_owner := private.analytics_owner(p_user);
  select * into w from private.analytics_window(p_from, p_to);
  with s as materialized (
    select r.*,
           case when w.bucket = 'day' then (r.o_at at time zone 'Europe/Paris')::date
                else date_trunc('week', r.o_at at time zone 'Europe/Paris')::date end as b
      from private.analytics_sale_lines(v_owner, w.t_from, w.t_to) r),
  o as (select s.o_id, s.b, s.o_fulfilment, coalesce(sum(s.l_total), 0) as revenue from s group by s.o_id, s.b, s.o_fulfilment),
  g as (select o.b, sum(o.revenue) as revenue, count(*) as sales from o group by o.b),
  t as (select (array_agg(s.l_name order by s.o_at desc, s.l_id desc))[1] as name,
               sum(s.l_total) as revenue, sum(s.l_qty) as pieces, lower(s.l_name) as k
          from s where s.l_id is not null
         group by lower(s.l_name)
         order by sum(s.l_total) desc, lower(s.l_name)
         limit 10)
  select jsonb_build_object(
           'bucket', w.bucket,
           'buckets', (select jsonb_agg(jsonb_build_object(
                                 'start', x.start, 'partial', x.partial,
                                 'revenue', coalesce(g.revenue, 0)::numeric(16, 2)::text, 'sales', coalesce(g.sales, 0))
                               order by x.start)
                         from private.analytics_buckets(p_from, p_to, w.bucket) x left join g on g.b = x.start),
           'totals', (select jsonb_build_object(
                               'revenue', coalesce(sum(o.revenue), 0)::numeric(16, 2)::text,
                               'sales', count(*),
                               'from_stock', coalesce(sum(o.revenue) filter (where o.o_fulfilment = 'from_stock'), 0)::numeric(16, 2)::text,
                               'direct', coalesce(sum(o.revenue) filter (where o.o_fulfilment = 'direct_from_source'), 0)::numeric(16, 2)::text)
                        from o),
           'top_products', (select coalesce(jsonb_agg(jsonb_build_object(
                                      'name', t.name, 'revenue', t.revenue::numeric(16, 2)::text, 'pieces', t.pieces)
                                    order by t.revenue desc, t.k), '[]'::jsonb)
                              from t))
    into v;
  return v;
end;
$$;

-- 1.4 Coverage (right now, not the range): untouched leads (exactly private.lead_filter_sql's inactive-days rule, so the
-- count equals the Leads list's count), never contacted, warm or negotiation leads with no next step, overdue tasks.
create function public.analytics_coverage(p_user uuid default null, p_idle_days integer default 30) returns jsonb
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  v_owner uuid;
  v_org uuid;
  v_today date;
  v_leads jsonb;
  v_tasks bigint;
begin
  v_owner := private.analytics_owner(p_user);
  if p_idle_days is null or p_idle_days not in (7, 30, 90) then
    raise exception 'untouched days are 7, 30 or 90' using errcode = '22023', hint = 'bounds';
  end if;
  v_org := (select private.current_org_id());
  v_today := (now() at time zone 'Europe/Paris')::date;
  if v_owner is not null then
    with c as materialized (
      select c.last_activity_at,
             case when c.lead_status in ('warm', 'negotiation') and c.next_action_at is null
                  then not exists (select 1 from public.tasks t
                                    where t.company_id = c.id and t.done_at is null and t.cancelled_at is null)
                  else false end as no_step
        from public.companies c
       where c.org_id = v_org and c.owner_id = v_owner and c.lead_status in ('cold', 'warm', 'negotiation'))
    select jsonb_build_object(
             'untouched', count(*) filter (where c.last_activity_at is null
                                              or c.last_activity_at < now() - make_interval(days => p_idle_days)),
             'never_contacted', count(*) filter (where c.last_activity_at is null),
             'no_next_step', count(*) filter (where c.no_step))
      into v_leads from c;
    select count(*) into v_tasks
      from public.tasks t
     where t.assignee_id = v_owner and t.done_at is null and t.cancelled_at is null
       and (t.due_at < now() or t.due_date < v_today);
  else
    with c as materialized (
      select c.last_activity_at,
             case when c.lead_status in ('warm', 'negotiation') and c.next_action_at is null
                  then not exists (select 1 from public.tasks t
                                    where t.company_id = c.id and t.done_at is null and t.cancelled_at is null)
                  else false end as no_step
        from public.companies c
       where c.org_id = v_org and c.lead_status in ('cold', 'warm', 'negotiation'))
    select jsonb_build_object(
             'untouched', count(*) filter (where c.last_activity_at is null
                                              or c.last_activity_at < now() - make_interval(days => p_idle_days)),
             'never_contacted', count(*) filter (where c.last_activity_at is null),
             'no_next_step', count(*) filter (where c.no_step))
      into v_leads from c;
    select count(*) into v_tasks
      from public.tasks t
     where t.org_id = v_org and t.done_at is null and t.cancelled_at is null
       and (t.due_at < now() or t.due_date < v_today);
  end if;
  return jsonb_build_object('idle_days', p_idle_days) || v_leads
         || jsonb_build_object('overdue_tasks', v_tasks, 'as_of', now());
end;
$$;

-- 1.5 List quality per import (admins only: import batches are admin-only under row level security): the newest
-- imported lead batches; per batch the leads in it now and how many were contacted, reached, got a deal and won one.
-- Only entries and deals created at or after the batch count (history from before the import never inflates it).
create function public.analytics_batches(p_user uuid default null, p_limit integer default 20) returns jsonb
language plpgsql stable security invoker set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  v_owner uuid;
  v jsonb;
begin
  if (select auth.uid()) is null or not (select private.has_aal2()) or not (select private.is_admin()) then
    raise exception 'list quality is for admins' using errcode = '42501', hint = 'forbidden';
  end if;
  v_owner := private.analytics_owner(p_user);
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'between 1 and 50 imports' using errcode = '22023', hint = 'bounds';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
                    'id', b.id, 'filename', b.filename, 'created_at', b.created_at, 'leads', q.leads,
                    'contacted', q.contacted, 'reached', q.reached, 'with_deal', q.with_deal, 'won', q.won)
                  order by b.created_at desc, b.id desc), '[]'::jsonb)
    into v
    from (select ib.id, ib.filename, ib.created_at
            from public.import_batches ib
           where ib.org_id = (select private.current_org_id()) and ib.kind = 'leads' and ib.status = 'imported'
           order by ib.created_at desc, ib.id desc
           limit p_limit) b
    cross join lateral (
      select count(*) as leads,
             count(*) filter (where e.touched) as contacted,
             count(*) filter (where e.reached) as reached,
             count(*) filter (where k.any_deal) as with_deal,
             count(*) filter (where k.any_won) as won
        from public.companies c
        cross join lateral (
          select coalesce(bool_or(x.type in ('call', 'email', 'whatsapp', 'meeting')), false) as touched,
                 coalesce(bool_or(x.type = 'call'
                                  and x.outcome in ('connected', 'interested', 'meeting_booked', 'not_interested', 'do_not_contact')), false) as reached
            from public.activities x
           where x.company_id = c.id and x.created_at >= b.created_at) e
        cross join lateral (
          select count(*) > 0 as any_deal, coalesce(bool_or(dd.status = 'won'), false) as any_won
            from public.deals dd
           where dd.company_id = c.id and dd.created_at >= b.created_at) k
       where c.import_batch_id = b.id and (v_owner is null or c.owner_id = v_owner)) q;
  return v;
end;
$$;

-- ===========================================================================
-- Part 4. Index (design 3.4): a deleted author's entries for the team totals, without a full scan
-- ===========================================================================
create index activities_no_author_idx on public.activities (org_id, created_at) where user_id is null;

-- ===========================================================================
-- Function privileges: helpers callable by signed-in people only (private has no API endpoint); every RPC revoked from
-- public and anon and granted to authenticated (the Day 3a loop).
-- ===========================================================================
revoke all on function private.analytics_owner(uuid), private.analytics_window(date, date),
  private.analytics_buckets(date, date, text),
  private.analytics_activity_rows(uuid, timestamptz, timestamptz, boolean),
  private.analytics_deal_rows(uuid, timestamptz, timestamptz),
  private.analytics_lead_rows(uuid, timestamptz, timestamptz),
  private.analytics_sale_lines(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function private.analytics_owner(uuid), private.analytics_window(date, date),
  private.analytics_buckets(date, date, text),
  private.analytics_activity_rows(uuid, timestamptz, timestamptz, boolean),
  private.analytics_deal_rows(uuid, timestamptz, timestamptz),
  private.analytics_lead_rows(uuid, timestamptz, timestamptz),
  private.analytics_sale_lines(uuid, timestamptz, timestamptz) to authenticated;
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.analytics_activity(date, date, uuid)',
    'public.analytics_pipeline(date, date, uuid)',
    'public.analytics_speed(date, date, uuid)',
    'public.analytics_call_times(date, date, uuid)',
    'public.analytics_sales(date, date, uuid)',
    'public.analytics_coverage(uuid, integer)',
    'public.analytics_batches(uuid, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
