-- Day 7a: Gate 1 security fixes that do not depend on Day 6 (docs/evidence/day7/plan.md step 7a; Haider 15 Oct 2026,
-- "A, all yes": record each sign-in without an IP address; fix the same-organisation owner check now).
-- Sorts after Day 6's last migration (20261020100000_deal_stock_blocks) so it applies last once both are on main.
-- Tests: supabase/tests/day7a_attack.sql (and the catalog-driven anon sweep in rls_attack.sql section 1).

-- ---------------------------------------------------------------------------
-- 1. An owner chosen by a manager or an admin belongs to the record's organisation, as a database rule.
-- ---------------------------------------------------------------------------
-- private.enforce_org_and_owner already refuses an owner from another organisation on every signed-in write (since
-- 20261010090000; the Day 5 review read the core version, which did not). It skips sessions with no signed-in user
-- (imports, maintenance, service paths) by design. These composite foreign keys hold the same rule for every path: a
-- lead's owner, a deal's owner and a task's assignee must be a profile of the row's own organisation. MATCH SIMPLE: a
-- row with no owner passes. Deleting a profile still empties the owner only (the single-column keys do the same).
alter table public.profiles add constraint profiles_id_org_key unique (id, org_id);
alter table public.companies add constraint companies_owner_same_org
  foreign key (owner_id, org_id) references public.profiles (id, org_id) on delete set null (owner_id);
alter table public.deals add constraint deals_owner_same_org
  foreign key (owner_id, org_id) references public.profiles (id, org_id) on delete set null (owner_id);
alter table public.tasks add constraint tasks_assignee_same_org
  foreign key (assignee_id, org_id) references public.profiles (id, org_id) on delete set null (assignee_id);

-- ---------------------------------------------------------------------------
-- 2. Sign-ins in the audit log (who and when; no IP address, no email, no details).
-- ---------------------------------------------------------------------------
-- 'sign_in': a sign-in finished with the authenticator code (aal2), once per sign-in. 'mfa_verify': a later "Confirm
-- it's you" code (step-up). The app writes the row right after the code is accepted, through record_auth_event, a
-- SECURITY INVOKER function: the caller's own row, under row level security. A person can write only a row about
-- themselves in their own organisation, with nothing else in it, and only with a two-factor session (the table's
-- restrictive require_mfa policy). Rows stay readable by the organisation's admins only, and nobody can change or
-- delete one (no update or delete grant, no policy).
alter table public.audit_log drop constraint audit_log_action_check,
  add constraint audit_log_action_check
  check (action in ('insert', 'update', 'delete', 'role_change', 'file_access', 'sign_in', 'mfa_verify'));

-- The flood guard's count (one person's recent sign-in rows).
create index audit_log_auth_actor_idx on public.audit_log (actor_id, created_at desc) where table_name = 'auth';

grant insert (org_id, actor_id, action, table_name) on public.audit_log to authenticated;
create policy audit_log_own_auth_event on public.audit_log for insert to authenticated
  with check (table_name = 'auth' and action in ('sign_in', 'mfa_verify')
              and actor_id = (select auth.uid()) and org_id = (select private.current_org_id())
              and record_id is null and diff_json is null);

-- At most 30 sign-in rows per person per hour: a script with a stolen session cannot flood the log. A trigger, not
-- callable by anyone; DEFINER so it can count the person's earlier rows (only admins can read the log).
create function private.auth_event_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- A row about someone else is left to RLS, which refuses it (42501): the count below must never answer for another
  -- person, or a refusal's code would tell a caller whether that person signed in 30 times this hour (security review).
  if new.actor_id is distinct from auth.uid() then
    return new;
  end if;
  if (select count(*) from public.audit_log l
       where l.actor_id = new.actor_id and l.table_name = 'auth' and l.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'too many sign-in records' using errcode = '22023', hint = 'rate_limited';
  end if;
  return new;
end;
$$;
create trigger auth_event_guard before insert on public.audit_log
  for each row when (new.table_name = 'auth') execute function private.auth_event_guard();
revoke all on function private.auth_event_guard() from public, anon, authenticated;

create function public.record_auth_event(p_event text) returns void
language sql volatile security invoker set search_path = '' as $$
  insert into public.audit_log (org_id, actor_id, action, table_name)
  values ((select private.current_org_id()), (select auth.uid()), p_event, 'auth');
$$;
revoke all on function public.record_auth_event(text) from public, anon;
grant execute on function public.record_auth_event(text) to authenticated;
