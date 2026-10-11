-- Day 4a: activity hardening (database only; design docs/evidence/day4/design.md sections 3.1 and 6, decisions D8 and
-- D9). Before this migration the dev database had no activities, tasks or files (read-only check, docs/log.md).
-- What changes, in plain words:
--  - the author of every activity is the person signed in (no one, not even an admin, logs as a colleague);
--  - after it is logged, only the text of an entry can change, only by its author, and the change is marked "edited";
--  - deleting a contact or a deal keeps the calls and notes that mention it (the link becomes empty);
--  - deleting or undoing the newest entry puts the lead's "last activity" back to the previous date (D9);
--  - tasks get a lead, a kind, an all-day date, who created and completed them, and "dismissed"; clients write only
--    the task fields they choose, and "done" or "dismissed" are switches whose time the server sets;
--  - the audit log no longer keeps a second copy of activity text (D8);
--  - undoing an import keeps every lead that has a task.
-- House rules (design section 3): every function sets search_path = ''; the guards are SECURITY INVOKER (only the
-- untouch trigger, like the touch trigger it mirrors, and the lead lock before the guard are DEFINER, trigger-only and
-- revoked); static SQL only; every CHECK that user input can reach
-- has a pre-check with a constant message first, so "Failing row contains ..." never reaches the logs; clients get
-- column grants only, and server-kept columns are set by BEFORE triggers (they need no column privilege).
-- Files are unchanged here: they move to the lead, with their own guards, in 4d.

