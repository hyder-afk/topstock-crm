-- Day 4a attack and behaviour tests: activity hardening (design docs/evidence/day4/design.md sections 3.1, 6 and 8.1;
-- migration 20261011120000_activity_hardening.sql). Runs after rls_attack.sql, import_attack.sql and
-- import_concurrency.sh on the same database (scripts/db-test.sh, CI job "rls"), reusing their users: admin a, manager
-- a1 (promoted in rls_attack), rep b1, other-org admin c1. It adds rep d1, rep e1 (only for the flood guards, so its
-- counts are exact) and rep f1 (deleted to test profile deletes). Any failure raises an exception and stops the run.
-- Three kinds of probe:
--  - as a signed-in user through the API role: grants, row level security and triggers all apply;
--  - as the superuser with a user's claims: only the triggers apply, which proves a guard on its own (as if a grant or
--    a policy were loosened by mistake);
--  - inside a transaction that switches one trigger off: proves a policy on its own.
\set ON_ERROR_STOP 1
\set QUIET 1

-- Helpers (temporary functions do not survive into a new psql session, so they are defined again here) -------------
create function pg_temp.as_user(sub text, aal text, totp_age_s integer default null) returns void
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', sub, 'role', 'authenticated', 'aal', aal,
    'amr', case when totp_age_s is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - totp_age_s)) end
  )::text, false)
$$;

-- Runs a statement that must fail with this SQLSTATE (and hint, when given). With a marker, the marker (planted in the
-- user's text) must appear in neither the message nor the detail: constant errors keep lead data out of the logs.
create function pg_temp.expect_error(stmt text, want_state text, want_hint text default null, marker text default null)
returns void language plpgsql as $$
declare
  got_state text;
  got_hint text;
  got_msg text;
  got_detail text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics got_state = returned_sqlstate, got_hint = pg_exception_hint, got_msg = message_text,
                            got_detail = pg_exception_detail;
    if got_state <> want_state or (want_hint is not null and coalesce(got_hint, '') <> want_hint) then
      raise exception 'FAIL: "%" gave % (hint "%"), expected % (hint "%")', left(stmt, 160), got_state, got_hint,
        want_state, want_hint;
    end if;
    if marker is not null and (strpos(coalesce(got_msg, ''), marker) > 0 or strpos(coalesce(got_detail, ''), marker) > 0) then
      raise exception 'FAIL: "%" put the user''s text in the error', left(stmt, 160);
    end if;
    return;
  end;
  raise exception 'FAIL: "%" succeeded, expected %', left(stmt, 160), want_state;
end;
$$;

-- Runs a statement that must succeed, then undoes it: a probe that is allowed leaves nothing behind.
create function pg_temp.expect_ok(stmt text) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
    raise exception 'probe undone' using errcode = 'TS001';
  exception
    when sqlstate 'TS001' then
      return;
    when others then
      raise exception 'FAIL: "%" gave % (%), expected it to succeed', left(stmt, 160), sqlstate, sqlerrm;
  end;
end;
$$;

-- Fixtures (superuser, no claims: the guards and the org/owner trigger leave rows as given) --------------------------
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000d1', 'repd@test.invalid', '{"first_name":"Dee"}'),
  ('00000000-0000-0000-0000-0000000000e1', 'repe@test.invalid', '{"first_name":"Eve"}'),
  ('00000000-0000-0000-0000-0000000000f1', 'repf@test.invalid', '{"first_name":"Fay"}');
do $$
declare
  main_org uuid := (select id from public.orgs where name = 'TopStock Wholesale');
  stage uuid := (select s.id from public.pipeline_stages s where s.org_id = main_org and s.position = 1);
begin
  if (select array_agg(role::text order by id) from public.profiles
       where id in ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1',
                    '00000000-0000-0000-0000-0000000000f1')) <> array['rep', 'rep', 'rep'] then
    raise exception 'FAIL: the new fixture users should be reps';
  end if;
  -- Leads: LB (rep b1's), LD (rep d1's), LE (rep e1's), LF (b1's, deleted later), LP (b1's, for the last-activity rule,
  -- with a date from the sheet and no entries).
  insert into public.companies (id, org_id, name, owner_id, last_activity_at) values
    ('32000000-0000-0000-0000-0000000000b1', main_org, 'Day4 B', '00000000-0000-0000-0000-0000000000b1', null),
    ('32000000-0000-0000-0000-0000000000d1', main_org, 'Day4 D', '00000000-0000-0000-0000-0000000000d1', null),
    ('32000000-0000-0000-0000-0000000000e1', main_org, 'Day4 E', '00000000-0000-0000-0000-0000000000e1', null),
    ('32000000-0000-0000-0000-0000000000f1', main_org, 'Day4 F', '00000000-0000-0000-0000-0000000000b1', null),
    ('32000000-0000-0000-0000-0000000000a7', main_org, 'Day4 P', '00000000-0000-0000-0000-0000000000b1',
     timestamptz '2026-01-15 10:00:00+00');
  insert into public.contacts (id, org_id, company_id, first_name) values
    ('12000000-0000-0000-0000-0000000000b1', main_org, '32000000-0000-0000-0000-0000000000b1', 'Basile'),
    ('12000000-0000-0000-0000-0000000000b2', main_org, '32000000-0000-0000-0000-0000000000b1', 'Bea'),
    ('12000000-0000-0000-0000-0000000000d1', main_org, '32000000-0000-0000-0000-0000000000d1', 'Dora'),
    ('12000000-0000-0000-0000-0000000000f1', main_org, '32000000-0000-0000-0000-0000000000f1', 'Fred');
  insert into public.deals (id, org_id, company_id, contact_id, stage_id, owner_id) values
    ('42000000-0000-0000-0000-0000000000b1', main_org, '32000000-0000-0000-0000-0000000000b1',
     '12000000-0000-0000-0000-0000000000b1', stage, '00000000-0000-0000-0000-0000000000b1');
  -- An entry linked to a deal (deal_id is not a client column until Day 5) and to a contact.
  insert into public.activities (id, org_id, company_id, contact_id, deal_id, type, body, user_id) values
    ('52000000-0000-0000-0000-0000000000b1', main_org, '32000000-0000-0000-0000-0000000000b1',
     '12000000-0000-0000-0000-0000000000b1', '42000000-0000-0000-0000-0000000000b1', 'note', 'with a deal',
     '00000000-0000-0000-0000-0000000000b1');
end $$;

-- 0. What the database itself says: grants, functions, foreign keys, indexes, policies ------------------------------
do $$
declare
  cols text[];
