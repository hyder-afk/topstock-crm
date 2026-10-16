-- Day 7 follow-up (Day 5 design line 1070; decision row 15 Oct 2026 in docs/log.md): the deal sheet leaves out Reopen
-- and Delete while stock records hold the deal, and Delete once the creator's 120 s window is over. The database keeps
-- refusing both exactly as before (private.deal_guard, public.delete_deal, the block_deal_delete_on_stock trigger and
-- deals_delete are unchanged); this only tells the sheet in advance. Read-only: no table, policy or check changes.
--
-- * private.deal_held_by_stock(p_deal) returns boolean: whether a confirmed sale or an active hold names the deal
--   (private.deal_stock_records, the same answer the delete trigger uses, so an open deal whose shipping is not chosen
--   yet counts too). SECURITY DEFINER, owned by postgres, search_path '': like private.deal_closing_blocked, it must see
--   a manager's sale that a rep's row level security hides, and it answers null for another organisation's caller (no
--   probing by id). Executable by authenticated only, because get_deal runs as the caller; the private schema has no
--   API endpoint.
-- * public.get_deal gains two keys:
--     stock_held    boolean, as above (false when nothing holds the deal);
--     delete_until  the end of the creator's no-code window (created_at + 120 s, deals_delete's second branch) when
--                   the caller created the deal and is not an admin; null otherwise (an admin's Delete has no time
--                   limit, and anyone else is not offered Delete: can_delete).
--
-- Redefines (REBASE when the named migration changes before this one merges):
--   public.get_deal (20261015090000_deals_pipeline.sql): its body verbatim plus the two keys at the end.

create function private.deal_held_by_stock(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.deal_stock_records(d.id) is not null
    from public.deals d
   where d.id = p_deal
     and ((select auth.uid()) is null or d.org_id = (select private.current_org_id()))
$$;
alter function private.deal_held_by_stock(uuid) owner to postgres;
revoke all on function private.deal_held_by_stock(uuid) from public, anon;
grant execute on function private.deal_held_by_stock(uuid) to authenticated;

-- One deal for the deal sheet; null when it is missing or not visible. Activities are listed without their text.
-- can_edit and can_delete come from the card (private.deal_cards).
create or replace function public.get_deal(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select private.deal_card(d.id) || jsonb_build_object(
    'lead', jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city, 'country', c.country,
                               'lead_status', c.lead_status,
                               'can_edit', (select private.is_manager_or_admin()) or c.owner_id = (select auth.uid())),
    'contact', case when k.id is not null then jsonb_build_object('id', k.id, 'first_name', k.first_name,
                                                                  'last_name', k.last_name) end,
    'owner', case when o.id is not null then jsonb_build_object('id', o.id, 'first_name', o.first_name,
                                                                'last_name', o.last_name) end,
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
        left join public.profiles p on p.id = a.user_id), '[]'::jsonb),
    -- Day 7: what the sheet needs to leave out actions the database would refuse (it still refuses them).
    'stock_held', coalesce(private.deal_held_by_stock(d.id), false),
    'delete_until', case when d.created_by = (select auth.uid()) and not (select private.is_admin())
                         then d.created_at + interval '120 seconds' end)
  from public.deals d
  join public.pipeline_stages s on s.id = d.stage_id
  join public.companies c on c.id = d.company_id
  left join public.contacts k on k.id = d.contact_id
  left join public.profiles o on o.id = d.owner_id
  where d.id = p_id
$$;
