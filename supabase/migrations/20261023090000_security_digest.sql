-- Master Plan section 8 item 43 ("No security monitoring"): the database part of the daily security digest
-- (docs/ops-templates/security-digest.yml, runbook docs/ops-templates/security-digest.md; go-live part I3.3). Planned for
-- Day 7c, written on 16 Oct 2026. Sorts after Day 7f's 20261022130000_share_take_paris_day, the newest on main.
--
-- The job: once a day a workflow in topstock-ops (Haider's private repository, never reached by Claude) reads counts of
-- security events in the last day and turns red, so GitHub emails Haider, when one crosses a limit. This migration only
-- READS: one function returns counts, never a row.
--
-- What changes, in plain words:
--  - Role security_digest_reader (nologin, noinherit): it can do one thing, run private.security_digest. It owns
--    nothing, reads no table and has no policy anywhere. The workflow signs in as postgres with the secrets topstock-ops
--    already holds for backup-prod (no new secret, the least privilege that exists there), opens a READ ONLY
--    transaction and switches to this role (SET LOCAL ROLE) before the call, so the workflow's own SQL can neither
--    write nor read rows. This guards against a mistake in that SQL, not against someone who controls the workflow:
--    the session is still signed in as postgres and could RESET ROLE (Postgres checks SET ROLE against the session
--    user). That person holds the postgres password already (backup-prod reads it from the same repository). A
--    dedicated LOGIN for this role with its own secret is the stricter option, left to Haider (runbook).
--    postgres gets SET on the role for that switch (the share_reader pattern, 20261020090000_client_share.sql).
--  - private.security_digest(p_since): SECURITY DEFINER (it reads public.audit_log and four auth tables that its
--    caller cannot), STABLE, search_path '', static SQL, owned by postgres. It returns (metric, value) pairs: fixed
--    metric names and whole numbers. No user id, name, email, IP address, lead, file name or organisation id ever
--    leaves it; "most by one person" metrics give the number only, never who.
--  - Deny by default: revoked from public, anon, authenticated and service_role; granted to security_digest_reader only.
--    Schema private is not exposed by the Data API, so no key of any kind reaches it over HTTP.
--  - p_since is bounded (1 hour to 8 days ago): a caller cannot make it scan more than 8 days.
--
-- Where each count comes from (verified 16 Oct 2026; docs/ops-templates/security-digest.md "For Claude"):
--  - public.audit_log (Day 1 onwards; sign_in and mfa_verify since Day 7a, file_sweep since Day 7c): completed
--    sign-ins and step-up codes, role changes (set_user_role), removed people (profiles deletes, which an account
--    deletion cascades to), deletes (an import undo's lead deletes carry undo = true and are counted apart), file opens,
--    import commits and undos (import_batches status), stock adjustments, the client sharing switch, new share links,
--    sweeper runs, and any action this digest does not know yet.
--  - auth.sessions, auth.mfa_challenges, auth.mfa_factors, auth.users (Supabase Auth's own tables): sign-ins started
--    (also the most by one account, which a script that skips the app cannot avoid), a password accepted but no code
--    finished, two-factor challenges never verified (any 6-digit code asked for and not entered right: at sign-in or at
--    a "Confirm it's you" step-up, src/app/(app)/step-up-actions.ts), password-reset emails, new accounts, accounts
--    without a verified authenticator, new authenticators.
--  - NOT failed passwords: Supabase Auth writes no audit entry for a wrong password or a wrong code (supabase/auth
--    token.go and mfa.go return before NewAuditLogEntry), and auth.audit_log_entries is not written at all on dev
--    (0 rows ever: "write audit logs to the database" is off; production, a new project too, is expected to match).
--    Wrong passwords are only in account B's Auth logs. The runbook says so.
--  - No exports: Release 1 has no export (the stock CSV export moved to Release 2, log 15 Oct 2026). An export would
--    add an audit action, which shows up as audit.unknown_actions until this function counts it.
-- Every reference to auth.* sits in plpgsql (checked when it runs, not when it is created: spike S1).
-- Tests: supabase/tests/digest_attack.sql.

do $$
begin
  if not exists (select from pg_roles where rolname = 'security_digest_reader') then
    create role security_digest_reader nologin noinherit;
  end if;
end;
$$;
grant security_digest_reader to postgres with set true;   -- PG16+: lets the workflow's postgres session SET ROLE to it
grant usage on schema private to security_digest_reader;

create function private.security_digest(p_since timestamptz)
returns table (metric text, value bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  -- A sign-in or a code younger than this may still be in progress: it is not counted as unfinished yet.
  settle constant interval := interval '15 minutes';
  a record;
  m record;
  s record;
begin
  if p_since is null or p_since > now() - interval '1 hour' or p_since < now() - interval '8 days' then
    raise exception 'the digest window starts 1 hour to 8 days ago' using errcode = '22023', hint = 'bounds';
  end if;

  -- One pass over the audit rows of the window.
  select count(*) as rows_all,
         count(*) filter (where l.action = 'sign_in') as sign_ins,
         count(distinct l.actor_id) filter (where l.action = 'sign_in') as sign_in_people,
         count(*) filter (where l.action = 'mfa_verify') as step_ups,
         count(*) filter (where l.action = 'role_change') as role_changes,
         count(*) filter (where l.action = 'delete' and l.table_name = 'profiles') as people_removed,
         count(*) filter (where l.action = 'delete' and l.table_name = 'companies'
                            and (l.diff_json ->> 'undo') is distinct from 'true') as leads_deleted,
         count(*) filter (where l.action = 'delete' and l.table_name = 'files') as files_deleted,
         count(*) filter (where l.action = 'delete'
                            and not (l.table_name = 'companies'
                                     and coalesce(l.diff_json ->> 'undo', '') = 'true')) as rows_deleted,
         count(*) filter (where l.action = 'delete' and l.table_name = 'companies'
                            and (l.diff_json ->> 'undo') = 'true') as undo_leads_removed,
         count(*) filter (where l.action = 'file_access') as file_opens,
         count(*) filter (where l.table_name = 'import_batches' and l.action = 'update'
                            and (l.diff_json #>> '{status,new}') = 'imported') as imports_done,
         count(*) filter (where l.table_name = 'import_batches' and l.action = 'update'
                            and (l.diff_json #>> '{status,new}') = 'rolled_back') as imports_undone,
         count(*) filter (where l.table_name = 'stock_movements' and l.action = 'insert'
                            and (l.diff_json ->> 'kind') in ('adjust_in', 'adjust_out')) as stock_adjustments,
         count(*) filter (where l.table_name = 'inventory_settings' and l.action = 'update'
                            and l.diff_json ? 'sharing_enabled') as sharing_switch,
         count(*) filter (where l.table_name = 'share_links' and l.action = 'insert') as share_links_new,
         count(*) filter (where l.action = 'file_sweep') as sweeps,
         count(*) filter (where l.action not in ('insert', 'update', 'delete', 'role_change', 'file_access', 'sign_in',
                                                 'mfa_verify', 'file_sweep')) as unknown_actions
    into a
    from public.audit_log l
   where l.created_at >= p_since;

  -- The busiest person, as a number only (who it was stays in the audit log, readable by the organisation's admins).
  select coalesce(max(x.n) filter (where x.action = 'sign_in'), 0) as sign_ins,
         coalesce(max(x.n) filter (where x.action = 'file_access'), 0) as file_opens
    into m
    from (select l.action, count(*) as n
            from public.audit_log l
           where l.created_at >= p_since and l.action in ('sign_in', 'file_access')
           group by l.action, l.actor_id) x;

  -- Supabase Auth's own tables (enums compared as text).
  select (select count(*) from auth.sessions x where x.created_at >= p_since) as sessions_started,
         -- Sessions are written by Supabase Auth itself, so a script that signs in without the app counts here too
         -- (the audit log's sign_in row is written only by the app's server action).
         (select coalesce(max(x.n), 0) from (select count(*) as n from auth.sessions y
                                              where y.created_at >= p_since group by y.user_id) x) as sessions_most,
         (select count(*) from auth.sessions x
           where x.created_at >= p_since and x.created_at < now() - settle
             and coalesce(x.aal::text, 'aal1') = 'aal1') as password_no_code,
         (select count(*) from auth.mfa_challenges c
           where c.created_at >= p_since and c.created_at < now() - settle and c.verified_at is null) as code_unfinished,
         (select count(*) from auth.users u where u.recovery_sent_at >= p_since) as reset_emails,
         (select count(*) from auth.users u where u.deleted_at is null) as users,
         (select count(*) from auth.users u where u.created_at >= p_since) as users_new,
         (select count(*) from auth.users u
           where u.deleted_at is null
             and not exists (select 1 from auth.mfa_factors f
                              where f.user_id = u.id and f.status::text = 'verified')) as without_two_factor,
         (select count(*) from auth.mfa_factors f where f.created_at >= p_since) as authenticators_added,
         (select count(*) from public.profiles p where p.role = 'admin') as admins
    into s;

  return query
    select v.metric, v.value
      from (values
        (1, 'digest.version', 1::bigint),
        (2, 'digest.window_minutes', floor(extract(epoch from now() - p_since) / 60)::bigint),
        (10, 'signin.completed', a.sign_ins),
        (11, 'signin.people', a.sign_in_people),
        (12, 'signin.most_by_one_person', m.sign_ins),
        (13, 'signin.step_up_codes', a.step_ups),
        (14, 'signin.passwords_accepted', s.sessions_started),
        (15, 'signin.password_ok_no_code', s.password_no_code),
        (16, 'signin.codes_not_finished', s.code_unfinished),
        (17, 'signin.reset_emails', s.reset_emails),
        (18, 'signin.sessions_most_by_one_user', s.sessions_most),
        (20, 'accounts.users', s.users),
        (21, 'accounts.new', s.users_new),
        (22, 'accounts.without_two_factor', s.without_two_factor),
        (23, 'accounts.authenticators_added', s.authenticators_added),
        (24, 'accounts.admins', s.admins),
        (25, 'accounts.role_changes', a.role_changes),
        (26, 'accounts.people_removed', a.people_removed),
        (30, 'data.leads_deleted', a.leads_deleted),
        (31, 'data.files_deleted', a.files_deleted),
        (32, 'data.rows_deleted', a.rows_deleted),
        (33, 'data.file_opens', a.file_opens),
        (34, 'data.file_opens_most_by_one_person', m.file_opens),
        (35, 'data.imports_done', a.imports_done),
        (36, 'data.imports_undone', a.imports_undone),
        (37, 'data.import_undo_leads_removed', a.undo_leads_removed),
        (38, 'data.stock_adjustments', a.stock_adjustments),
        (39, 'data.sharing_switch_changes', a.sharing_switch),
        (40, 'data.share_links_created', a.share_links_new),
        (50, 'audit.rows', a.rows_all),
        (51, 'audit.unknown_actions', a.unknown_actions),
        (52, 'ops.file_sweeps', a.sweeps)
      ) as v (pos, metric, value)
     order by v.pos;
end;
$$;

revoke all on function private.security_digest(timestamptz) from public, anon, authenticated, service_role;
grant execute on function private.security_digest(timestamptz) to security_digest_reader;