begin
  -- Column grants (threats 3, 4 and 7): clients name only these columns; everything else is the server's.
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'public.activities'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'INSERT');
  if cols is distinct from array['body', 'company_id', 'contact_id', 'outcome', 'request_id', 'type'] then
    raise exception 'FAIL: activity insert columns are %', cols;
  end if;
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'public.activities'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'UPDATE');
  if cols is distinct from array['body'] then raise exception 'FAIL: activity update columns are %', cols; end if;
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'public.tasks'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'INSERT');
  if cols is distinct from array['assignee_id', 'company_id', 'contact_id', 'due_at', 'due_date', 'kind', 'request_id',
                                 'source_activity_id', 'title'] then
    raise exception 'FAIL: task insert columns are %', cols;
  end if;
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'public.tasks'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'UPDATE');
  if cols is distinct from array['assignee_id', 'cancelled_at', 'contact_id', 'done_at', 'due_at', 'due_date', 'title'] then
    raise exception 'FAIL: task update columns are %', cols;
  end if;
  if has_table_privilege('anon', 'public.activities', 'SELECT') or has_table_privilege('anon', 'public.tasks', 'SELECT')
     or has_column_privilege('anon', 'public.activities', 'body', 'INSERT')
     or has_column_privilege('anon', 'public.tasks', 'title', 'INSERT') then
    raise exception 'FAIL: anon has a privilege on activities or tasks';
  end if;
  -- Trigger functions are never callable by clients.
  if has_function_privilege('authenticated', 'private.activity_guard()', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.task_guard()', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.untouch_company_activity()', 'EXECUTE')
     or has_function_privilege('anon', 'private.untouch_company_activity()', 'EXECUTE') then
    raise exception 'FAIL: a client may call a Day 4a trigger function';
  end if;
  if (select prosecdef from pg_proc where oid = 'private.untouch_company_activity()'::regprocedure) is not true
     or (select prosecdef from pg_proc where oid = 'private.activity_guard()'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'private.task_guard()'::regprocedure) then
    raise exception 'FAIL: only the untouch trigger runs as its owner';
  end if;
  -- History survives contact, deal, entry and profile deletes; a task goes with its lead (G5).
  if (select array_agg(conname::text || '=' || confdeltype::text order by conname) from pg_constraint
       where contype = 'f' and conrelid in ('public.activities'::regclass, 'public.tasks'::regclass)
         and conname in ('activities_contact_id_fkey', 'activities_deal_id_fkey', 'activities_user_id_fkey',
                         'tasks_company_id_fkey', 'tasks_contact_id_fkey', 'tasks_created_by_fkey',
                         'tasks_source_activity_id_fkey', 'tasks_assignee_id_fkey'))
     is distinct from array['activities_contact_id_fkey=n', 'activities_deal_id_fkey=n', 'activities_user_id_fkey=n',
                            'tasks_assignee_id_fkey=n', 'tasks_company_id_fkey=c', 'tasks_contact_id_fkey=n',
                            'tasks_created_by_fkey=n', 'tasks_source_activity_id_fkey=n'] then
    raise exception 'FAIL: foreign key delete actions on activities and tasks';
  end if;
  -- One request id per author (threat 10): a replay finds its first result instead of logging twice.
  if (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname in ('activities_author_request_idx', 'tasks_creator_request_idx') and i.indisunique
         and i.indpred is not null) <> 2 then
    raise exception 'FAIL: the request indexes must be unique per author';
  end if;
  -- Exactly these policies (an extra permissive policy would widen access).
  if (select array_agg(policyname::text order by policyname) from pg_policies
       where schemaname = 'public' and tablename = 'activities')
     is distinct from array['activities_delete', 'activities_insert', 'activities_select', 'activities_update', 'require_mfa'] then
    raise exception 'FAIL: activity policies';
  end if;
  if (select array_agg(policyname::text order by policyname) from pg_policies
       where schemaname = 'public' and tablename = 'tasks')
     is distinct from array['require_mfa', 'tasks_delete', 'tasks_insert', 'tasks_select', 'tasks_update'] then
    raise exception 'FAIL: task policies';
  end if;
end $$;

-- 1. anon and a session without two-factor (aal1) --------------------------------------------------------------------
set role anon;
do $$ begin perform set_config('request.jwt.claims', '{"role":"anon"}', false); end $$;
do $$
declare stmt text;
begin
  -- Inline, not through the helpers: anon may not run the session's temporary functions on every image.
  foreach stmt in array array[
    'select count(*) from public.activities', 'select count(*) from public.tasks',
    $q$insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000b1', 'note')$q$,
    $q$insert into public.tasks (title) values ('x')$q$] loop
    begin
      execute stmt;
      raise exception 'FAIL: anon ran %', stmt;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal1'); end $$;
