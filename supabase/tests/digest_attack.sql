-- Security digest attack tests (Master Plan section 8 item 43; migration 20261023090000_security_digest.sql; runbook
-- docs/ops-templates/security-digest.md). Runs after the earlier files in scripts/db-test.sh (CI job "rls"), on the same
-- database, so every count is checked as a difference against a reading taken in the same transaction:
--   A. Deny by default: private.security_digest is SECURITY DEFINER with search_path '' and static SQL, STABLE, owned by
--      postgres, returns exactly (metric text, value bigint); only security_digest_reader may execute it (not PUBLIC,
--      anon, authenticated or service_role, live 42501). The role cannot log in, holds no other privilege (no table in
--      public, private, auth or storage, no other function in private, no policy, owns nothing, member of nothing), and
--      postgres may SET ROLE to it. The body names no column that holds personal data.
--   B. The workflow's exact statements (READ ONLY transaction, SET LOCAL ROLE) return the 32 metrics, in order, whole
--      numbers, none null; the reader cannot read a table directly. After RESET ROLE (possible: the session user is
--      postgres) the READ ONLY transaction still refuses a write.
--   C. Bounds: the window starts 1 hour to 8 days ago, never null.
--   D. Counting: each metric moves by exactly what the block wrote (audit rows, a real role change through
--      set_user_role, a real account deletion, a real lead delete, sessions, codes, authenticators, reset emails); rows
--      older than the window and sign-ins or codes younger than 15 minutes are left out; an audit action the digest does
--      not know is counted.
-- Each scenario that writes runs in a block that is rolled back at the end (raise TS001, caught).
\set ON_ERROR_STOP 1
\set QUIET 1

create function pg_temp.as_user(sub text, aal text, totp_age_s integer default null) returns void
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', sub, 'role', 'authenticated', 'aal', aal,
    'amr', case when totp_age_s is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - totp_age_s)) end
  )::text, false)
$$;
create function pg_temp.act(sub uuid, aal text default 'aal2', totp_age_s integer default 30) returns void
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', false);
  perform pg_temp.as_user(sub::text, aal, totp_age_s);
end;
$$;
create function pg_temp.anon() returns void
language plpgsql as $$
begin
  perform set_config('role', 'anon', false);
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
end;
$$;
create function pg_temp.svc() returns void
language plpgsql as $$
begin
  perform set_config('role', 'service_role', false);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
end;
$$;
create function pg_temp.reader() returns void
language plpgsql as $$
begin
  perform set_config('role', 'security_digest_reader', false);
  perform set_config('request.jwt.claims', '', false);
end;
$$;
create function pg_temp.su() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
end;
$$;
create function pg_temp.expect_error(stmt text, want_state text, want_hint text default null) returns void
language plpgsql as $$
declare
  got_state text;
  got_hint text;
  got_msg text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics got_state = returned_sqlstate, got_hint = pg_exception_hint, got_msg = message_text;
    if got_state <> want_state or (want_hint is not null and coalesce(got_hint, '') <> want_hint) then
      raise exception 'FAIL: "%" gave % (hint "%", %), expected % (hint "%")', left(stmt, 200), got_state, got_hint,
        got_msg, want_state, want_hint;
    end if;
    return;
  end;
  raise exception 'FAIL: "%" succeeded, expected %', left(stmt, 200), want_state;
end;
$$;
create function pg_temp.eq(label text, got anyelement, want anyelement) returns void
language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL: % is %, expected %', label, got, want;
  end if;
end;
$$;
-- One reading of the digest as a JSON object (metric -> value), taken as the workflow's role.
create function pg_temp.digest(p_since timestamptz) returns jsonb
language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.reader();
  select jsonb_object_agg(d.metric, d.value) into r from private.security_digest(p_since) d;
  perform pg_temp.su();
  return r;
end;
$$;
-- After minus before, for one metric.
create function pg_temp.moved(label text, after jsonb, before jsonb, want bigint) returns void
language plpgsql as $$
begin
  if (after ->> label)::bigint - (before ->> label)::bigint is distinct from want then
    raise exception 'FAIL: % moved by %, expected %', label, (after ->> label)::bigint - (before ->> label)::bigint, want;
  end if;
end;
$$;