-- ===========================================================================
-- Part 1. Activities (gaps G1, G2, G5)
-- ===========================================================================
alter table public.activities
  add column request_id uuid,                    -- idempotency key from the browser, unique per author (used from 4b)
  add column edited_at timestamptz,              -- set by the guard when the text changes
  add column prev_last_activity_at timestamptz,  -- the lead's date before the entries still standing; guard-set, no grant
  drop constraint activities_outcome_check,      -- was char_length(outcome) <= 60
  -- Each kind of entry takes only its own outcomes. A call must have one ("outcome is not null": an IN list with a
  -- null outcome is null, and a CHECK lets null through).
  add constraint activities_outcome_fits_type check (
       (type = 'call' and outcome is not null and outcome in ('no_answer', 'voicemail', 'wrong_number',
                                                              'not_interested', 'interested', 'meeting_booked',
                                                              'do_not_contact', 'connected'))
    or (type in ('email', 'whatsapp') and (outcome is null or outcome = 'sent'))
    or (type = 'meeting' and (outcome is null or outcome in ('held', 'no_show')))
    or (type = 'note' and outcome is null)),
  -- Tab and line feed only: no other control character (C0, DEL or C1, as Day 3b's file names), and no bidi
  -- embedding, override or isolate, so a note cannot reorder the text shown next to it. Joiners such as U+200D, which
  -- emoji need, stay allowed. Code point ranges, so the rule is the same under any database locale.
  add constraint activities_body_safe check (body is null or body !~ '[\u0001-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]');

-- Timeline pages walk (created_at, id) newest first on one lead; the author index serves the rate guard, "my calls
-- today" and the user_id foreign key; the request index makes a replayed request find its first result.
drop index public.activities_company_idx, public.activities_user_idx, public.activities_org_user_idx;
create index activities_company_keyset_idx on public.activities (company_id, created_at desc, id desc);
create index activities_user_created_idx on public.activities (user_id, created_at desc);
create unique index activities_author_request_idx on public.activities (user_id, request_id) where request_id is not null;

-- Deleting a contact or a deal no longer deletes the history that mentions it (G5).
alter table public.activities
  drop constraint activities_contact_id_fkey,
  add constraint activities_contact_id_fkey foreign key (contact_id) references public.contacts (id) on delete set null,
  drop constraint activities_deal_id_fkey,
  add constraint activities_deal_id_fkey foreign key (deal_id) references public.deals (id) on delete set null;

-- Clients name only these columns (G2). The author, times, org and the previous date are the server's.
-- deal_id returns to the insert grant on Day 5, with a policy that requires the deal to belong to the same lead.
revoke insert, update on public.activities from authenticated;
grant insert (company_id, contact_id, type, outcome, body, request_id), update (body) on public.activities to authenticated;

-- Entries on one lead take turns (D9 under concurrency). An insert locks its lead before the guard reads the lead's
-- date, and the untouch trigger below locks it before it looks for the newest remaining entry, so each sees the entries
-- the other committed: two deletes or undos at once on one lead, or an entry whose transaction started before the
-- newest entry and is still open when that one is deleted, leave the lead on a date a remaining entry supports. The
-- name sorts before activity_guard, so it runs first. DEFINER, because a SELECT ... FOR NO KEY UPDATE as the caller
-- would quietly lock nothing on a lead the caller may log on but not change (row level security, spike S5 (b)). It
-- reads and changes nothing; FOR NO KEY UPDATE does not block the foreign key checks (FOR KEY SHARE) on the lead.
create function private.lock_activity_lead() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.companies c where c.id = new.company_id for no key update;
  return new;
end;
$$;
create trigger activity_date_lock before insert on public.activities
  for each row execute function private.lock_activity_lead();

-- The activity guard. Its name sorts before enforce_org_and_owner and set_activity_time, so it runs right after the
-- lock. Sessions with no signed-in user (fixtures, maintenance, imports by the service) are left alone, as Day 3a's
-- triggers do, except that their entries get the D9 previous date too, so the chain below holds after them.
create function private.activity_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  changed text[];
  base timestamptz;
  inherited timestamptz;
begin
  if tg_op = 'INSERT' then
    -- D9, for every session: the lead's date before any entry still standing. It is the lead's current date, unless an
    -- entry set that date: then it is that entry's own previous date, carried forward (for example the date from the
    -- import). So deleting entries in any order puts the lead back on a date a remaining entry, or the sheet, supports.
    base := (select c.last_activity_at from public.companies c where c.id = new.company_id);
    if base is not null then
      select a.prev_last_activity_at into inherited
        from public.activities a
       where a.company_id = new.company_id and a.created_at = base
       order by a.id
       limit 1;
      if found then
        base := inherited;
      end if;
    end if;
    if caller is null then
      -- A maintenance session keeps a previous date it gives (history it imports); otherwise it gets the chain's.
      new.prev_last_activity_at := coalesce(new.prev_last_activity_at, base);
      return new;
    end if;
    new.prev_last_activity_at := base;
    new.user_id := caller;  -- G1: always the person signed in
    new.edited_at := null;
    new.body := replace(new.body, E'\r\n', E'\n');
    if not coalesce(
           (new.type = 'call' and new.outcome in ('no_answer', 'voicemail', 'wrong_number', 'not_interested',
                                                  'interested', 'meeting_booked', 'do_not_contact', 'connected'))
        or (new.type in ('email', 'whatsapp') and (new.outcome is null or new.outcome = 'sent'))
        or (new.type = 'meeting' and (new.outcome is null or new.outcome in ('held', 'no_show')))
        or (new.type = 'note' and new.outcome is null), false) then
      raise exception 'this outcome does not fit this kind of entry' using errcode = '22023', hint = 'outcome';
    end if;
    -- Flood guard: at most 60 entries a minute per person (one short range read on activities_user_created_idx).
    if (select count(*) from (select 1 from public.activities a
                               where a.user_id = caller and a.created_at > now() - interval '60 seconds'
                               limit 60) recent) >= 60 then
      raise exception 'too many entries in a minute' using errcode = '22023', hint = 'rate_limited';
    end if;
  elsif caller is null then
    return new;
  else
    -- The columns this statement changes (updated_at is kept by its own trigger).
    select coalesce(array_agg(n.key order by n.key), '{}') into changed
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value and n.key <> 'updated_at';
    -- A referential SET NULL from a contact, deal or profile delete runs one trigger level down (spike S5: depth 2)
    -- and only empties those links. Anything else at that depth, and any direct change, goes through the rule below.
    if pg_trigger_depth() > 1 and changed <@ array['contact_id', 'deal_id', 'user_id']
       and (new.contact_id is null or new.contact_id is not distinct from old.contact_id)
       and (new.deal_id is null or new.deal_id is not distinct from old.deal_id)
       and (new.user_id is null or new.user_id is not distinct from old.user_id) then
      return new;
    end if;
    if changed <> '{}' and not changed <@ array['body'] then
      raise exception 'only the text of an entry can change' using errcode = '42501', hint = 'not_editable';
    end if;
    new.body := replace(new.body, E'\r\n', E'\n');
    if new.body is not distinct from old.body then
      return new;
    end if;
    new.edited_at := now();
  end if;

  -- The text, on insert and when it changes. Constant messages: the text never reaches the logs.
  if char_length(new.body) > 10000 then
    raise exception 'the text is too long' using errcode = '22023', hint = 'body_too_long';
  end if;
  if new.body ~ '[\u0001-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]' then
    raise exception 'the text contains characters that are not allowed' using errcode = '22023', hint = 'body_chars';
  end if;
  return new;