do $$ begin
  if (select count(*) from public.activities) <> 0 or (select count(*) from public.tasks) <> 0 then
    raise exception 'FAIL: an aal1 session reads activities or tasks';
  end if;
  perform pg_temp.expect_error($q$insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000b1', 'note')$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.tasks (company_id, title) values ('32000000-0000-0000-0000-0000000000b1', 'x')$q$, '42501');
end $$;

-- 2. The author is the person signed in (threat 3, G1) ---------------------------------------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2'); end $$;
do $$
declare
  v uuid;
begin
  -- activity_author_forced_for_admin: an admin logs on a rep's lead; the entry is the admin's.
  insert into public.activities (company_id, type, body) values ('32000000-0000-0000-0000-0000000000b1', 'note', 'admin note')
  returning id into v;
  if (select user_id from public.activities where id = v) <> '00000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL: an admin entry is not stored as the admin';
  end if;
  perform set_config('t.admin_note', v::text, false);
  -- activity_insert_user_id_column_denied: nobody may even name the author.
  perform pg_temp.expect_error($q$insert into public.activities (company_id, type, user_id) values ('32000000-0000-0000-0000-0000000000b1', 'note', '00000000-0000-0000-0000-0000000000b1')$q$, '42501');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2'); end $$;
do $$
declare
  v uuid;
begin
  insert into public.activities (company_id, contact_id, type, outcome, body)
  values ('32000000-0000-0000-0000-0000000000b1', '12000000-0000-0000-0000-0000000000b1', 'call', 'connected', 'b1 call')
  returning id into v;
  perform set_config('t.b_call', v::text, false);
  insert into public.activities (company_id, type, body) values ('32000000-0000-0000-0000-0000000000b1', 'note', 'b1 note')
  returning id into v;
  perform set_config('t.b_note', v::text, false);
  if (select count(*) from public.activities where id in (current_setting('t.b_call')::uuid, v)
        and user_id = '00000000-0000-0000-0000-0000000000b1' and edited_at is null) <> 2 then
    raise exception 'FAIL: a rep entry is not stored as the rep';
  end if;
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2'); end $$;
do $$
declare
  v uuid;
begin
  -- The team logs on any lead of the org; the entry is the caller's.
  insert into public.activities (company_id, type, body) values ('32000000-0000-0000-0000-0000000000b1', 'note', 'd1 note on B')
  returning id into v;
  if (select user_id from public.activities where id = v) <> '00000000-0000-0000-0000-0000000000d1' then
    raise exception 'FAIL: an entry on a colleague''s lead is not stored as its author';
  end if;
  perform set_config('t.d_note', v::text, false);
end $$;

-- The guard on its own (superuser with the admin's claims: no grant or policy stops anything): every server column
-- sent anyway is replaced. Covers activity_created_at_server_time and prev_last_activity_not_writable.
reset role;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2'); end $$;
do $$
declare
  r record;
  before_date timestamptz := (select last_activity_at from public.companies where id = '32000000-0000-0000-0000-0000000000d1');
begin
  begin
    insert into public.activities (company_id, type, user_id, created_at, edited_at, prev_last_activity_at, org_id)
    values ('32000000-0000-0000-0000-0000000000d1', 'note', '00000000-0000-0000-0000-0000000000b1',
            now() + interval '5 years', now(), timestamptz '2000-01-01 00:00:00+00', '00000000-0000-0000-0000-0000000000cc')
    returning user_id, created_at, edited_at, prev_last_activity_at, org_id into r;
    if r.user_id <> '00000000-0000-0000-0000-00000000000a' or r.created_at <> now() or r.edited_at is not null
       or r.prev_last_activity_at is distinct from before_date
       or r.org_id <> (select id from public.orgs where name = 'TopStock Wholesale') then
      raise exception 'FAIL: the guard kept a server column sent by the client: %', row_to_json(r);
    end if;
    raise exception 'probe undone' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
end $$;

-- The policy on its own (G1, no manager exception): with the guard off, an admin entry that does not name the admin as
-- its author is refused by activities_insert.
begin;
alter table public.activities disable trigger activity_guard;
set local role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2'); end $$;
do $$ begin
  perform pg_temp.expect_error($q$insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000b1', 'note')$q$, '42501');
end $$;
rollback;

-- 3. Only the text of an entry changes, only by its author, and it is marked edited (threat 4, G2) ------------------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2'); end $$;
do $$
declare
  v uuid := current_setting('t.b_note')::uuid;
  r record;
  stmt text;
begin
  update public.activities set body = E'line one\r\nline two' where id = v;
  select body, edited_at, user_id, created_at into r from public.activities where id = v;
  if r.body <> E'line one\nline two' or r.edited_at is null or r.edited_at <> now()
     or r.user_id <> '00000000-0000-0000-0000-0000000000b1' then
    raise exception 'FAIL: an edit by the author (text with CRLF, edited_at set, author kept): %', row_to_json(r);
  end if;
  perform set_config('t.b_note_edited', r.edited_at::text, false);
  -- Every other column is refused by the grant (activity_update_only_body).
  foreach stmt in array array[
    'update public.activities set type = ''email'' where id = %L',
    'update public.activities set outcome = ''sent'' where id = %L',
    'update public.activities set company_id = ''32000000-0000-0000-0000-0000000000d1'' where id = %L',
    'update public.activities set contact_id = null where id = %L',
    'update public.activities set deal_id = null where id = %L',
    'update public.activities set user_id = ''00000000-0000-0000-0000-0000000000d1'' where id = %L',
    'update public.activities set created_at = now() - interval ''1 day'' where id = %L',
    'update public.activities set edited_at = null where id = %L',
    'update public.activities set prev_last_activity_at = null where id = %L',
    'update public.activities set request_id = gen_random_uuid() where id = %L',
    'update public.activities set updated_at = now() where id = %L',
    'update public.activities set org_id = ''00000000-0000-0000-0000-0000000000cc'' where id = %L'] loop
    perform pg_temp.expect_error(format(stmt, current_setting('t.b_call')), '42501');
  end loop;
  -- The text's own rules on an edit, with constant errors (bad_body_constant_error).
  perform pg_temp.expect_error(format('update public.activities set body = %L where id = %L',
    'PLANTED-SECRET ' || repeat('x', 10000), v), '22023', 'body_too_long', 'PLANTED-SECRET');
  perform pg_temp.expect_error(format('update public.activities set body = %L where id = %L',
    'PLANTED-SECRET ' || chr(8238) || 'evil', v), '22023', 'body_chars', 'PLANTED-SECRET');
end $$;
do $$
declare
  v uuid := current_setting('t.b_note')::uuid;
begin
  -- A later transaction that writes the same text (once CRLF is folded) is no edit: edited_at stays.
  update public.activities set body = E'line one\r\nline two' where id = v;
  if (select edited_at from public.activities where id = v) <> current_setting('t.b_note_edited')::timestamptz then
    raise exception 'FAIL: writing the same text moved edited_at';
  end if;
end $$;

-- admin_cannot_edit_others_entry: not the admin, not a manager, not a colleague.
do $$
declare
  who text;
  n int;
begin
  foreach who in array array['00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
                             '00000000-0000-0000-0000-0000000000d1'] loop
    perform pg_temp.as_user(who, 'aal2', 30);
    update public.activities set body = 'rewritten' where id = current_setting('t.b_note')::uuid;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: % rewrote rep b1''s entry', who; end if;
  end loop;
  if (select body from public.activities where id = current_setting('t.b_note')::uuid) <> E'line one\nline two' then
    raise exception 'FAIL: a colleague changed rep b1''s words';
  end if;
end $$;

-- The guard on its own (superuser with b1's claims): even with a grant added by mistake, only the text changes.
-- direct_update_contact_to_null_refused: emptying a link by hand (depth 1) is not the referential exception.
reset role;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2'); end $$;
do $$
declare
  stmt text;
begin
  foreach stmt in array array[
    'update public.activities set type = ''email'' where id = %L',
    'update public.activities set outcome = ''no_answer'' where id = %L',
    'update public.activities set company_id = ''32000000-0000-0000-0000-0000000000d1'' where id = %L',
    'update public.activities set contact_id = null where id = %L',
    'update public.activities set contact_id = ''12000000-0000-0000-0000-0000000000b2'' where id = %L',
    'update public.activities set user_id = null where id = %L',
    'update public.activities set user_id = ''00000000-0000-0000-0000-0000000000d1'' where id = %L',
    'update public.activities set created_at = now() - interval ''1 day'' where id = %L',
    'update public.activities set edited_at = now() where id = %L',
    'update public.activities set prev_last_activity_at = now() where id = %L',
    'update public.activities set request_id = gen_random_uuid() where id = %L',
    'update public.activities set body = ''x'', outcome = ''no_answer'' where id = %L'] loop
    perform pg_temp.expect_error(format(stmt, current_setting('t.b_call')), '42501', 'not_editable');
  end loop;
  perform pg_temp.expect_error($q$update public.activities set deal_id = null where id = '52000000-0000-0000-0000-0000000000b1'$q$,
                               '42501', 'not_editable');
end $$;

-- 4. Each kind of entry takes only its own outcomes (constant error, hint "outcome") ---------------------------------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2'); end $$;
do $$
declare
  t record;
begin
  for t in select * from (values
      ('call', 'no_answer'), ('call', 'voicemail'), ('call', 'wrong_number'), ('call', 'not_interested'),
      ('call', 'interested'), ('call', 'meeting_booked'), ('call', 'do_not_contact'), ('call', 'connected'),
      ('email', null), ('email', 'sent'), ('whatsapp', null), ('whatsapp', 'sent'),
      ('meeting', null), ('meeting', 'held'), ('meeting', 'no_show'), ('note', null)) as p (type, outcome) loop
    perform pg_temp.expect_ok(format('insert into public.activities (company_id, type, outcome) values (%L, %L, %L)',
                                     '32000000-0000-0000-0000-0000000000d1', t.type, t.outcome));
  end loop;
  for t in select * from (values
      ('call', null), ('call', 'sent'), ('call', 'held'), ('call', 'NO_ANSWER'), ('email', 'no_answer'),
      ('whatsapp', 'held'), ('meeting', 'sent'), ('meeting', 'connected'), ('note', 'sent'), ('note', 'no_answer'),
      ('sms', null), (null, null), (null, 'sent')) as p (type, outcome) loop
    perform pg_temp.expect_error(format('insert into public.activities (company_id, type, outcome) values (%L, %L, %L)',
                                        '32000000-0000-0000-0000-0000000000d1', t.type, t.outcome), '22023', 'outcome');
  end loop;
end $$;

-- 5. Text limits and safe characters (threat 29: constant errors, the text never reaches the logs) --------------------
do $$
declare
  c integer;
  v uuid;
begin
  perform pg_temp.expect_ok(format('insert into public.activities (company_id, type, body) values (%L, %L, %L)',
                                   '32000000-0000-0000-0000-0000000000d1', 'note', repeat('x', 10000)));
  perform pg_temp.expect_error(format('insert into public.activities (company_id, type, body) values (%L, %L, %L)',
    '32000000-0000-0000-0000-0000000000d1', 'note', 'PLANTED-SECRET ' || repeat('x', 9986)), '22023', 'body_too_long',
    'PLANTED-SECRET');
  -- Control characters (other than tab and line feed), DEL, a lone CR, bidi embeddings, overrides and isolates.
  foreach c in array array[1, 8, 11, 12, 13, 31, 127, 8234, 8238, 8294, 8297] loop
    perform pg_temp.expect_error(format('insert into public.activities (company_id, type, body) values (%L, %L, %L)',
      '32000000-0000-0000-0000-0000000000d1', 'note', 'PLANTED-SECRET a' || chr(c) || 'b'), '22023', 'body_chars',
      'PLANTED-SECRET');
  end loop;
  -- Tab and line feed are fine; CRLF is stored as LF.
  insert into public.activities (company_id, type, body)
  values ('32000000-0000-0000-0000-0000000000d1', 'note', E'col1\tcol2\r\nnext line\nlast') returning id into v;
  if (select body from public.activities where id = v) <> E'col1\tcol2\nnext line\nlast' then
    raise exception 'FAIL: tab, LF and CRLF handling';
  end if;
end $$;

-- The CHECKs behind the guard (superuser, no claims: the guard steps aside, the table still refuses).
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
do $$
declare
  ins constant text := 'insert into public.activities (org_id, company_id, type, outcome, body) select org_id, id, %L, %L, %L from public.companies where id = ''32000000-0000-0000-0000-0000000000d1''';
begin
  perform pg_temp.expect_error(format(ins, 'call', null, null), '23514');
  perform pg_temp.expect_error(format(ins, 'note', 'sent', null), '23514');
  perform pg_temp.expect_error(format(ins, 'email', 'no_answer', null), '23514');
  perform pg_temp.expect_error(format(ins, 'note', null, 'a' || chr(8238) || 'b'), '23514');
  perform pg_temp.expect_error(format(ins, 'note', null, 'a' || chr(13) || 'b'), '23514');
  perform pg_temp.expect_error(format(ins, 'note', null, repeat('x', 10001)), '23514');
  perform pg_temp.expect_ok(format(ins, 'call', 'connected', E'a\tb\nc'));
end $$;

-- 6. Flood guards: 60 entries and 60 tasks a minute per person (threat 32) --------------------------------------------
-- Rep e1 does nothing else, so its counts are exact. The first block also shows older entries do not count.
begin;
insert into public.activities (org_id, company_id, type, user_id, created_at)
select c.org_id, c.id, 'note', '00000000-0000-0000-0000-0000000000e1', now() - interval '61 seconds'
  from public.companies c, generate_series(1, 60) where c.id = '32000000-0000-0000-0000-0000000000e1';
set local role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1', 'aal2'); end $$;
do $$ begin
  for i in 1..60 loop
    insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000e1', 'note');
  end loop;
  perform pg_temp.expect_error($q$insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000e1', 'note')$q$,
                               '22023', 'rate_limited');
  perform pg_temp.expect_error($q$insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000b1', 'note')$q$,
                               '22023', 'rate_limited');
  for i in 1..60 loop
    insert into public.tasks (company_id, title) values ('32000000-0000-0000-0000-0000000000e1', 'Task ' || i);
  end loop;
  perform pg_temp.expect_error($q$insert into public.tasks (title) values ('One too many')$q$, '22023', 'rate_limited');
end $$;
rollback;

-- 7. Request ids are unique per author, never across authors (threat 10) ---------------------------------------------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2'); end $$;
do $$ begin
  insert into public.activities (company_id, type, request_id)
  values ('32000000-0000-0000-0000-0000000000d1', 'note', 'aaaaaaaa-0000-4000-8000-000000000001');
  perform pg_temp.expect_error($q$insert into public.activities (company_id, type, request_id) values ('32000000-0000-0000-0000-0000000000d1', 'note', 'aaaaaaaa-0000-4000-8000-000000000001')$q$, '23505');
  insert into public.tasks (company_id, title, request_id)
  values ('32000000-0000-0000-0000-0000000000d1', 'Request task', 'aaaaaaaa-0000-4000-8000-000000000002');
  perform pg_temp.expect_error($q$insert into public.tasks (company_id, title, request_id) values ('32000000-0000-0000-0000-0000000000d1', 'Again', 'aaaaaaaa-0000-4000-8000-000000000002')$q$, '23505');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2'); end $$;
do $$ begin
  -- request_id_other_author_no_collision
  insert into public.activities (company_id, type, request_id)
  values ('32000000-0000-0000-0000-0000000000b1', 'note', 'aaaaaaaa-0000-4000-8000-000000000001');
  insert into public.tasks (company_id, title, request_id)
  values ('32000000-0000-0000-0000-0000000000b1', 'Request task', 'aaaaaaaa-0000-4000-8000-000000000002');
end $$;

-- 8. Deleting a contact, a deal, an entry or a person keeps the history; deleting a lead takes everything (threat 5) --
-- Rep d1 and rep b1 log with contact Bea on b1's lead; b1 adds a task for Bea.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2'); end $$;
do $$
declare v uuid;
begin
  insert into public.activities (company_id, contact_id, type, outcome)
  values ('32000000-0000-0000-0000-0000000000b1', '12000000-0000-0000-0000-0000000000b2', 'call', 'voicemail')
  returning id into v;
  perform set_config('t.d_bea_call', v::text, false);
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$
declare
  v uuid;
  t uuid;
  n int;
begin
  insert into public.activities (company_id, contact_id, type, body)
  values ('32000000-0000-0000-0000-0000000000b1', '12000000-0000-0000-0000-0000000000b2', 'note', 'Bea likes blue')
  returning id into v;
  insert into public.tasks (company_id, contact_id, title)
  values ('32000000-0000-0000-0000-0000000000b1', '12000000-0000-0000-0000-0000000000b2', 'Send Bea the list')
  returning id into t;
  -- contact_delete_keeps_activities: the lead's owner deletes the contact with a fresh code. A colleague's call that
  -- mentions her stays too (the referential update runs as the table owner, not under b1's policies).
  delete from public.contacts where id = '12000000-0000-0000-0000-0000000000b2';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: the owner could not delete a contact with history'; end if;
  if (select count(*) from public.activities
       where id in (v, current_setting('t.d_bea_call')::uuid) and contact_id is null) <> 2 then
    raise exception 'FAIL: deleting a contact lost or kept the link on its entries';
  end if;
  if (select contact_id from public.tasks where id = t) is not null or not exists (select 1 from public.tasks where id = t) then
    raise exception 'FAIL: deleting a contact lost its task or kept the link';
  end if;
  if (select body from public.activities where id = v) <> 'Bea likes blue' then
    raise exception 'FAIL: deleting a contact changed an entry';
  end if;
end $$;
-- deal_delete_keeps_activities (the admin deletes the deal).
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare n int;
begin
  delete from public.deals where id = '42000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: the admin could not delete a deal with history'; end if;
  if (select row(deal_id, contact_id, body) from public.activities where id = '52000000-0000-0000-0000-0000000000b1')
     is distinct from row(null::uuid, '12000000-0000-0000-0000-0000000000b1'::uuid, 'with a deal'::text) then
    raise exception 'FAIL: deleting a deal lost its entry or kept the link';
  end if;
end $$;
-- lead_delete_with_contact_activities: lead F, with a contact, entries on that contact and a task, goes as one.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2'); end $$;
do $$ begin
  insert into public.activities (company_id, contact_id, type, outcome)
  values ('32000000-0000-0000-0000-0000000000f1', '12000000-0000-0000-0000-0000000000f1', 'call', 'interested');
  insert into public.activities (company_id, type, body) values ('32000000-0000-0000-0000-0000000000f1', 'note', 'F note');
  insert into public.tasks (company_id, contact_id, title)
  values ('32000000-0000-0000-0000-0000000000f1', '12000000-0000-0000-0000-0000000000f1', 'Call Fred');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare n int;
begin
  delete from public.companies where id = '32000000-0000-0000-0000-0000000000f1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: the admin could not delete a lead with contacts, entries and tasks'; end if;
  if exists (select 1 from public.activities where company_id = '32000000-0000-0000-0000-0000000000f1')
     or exists (select 1 from public.tasks where company_id = '32000000-0000-0000-0000-0000000000f1')
     or exists (select 1 from public.contacts where company_id = '32000000-0000-0000-0000-0000000000f1') then
    raise exception 'FAIL: a deleted lead left entries, tasks or contacts behind';
  end if;
end $$;
-- Deleting an entry keeps the task made from it (source_activity_id becomes empty).
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$
declare
  v uuid;
  t uuid;
begin
  insert into public.activities (company_id, type, outcome)
  values ('32000000-0000-0000-0000-0000000000b1', 'call', 'interested') returning id into v;
  insert into public.tasks (company_id, title, kind, source_activity_id)
  values ('32000000-0000-0000-0000-0000000000b1', 'Follow up', 'call', v) returning id into t;
  if (select source_activity_id from public.tasks where id = t) <> v then raise exception 'FAIL: task from an entry'; end if;
  delete from public.activities where id = v;
  if not exists (select 1 from public.tasks where id = t and source_activity_id is null) then
    raise exception 'FAIL: deleting an entry lost its task or kept the link';
  end if;
end $$;
-- A person leaves (their login is deleted): their entries and tasks stay, with the links emptied. Run with an admin's
-- claims, so the guards see a signed-in caller and must recognise the referential updates.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f1', 'aal2'); end $$;
do $$ begin
  insert into public.activities (company_id, type, body) values ('32000000-0000-0000-0000-0000000000d1', 'note', 'by Fay');
  insert into public.tasks (company_id, title) values ('32000000-0000-0000-0000-0000000000d1', 'Fay''s task');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2'); end $$;
do $$ begin
  insert into public.tasks (company_id, title, assignee_id)
  values ('32000000-0000-0000-0000-0000000000d1', 'For Fay', '00000000-0000-0000-0000-0000000000f1');
end $$;
reset role;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2'); end $$;
delete from auth.users where id = '00000000-0000-0000-0000-0000000000f1';
do $$ begin
  if not exists (select 1 from public.activities where body = 'by Fay' and user_id is null)
     or not exists (select 1 from public.tasks where title = 'Fay''s task' and created_by is null and assignee_id is null)
     or not exists (select 1 from public.tasks where title = 'For Fay' and assignee_id is null
                      and created_by = '00000000-0000-0000-0000-00000000000a') then
    raise exception 'FAIL: deleting a person lost their entries or tasks, or kept the links';
  end if;
end $$;

-- 9. Last activity when an entry is deleted (D9, threat 6) -----------------------------------------------------------
-- Lead P has the sheet's date (15 Jan 2026) and no entries. Rep b1 logs twice, in two transactions.
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$
declare v uuid;
begin
  insert into public.activities (company_id, type, outcome) values ('32000000-0000-0000-0000-0000000000a7', 'call', 'no_answer')
  returning id into v;
  perform set_config('t.p1', v::text, false);
end $$;
do $$
declare v uuid;
begin
  insert into public.activities (company_id, type, outcome) values ('32000000-0000-0000-0000-0000000000a7', 'call', 'voicemail')
  returning id into v;
  perform set_config('t.p2', v::text, false);
end $$;
do $$
declare
  p1 record;
  p2 record;
  sheet constant timestamptz := timestamptz '2026-01-15 10:00:00+00';
begin
  select created_at, prev_last_activity_at into p1 from public.activities where id = current_setting('t.p1')::uuid;
  select created_at, prev_last_activity_at into p2 from public.activities where id = current_setting('t.p2')::uuid;
  if p1.created_at >= p2.created_at
     or (select last_activity_at from public.companies where id = '32000000-0000-0000-0000-0000000000a7') <> p2.created_at then
    raise exception 'FAIL: logging did not move the lead''s date to the newest entry';
  end if;
  -- Both remember the sheet's date: the second carries it forward from the first.
  if p1.prev_last_activity_at is distinct from sheet or p2.prev_last_activity_at is distinct from sheet then
    raise exception 'FAIL: previous dates %, % (expected the sheet''s)', p1.prev_last_activity_at, p2.prev_last_activity_at;
  end if;
  perform pg_temp.expect_error($q$insert into public.activities (company_id, type, prev_last_activity_at) values ('32000000-0000-0000-0000-0000000000a7', 'note', now())$q$, '42501');
  -- delete_old_entry_keeps_date
  delete from public.activities where id = current_setting('t.p1')::uuid;
  if (select last_activity_at from public.companies where id = '32000000-0000-0000-0000-0000000000a7') <> p2.created_at then
    raise exception 'FAIL: deleting an older entry moved the lead''s date';
  end if;
  -- undo_restores_previous_date: the last entry goes, so the date goes back to the sheet's (not to the deleted first
  -- entry's time, and not to empty).
  delete from public.activities where id = current_setting('t.p2')::uuid;
  if (select last_activity_at from public.companies where id = '32000000-0000-0000-0000-0000000000a7') is distinct from sheet then
    raise exception 'FAIL: deleting the last entry left the date at %',
      (select last_activity_at from public.companies where id = '32000000-0000-0000-0000-0000000000a7');
  end if;
end $$;
-- Newest of two deleted: the date goes back to the other entry (the newest remaining), not to the sheet's.
do $$
declare v uuid;
begin
  insert into public.activities (company_id, type, outcome) values ('32000000-0000-0000-0000-0000000000a7', 'call', 'no_answer')
  returning id into v;
  perform set_config('t.p3', v::text, false);
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2', 30); end $$;
do $$
declare
  v uuid;
  p3_at timestamptz := (select created_at from public.activities where id = current_setting('t.p3')::uuid);
begin
  -- Rep d1 may log on b1's lead, cannot change it, but deleting their own entry still puts its date back: the untouch
  -- trigger runs as the table owner.
  insert into public.activities (company_id, type, body) values ('32000000-0000-0000-0000-0000000000a7', 'note', 'd1 on P')
  returning id into v;
  if (select last_activity_at from public.companies where id = '32000000-0000-0000-0000-0000000000a7') <> now() then
    raise exception 'FAIL: d1''s entry did not move the date';
  end if;
  delete from public.activities where id = v;
  if (select last_activity_at from public.companies where id = '32000000-0000-0000-0000-0000000000a7') <> p3_at then
    raise exception 'FAIL: deleting the newest entry should go back to the newest remaining one';
  end if;
end $$;
-- Two entries with the same time (one transaction): deleting one keeps the date.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$
declare
  v uuid;
  w uuid;
begin
  insert into public.activities (company_id, type, body) values ('32000000-0000-0000-0000-0000000000a7', 'note', 'twin 1')
  returning id into v;
  insert into public.activities (company_id, type, body) values ('32000000-0000-0000-0000-0000000000a7', 'note', 'twin 2')
  returning id into w;
  delete from public.activities where id = v;
  if (select last_activity_at from public.companies where id = '32000000-0000-0000-0000-0000000000a7') <> now() then
    raise exception 'FAIL: deleting one of two same-time entries moved the date';
  end if;
  perform set_config('t.twin', w::text, false);
end $$;

-- 10. Tasks: the server keeps who and when; done and dismissed are switches (threats 3, 7, G3) -----------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2'); end $$;
do $$
declare
  r record;
  v uuid;
begin
  insert into public.tasks (company_id, contact_id, title, kind, due_date)
  values ('32000000-0000-0000-0000-0000000000b1', '12000000-0000-0000-0000-0000000000b1', 'Call Basile back', 'call',
          current_date + 1)
  returning id into v;
  select assignee_id, created_by, done_at, completed_by, cancelled_at into r from public.tasks where id = v;
  if r.assignee_id <> '00000000-0000-0000-0000-0000000000d1' or r.created_by <> '00000000-0000-0000-0000-0000000000d1'
     or r.done_at is not null or r.completed_by is not null or r.cancelled_at is not null then
    raise exception 'FAIL: a new task (assignee, creator, open): %', row_to_json(r);
  end if;
  perform set_config('t.task1', v::text, false);
  insert into public.tasks (title) values ('   Buy stamps  ') returning id into v;  -- a personal task
  if (select row(title, company_id, kind) from public.tasks where id = v)
     is distinct from row('Buy stamps'::text, null::uuid, 'todo'::text) then
    raise exception 'FAIL: a personal task (trimmed title, no lead, kind todo)';
  end if;
  perform set_config('t.task2', v::text, false);
  -- task_created_by_forced: server columns cannot be named.
  perform pg_temp.expect_error($q$insert into public.tasks (title, created_by) values ('x', '00000000-0000-0000-0000-0000000000b1')$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.tasks (title, done_at) values ('x', now())$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.tasks (title, completed_by) values ('x', '00000000-0000-0000-0000-0000000000b1')$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.tasks (title, cancelled_at) values ('x', now())$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.tasks (title, deal_id) values ('x', null)$q$, '42501');
  -- A rep cannot give a task to a colleague.
  perform pg_temp.expect_error($q$insert into public.tasks (title, assignee_id) values ('x', '00000000-0000-0000-0000-0000000000b1')$q$, '42501');
end $$;

-- task_done_at_is_server_time, and the switch semantics, one transaction at a time.
do $$
declare r record;
begin
  update public.tasks set done_at = timestamptz '2000-01-01 00:00:00+00' where id = current_setting('t.task1')::uuid;
  select done_at, completed_by into r from public.tasks where id = current_setting('t.task1')::uuid;
  if r.done_at <> now() or r.completed_by <> '00000000-0000-0000-0000-0000000000d1' then
    raise exception 'FAIL: done takes the server''s time and the caller: %', row_to_json(r);
  end if;
  perform set_config('t.task1_done', r.done_at::text, false);
end $$;
do $$
declare r record;
begin
  -- Done again with another time: no change (the client never chooses the time).
  update public.tasks set done_at = timestamptz '2031-01-01 00:00:00+00' where id = current_setting('t.task1')::uuid;
  select done_at, completed_by into r from public.tasks where id = current_setting('t.task1')::uuid;
  if r.done_at <> current_setting('t.task1_done')::timestamptz then
    raise exception 'FAIL: a done task took a client time';
  end if;
  -- Done and dismissed at once: refused either way round.
  perform pg_temp.expect_error(format('update public.tasks set cancelled_at = now() where id = %L', current_setting('t.task1')),
                               '22023', 'state');
  update public.tasks set done_at = null where id = current_setting('t.task1')::uuid;
  select done_at, completed_by into r from public.tasks where id = current_setting('t.task1')::uuid;
  if r.done_at is not null or r.completed_by is not null then raise exception 'FAIL: reopening a task'; end if;
  update public.tasks set cancelled_at = timestamptz '2000-01-01 00:00:00+00' where id = current_setting('t.task1')::uuid;
  if (select cancelled_at from public.tasks where id = current_setting('t.task1')::uuid) <> now() then
    raise exception 'FAIL: dismissing takes the server''s time';
  end if;
  perform pg_temp.expect_error(format('update public.tasks set done_at = now() where id = %L', current_setting('t.task1')),
                               '22023', 'state');
  update public.tasks set cancelled_at = timestamptz '2031-01-01 00:00:00+00' where id = current_setting('t.task1')::uuid;
  if (select cancelled_at from public.tasks where id = current_setting('t.task1')::uuid) <> now() then
    raise exception 'FAIL: a dismissed task took a client time';
  end if;
  update public.tasks set cancelled_at = null where id = current_setting('t.task1')::uuid;
  if (select cancelled_at from public.tasks where id = current_setting('t.task1')::uuid) is not null then
    raise exception 'FAIL: undoing a dismiss';
  end if;
end $$;

-- Immutables, the title, the kind and the dates (constant errors).
do $$
declare
  stmt text;
  t1 constant text := current_setting('t.task1');
begin
  foreach stmt in array array[
    'update public.tasks set created_by = ''00000000-0000-0000-0000-0000000000b1'' where id = %L',
    'update public.tasks set company_id = ''32000000-0000-0000-0000-0000000000d1'' where id = %L',
    'update public.tasks set kind = ''todo'' where id = %L',
    'update public.tasks set source_activity_id = null where id = %L',
    'update public.tasks set request_id = gen_random_uuid() where id = %L',
    'update public.tasks set completed_by = ''00000000-0000-0000-0000-0000000000d1'' where id = %L',
    'update public.tasks set created_at = now() where id = %L',
    'update public.tasks set updated_at = now() where id = %L',
    'update public.tasks set deal_id = null where id = %L'] loop
    perform pg_temp.expect_error(format(stmt, t1), '42501');
  end loop;
  perform pg_temp.expect_error($q$insert into public.tasks (title) values ('   ')$q$, '22023', 'task_title');
  perform pg_temp.expect_error($q$insert into public.tasks (title) values (null)$q$, '22023', 'task_title');
  perform pg_temp.expect_error(format('insert into public.tasks (title) values (%L)', 'PLANTED-SECRET' || repeat('t', 290)),
                               '22023', 'task_title', 'PLANTED-SECRET');
  perform pg_temp.expect_error(format('insert into public.tasks (title) values (%L)', 'PLANTED-SECRET' || chr(10) || 'x'),
                               '22023', 'task_title', 'PLANTED-SECRET');
  perform pg_temp.expect_error(format('insert into public.tasks (title) values (%L)', 'PLANTED-SECRET' || chr(8297) || 'x'),
                               '22023', 'task_title', 'PLANTED-SECRET');
  perform pg_temp.expect_error(format('update public.tasks set title = %L where id = %L', 'PLANTED-SECRET' || chr(1), t1),
                               '22023', 'task_title', 'PLANTED-SECRET');
  perform pg_temp.expect_ok(format('insert into public.tasks (title) values (%L)', repeat('t', 300)));
  perform pg_temp.expect_error($q$insert into public.tasks (title, kind) values ('PLANTED-SECRET', 'chore')$q$, '22023', 'task_kind', 'PLANTED-SECRET');
  perform pg_temp.expect_error($q$insert into public.tasks (title, kind) values ('x', null)$q$, '22023', 'task_kind');
  perform pg_temp.expect_error($q$insert into public.tasks (title, due_date, due_at) values ('PLANTED-SECRET', current_date, now())$q$, '22023', 'task_due', 'PLANTED-SECRET');
  perform pg_temp.expect_error($q$insert into public.tasks (title, kind) values ('PLANTED-SECRET', 'meeting')$q$, '22023', 'task_due', 'PLANTED-SECRET');
  perform pg_temp.expect_error($q$insert into public.tasks (title, kind, due_date) values ('x', 'meeting', current_date)$q$, '22023', 'task_due');
  perform pg_temp.expect_ok($q$insert into public.tasks (title, kind, due_at) values ('Meet', 'meeting', now() + interval '1 day')$q$);
  perform pg_temp.expect_error($q$insert into public.tasks (title, due_date) values ('PLANTED-SECRET', current_date + 2000)$q$, '22023', 'bounds', 'PLANTED-SECRET');
  perform pg_temp.expect_error($q$insert into public.tasks (title, due_at) values ('x', now() - interval '6 years')$q$, '22023', 'bounds');
  perform pg_temp.expect_ok($q$insert into public.tasks (title, due_date) values ('x', current_date + 1800)$q$);
  perform pg_temp.expect_error(format('update public.tasks set due_date = current_date + 2000 where id = %L', t1), '22023', 'bounds');
  perform pg_temp.expect_error(format('update public.tasks set due_at = now() where id = %L', t1), '22023', 'task_due');
end $$;

-- An overdue date from long ago stays editable: dates are checked only when they change.
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
update public.tasks set due_date = current_date - 2500 where id = current_setting('t.task1')::uuid;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2'); end $$;
do $$ begin
  update public.tasks set title = 'Call Basile back (late)' where id = current_setting('t.task1')::uuid;
  if (select title from public.tasks where id = current_setting('t.task1')::uuid) <> 'Call Basile back (late)' then
    raise exception 'FAIL: an overdue task could not be renamed';
  end if;
end $$;

-- The task guard on its own (superuser with d1's claims): server columns sent anyway are replaced, immutables refused.
reset role;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2'); end $$;
do $$
declare
  r record;
  stmt text;
begin
  begin
    insert into public.tasks (company_id, title, created_by, done_at, completed_by, cancelled_at)
    values ('32000000-0000-0000-0000-0000000000d1', 'Forged', '00000000-0000-0000-0000-0000000000b1', now(),
            '00000000-0000-0000-0000-0000000000b1', now())
    returning created_by, done_at, completed_by, cancelled_at, assignee_id into r;
    if r.created_by <> '00000000-0000-0000-0000-0000000000d1' or r.done_at is not null or r.completed_by is not null
       or r.cancelled_at is not null or r.assignee_id <> '00000000-0000-0000-0000-0000000000d1' then
      raise exception 'FAIL: the task guard kept a server column: %', row_to_json(r);
    end if;
    raise exception 'probe undone' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  foreach stmt in array array[
    'update public.tasks set created_by = ''00000000-0000-0000-0000-0000000000b1'' where id = %L',
    'update public.tasks set created_by = null where id = %L',
    'update public.tasks set company_id = ''32000000-0000-0000-0000-0000000000d1'' where id = %L',
    'update public.tasks set kind = ''todo'' where id = %L',
    'update public.tasks set source_activity_id = gen_random_uuid() where id = %L',
    'update public.tasks set request_id = gen_random_uuid() where id = %L',
    'update public.tasks set created_at = now() - interval ''1 day'' where id = %L'] loop
    perform pg_temp.expect_error(format(stmt, current_setting('t.task1')), '42501', 'not_editable');
  end loop;
  -- completed_by follows done_at only.
  update public.tasks set completed_by = '00000000-0000-0000-0000-0000000000b1' where id = current_setting('t.task1')::uuid;
  if (select completed_by from public.tasks where id = current_setting('t.task1')::uuid) is not null then
    raise exception 'FAIL: completed_by changed without done_at';
  end if;
end $$;

-- The CHECKs behind the task guard (superuser, no claims).
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
do $$
declare
  ins constant text := 'insert into public.tasks (org_id, %s) select id, %s from public.orgs where name = ''TopStock Wholesale''';
begin
  perform pg_temp.expect_error(format(ins, 'title, due_date, due_at', '''x'', current_date, now()'), '23514');
  perform pg_temp.expect_error(format(ins, 'title, kind', '''x'', ''meeting'''), '23514');
  perform pg_temp.expect_error(format(ins, 'title, done_at, cancelled_at', '''x'', now(), now()'), '23514');
  perform pg_temp.expect_error(format(ins, 'title, contact_id', '''x'', ''12000000-0000-0000-0000-0000000000b1'''), '23514');
  perform pg_temp.expect_error(format(ins, 'title', quote_literal('a' || chr(8238) || 'b')), '23514');
  perform pg_temp.expect_error(format(ins, 'title, kind', '''x'', ''chore'''), '23514');
end $$;

-- source_activity_id: only the caller's own entry, on the same lead, logged in the last 10 seconds.
-- An entry by rep b1 from 11 seconds ago (the superuser may date it).
insert into public.activities (id, org_id, company_id, type, outcome, user_id, created_at)
select '52000000-0000-0000-0000-0000000000b2', org_id, id, 'call', 'no_answer', '00000000-0000-0000-0000-0000000000b1',
       now() - interval '11 seconds'
  from public.companies where id = '32000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2'); end $$;
do $$
declare v uuid;
begin
  insert into public.activities (company_id, type, outcome) values ('32000000-0000-0000-0000-0000000000b1', 'call', 'interested')
  returning id into v;
  perform set_config('t.b_source', v::text, false);
  perform pg_temp.expect_ok(format('insert into public.tasks (company_id, title, source_activity_id) values (%L, %L, %L)',
                                   '32000000-0000-0000-0000-0000000000b1', 'From my call', v));
  -- Same entry, another lead; same entry, no lead; an entry too old.
  perform pg_temp.expect_error(format('insert into public.tasks (company_id, title, source_activity_id) values (%L, %L, %L)',
                                      '32000000-0000-0000-0000-0000000000d1', 'Elsewhere', v), '42501', 'source');
  perform pg_temp.expect_error(format('insert into public.tasks (title, source_activity_id) values (%L, %L)', 'Personal', v),
                               '42501', 'source');
  perform pg_temp.expect_error($q$insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000b1', 'Old', '52000000-0000-0000-0000-0000000000b2')$q$,
                               '42501', 'source');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2'); end $$;
do $$ begin
  -- A colleague's fresh entry on the same lead.
  perform pg_temp.expect_error(format('insert into public.tasks (company_id, title, source_activity_id) values (%L, %L, %L)',
    '32000000-0000-0000-0000-0000000000b1', 'Not mine', current_setting('t.b_source')), '42501', 'source');
end $$;

-- Who sees and changes a task (D11): the assignee, the creator, managers and admins.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2'); end $$;
do $$
declare n int;
begin
  -- The admin gives d1's task to b1: d1 still sees it as its creator.
  update public.tasks set assignee_id = '00000000-0000-0000-0000-0000000000b1' where id = current_setting('t.task1')::uuid;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: the admin could not reassign a task'; end if;
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2'); end $$;
do $$
declare n int;
begin
  if not exists (select 1 from public.tasks where id = current_setting('t.task1')::uuid) then
    raise exception 'FAIL: the creator lost sight of a task given to a colleague';
  end if;
  -- other_org_task_invisible, and b1's own task (assignee b1, made by the fixtures) is not d1's to see.
  if exists (select 1 from public.tasks where id in ('60000000-0000-0000-0000-0000000000b1', '60000000-0000-0000-0000-0000000000c1')) then
    raise exception 'FAIL: rep d1 sees a task that is neither theirs nor made by them';
  end if;
  update public.tasks set title = 'hacked' where id = '60000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: rep d1 changed rep b1''s task'; end if;
  -- Writes point only at a lead of the org and at a contact of the task's own lead.
  perform pg_temp.expect_error(format('update public.tasks set contact_id = %L where id = %L',
                                      '12000000-0000-0000-0000-0000000000d1', current_setting('t.task1')), '42501');
  perform pg_temp.expect_error(format('update public.tasks set contact_id = %L where id = %L',
                                      '12000000-0000-0000-0000-0000000000b1', current_setting('t.task2')), '42501');
  perform pg_temp.expect_error($q$insert into public.tasks (company_id, title) values ('30000000-0000-0000-0000-0000000000c1', 'x')$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.tasks (company_id, contact_id, title) values ('32000000-0000-0000-0000-0000000000d1', '12000000-0000-0000-0000-0000000000b1', 'x')$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.tasks (contact_id, title) values ('12000000-0000-0000-0000-0000000000d1', 'x')$q$, '42501');
  perform pg_temp.expect_ok(format('update public.tasks set contact_id = null where id = %L', current_setting('t.task1')));
end $$;
-- task_delete_stale_code_denied: deleting needs a fresh code.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2'); end $$;
do $$
declare n int;
begin
  delete from public.tasks where id = current_setting('t.task2')::uuid;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a task deleted without a code'; end if;
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2', 660); end $$;
do $$
declare n int;
begin
  delete from public.tasks where id = current_setting('t.task2')::uuid;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a task deleted with a code older than 10 minutes'; end if;
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2', 30); end $$;
do $$
declare n int;
begin
  delete from public.tasks where id in ('60000000-0000-0000-0000-0000000000b1', '60000000-0000-0000-0000-0000000000c1');
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: rep d1 deleted a task that is not theirs'; end if;
  delete from public.tasks where id = current_setting('t.task2')::uuid;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: the owner of a task could not delete it with a fresh code'; end if;
end $$;

-- 11. Deleting an entry needs a fresh code, and only the author, a manager or an admin (threat 8) --------------------
do $$
declare
  n int;
  who record;
begin
  for who in select * from (values
      ('00000000-0000-0000-0000-0000000000b1', null::integer, 'no code'),
      ('00000000-0000-0000-0000-0000000000b1', 660, 'a code older than 10 minutes'),
      ('00000000-0000-0000-0000-0000000000d1', 30, 'a colleague with a fresh code')) as w (sub, age, label) loop
    perform pg_temp.as_user(who.sub, 'aal2', who.age);
    delete from public.activities where id = current_setting('t.b_note')::uuid;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: an entry deleted with %', who.label; end if;
  end loop;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  delete from public.activities where id = current_setting('t.b_note')::uuid;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: the author could not delete an entry with a fresh code'; end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  delete from public.activities where id = current_setting('t.d_note')::uuid;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: an admin could not delete a colleague''s entry with a fresh code'; end if;
end $$;

-- 12. The audit log keeps no copy of an entry's text (D8, threat 30) ------------------------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$
declare v uuid;
begin
  insert into public.activities (company_id, type, body)
  values ('32000000-0000-0000-0000-0000000000d1', 'note', 'AUDIT-MARKER first words') returning id into v;
  perform set_config('t.audited', v::text, false);
end $$;
do $$ begin
  update public.activities set body = 'AUDIT-MARKER second, longer words' where id = current_setting('t.audited')::uuid;
end $$;
do $$ begin
  delete from public.activities where id = current_setting('t.audited')::uuid;
end $$;
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
do $$
declare
  v constant text := current_setting('t.audited');
  upd jsonb;
  del jsonb;
begin
  -- audit_activity_insert_not_logged: no activity insert was ever copied (every entry in these tests is after Day 4a).
  if exists (select 1 from public.audit_log where table_name = 'activities' and action = 'insert') then
    raise exception 'FAIL: an activity insert was copied into the audit log';
  end if;
  select diff_json into upd from public.audit_log where table_name = 'activities' and action = 'update' and record_id = v;
  if upd is distinct from jsonb_build_object('body', jsonb_build_object('changed', true, 'old_len', 24, 'new_len', 33))
                          || jsonb_build_object('edited_at', upd -> 'edited_at')
     or upd -> 'edited_at' -> 'new' = 'null'::jsonb then
    raise exception 'FAIL: an edit should be audited as the text''s lengths and edited_at: %', upd;
  end if;
  -- audit_activity_delete_has_no_body
  select diff_json -> 'old' into del from public.audit_log where table_name = 'activities' and action = 'delete' and record_id = v;
  if del ? 'body' or (del ->> 'body_len')::integer <> 33 or del ->> 'type' <> 'note'
     or del ->> 'user_id' <> '00000000-0000-0000-0000-0000000000b1' then
    raise exception 'FAIL: a deleted entry should be audited without its text, with its length: %', del;
  end if;
  if exists (select 1 from public.audit_log where strpos(diff_json::text, 'AUDIT-MARKER') > 0
                                               or strpos(diff_json::text, 'Bea likes blue') > 0
                                               or strpos(diff_json::text, 'line one') > 0) then
    raise exception 'FAIL: activity text found in the audit log';
  end if;
  -- Emptied links are audited like any change; tasks are still audited in full.
  if not exists (select 1 from public.audit_log where table_name = 'activities' and action = 'update'
                   and diff_json -> 'contact_id' ->> 'old' = '12000000-0000-0000-0000-0000000000b2') then
    raise exception 'FAIL: an entry losing its contact was not audited';
  end if;
  if not exists (select 1 from public.audit_log where table_name = 'tasks' and action = 'insert'
                   and record_id = current_setting('t.task1')) then
    raise exception 'FAIL: a new task was not audited';
  end if;
end $$;

-- 13. Undoing an import keeps a lead that has a task (G7, import_undo_keeps_lead_with_task) --------------------------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  batch uuid;
  r jsonb;
begin
  batch := public.create_lead_import('day4a-task.csv', null, 2, 3);
  perform public.stage_lead_import_rows(batch, '[{"row_no": 2, "name": "Day4a Import One", "lead_status": "cold"},
                                                 {"row_no": 3, "name": "Day4a Import Two", "lead_status": "cold"}]');
  perform public.validate_lead_import(batch);
  r := public.commit_lead_import(batch);
  if r ->> 'status' <> 'imported' then raise exception 'FAIL: import %', r; end if;
  insert into public.tasks (company_id, title)
  select id, 'Call the buyer' from public.companies where import_batch_id = batch and name = 'Day4a Import One';
  r := public.preview_lead_import_rollback(batch);
  if r <> '{"tagged": 2, "removable": 1, "kept": 1}'::jsonb then raise exception 'FAIL: undo preview with a task %', r; end if;
  r := public.rollback_lead_import(batch);
  if r ->> 'status' <> 'rolled_back' or (r ->> 'kept')::integer <> 1
     or not exists (select 1 from public.companies where import_batch_id = batch and name = 'Day4a Import One')
     or exists (select 1 from public.companies where import_batch_id = batch and name = 'Day4a Import Two') then
    raise exception 'FAIL: undo removed the lead with a task, or kept the other: %', r;
  end if;
end $$;

-- 14. Another organisation sees and touches none of this (threat 2) --------------------------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1', 'aal2', 30); end $$;
do $$
declare n int;
begin
  if exists (select 1 from public.activities where org_id <> '00000000-0000-0000-0000-0000000000cc')
     or exists (select 1 from public.tasks where org_id <> '00000000-0000-0000-0000-0000000000cc') then
    raise exception 'FAIL: other_org_activity_invisible / other_org_task_invisible';
  end if;
  perform pg_temp.expect_error($q$insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000b1', 'note')$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.tasks (company_id, title) values ('32000000-0000-0000-0000-0000000000b1', 'x')$q$, '42501');
  update public.activities set body = 'x' where id = current_setting('t.b_call')::uuid;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: another org changed an entry'; end if;
  delete from public.tasks where id = current_setting('t.task1')::uuid;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: another org deleted a task'; end if;
end $$;
reset role;

\echo 'activity_attack: all checks passed'
