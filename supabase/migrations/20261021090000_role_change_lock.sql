-- Team screen (verifier finding 2): two admins demoting each other at the same moment could leave an organisation with
-- no admin. set_user_role locked only the target's row before counting the admins, so under READ COMMITTED each call
-- counted two admins and both committed.
-- Now, after the cheap admin and fresh-code check, the function locks every admin row of the caller's organisation,
-- always in id order (so two calls queue instead of deadlocking), and only then locks the target and counts. A call that
-- waited checks the caller again: an admin demoted meanwhile is refused, whatever the change. Same signature, same
-- refusals (constant messages and SQLSTATEs the Team screen already maps), same audit row. The admin rows are a handful.
-- Timestamped after every migration on the other open branches; it only replaces this one function.
create or replace function public.set_user_role(target_user uuid, new_role public.app_role) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller_org uuid := private.current_org_id();
  target_org uuid;
  old_role public.app_role;
begin
  if not private.is_admin() or not private.has_recent_aal2(600) then
    raise exception 'admin with a two-factor code from the last 10 minutes required' using errcode = '42501';
  end if;
  -- Every role change of the organisation goes through these locks first, in one order.
  perform 1 from public.profiles where org_id = caller_org and role = 'admin' order by id for update;
  -- The caller may have been demoted while this call waited (a new statement sees the committed role).
  if not private.is_admin() then
    raise exception 'admin with a two-factor code from the last 10 minutes required' using errcode = '42501';
  end if;
  select org_id, role into target_org, old_role from public.profiles where id = target_user for update;
  if target_org is null or target_org <> caller_org then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if old_role = 'admin' and new_role <> 'admin'
     and (select count(*) from public.profiles where org_id = caller_org and role = 'admin') <= 1 then
    raise exception 'cannot remove the last admin' using errcode = '42501';
  end if;
  update public.profiles set role = new_role where id = target_user;
  insert into public.audit_log (org_id, actor_id, action, table_name, record_id, diff_json)
  values (caller_org, (select auth.uid()), 'role_change', 'profiles', target_user::text,
          jsonb_build_object('role', jsonb_build_object('old', old_role, 'new', new_role)));
end;
$$;

revoke all on function public.set_user_role(uuid, public.app_role) from public, anon;
grant execute on function public.set_user_role(uuid, public.app_role) to authenticated;
