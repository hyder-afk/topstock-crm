\set ON_ERROR_STOP 1
create table public.spike_deals (id uuid primary key, owner uuid not null, stage text not null, status text not null default 'open', version int not null default 0);
create table public.spike_hist (id bigint generated always as identity primary key, deal_id uuid not null references public.spike_deals(id),
  actor_id uuid, from_stage text, to_stage text not null, version_after int not null, created_at timestamptz not null default now());
alter table public.spike_deals enable row level security;
alter table public.spike_hist enable row level security;
create policy s on public.spike_deals for select to authenticated using (owner = (select auth.uid()));
create policy u on public.spike_deals for update to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy h on public.spike_hist for select to authenticated using (exists (select 1 from public.spike_deals d where d.id = spike_hist.deal_id));
grant select on public.spike_deals, public.spike_hist to authenticated;
grant update (stage) on public.spike_deals to authenticated;
create function private.spike_cand(p_deal uuid, p_from text, p_to text, p_old_version int) returns bigint
language sql stable set search_path = '' as $$
  select h.id from (select * from public.spike_hist x where x.deal_id = p_deal order by x.id desc limit 1) h
   where h.actor_id = (select auth.uid()) and h.created_at > now() - interval '120 seconds'
     and h.to_stage = p_from and h.from_stage = p_to and h.version_after = p_old_version $$;
grant execute on function private.spike_cand(uuid, text, text, int) to authenticated;
create function private.spike_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  raise notice 'S9 guard (INVOKER, role %) candidate=%', current_user, private.spike_cand(new.id, old.stage, new.stage, old.version);
  new.status := case new.stage when 'won' then 'won' when 'lost' then 'lost' else 'open' end;
  new.version := old.version + 1;
  return new;
end $$;
create function private.spike_hist_trg() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise notice 'S9 history (DEFINER, role %) candidate=%', current_user, private.spike_cand(new.id, old.stage, new.stage, old.version);
  insert into public.spike_hist (deal_id, actor_id, from_stage, to_stage, version_after) values (new.id, (select auth.uid()), old.stage, new.stage, new.version);
  return null;
end $$;
create function private.spike_probe() returns trigger language plpgsql set search_path = '' as $$
begin raise notice 'S9 probe fired: %', tg_name; return null; end $$;
create trigger guard_deal before update on public.spike_deals for each row execute function private.spike_guard();
create trigger history_stage after update of stage on public.spike_deals for each row when (old.stage is distinct from new.stage) execute function private.spike_hist_trg();
create trigger probe_update_of_status after update of status on public.spike_deals for each row execute function private.spike_probe();
create trigger probe_when_status after update on public.spike_deals for each row when (old.status is distinct from new.status) execute function private.spike_probe();
insert into public.spike_deals values ('40000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'negotiations');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","aal":"aal2"}', false) \g /dev/null
\echo '--- move negotiations -> won (client sets stage only; guard sets status)'
update public.spike_deals set stage = 'won' where id = '40000000-0000-0000-0000-0000000000f1';
\echo '--- reverse won -> negotiations by the same person within 120 s (expect both candidates = the won row)'
update public.spike_deals set stage = 'negotiations' where id = '40000000-0000-0000-0000-0000000000f1';
\echo '--- an update that does not name stage (value unchanged): no history trigger'
update public.spike_deals set stage = stage where id = '40000000-0000-0000-0000-0000000000f1';
reset role;
select 'history rows: ' || string_agg(from_stage || '->' || to_stage || ' v' || version_after, ', ' order by id) from public.spike_hist;
drop table public.spike_hist, public.spike_deals;
drop function private.spike_cand(uuid, text, text, int), private.spike_guard(), private.spike_hist_trg(), private.spike_probe();
