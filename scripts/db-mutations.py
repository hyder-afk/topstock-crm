#!/usr/bin/env python3
"""Local only: proves the database tests catch each protection being removed (Day 3b design section 6A, Day 4 design
section 8.3).

For each mutation below, one or more migrations are changed in place, scripts/db-test.sh runs (migrations, the RLS,
import and activity attack tests, the two-session test, advisors), and the migrations are restored. A mutation is
"caught" when the run fails. Never run it in a checkout someone else is reading: use a separate copy (git worktree).
Usage: python3 scripts/db-mutations.py [--set day3b|day4a|all] [numbers...]  (about 30 s per mutation; default: all
sets, numbers apply within one set). Writes one Markdown table per set to stdout, then a count line per set; exits 1
when a row does not behave as listed. A protection with two layers is also removed together with its second layer (one
mutation each way). A row marked SURVIVES is such a layer that no test can see on its own, because the other layer stops
the same thing: it must stay NOT CAUGHT, and the row removing both layers must be caught.
An edit is (old, new) on the set's own migration, or (path, old, new) on another one. Day 4a redefines the import
"untouched" rule and the audit trigger, so the Day 3b mutations of those two functions edit the Day 4a migration.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIG_3A = ROOT / "supabase/migrations/20261010090000_leads_are_companies.sql"
MIG_3B = ROOT / "supabase/migrations/20261010150000_lead_import.sql"
MIG_4A = ROOT / "supabase/migrations/20261011120000_activity_hardening.sql"
SURVIVES = "survives"  # a documented layer behind another one (see above)

MUTATIONS_3B = [
    ("Working rows: insert without a fresh code",
     [("              and (select private.has_recent_aal2(600))\n              and exists (select 1 from public.import_batches b\n",
       "              and exists (select 1 from public.import_batches b\n")]),
    ("Working rows: read without a fresh code",
     [("create policy staging_select on private.lead_import_staging for select to authenticated\n  using (org_id = (select private.current_org_id()) and (select private.is_admin())\n         and (select private.has_recent_aal2(600)));",
       "create policy staging_select on private.lead_import_staging for select to authenticated\n  using (org_id = (select private.current_org_id()) and (select private.is_admin()));")]),
    ("Working rows: row number past the file's end",
     [("                            and lead_import_staging.row_no between 2 and b.last_row_no));", "));")]),
    ("Tagging leads: no admin check",
     [("      and (select private.is_admin()) and (select private.has_recent_aal2(600))\n      and (last_activity_at is null",
       "      and (select private.has_recent_aal2(600))\n      and (last_activity_at is null")], SURVIVES),
    ("Tagging leads: no admin check in the rule nor in who sees imports (both layers)",
     [("      and (select private.is_admin()) and (select private.has_recent_aal2(600))\n      and (last_activity_at is null",
       "      and (select private.has_recent_aal2(600))\n      and (last_activity_at is null"),
      ("create policy import_batches_select on public.import_batches for select to authenticated\n  using (org_id = (select private.current_org_id()) and (select private.is_admin()));",
       "create policy import_batches_select on public.import_batches for select to authenticated\n  using (org_id = (select private.current_org_id()));")]),
    ("Tagging leads: no fresh-code check",
     [("      and (select private.is_admin()) and (select private.has_recent_aal2(600))\n      and (last_activity_at is null",
       "      and (select private.is_admin())\n      and (last_activity_at is null")]),
    ("Tagging leads: import need not be in progress",
     [("b.kind = 'leads' and b.status = 'committing'\n", "b.kind = 'leads'\n")]),
    ("Tagging leads: any last-activity date",
     [("      and (last_activity_at is null\n           or (last_activity_at >= timestamptz '1989-12-31 00:00:00+00' and last_activity_at <= now()))\n",
       "")]),
    ("Tagging leads: date bound 1 Jan 1990 UTC (refuses 1 Jan 1990 in Paris)",
     [("last_activity_at >= timestamptz '1989-12-31 00:00:00+00'", "last_activity_at >= timestamptz '1990-01-01 00:00:00+00'")]),
    ("Check: dates compared in UTC instead of local time",
     [("                       or s.last_activity_local < timestamp '1990-01-01 00:00:00') then 'date_out_of_range'",
       "                       or s.last_activity_local at time zone b.source_timezone < timestamptz '1989-12-31 00:00:00+00') then 'date_out_of_range'")]),
    ("Tagging leads: into someone else's import",
     [("\n                    and b.uploaded_by = (select auth.uid()))));", ")));")]),
    ("Import history: no organisation check",
     [("create policy import_batches_select on public.import_batches for select to authenticated\n  using (org_id = (select private.current_org_id()) and (select private.is_admin()));",
       "create policy import_batches_select on public.import_batches for select to authenticated\n  using ((select private.is_admin()));")]),
    ("Import status: changeable without a fresh code",
     [("create policy import_batches_update on public.import_batches for update to authenticated\n  using (org_id = (select private.current_org_id()) and (select private.is_admin())\n         and (select private.has_recent_aal2(600)))",
       "create policy import_batches_update on public.import_batches for update to authenticated\n  using (org_id = (select private.current_org_id()) and (select private.is_admin()))")]),
    ("Import counters: client may write one",
     [("grant update (status) on public.import_batches to authenticated;",
       "grant update (status, imported) on public.import_batches to authenticated;")]),
    ("File name: zero-width and bidi characters allowed (controls only)",
     [("'[\\u0001-\\u001F\\u007F-\\u009F\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\uFFF9-\\uFFFB\\U000E0000-\\U000E007F/\\\\]'",
       "'[[:cntrl:]/\\\\]'")]),
    ("Batch guard trigger dropped",
     [("create trigger import_batch_guard before insert or update on public.import_batches\n  for each row execute function private.import_batch_guard();", "")]),
    ("One import at a time: index not unique",
     [("create unique index import_batches_one_writer_idx", "create index import_batches_one_writer_idx")]),
    ("Undo: leads with an activity count as untouched",
     [(MIG_4A, "     and not exists (select 1 from public.activities a where a.company_id = c.id)\n", "")]),
    ("Undo: leads with a contact count as untouched",
     [(MIG_4A, "     and not exists (select 1 from public.contacts k where k.company_id = c.id)\n", "")]),
    ("Undo: leads with a deal count as untouched",
     [(MIG_4A, "     and not exists (select 1 from public.deals d where d.company_id = c.id)\n", "")]),
    ("Undo: edited leads count as untouched",
     [(MIG_4A, "c.import_batch_id = p_batch and c.updated_at = c.created_at", "c.import_batch_id = p_batch")]),
    ("Undo: no second look before deleting (race with a new contact)",
     [("   where c.id = any (v_ids) and c.id in (select private.lead_import_untouched(p_batch, p_max_rows));",
       "   where c.id = any (v_ids);")]),
    ("Undo: a short chunk counts as the end (race with a deleted lead)",
     [(" and not exists (select 1 from private.lead_import_untouched(p_batch, 1));", ";")]),
    ("Import: no re-check for leads added meanwhile",
     [("case when not p.bad and p.email_key is not null then\n             (select c.id from public.companies c where c.org_id = b.org_id and c.email_key = p.email_key\n               order by c.created_at, c.id limit 1) end as ex_email,",
       "null::uuid as ex_email,")]),
    ("Import: someone else may run it",
     [("    raise exception 'only the person who started this import can import it' using errcode = '42501';\n  end if;\n  if b.status = 'imported' then",
       "    null;\n  end if;\n  if b.status = 'imported' then")]),
    ("Add rows: no constant-error pre-check",
     [("     where r.row_no is null or r.row_no !~ '^[0-9]{1,6}$' or r.row_no::integer not between 2 and b.last_row_no",
       "     where false and (r.row_no is null or r.row_no !~ '^[0-9]{1,6}$' or r.row_no::integer not between 2 and b.last_row_no"),
      ("'country_dropped']))))\n  ) then", "'country_dropped'])))))\n  ) then")]),
    ("Functions: no fresh-code check (hint step_up)",
     [("  if p_fresh and not private.has_recent_aal2(600) then", "  if false then")]),
    ("Audit: full copy of imported leads",
     [(MIG_4A, "  elsif tg_op = 'INSERT' and tg_table_name = 'companies' and rec ->> 'import_batch_id' is not null then\n    diff := jsonb_build_object('import_batch_id', rec -> 'import_batch_id');\n", "")]),
    ("Audit: search and key columns kept",
     [(MIG_4A, "(case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) - hidden;",
       "(case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end);")]),
    ("Working rows kept after the import",
     [("  if new.status in ('discarded', 'imported', 'rolling_back', 'rolled_back') then",
       "  if new.status in ('discarded', 'rolling_back', 'rolled_back') then")]),
    ("Working rows kept after a direct discard",
     [("  if new.status in ('discarded', 'imported', 'rolling_back', 'rolled_back') then",
       "  if new.status in ('imported', 'rolling_back', 'rolled_back') then"),
      ("  update public.import_batches set status = 'discarded' where id = p_batch;  -- the guard deletes the working rows\n",
       "  update public.import_batches set status = 'discarded' where id = p_batch;\n  delete from private.lead_import_staging where batch_id = p_batch;\n")]),
    ("Working rows kept when an undo starts directly",
     [("  if new.status in ('discarded', 'imported', 'rolling_back', 'rolled_back') then",
       "  if new.status in ('discarded', 'imported', 'rolled_back') then"),
      ("      update public.import_batches set status = 'rolling_back' where id = p_batch;  -- the guard deletes the working rows\n",
       "      update public.import_batches set status = 'rolling_back' where id = p_batch;\n      delete from private.lead_import_staging where batch_id = p_batch;\n")]),
    ("Import: running total is this call's count, not the leads tagged so far",
     [("  select count(*) into v_total from public.companies c where c.import_batch_id = p_batch;\n  return jsonb_build_object('status', case when v_remaining",
       "  v_total := v_imported;\n  return jsonb_build_object('status', case when v_remaining")]),
    ("Import history: a paused import shows the counter (0), not the leads added",
     [("           case when b.status in ('committing', 'rolling_back')\n                then (select count(*)::integer from public.companies c where c.import_batch_id = b.id)\n                else b.imported end,\n",
       "           b.imported,\n")]),
    ("Undo of a paused import: working rows deleted before they are counted",
     [("    new.rolled_back_by := caller;\n",
       "    new.rolled_back_by := caller;\n    delete from private.lead_import_staging s where s.batch_id = new.id;\n")]),
    ("Name rule: a phone too short to be a key counts as no phone (chain shops merged)",
     [("st.db_problem, st.phone is not null as has_phone", "st.db_problem, st.phone_key is not null as has_phone")]),
    ("Counters not recounted at the end of an import",
     [("    tally := private.lead_import_tally(new.id);\n    new.imported := (tally ->> 'imported')::integer;\n    new.imported_at := now();",
       "    tally := old.issue_counts;\n    new.imported := old.imported;\n    new.imported_at := now();")]),
]


# Day 4a (activity hardening). Rows 1 to 13 are the design's list (section 8.3, 4a), in order; the rest remove, one at a
# time, the other protections listed in docs/evidence/day4a/mutations.md (that file says what the list covers).
MUTATIONS_4A = [
    ("Activities insert policy: manager exception back (G1)",
     [("with check (\n  org_id = (select private.current_org_id()) and user_id = (select auth.uid())\n  and exists (select 1 from public.companies c where c.id = activities.company_id)",
       "with check (\n  org_id = (select private.current_org_id()) and ((select private.is_manager_or_admin()) or user_id = (select auth.uid()))\n  and exists (select 1 from public.companies c where c.id = activities.company_id)")]),
    ("Activity guard: author line dropped",
     [("    new.user_id := caller;  -- G1: always the person signed in\n", "")]),
    ("Activities: update grant on outcome too",
     [("update (body) on public.activities to authenticated;", "update (body, outcome) on public.activities to authenticated;")]),
    ("Activity guard: link-emptying exception without the depth condition (a direct update to null passes)",
     [("    if pg_trigger_depth() > 1 and changed <@ array['contact_id', 'deal_id', 'user_id']",
       "    if changed <@ array['contact_id', 'deal_id', 'user_id']")]),
    ("Activity guard: no link-emptying exception (a contact delete must then fail)",
     [("    if pg_trigger_depth() > 1 and changed <@ array['contact_id', 'deal_id', 'user_id']",
       "    if false and changed <@ array['contact_id', 'deal_id', 'user_id']")]),
    ("Activities delete: no fresh code (Day 3a policy)",
     [(MIG_3A, "create policy activities_delete on public.activities for delete to authenticated\n  using (org_id = (select private.current_org_id()) and (select private.has_recent_aal2(600))\n",
       "create policy activities_delete on public.activities for delete to authenticated\n  using (org_id = (select private.current_org_id())\n")]),
    ("Last activity on delete: newest remaining entry only (previous date ignored)",
     [("greatest((select max(a.created_at) from public.activities a where a.company_id = old.company_id),\n                                     old.prev_last_activity_at)",
       "(select max(a.created_at) from public.activities a where a.company_id = old.company_id)")]),
    ("Activities: contact FK back to cascade",
     [("foreign key (contact_id) references public.contacts (id) on delete set null,\n  drop constraint activities_deal_id_fkey",
       "foreign key (contact_id) references public.contacts (id) on delete cascade,\n  drop constraint activities_deal_id_fkey")]),
    ("Audit: a deleted entry keeps its text",
     [("    diff := jsonb_build_object('old', (rec - 'body') || jsonb_build_object('body_len', char_length(rec ->> 'body')));\n",
       "    diff := jsonb_build_object('old', rec);\n")]),
    ("Import undo: leads with a task count as untouched",
     [("     and not exists (select 1 from public.tasks t where t.company_id = c.id)\n", "")]),
    ("Task guard: keeps the client's done_at",
     [("      new.done_at := now();\n      new.completed_by := caller;\n", "      new.completed_by := caller;\n")]),
    ("Task guard: the source entry need not be the caller's",
     [("a.id = new.source_activity_id and a.user_id = caller and a.company_id", "a.id = new.source_activity_id and a.company_id")]),
    ("Activity guard: no flood guard",
     [("limit 60) recent) >= 60 then\n      raise exception 'too many entries in a minute'",
       "limit 60) recent) > 60 then\n      raise exception 'too many entries in a minute'")]),
    # Beyond the design's list.
    ("Task guard: no flood guard",
     [("limit 60) recent) >= 60 then\n      raise exception 'too many tasks in a minute'",
       "limit 60) recent) > 60 then\n      raise exception 'too many tasks in a minute'")]),
    ("Activities: insert grant on user_id too",
     [("grant insert (company_id, contact_id, type, outcome, body, request_id), update (body)",
       "grant insert (company_id, contact_id, type, outcome, body, request_id, user_id), update (body)")]),
    ("Activity guard: the client's edited_at kept on insert",
     [("    new.edited_at := null;\n", "")]),
    ("Activity guard: previous date not set",
     [("    new.prev_last_activity_at := base;\n", "")]),
    ("Activity guard: previous date not carried forward (the design's literal rule)",
     [("      if found then\n        base := inherited;\n      end if;\n", "")]),
    ("Last activity on delete: runs as the caller",
     [("create function private.untouch_company_activity() returns trigger\nlanguage plpgsql security definer set search_path",
       "create function private.untouch_company_activity() returns trigger\nlanguage plpgsql set search_path")]),
    ("Last activity on delete: previous date only (remaining entries ignored)",
     [("greatest((select max(a.created_at) from public.activities a where a.company_id = old.company_id),\n                                     old.prev_last_activity_at)",
       "old.prev_last_activity_at")]),
    ("Activities: deal FK back to cascade",
     [("foreign key (deal_id) references public.deals (id) on delete set null;",
       "foreign key (deal_id) references public.deals (id) on delete cascade;")]),
    ("Activity guard: any column editable",
     [("    if changed <> '{}' and not changed <@ array['body'] then", "    if false then")]),
    ("Activity guard: an edit is not marked",
     [("    new.edited_at := now();\n  end if;\n", "  end if;\n")]),
    ("Activities update policy: managers and admins edit any entry (Day 3a rule)",
     [("  using (org_id = (select private.current_org_id()) and user_id = (select auth.uid()))\n  with check (org_id = (select private.current_org_id()) and user_id = (select auth.uid()));",
       "  using (org_id = (select private.current_org_id()) and ((select private.is_manager_or_admin()) or user_id = (select auth.uid())))\n  with check (org_id = (select private.current_org_id()) and ((select private.is_manager_or_admin()) or user_id = (select auth.uid())));")]),
    ("Activities insert policy: a contact of another lead",
     [("  and exists (select 1 from public.companies c where c.id = activities.company_id)\n  and (contact_id is null or exists (select 1 from public.contacts k\n       where k.id = activities.contact_id and k.company_id = activities.company_id)));",
       "  and exists (select 1 from public.companies c where c.id = activities.company_id));")]),
    ("Activity guard: no outcome pre-check (the CHECK answers with the row)",
     [("      raise exception 'this outcome does not fit this kind of entry' using errcode = '22023', hint = 'outcome';\n", "      null;\n")]),
    ("Activity guard: no text length pre-check",
     [("    raise exception 'the text is too long' using errcode = '22023', hint = 'body_too_long';\n", "    null;\n")]),
    ("Activity guard: no safe-character pre-check",
     [("    raise exception 'the text contains characters that are not allowed' using errcode = '22023', hint = 'body_chars';\n", "    null;\n")]),
    ("Activity guard: CRLF not folded on insert",
     [("    new.edited_at := null;\n    new.body := replace(new.body, E'\\r\\n', E'\\n');\n", "    new.edited_at := null;\n")]),
    ("Activities: a call without an outcome passes the CHECK",
     [("(type = 'call' and outcome is not null and outcome in", "(type = 'call' and outcome in")]),
    ("Activities: no safe-character CHECK",
     [("add constraint activities_body_safe check (body is null or body !~", "add constraint activities_body_safe check (true or body !~")]),
    ("Audit: an edit keeps the text",
     [("       and not (is_activity and n.key = 'body');\n", ";\n"),
      ("    if is_activity and (to_jsonb(new) -> 'body') is distinct from (to_jsonb(old) -> 'body') then", "    if false then")]),
    ("Audit: new entries copied",
     [("  if is_activity and tg_op = 'INSERT' then\n    return new;\n  end if;\n", "")]),
    ("Tasks: contact FK back to cascade",
     [("foreign key (contact_id) references public.contacts (id) on delete set null,\n  add constraint tasks_one_due",
       "foreign key (contact_id) references public.contacts (id) on delete cascade,\n  add constraint tasks_one_due")]),
    ("Task guard: no link-emptying exception (a contact delete must then fail)",
     [("    if pg_trigger_depth() > 1 and changed <@ array['assignee_id', 'contact_id', 'created_by', 'source_activity_id']",
       "    if false and changed <@ array['assignee_id', 'contact_id', 'created_by', 'source_activity_id']")]),
    ("Task guard: link-emptying exception without the depth condition",
     [("    if pg_trigger_depth() > 1 and changed <@ array['assignee_id', 'contact_id', 'created_by', 'source_activity_id']",
       "    if changed <@ array['assignee_id', 'contact_id', 'created_by', 'source_activity_id']")]),
    ("Task guard: link-emptying exception without created_by (the design's list: a person delete fails)",
     [("changed <@ array['assignee_id', 'contact_id', 'created_by', 'source_activity_id']",
       "changed <@ array['assignee_id', 'contact_id', 'source_activity_id']")]),
    ("Task guard: fixed fields editable",
     [("    if not changed <@ array['assignee_id', 'cancelled_at', 'completed_by', 'contact_id', 'done_at', 'due_at',\n                            'due_date', 'title'] then",
       "    if false then")]),
    ("Task guard: creator left to the client",
     [("    new.created_by := caller;\n", "")]),
    ("Task guard: done, completed by and dismissed kept from the client on insert",
     [("    new.done_at := null;\n    new.completed_by := null;\n    new.cancelled_at := null;\n", "")]),
    ("Task guard: no assignee left empty for an admin",
     [("    new.assignee_id := coalesce(new.assignee_id, caller);\n", "")]),
    ("Task guard: a done task takes a new client time",
     [("      new.done_at := old.done_at;\n", "")]),
    ("Task guard: completed_by changes without done",
     [("      new.completed_by := old.completed_by;\n", "")]),
    ("Task guard: dismissed takes the client's time",
     [("      new.cancelled_at := now();\n", "")]),
    ("Task guard: a dismissed task takes a new client time",
     [("    elsif not (old.cancelled_at is not null and new.cancelled_at is null) then\n      new.cancelled_at := old.cancelled_at;\n", "")]),
    ("Task guard: no done-and-dismissed pre-check",
     [("      raise exception 'a task cannot be done and dismissed at once' using errcode = '22023', hint = 'state';\n", "      null;\n")]),
    ("Task guard: no title pre-check",
     [("  if check_title then\n    new.title := btrim(new.title);", "  if false then\n    new.title := btrim(new.title);")]),
    ("Task guard: no kind pre-check",
     [("      raise exception 'unknown kind of task' using errcode = '22023', hint = 'task_kind';\n", "      null;\n")]),
    ("Task guard: no date-or-time pre-check",
     [("      raise exception 'a task has a date or a time, not both' using errcode = '22023', hint = 'task_due';\n", "      null;\n")]),
    ("Task guard: no meeting-time pre-check",
     [("      raise exception 'a meeting needs a time' using errcode = '22023', hint = 'task_due';\n", "      null;\n")]),
    ("Task guard: dates not bounded",
     [("      raise exception 'the date is out of range' using errcode = '22023', hint = 'bounds';\n", "      null;\n")]),
    ("Task guard: dates checked even when unchanged (overdue tasks stuck)",
     [("    check_due := new.due_date is distinct from old.due_date or new.due_at is distinct from old.due_at;\n", "")]),
    ("Task guard: the source entry may be on another lead",
     [("a.user_id = caller and a.company_id = new.company_id\n", "a.user_id = caller\n")]),
    ("Task guard: the source entry may be of any age",
     [("\n            and a.created_at > now() - interval '10 seconds') then", ") then")]),
    ("Tasks select: the creator loses sight of a task given away",
     [("for select to authenticated using (\n  org_id = (select private.current_org_id())\n  and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or",
       "for select to authenticated using (\n  org_id = (select private.current_org_id())\n  and (assignee_id = (select auth.uid()) or")]),
    ("Tasks select: everyone in the org sees every task",
     [("for select to authenticated using (\n  org_id = (select private.current_org_id())\n  and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin())));",
       "for select to authenticated using (\n  org_id = (select private.current_org_id()));")]),
    ("Tasks delete: no fresh code",
     [("create policy tasks_delete on public.tasks for delete to authenticated using (\n  org_id = (select private.current_org_id()) and (select private.has_recent_aal2(600))\n",
       "create policy tasks_delete on public.tasks for delete to authenticated using (\n  org_id = (select private.current_org_id())\n")]),
    ("Tasks insert: a lead of another organisation",
     [("  and ((select private.is_manager_or_admin()) or assignee_id = (select auth.uid()))\n  and (company_id is null or exists (select 1 from public.companies c where c.id = tasks.company_id))\n",
       "  and ((select private.is_manager_or_admin()) or assignee_id = (select auth.uid()))\n")]),
    ("Tasks insert: a contact of another lead",
     [("  and (contact_id is null or exists (select 1 from public.contacts k\n       where k.id = tasks.contact_id and k.company_id = tasks.company_id)));\ncreate policy tasks_update",
       ");\ncreate policy tasks_update")]),
    ("Tasks update: no check on the lead and contact",
     [("              and (company_id is null or exists (select 1 from public.companies c where c.id = tasks.company_id))\n              and (contact_id is null or exists (select 1 from public.contacts k\n                   where k.id = tasks.contact_id and k.company_id = tasks.company_id)));",
       "              );")]),
    ("Tasks: a contact without a lead passes the CHECK",
     [("  add constraint tasks_contact_needs_lead check (contact_id is null or company_id is not null),",
       "  add constraint tasks_contact_needs_lead check (true),")]),
    ("Tasks: insert grant on created_by too",
     [("grant insert (company_id, contact_id, title, kind, due_date, due_at, assignee_id, source_activity_id, request_id),",
       "grant insert (company_id, contact_id, title, kind, due_date, due_at, assignee_id, source_activity_id, request_id, created_by),")]),
    ("Tasks: request id unique across everyone (index on request_id alone)",
     [("create unique index tasks_creator_request_idx on public.tasks (created_by, request_id)",
       "create unique index tasks_creator_request_idx on public.tasks (request_id)")]),
    ("Activities: request id not unique",
     [("create unique index activities_author_request_idx", "create index activities_author_request_idx")]),
    # Review round 1 (docs/log.md, 11 Oct): protections that had a test but no row, or neither.
    ("Activity guard: C1 controls pass the safe-character pre-check",
     [("  if new.body ~ '[\\u0001-\\u0008\\u000B-\\u001F\\u007F-\\u009F", "  if new.body ~ '[\\u0001-\\u0008\\u000B-\\u001F\\u007F")]),
    ("Activities: C1 controls pass the safe-character CHECK",
     [("body !~ '[\\u0001-\\u0008\\u000B-\\u001F\\u007F-\\u009F", "body !~ '[\\u0001-\\u0008\\u000B-\\u001F\\u007F")]),
    ("Task guard: C1 controls pass the title pre-check",
     [("       or new.title ~ '[\\u0001-\\u001F\\u007F-\\u009F", "       or new.title ~ '[\\u0001-\\u001F\\u007F")]),
    ("Tasks: C1 controls pass the title CHECK",
     [("tasks_title_safe check (title !~ '[\\u0001-\\u001F\\u007F-\\u009F", "tasks_title_safe check (title !~ '[\\u0001-\\u001F\\u007F")]),
    ("Last activity on delete: no lead lock (two deletes at once leave a deleted entry's date)",
     [("  perform 1 from public.companies c where c.id = old.company_id for no key update;\n", "")]),
    ("Lead lock on insert: locks nothing (an entry still being logged is missed when the newest is deleted)",
     [("  perform 1 from public.companies c where c.id = new.company_id for no key update;\n", "")]),
    ("Lead lock on insert: runs as the caller (locks nothing on a lead the caller cannot change)",
     [("create function private.lock_activity_lead() returns trigger\nlanguage plpgsql security definer set search_path",
       "create function private.lock_activity_lead() returns trigger\nlanguage plpgsql set search_path")]),
    ("Activity guard: no previous date for sessions with no signed-in user (the chain breaks after them)",
     [("      new.prev_last_activity_at := coalesce(new.prev_last_activity_at, base);\n", "")]),
    ("Last activity on delete: any deleted entry moves the date (not only the one that set it)",
     [("   where c.id = old.company_id and c.last_activity_at = old.created_at;", "   where c.id = old.company_id;")]),
    ("Activity guard: a maintenance session's own previous date replaced",
     [("coalesce(new.prev_last_activity_at, base);", "base;")]),
    ("Activity guard: link-emptying exception lets a link move to another record (depth 2)",
     [("\n       and (new.contact_id is null or new.contact_id is not distinct from old.contact_id)\n       and (new.deal_id is null or new.deal_id is not distinct from old.deal_id)\n       and (new.user_id is null or new.user_id is not distinct from old.user_id) then",
       " then")]),
    ("Activity guard: link-emptying exception lets any column change (depth 2)",
     [("    if pg_trigger_depth() > 1 and changed <@ array['contact_id', 'deal_id', 'user_id']\n",
       "    if pg_trigger_depth() > 1\n")]),
    ("Task guard: link-emptying exception lets a link move to another record (depth 2)",
     [("\n       and (new.assignee_id is null or new.assignee_id is not distinct from old.assignee_id)\n       and (new.contact_id is null or new.contact_id is not distinct from old.contact_id)\n       and (new.created_by is null or new.created_by is not distinct from old.created_by)\n       and (new.source_activity_id is null or new.source_activity_id is not distinct from old.source_activity_id) then",
       " then")]),
    ("Task guard: link-emptying exception lets any column change (depth 2)",
     [("    if pg_trigger_depth() > 1 and changed <@ array['assignee_id', 'contact_id', 'created_by', 'source_activity_id']\n",
       "    if pg_trigger_depth() > 1\n")]),
    ("Activity guard: flood window of one second (60 a second)",
     [("a.user_id = caller and a.created_at > now() - interval '60 seconds'", "a.user_id = caller and a.created_at > now() - interval '1 second'")]),
    ("Activity guard: flood window of two minutes",
     [("a.user_id = caller and a.created_at > now() - interval '60 seconds'", "a.user_id = caller and a.created_at > now() - interval '2 minutes'")]),
    ("Task guard: flood window of one second (60 a second)",
     [("t.created_by = caller and t.created_at > now() - interval '60 seconds'", "t.created_by = caller and t.created_at > now() - interval '1 second'")]),
    ("Task guard: flood window of two minutes",
     [("t.created_by = caller and t.created_at > now() - interval '60 seconds'", "t.created_by = caller and t.created_at > now() - interval '2 minutes'")]),
    ("Audit: a deleted entry without its length (D8)",
     [("    diff := jsonb_build_object('old', (rec - 'body') || jsonb_build_object('body_len', char_length(rec ->> 'body')));\n",
       "    diff := jsonb_build_object('old', rec - 'body');\n")]),
    ("Tasks delete: no role clause (a fresh code deletes any task of the org)",
     [("  org_id = (select private.current_org_id()) and (select private.has_recent_aal2(600))\n  and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin())));",
       "  org_id = (select private.current_org_id()) and (select private.has_recent_aal2(600)));")]),
    ("Activity time (Day 3a trigger): a session with no signed-in user may change it after the fact",
     [(MIG_3A, "  if tg_op = 'UPDATE' then\n    new.created_at := old.created_at;\n  elsif (select auth.uid()) is not null then",
       "  if tg_op = 'UPDATE' then\n    null;\n  elsif (select auth.uid()) is not null then")]),
    # Tested before this round, but without a row.
    ("Tasks: date-or-time CHECK dropped",
     [("  add constraint tasks_one_due check (due_date is null or due_at is null),", "  add constraint tasks_one_due check (true),")]),
    ("Tasks: meeting-time CHECK dropped",
     [("  add constraint tasks_meeting_timed check (kind <> 'meeting' or due_at is not null),",
       "  add constraint tasks_meeting_timed check (true),")]),
    ("Tasks: done-and-dismissed CHECK dropped",
     [("  add constraint tasks_not_done_and_cancelled check (done_at is null or cancelled_at is null),",
       "  add constraint tasks_not_done_and_cancelled check (true),")]),
    ("Tasks: safe-title CHECK dropped",
     [("  add constraint tasks_title_safe check (title !~", "  add constraint tasks_title_safe check (true or title !~")]),
    ("Tasks: kind CHECK dropped",
     [("  add column kind text not null default 'todo' check (kind in ('todo', 'call', 'meeting')),",
       "  add column kind text not null default 'todo',")]),
    ("Tasks: lead FK without cascade (a lead with a task cannot be deleted)",
     [("  add column company_id uuid references public.companies (id) on delete cascade,",
       "  add column company_id uuid references public.companies (id),")]),
    ("Tasks: creator FK without set null (a person who created a task cannot leave)",
     [("  add column created_by uuid references public.profiles (id) on delete set null,",
       "  add column created_by uuid references public.profiles (id),")]),
    ("Tasks: source entry FK without set null (an entry with a follow-up cannot be deleted)",
     [("  add column source_activity_id uuid references public.activities (id) on delete set null,",
       "  add column source_activity_id uuid references public.activities (id),")]),
    ("Tasks: update grant on kind too",
     [("      update (title, due_date, due_at, assignee_id, contact_id, done_at, cancelled_at) on public.tasks to authenticated;",
       "      update (title, due_date, due_at, assignee_id, contact_id, done_at, cancelled_at, kind) on public.tasks to authenticated;")]),
    # Policy layers: each one alone, and the pairs where one layer stands behind another.
    ("Activities update policy: USING without the author rule",
     [("  using (org_id = (select private.current_org_id()) and user_id = (select auth.uid()))\n  with check (org_id",
       "  using (org_id = (select private.current_org_id()))\n  with check (org_id")]),
    ("Activities update policy: WITH CHECK without the author rule (behind USING, the grant and the guard)",
     [("  with check (org_id = (select private.current_org_id()) and user_id = (select auth.uid()));",
       "  with check (org_id = (select private.current_org_id()));")], SURVIVES),
    ("Activities update policy: no author rule in USING nor in WITH CHECK (both layers)",
     [("  using (org_id = (select private.current_org_id()) and user_id = (select auth.uid()))\n  with check (org_id = (select private.current_org_id()) and user_id = (select auth.uid()));",
       "  using (org_id = (select private.current_org_id()))\n  with check (org_id = (select private.current_org_id()));")]),
    ("Tasks update policy: USING without the role clause (behind tasks_select and WITH CHECK)",
     [("  using (org_id = (select private.current_org_id())\n         and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin())))\n  with check",
       "  using (org_id = (select private.current_org_id()))\n  with check")], SURVIVES),
    ("Tasks update policy: no role clause in USING nor in who sees tasks (both layers)",
     [("  using (org_id = (select private.current_org_id())\n         and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin())))\n  with check",
       "  using (org_id = (select private.current_org_id()))\n  with check"),
      ("for select to authenticated using (\n  org_id = (select private.current_org_id())\n  and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin())));",
       "for select to authenticated using (\n  org_id = (select private.current_org_id()));")]),
    ("Tasks update policy: WITH CHECK without the role clause (behind the owner rule and tasks_select)",
     [("  with check (org_id = (select private.current_org_id())\n              and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin()))\n              and (company_id",
       "  with check (org_id = (select private.current_org_id())\n              and (company_id")], SURVIVES),
    ("Tasks update policy: no role clause in WITH CHECK, and reps may change an owner (both layers)",
     [("  with check (org_id = (select private.current_org_id())\n              and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin()))\n              and (company_id",
       "  with check (org_id = (select private.current_org_id())\n              and (company_id"),
      (MIG_3A, "        raise exception 'only managers and admins can change the owner' using errcode = '42501';\n", "        null;\n")]),
]


SETS = {"day3b": (MIG_3B, MUTATIONS_3B), "day4a": (MIG_4A, MUTATIONS_4A)}


def run_set(name: str, only: set) -> int:
    default, mutations = SETS[name]
    print(f"\n### {name}\n")
    print("| # | Protection removed | Result | First failure |")
    print("|---|---|---|---|")
    counts = {"caught": 0, "documented": 0, "unexpected": 0}
    for i, (title, edits, *flags) in enumerate(mutations, 1):
        if only and i not in only:
            continue
        files = {}
        applied = True
        for edit in edits:
            path, old, new = edit if len(edit) == 3 else (default, *edit)
            files.setdefault(path, path.read_text())
            text = files[path]
            if text.count(old) != 1:
                print(f"| {i} | {title} | NOT APPLIED (pattern found {text.count(old)} times in {path.name}) | |")
                counts["unexpected"] += 1
                applied = False
                break
            files[path] = text.replace(old, new)
        if not applied:
            continue
        originals = {path: path.read_text() for path in files}
        try:
            for path, text in files.items():
                path.write_text(text)
            run = subprocess.run(["bash", str(ROOT / "scripts/db-test.sh")], capture_output=True, text=True)
        finally:
            for path, text in originals.items():
                path.write_text(text)
        out = run.stdout + run.stderr
        first = next((l.strip() for l in out.splitlines() if "FAIL" in l or "ERROR" in l), "")
        first = first.split("ERROR:", 1)[-1].strip().replace("|", "/")[:140]
        # Invisible characters (a file-name test prints a bidi override) as escapes, so the table reads right.
        first = "".join(c if c.isprintable() else f"\\u{ord(c):04X}" for c in first)
        caught = run.returncode != 0
        if SURVIVES in flags:
            result = "caught, but listed as NOT CAUGHT" if caught else "**NOT CAUGHT** (documented: two layers)"
            counts["unexpected" if caught else "documented"] += 1
        else:
            result = "caught" if caught else "**NOT CAUGHT**"
            counts["caught" if caught else "unexpected"] += 1
        print(f"| {i} | {title} | {result} | {first} |", flush=True)
    print(f"\n{name}: {sum(counts.values())} rows run: {counts['caught']} caught, {counts['documented']} documented "
          f"two-layer rows not caught, {counts['unexpected']} not as listed", flush=True)
    return counts["unexpected"]


def main() -> int:
    args = sys.argv[1:]
    chosen = "all"
    if args[:1] == ["--set"]:
        chosen, args = args[1], args[2:]
    only = {int(a) for a in args}  # optional: mutation numbers to run (within one set)
    names = list(SETS) if chosen == "all" else [chosen]
    unexpected = sum(run_set(n, only) for n in names)
    return 1 if unexpected else 0


if __name__ == "__main__":
    sys.exit(main())