end;
$$;
create trigger activity_guard before insert or update on public.activities
  for each row execute function private.activity_guard();

-- Policies: the insert and update rules are replaced; select stays org-wide; require_mfa stays.
drop policy activities_insert on public.activities;
drop policy activities_update on public.activities;
-- No manager exception (G1): the author is the caller, and the contact belongs to the same lead.
create policy activities_insert on public.activities for insert to authenticated with check (
  org_id = (select private.current_org_id()) and user_id = (select auth.uid())
  and exists (select 1 from public.companies c where c.id = activities.company_id)
  and (contact_id is null or exists (select 1 from public.contacts k
       where k.id = activities.contact_id and k.company_id = activities.company_id)));
-- Nobody edits a colleague's words, not even an admin.
create policy activities_update on public.activities for update to authenticated
  using (org_id = (select private.current_org_id()) and user_id = (select auth.uid()))
  with check (org_id = (select private.current_org_id()) and user_id = (select auth.uid()));
-- activities_delete stays as Day 3a (a fresh code; the author, a manager or an admin) until 4b adds the undo branch.

-- Last activity on delete (D9, reverses Day 3a's "deleting leaves the date as it was"). When the deleted entry is the
-- one that set the lead's date, the date moves back to the newest remaining entry, or to the date the lead had before
-- the entries (prev_last_activity_at), whichever is later. prev_last_activity_at is guard-set and never granted, so
-- neither a delete nor an undo can move a lead's date anywhere the history does not support. Deleting an older entry
-- changes nothing; in a lead delete the lead row is already gone, so the update finds nothing. DEFINER like
-- touch_company_activity, so deleting an entry on a lead someone else owns still corrects its date; trigger-only,
-- revoked from everyone below. It locks the lead first and looks in a statement of its own: under READ COMMITTED that
-- statement sees every delete and insert the lock waited for (see lock_activity_lead above).
create function private.untouch_company_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.companies c where c.id = old.company_id for no key update;
  update public.companies c
     set last_activity_at = greatest((select max(a.created_at) from public.activities a where a.company_id = old.company_id),
                                     old.prev_last_activity_at)
   where c.id = old.company_id and c.last_activity_at = old.created_at;
  return null;
end;
$$;
create trigger untouch_company_activity after delete on public.activities
  for each row execute function private.untouch_company_activity();

-- ===========================================================================
-- Part 2. Tasks (gaps G3, G5, G7)
-- ===========================================================================
alter table public.tasks
  add column company_id uuid references public.companies (id) on delete cascade,  -- the lead; null: a personal task
  add column kind text not null default 'todo' check (kind in ('todo', 'call', 'meeting')),
  add column due_date date,                                                         -- all-day: a calendar date, no zone
  add column created_by uuid references public.profiles (id) on delete set null,
  add column completed_by uuid,                                                     -- no FK, like audit_log.actor_id
  add column cancelled_at timestamptz,                                              -- "Dismiss": reversible, no code
  add column source_activity_id uuid references public.activities (id) on delete set null,
  add column request_id uuid;
update public.tasks t set company_id = k.company_id from public.contacts k where k.id = t.contact_id;  -- dev: 0 rows
alter table public.tasks
  drop constraint tasks_contact_id_fkey,
  add constraint tasks_contact_id_fkey foreign key (contact_id) references public.contacts (id) on delete set null,
  add constraint tasks_one_due check (due_date is null or due_at is null),
  add constraint tasks_meeting_timed check (kind <> 'meeting' or due_at is not null),
  add constraint tasks_not_done_and_cancelled check (done_at is null or cancelled_at is null),
  add constraint tasks_contact_needs_lead check (contact_id is null or company_id is not null),
  add constraint tasks_title_safe check (title !~ '[\u0001-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]');
create index tasks_company_idx on public.tasks (company_id);                  -- FK, import undo, the lead page
-- The creator's tasks by time: the created_by foreign key and the task flood guard (one short range read).
create index tasks_created_by_idx on public.tasks (created_by, created_at);
create index tasks_source_activity_idx on public.tasks (source_activity_id) where source_activity_id is not null;
create unique index tasks_creator_request_idx on public.tasks (created_by, request_id) where request_id is not null;

revoke insert, update on public.tasks from authenticated;
grant insert (company_id, contact_id, title, kind, due_date, due_at, assignee_id, source_activity_id, request_id),
      update (title, due_date, due_at, assignee_id, contact_id, done_at, cancelled_at) on public.tasks to authenticated;

-- The task guard. Its name sorts after enforce_org_and_owner('assignee_id') (which keeps reps to themselves and checks
-- that an assignee is in the org) and set_updated_at. Sessions with no signed-in user are left alone.
create function private.task_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller constant uuid := (select auth.uid());
  changed text[];
  check_title boolean := true;
  check_due boolean := true;
begin
  if caller is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := caller;
    new.done_at := null;
    new.completed_by := null;
    new.cancelled_at := null;
    new.assignee_id := coalesce(new.assignee_id, caller);
    if new.kind is null or new.kind not in ('todo', 'call', 'meeting') then
      raise exception 'unknown kind of task' using errcode = '22023', hint = 'task_kind';
    end if;
    -- A follow-up made from an entry: the caller's own entry, on the same lead, logged in the last 10 seconds
    -- (log_activity, 4b, makes both in one transaction).
    if new.source_activity_id is not null and not exists (
         select 1 from public.activities a
          where a.id = new.source_activity_id and a.user_id = caller and a.company_id = new.company_id
            and a.created_at > now() - interval '10 seconds') then
      raise exception 'a task can only come from your own entry on this lead, just logged'
        using errcode = '42501', hint = 'source';
    end if;
    -- Flood guard: at most 60 tasks a minute per person.
    if (select count(*) from (select 1 from public.tasks t
                               where t.created_by = caller and t.created_at > now() - interval '60 seconds'
                               limit 60) recent) >= 60 then
      raise exception 'too many tasks in a minute' using errcode = '22023', hint = 'rate_limited';
    end if;
  else
    select coalesce(array_agg(n.key order by n.key), '{}') into changed
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value and n.key <> 'updated_at';
    -- A referential SET NULL from a contact, entry or profile delete (spike S5), as in the activity guard.
    if pg_trigger_depth() > 1 and changed <@ array['assignee_id', 'contact_id', 'created_by', 'source_activity_id']
       and (new.assignee_id is null or new.assignee_id is not distinct from old.assignee_id)
       and (new.contact_id is null or new.contact_id is not distinct from old.contact_id)
       and (new.created_by is null or new.created_by is not distinct from old.created_by)
       and (new.source_activity_id is null or new.source_activity_id is not distinct from old.source_activity_id) then
      return new;
    end if;
    -- Only the granted fields may change; who made the task, its lead, kind, source and request never do.
    if not changed <@ array['assignee_id', 'cancelled_at', 'completed_by', 'contact_id', 'done_at', 'due_at',
                            'due_date', 'title'] then
      raise exception 'this part of a task cannot change' using errcode = '42501', hint = 'not_editable';
    end if;
    -- Done and dismissed are switches: the client turns them on or off, the server sets the time and who did it.
    if old.done_at is null and new.done_at is not null then
      new.done_at := now();
      new.completed_by := caller;
    elsif old.done_at is not null and new.done_at is null then
      new.completed_by := null;
    else
      new.done_at := old.done_at;
      new.completed_by := old.completed_by;
    end if;
    if old.cancelled_at is null and new.cancelled_at is not null then
      new.cancelled_at := now();
    elsif not (old.cancelled_at is not null and new.cancelled_at is null) then
      new.cancelled_at := old.cancelled_at;
    end if;
    if new.done_at is not null and new.cancelled_at is not null then
      raise exception 'a task cannot be done and dismissed at once' using errcode = '22023', hint = 'state';
    end if;
    check_title := new.title is distinct from old.title;
    check_due := new.due_date is distinct from old.due_date or new.due_at is distinct from old.due_at;
  end if;

  -- Constant messages before the CHECKs, so a title never reaches the logs.
  if check_title then
    new.title := btrim(new.title);
    if new.title is null or char_length(new.title) not between 1 and 300
       or new.title ~ '[\u0001-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]' then
      raise exception 'a task title needs 1 to 300 characters, without control characters'
        using errcode = '22023', hint = 'task_title';
    end if;
  end if;
  if check_due then
    if new.due_date is not null and new.due_at is not null then
      raise exception 'a task has a date or a time, not both' using errcode = '22023', hint = 'task_due';
    end if;
    if new.kind = 'meeting' and new.due_at is null then
      raise exception 'a meeting needs a time' using errcode = '22023', hint = 'task_due';
    end if;
    if new.due_date not between (now() - interval '5 years')::date and (now() + interval '5 years')::date
       or new.due_at not between now() - interval '5 years' and now() + interval '5 years' then
      raise exception 'the date is out of range' using errcode = '22023', hint = 'bounds';
    end if;
  end if;
  return new;
end;
$$;
create trigger task_guard before insert or update on public.tasks
  for each row execute function private.task_guard();

-- Policies (replace tasks_rw). Who sees a task stays as today, plus its creator (D11): the assignee, the creator,
-- managers and admins. Writes may only point at a lead of the org, and at a contact of that same lead.
drop policy tasks_rw on public.tasks;
create policy tasks_select on public.tasks for select to authenticated using (
  org_id = (select private.current_org_id())
  and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin())));