-- ===========================================================================
-- A. Deny by default
-- ===========================================================================
do $$
declare
  f record;
  r record;
begin
  select p.oid, p.prosecdef, p.proconfig, p.prosrc, p.provolatile, pg_get_userbyid(p.proowner) as owner,
         p.proretset, p.proargnames, p.proallargtypes::regtype[]::text[] as argtypes, p.proargmodes
    into f
    from pg_proc p where p.oid = to_regprocedure('private.security_digest(timestamptz)');
  if f.oid is null then
    raise exception 'FAIL: private.security_digest(timestamptz) is missing';
  end if;
  perform pg_temp.eq('digest functions named security_digest',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = 'security_digest'), 1::bigint);
  if not f.prosecdef or f.proconfig is distinct from array['search_path=""'] or f.provolatile <> 's'
     or f.owner <> 'postgres' or f.prosrc ~* '\mexecute\M' or f.prosrc ~* 'format\s*\(' then
    raise exception 'FAIL: security_digest must be SECURITY DEFINER, STABLE, search_path '''', owned by postgres, static SQL';
  end if;
  -- Exactly two columns out: a name and a number. Nothing else can leave it.
  perform pg_temp.eq('result columns', f.proargnames, array['p_since', 'metric', 'value']);
  perform pg_temp.eq('result types', f.argtypes, array['timestamp with time zone', 'text', 'bigint']);
  perform pg_temp.eq('argument modes', f.proargmodes, array['i', 't', 't']::"char"[]);
  -- The body reads no column that holds personal data (names, emails, IP addresses, phones, user agents, file paths,
  -- the auth audit payload, secrets, codes).
  if f.prosrc ~* '\m(email|ip|ip_address|phone|first_name|last_name|raw_user_meta_data|user_agent|storage_path|payload|otp_code|secret|friendly_name|record_id|diff_json\s*->\s*''(old|new)'')\M' then
    raise exception 'FAIL: security_digest reads a column that holds personal data';
  end if;
  -- Who may execute it.
  if has_function_privilege('public', f.oid, 'EXECUTE') or has_function_privilege('anon', f.oid, 'EXECUTE')
     or has_function_privilege('authenticated', f.oid, 'EXECUTE')
     or has_function_privilege('service_role', f.oid, 'EXECUTE') then
    raise exception 'FAIL: security_digest is callable by public, anon, authenticated or service_role';
  end if;
  if not has_function_privilege('security_digest_reader', f.oid, 'EXECUTE') then
    raise exception 'FAIL: security_digest is not callable by security_digest_reader';
  end if;
  -- The role: cannot log in, no special attribute, owns nothing, member of nothing, no policy, no table privilege.
  select * into r from pg_roles where rolname = 'security_digest_reader';
  if r.rolname is null then
    raise exception 'FAIL: role security_digest_reader is missing';
  end if;
  if r.rolcanlogin or r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls
     or r.rolinherit then
    raise exception 'FAIL: security_digest_reader must be NOLOGIN NOINHERIT with no special attribute';
  end if;
  perform pg_temp.eq('security_digest_reader is a member of other roles',
    (select count(*) from pg_auth_members m where m.member = r.oid), 0::bigint);
  perform pg_temp.eq('relations owned by security_digest_reader',
    (select count(*) from pg_class c where c.relowner = r.oid), 0::bigint);
  perform pg_temp.eq('functions owned by security_digest_reader',
    (select count(*) from pg_proc p where p.proowner = r.oid), 0::bigint);
  perform pg_temp.eq('policies naming security_digest_reader',
    (select count(*) from pg_policies p where 'security_digest_reader' = any (p.roles)), 0::bigint);
  perform pg_temp.eq('relations security_digest_reader can touch',
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'private', 'auth', 'storage') and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and (has_table_privilege(r.oid, c.oid, 'SELECT') or has_table_privilege(r.oid, c.oid, 'INSERT')
             or has_table_privilege(r.oid, c.oid, 'UPDATE') or has_table_privilege(r.oid, c.oid, 'DELETE')
             or has_table_privilege(r.oid, c.oid, 'TRUNCATE'))), 0::bigint);
  -- No way into Supabase's auth or storage schemas (it needs private for the call; public is open to PUBLIC on Supabase).
  if has_schema_privilege(r.oid, 'auth', 'USAGE') or has_schema_privilege(r.oid, 'storage', 'USAGE')
     or has_schema_privilege(r.oid, 'private', 'CREATE') or has_schema_privilege(r.oid, 'public', 'CREATE') then
    raise exception 'FAIL: security_digest_reader may use auth or storage, or create objects';
  end if;
  perform pg_temp.eq('other private or public functions security_digest_reader can execute',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.oid <> f.oid
        and has_function_privilege(r.oid, p.oid, 'EXECUTE')), 0::bigint);
  -- postgres may switch to it (the workflow's SET LOCAL ROLE); nobody else of ours is a member.
  if not pg_has_role('postgres', 'security_digest_reader', 'SET') then
    raise exception 'FAIL: postgres cannot SET ROLE security_digest_reader';
  end if;
  perform pg_temp.eq('members of security_digest_reader other than postgres',
    (select count(*) from pg_auth_members m join pg_roles mr on mr.oid = m.member
      where m.roleid = r.oid and mr.rolname <> 'postgres'), 0::bigint);
end $$;

-- The Supabase Auth columns the digest reads, as on the real image (dev's information_schema, 16 Oct 2026): no
-- default anywhere (Supabase Auth fills them), created_at nullable on users and sessions, NOT NULL on the two MFA tables.
-- In CI this reads the real image; locally it keeps supabase/tests/shim.sql honest (a default there once hid a test that
-- left created_at empty: CI run on 523837a).
do $$
declare
  r record;
begin
  for r in select * from (values
      ('users', 'created_at', 'YES'), ('users', 'recovery_sent_at', 'YES'), ('users', 'deleted_at', 'YES'),
      ('users', 'raw_user_meta_data', 'YES'), ('sessions', 'created_at', 'YES'), ('sessions', 'aal', 'YES'),
      ('mfa_factors', 'created_at', 'NO'), ('mfa_factors', 'status', 'NO'), ('mfa_challenges', 'created_at', 'NO'),
      ('mfa_challenges', 'verified_at', 'YES')) as w (tbl, col, nullable) loop
    if not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'auth' and c.table_name = r.tbl and c.column_name = r.col
                      and c.is_nullable = r.nullable and c.column_default is null) then
      raise exception 'FAIL: auth.%.% is not as on the real image (nullable %, no default)', r.tbl, r.col, r.nullable;
    end if;
  end loop;
end $$;

-- Live calls: anon, a signed-in admin with a fresh code and service_role are refused (42501).
do $$
declare
  stmt constant text := $q$select * from private.security_digest(now() - interval '25 hours')$q$;
begin
  perform pg_temp.anon();
  perform pg_temp.expect_error(stmt, '42501');
  perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
  perform pg_temp.expect_error(stmt, '42501');
  perform pg_temp.svc();
  perform pg_temp.expect_error(stmt, '42501');
  perform pg_temp.su();
end $$;

-- ===========================================================================
-- B. The workflow's statements, as written in docs/ops-templates/security-digest.yml
-- ===========================================================================
begin transaction read only;
set local role security_digest_reader;
set local statement_timeout = '30s';
do $$
declare
  got text[];
begin
  perform pg_temp.eq('role inside the digest transaction', current_user::text, 'security_digest_reader');
  select array_agg(d.metric) into got from private.security_digest(now() - interval '25 hours') d;
  perform pg_temp.eq('metrics, in order', got, array[
    'digest.version', 'digest.window_minutes',
    'signin.completed', 'signin.people', 'signin.most_by_one_person', 'signin.step_up_codes',
    'signin.passwords_accepted', 'signin.password_ok_no_code', 'signin.codes_not_finished', 'signin.reset_emails',
    'signin.sessions_most_by_one_user',
    'accounts.users', 'accounts.new', 'accounts.without_two_factor', 'accounts.authenticators_added', 'accounts.admins',
    'accounts.role_changes', 'accounts.people_removed',
    'data.leads_deleted', 'data.files_deleted', 'data.rows_deleted', 'data.file_opens',
    'data.file_opens_most_by_one_person', 'data.imports_done', 'data.imports_undone', 'data.import_undo_leads_removed',
    'data.stock_adjustments', 'data.sharing_switch_changes', 'data.share_links_created',
    'audit.rows', 'audit.unknown_actions', 'ops.file_sweeps']);
  perform pg_temp.eq('version', (select d.value from private.security_digest(now() - interval '25 hours') d
                                  where d.metric = 'digest.version'), 1::bigint);
  perform pg_temp.eq('window of 25 hours in minutes',
    (select d.value from private.security_digest(now() - interval '25 hours') d where d.metric = 'digest.window_minutes'),
    1500::bigint);
  perform pg_temp.eq('null or negative values',
    (select count(*) from private.security_digest(now() - interval '25 hours') d where d.value is null or d.value < 0),
    0::bigint);
  -- The reader reaches nothing else, even inside this transaction.
  perform pg_temp.expect_error('select count(*) from public.audit_log', '42501');
  perform pg_temp.expect_error('select count(*) from public.companies', '42501');
  perform pg_temp.expect_error('select count(*) from public.profiles', '42501');
  perform pg_temp.expect_error('select count(*) from auth.users', '42501');
  perform pg_temp.expect_error('select count(*) from auth.sessions', '42501');
  perform pg_temp.expect_error('select private.current_org_id()', '42501');
end $$;
-- The role is a guard for the workflow's own SQL, not a boundary: Postgres checks SET ROLE against the session user
-- (postgres), so the session can switch back (runbook, "For Claude"). The READ ONLY transaction still refuses any write.
reset role;
do $$
begin
  perform pg_temp.eq('role after RESET ROLE', current_user::text, 'postgres');
  perform pg_temp.expect_error($q$insert into public.audit_log (action, table_name) values ('file_sweep', 'storage.objects')$q$,
    '25006');
end $$;
commit;

-- The admin count, read as postgres, matches.
do $$
begin
  perform pg_temp.eq('accounts.admins',
    (pg_temp.digest(now() - interval '25 hours') ->> 'accounts.admins')::bigint,
    (select count(*) from public.profiles where role = 'admin'));
end $$;

-- ===========================================================================
-- C. Bounds
-- ===========================================================================
do $$
begin
  perform pg_temp.reader();
  perform pg_temp.expect_error('select * from private.security_digest(null)', '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from private.security_digest(now() - interval '59 minutes')$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from private.security_digest(now() + interval '1 day')$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from private.security_digest(now() - interval '8 days 1 minute')$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from private.security_digest('-infinity')$q$, '22023', 'bounds');
  perform count(*) from private.security_digest(now() - interval '1 hour');
  perform count(*) from private.security_digest(now() - interval '8 days');
  perform pg_temp.su();
end $$;

-- ===========================================================================
-- D. Counting
-- ===========================================================================
do $$
declare
  admin_a constant uuid := '00000000-0000-0000-0000-00000000000a';
  u1 constant uuid := 'd1000000-0000-4000-8000-000000000001';   -- new, signs in, adds an authenticator
  u2 constant uuid := 'd1000000-0000-4000-8000-000000000002';   -- new, no verified authenticator, asks for a reset
  u3 constant uuid := 'd1000000-0000-4000-8000-000000000003';   -- new, then deleted (its profile goes with it)
  u4 constant uuid := 'd1000000-0000-4000-8000-000000000004';   -- soft-deleted by Supabase Auth
  u5 constant uuid := 'd1000000-0000-4000-8000-000000000005';   -- written by hand in SQL: no creation time
  busy constant uuid := 'd1000000-0000-4000-8000-0000000000bb'; -- the busiest person (audit rows only)
  other constant uuid := 'd1000000-0000-4000-8000-0000000000cc';
  f1 constant uuid := 'd2000000-0000-4000-8000-000000000001';
  lead constant uuid := 'd3000000-0000-4000-8000-000000000001';
  batch constant text := 'd4000000-0000-4000-8000-000000000001';
  before jsonb;
  after jsonb;
  wide jsonb;
  max_sign_ins bigint;
  max_opens bigint;
  max_sessions bigint;
  i integer;
begin
  before := pg_temp.digest(now() - interval '25 hours');
  max_sign_ins := (before ->> 'signin.most_by_one_person')::bigint;
  max_opens := (before ->> 'data.file_opens_most_by_one_person')::bigint;
  max_sessions := (before ->> 'signin.sessions_most_by_one_user')::bigint;

  -- Accounts (the profile trigger gives each a profile in the first organisation, as a rep). Every time the digest
  -- reads is set here: on the real image auth.users.created_at has no default (Supabase Auth fills it), and the shim
  -- copies that.
  insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at) values
    (u1, 'digest-u1@test.invalid', '{"first_name":"Dee"}', now() - interval '3 hours', now() - interval '3 hours'),
    (u2, 'digest-u2@test.invalid', '{"first_name":"Eli"}', now() - interval '3 hours', now() - interval '3 hours'),
    (u3, 'digest-u3@test.invalid', '{"first_name":"Fay"}', now() - interval '3 hours', now() - interval '3 hours');
  -- An account Supabase Auth did not create (no creation time): counted as new, so it turns the digest red.
  insert into auth.users (id, email, raw_user_meta_data) values (u5, 'digest-u5@test.invalid', '{"first_name":"Hal"}');
  perform pg_temp.eq('u5 creation time (none, as Supabase Auth leaves an unset column)',
    (select u.created_at from auth.users u where u.id = u5), null::timestamptz);
  insert into auth.users (id, email, raw_user_meta_data, created_at, deleted_at)
  values (u4, 'digest-u4@test.invalid', '{"first_name":"Gus"}', now() - interval '40 days', now() - interval '2 days');
  update auth.users set recovery_sent_at = now() - interval '2 hours' where id = u2;
  update auth.users set recovery_sent_at = now() - interval '30 hours' where id = u1;   -- before the window
  -- u1 enrols an authenticator now; u2 started one a month ago and never finished it.
  insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values
    (f1, u1, 'totp', 'verified', now(), now()),
    ('d2000000-0000-4000-8000-000000000002', u2, 'totp', 'unverified', now() - interval '30 days', now() - interval '30 days');
  -- Sessions: a finished sign-in, two password-only ones older than 15 minutes (one with no level recorded), one
  -- password-only that may still be typing its code, and one from before the window.
  insert into auth.sessions (id, user_id, created_at, aal) values
    ('d5000000-0000-4000-8000-000000000001', u1, now() - interval '20 minutes', 'aal2'),
    ('d5000000-0000-4000-8000-000000000002', u1, now() - interval '20 minutes', 'aal1'),
    ('d5000000-0000-4000-8000-000000000003', u1, now() - interval '20 minutes', null),
    ('d5000000-0000-4000-8000-000000000004', u1, now() - interval '5 minutes', 'aal1'),
    ('d5000000-0000-4000-8000-000000000005', u1, now() - interval '26 hours', 'aal1');
  -- A session written by hand (no creation time, password level only): counted as started and as no code finished.
  insert into auth.sessions (id, user_id, created_at, aal) values ('d5000000-0000-4000-8000-000000000006', u5, null, 'aal1');
  -- u2 signs in more often than anyone (finished sign-ins, as a script calling Supabase Auth directly would: no audit
  -- row): five more than the busiest account so far, so more than u1's four too.
  for i in 1 .. max_sessions + 5 loop
    insert into auth.sessions (id, user_id, created_at, aal) values (gen_random_uuid(), u2, now() - interval '1 hour', 'aal2');
  end loop;
  -- and one of u2's from before the window, which must not count.
  insert into auth.sessions (id, user_id, created_at, aal) values (gen_random_uuid(), u2, now() - interval '26 hours', 'aal2');
  -- Codes asked for: one entered right, one never finished, one still in progress, one from before the window.
  insert into auth.mfa_challenges (id, factor_id, created_at, verified_at, ip_address) values
    ('d6000000-0000-4000-8000-000000000001', f1, now() - interval '20 minutes', now() - interval '19 minutes', '192.0.2.10'),
    ('d6000000-0000-4000-8000-000000000002', f1, now() - interval '20 minutes', null, '192.0.2.10'),
    ('d6000000-0000-4000-8000-000000000003', f1, now() - interval '5 minutes', null, '192.0.2.10'),
    ('d6000000-0000-4000-8000-000000000004', f1, now() - interval '26 hours', null, '192.0.2.10');

  -- A real role change: the admin, with a fresh code, makes u2 a manager through set_user_role.
  perform pg_temp.act(admin_a);
  perform public.set_user_role(u2, 'manager');
  perform pg_temp.su();
  -- A real account deletion: the profile goes with the account, and its audit row says so.
  delete from auth.users where id = u3;
  -- A real lead delete (made and removed as the superuser: no signed-in user, so the rows stay as given).
  insert into public.companies (id, org_id, name)
  values (lead, (select id from public.orgs where name = 'TopStock Wholesale'), 'Digest lead');
  delete from public.companies where id = lead;

  -- Audit rows written as the triggers and functions write them.
  for i in 1 .. max_sign_ins + 5 loop
    insert into public.audit_log (actor_id, action, table_name) values (busy, 'sign_in', 'auth');
  end loop;
  insert into public.audit_log (actor_id, action, table_name) values
    (other, 'sign_in', 'auth'), (other, 'mfa_verify', 'auth'), (busy, 'mfa_verify', 'auth');
  insert into public.audit_log (actor_id, action, table_name, created_at)
  values (other, 'sign_in', 'auth', now() - interval '26 hours');                 -- before the window
  for i in 1 .. max_opens + 3 loop
    insert into public.audit_log (actor_id, action, table_name, record_id, diff_json)
    values (other, 'file_access', 'files', gen_random_uuid()::text, '{}');
  end loop;
  insert into public.audit_log (actor_id, action, table_name, record_id, diff_json) values
    (busy, 'file_access', 'files', gen_random_uuid()::text, '{}'),
    -- two plain lead deletes, two removed by an import undo, a file and a contact
    (busy, 'delete', 'companies', gen_random_uuid()::text, '{"old": {}}'),
    (busy, 'delete', 'companies', gen_random_uuid()::text, '{"old": {}}'),
    (busy, 'delete', 'companies', gen_random_uuid()::text, jsonb_build_object('import_batch_id', batch, 'undo', true)),
    (busy, 'delete', 'companies', gen_random_uuid()::text, jsonb_build_object('import_batch_id', batch, 'undo', true)),
    (busy, 'delete', 'files', gen_random_uuid()::text, '{"old": {}}'),
    (busy, 'delete', 'contacts', gen_random_uuid()::text, '{"old": {}}'),
    -- an import committed and one undone; a dry run is not an import
    (busy, 'update', 'import_batches', batch, '{"status": {"old": "committing", "new": "imported"}}'),
    (busy, 'update', 'import_batches', batch, '{"status": {"old": "rolling_back", "new": "rolled_back"}}'),
    (busy, 'update', 'import_batches', batch, '{"status": {"old": "staged", "new": "dry_run"}}'),
    -- one stock adjustment; a receipt is not an adjustment
    (busy, 'insert', 'stock_movements', gen_random_uuid()::text, '{"kind": "adjust_out", "note_len": 0}'),
    (busy, 'insert', 'stock_movements', gen_random_uuid()::text, '{"kind": "receive", "note_len": 0}'),
    -- the client sharing switch flipped; another settings change is not the switch
    (busy, 'update', 'inventory_settings', gen_random_uuid()::text, '{"sharing_enabled": {"old": false, "new": true}}'),
    (busy, 'update', 'inventory_settings', gen_random_uuid()::text, '{"low_stock_days": {"old": 7, "new": 14}}'),
    (busy, 'insert', 'share_links', gen_random_uuid()::text, '{"new": {}}');
  insert into public.audit_log (action, table_name, diff_json)
  values ('file_sweep', 'storage.objects', '{"found": 0, "removed": 0, "bytes": 0, "dry_run": true}');
  -- An action this digest does not know (as a later migration might add, for example an export).
  alter table public.audit_log drop constraint audit_log_action_check;
  insert into public.audit_log (actor_id, action, table_name) values (busy, 'export', 'companies');

  after := pg_temp.digest(now() - interval '25 hours');
  perform pg_temp.moved('digest.version', after, before, 0);
  perform pg_temp.moved('signin.completed', after, before, max_sign_ins + 6);
  perform pg_temp.moved('signin.people', after, before, 2);
  perform pg_temp.eq('signin.most_by_one_person', (after ->> 'signin.most_by_one_person')::bigint, max_sign_ins + 5);
  perform pg_temp.moved('signin.step_up_codes', after, before, 2);
  perform pg_temp.moved('signin.passwords_accepted', after, before, 4 + max_sessions + 5 + 1);   -- + u5's
  perform pg_temp.eq('signin.sessions_most_by_one_user',
    (after ->> 'signin.sessions_most_by_one_user')::bigint, max_sessions + 5);
  perform pg_temp.moved('signin.password_ok_no_code', after, before, 3);   -- two of u1's and u5's
  perform pg_temp.moved('signin.codes_not_finished', after, before, 1);
  perform pg_temp.moved('signin.reset_emails', after, before, 1);
  perform pg_temp.moved('accounts.users', after, before, 3);                  -- u1, u2, u5 (u3 deleted, u4 soft-deleted)
  perform pg_temp.moved('accounts.new', after, before, 3);                    -- u1, u2, u5 (u3 is gone; u4 is 40 days old)
  perform pg_temp.moved('accounts.without_two_factor', after, before, 2);     -- u2 (its factor is unverified), u5
  perform pg_temp.moved('accounts.authenticators_added', after, before, 1);   -- f1 (u2's is a month old)
  perform pg_temp.moved('accounts.admins', after, before, 0);
  perform pg_temp.moved('accounts.role_changes', after, before, 1);
  perform pg_temp.moved('accounts.people_removed', after, before, 1);
  perform pg_temp.moved('data.leads_deleted', after, before, 3);              -- the real one and two audit rows
  perform pg_temp.moved('data.files_deleted', after, before, 1);
  perform pg_temp.moved('data.rows_deleted', after, before, 6);               -- 3 leads, a file, a contact, a profile
  perform pg_temp.moved('data.file_opens', after, before, max_opens + 4);
  perform pg_temp.eq('data.file_opens_most_by_one_person',
    (after ->> 'data.file_opens_most_by_one_person')::bigint, max_opens + 3);
  perform pg_temp.moved('data.imports_done', after, before, 1);
  perform pg_temp.moved('data.imports_undone', after, before, 1);
  perform pg_temp.moved('data.import_undo_leads_removed', after, before, 2);
  perform pg_temp.moved('data.stock_adjustments', after, before, 1);
  perform pg_temp.moved('data.sharing_switch_changes', after, before, 1);
  perform pg_temp.moved('data.share_links_created', after, before, 1);
  perform pg_temp.moved('audit.unknown_actions', after, before, 1);
  perform pg_temp.moved('ops.file_sweeps', after, before, 1);
  -- audit.rows: every audit row this block wrote, the triggers' included (counted from the table, not by hand).
  perform pg_temp.eq('audit.rows',
    (after ->> 'audit.rows')::bigint,
    (select count(*) from public.audit_log l where l.created_at >= now() - interval '25 hours'));

  -- A wider window takes in what was before the 25 hours (the old sign-in row, session, code and reset email).
  wide := pg_temp.digest(now() - interval '27 hours');
  perform pg_temp.eq('old sign-in row in a 27-hour window',
    (wide ->> 'signin.completed')::bigint - (after ->> 'signin.completed')::bigint
      >= 1, true);
  perform pg_temp.eq('old password-only session in a 27-hour window',
    (wide ->> 'signin.password_ok_no_code')::bigint - (after ->> 'signin.password_ok_no_code')::bigint >= 1, true);
  perform pg_temp.eq('old unfinished code in a 27-hour window',
    (wide ->> 'signin.codes_not_finished')::bigint - (after ->> 'signin.codes_not_finished')::bigint >= 1, true);
  perform pg_temp.eq('old reset email in a 31-hour window',
    (pg_temp.digest(now() - interval '31 hours') ->> 'signin.reset_emails')::bigint
      - (after ->> 'signin.reset_emails')::bigint >= 1, true);
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- The constraint dropped in D is back (the block was rolled back).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'audit_log_action_check'
                   and conrelid = 'public.audit_log'::regclass) then
    raise exception 'FAIL: audit_log_action_check was not restored';
  end if;
end $$;

\echo 'digest_attack: all checks passed'
