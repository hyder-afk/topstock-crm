-- Bugs audit of 17 Oct 2026, finding M1: the board's "Longest in stage" sort did nothing (pipeline_board always read the
-- newest in stage first, and the board's cache key and "Show more" never carried the order). Sorts after
-- 20261023090000_security_digest, the newest on main. A read-only function only: no table, policy or check changes.
--
-- public.pipeline_board gains p_order ('recent', the default, or 'oldest'), forwarded to private.stage_deal_ids for the
-- open columns, so the first paint of each open column is the 50 deals longest in their stage and its cursor continues
-- in that order (list_stage_deals already takes p_order for "Show more"). The Won column stays newest close first, as
-- list_stage_deals does. Anything else is 22023 'bad_order', as list_stage_deals. Adding a parameter changes the
-- signature, so the old function is dropped first (one pipeline_board, never two overloads PostgREST would have to
-- choose between); its grants are made again (revoked from public and anon, executable by authenticated).
--
-- Redefines (REBASE when the named migration changes before this one merges):
--   public.pipeline_board (20261015090000_deals_pipeline.sql): its body verbatim plus p_order.

drop function public.pipeline_board(text, uuid, integer);

-- The board's first paint in one call (D21): the summary plus up to p_per_stage cards per open column (newest in stage
-- first, or longest in stage first with p_order 'oldest') and the Won column (last 30 days, newest first), each with the
-- cursor of its next page (null at the end). A rep asking for the team or a colleague silently gets their own deals here
-- only.
create function public.pipeline_board(p_scope text default 'team', p_owner uuid default null,
                                      p_per_stage integer default 50, p_order text default 'recent') returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_owner uuid;
  v_summary jsonb;
  v_stages jsonb := '[]'::jsonb;
  v_all uuid[] := '{}'::uuid[];
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
  if p_order is null or p_order not in ('recent', 'oldest') then
    raise exception 'unknown order' using errcode = '22023', hint = 'bad_order';
  end if;
  v_owner := private.deal_scope_owner(p_scope, p_owner, false);
  v_summary := private.pipeline_summary_for(v_owner);
  -- One index walk per column (one more row than shown tells whether a next page exists), then every card in one call.
  for s in select st.id, st.key from public.pipeline_stages st
            where st.org_id = (select private.current_org_id()) and st.key in ('lead', 'qualified', 'negotiations', 'won')
            order by st.position loop
    v_ids := private.stage_deal_ids(v_owner, s.id, case when s.key = 'won' then 'won' end,
                                    s.key <> 'won' and p_order = 'oldest', 'infinity'::timestamptz,
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
revoke all on function public.pipeline_board(text, uuid, integer, text) from public, anon;
grant execute on function public.pipeline_board(text, uuid, integer, text) to authenticated;