create policy tasks_insert on public.tasks for insert to authenticated with check (
  org_id = (select private.current_org_id())
  and ((select private.is_manager_or_admin()) or assignee_id = (select auth.uid()))
  and (company_id is null or exists (select 1 from public.companies c where c.id = tasks.company_id))
  and (contact_id is null or exists (select 1 from public.contacts k
       where k.id = tasks.contact_id and k.company_id = tasks.company_id)));
create policy tasks_update on public.tasks for update to authenticated
  using (org_id = (select private.current_org_id())
         and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin())))
  with check (org_id = (select private.current_org_id())
              and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin()))
              and (company_id is null or exists (select 1 from public.companies c where c.id = tasks.company_id))
              and (contact_id is null or exists (select 1 from public.contacts k
                   where k.id = tasks.contact_id and k.company_id = tasks.company_id)));
-- Deleting needs a fresh code (4b adds an undo branch).
create policy tasks_delete on public.tasks for delete to authenticated using (
  org_id = (select private.current_org_id()) and (select private.has_recent_aal2(600))
  and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin())));

-- ===========================================================================
-- Part 3. Audit (G6, D8) and import undo (G7)
-- ===========================================================================
-- Same as Day 3b, plus activities (D8): a new entry gets no audit row (the entry is its own record: author and time
-- are set by the server, and only its text can change later); an edit records the text's lengths, not the text; a
-- deleted entry is kept without its text, with its length. So the audit log never holds a second copy of a note.
-- Values are read from the row as jsonb because this trigger is shared by every table.
create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  hidden constant text[] := array['search_text', 'email_key', 'phone_key', 'name_key'];
  is_activity constant boolean := tg_table_name = 'activities';
  rec jsonb := (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) - hidden;
  diff jsonb;
begin
  if is_activity and tg_op = 'INSERT' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
      into diff
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value
       and n.key not in ('updated_at', 'last_activity_at')
       and not n.key = any (hidden)
       and not (is_activity and n.key = 'body');
    if is_activity and (to_jsonb(new) -> 'body') is distinct from (to_jsonb(old) -> 'body') then
      diff := coalesce(diff, '{}'::jsonb) || jsonb_build_object('body', jsonb_build_object(
                'changed', true, 'old_len', char_length(to_jsonb(old) ->> 'body'),
                'new_len', char_length(to_jsonb(new) ->> 'body')));
    end if;
    if diff is null then
      return new;
    end if;
  elsif tg_op = 'INSERT' and tg_table_name = 'companies' and rec ->> 'import_batch_id' is not null then
    diff := jsonb_build_object('import_batch_id', rec -> 'import_batch_id');
  elsif tg_op = 'INSERT' then
    diff := jsonb_build_object('new', rec);
  elsif tg_table_name = 'companies' and rec ->> 'import_batch_id' is not null
        and rec ->> 'updated_at' = rec ->> 'created_at'
        and exists (select 1 from public.import_batches b
                    where b.id = (rec ->> 'import_batch_id')::uuid and b.status = 'rolling_back') then
    diff := jsonb_build_object('import_batch_id', rec -> 'import_batch_id', 'undo', true);
  elsif is_activity then
    diff := jsonb_build_object('old', (rec - 'body') || jsonb_build_object('body_len', char_length(rec ->> 'body')));
  else
    diff := jsonb_build_object('old', rec);
  end if;
  insert into public.audit_log (org_id, actor_id, action, table_name, record_id, diff_json)
  values ((rec ->> 'org_id')::uuid, (select auth.uid()), lower(tg_op), tg_table_name, rec ->> 'id', diff);
  return coalesce(new, old);
end;
$$;

-- Import undo (G7): a lead with a task has been worked on, so an undo keeps it. Same definition as Day 3b otherwise.
create or replace function private.lead_import_untouched(p_batch uuid, p_limit integer) returns setof uuid
language sql stable set search_path = '' as $$
  select c.id from public.companies c
   where c.import_batch_id = p_batch and c.updated_at = c.created_at
     and not exists (select 1 from public.activities a where a.company_id = c.id)
     and not exists (select 1 from public.contacts k where k.company_id = c.id)
     and not exists (select 1 from public.deals d where d.company_id = c.id)
     and not exists (select 1 from public.tasks t where t.company_id = c.id)
   order by c.id
   limit p_limit
$$;

-- ===========================================================================
-- Function privileges: trigger functions are never callable by clients.
-- ===========================================================================
revoke all on function private.activity_guard(), private.task_guard(), private.untouch_company_activity(),
  private.lock_activity_lead() from public, anon, authenticated;
