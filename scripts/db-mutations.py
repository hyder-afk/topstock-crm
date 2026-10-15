#!/usr/bin/env python3
"""Local only: proves the database tests catch each protection being removed (Day 3b design section 6A, Day 4 design
section 8.3).

For each mutation below, one or more migrations are changed in place, scripts/db-test.sh runs (migrations, the RLS,
import, activity and outcome attack tests, the two-session tests, advisors), and the migrations are restored. A mutation is
"caught" when the run fails. Never run it in a checkout someone else is reading: use a separate copy (git worktree).
Usage: python3 scripts/db-mutations.py [--set day3b|day4a|day4b|day4c|day5a|day5b|day5c|all] [numbers...]  (about 60 s per
mutation; default: all sets, numbers apply within one set). Writes one Markdown table per set to stdout, then a count line
per set; exits 1 when a row does not behave as listed. --anchors [--set ...] only checks that every edit applies (its
text is found exactly once where it is aimed), without running anything. A protection with two layers is also removed
together with its second layer (one
mutation each way). A row marked SURVIVES is such a layer that no test can see on its own, because the other layer stops
the same thing: it must stay NOT CAUGHT, and the row removing both layers must be caught.
An edit is (old, new) on the set's own migration, or (path, old, new) on another one. A mutation edits the definition
that is live after every migration: Day 4a redefines the import "untouched" rule (so Day 3b's mutations of it edit the
Day 4a migration), and Day 4b redefines the audit trigger, the activity and task delete policies and the insert lock
(so the Day 3b and Day 4a mutations of those edit the Day 4b migration). Day 4c redefines the audit trigger, get_lead
and log_activity again: the earlier rows that edit those are moved to the Day 4c migration (REDEFINED_IN_4C below).
Day 5a redefines the audit trigger and the task guard (so every earlier mutation of those, Day 4c's included, edits the
Day 5a copy: a Region names the function inside the file, because the Day 5a migration holds the same text in other
functions too). Day 5b recreates log_activity and get_lead (from Day 4c), undo_activity (Day 4b), the work queue's card
private.queue_card (Day 4c) and the activities insert policy (Day 4a), so every earlier mutation aimed inside those now
edits the Day 5b copy. Day 5c (the Home figures) only adds functions, so no earlier row moves.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIG_3A = ROOT / "supabase/migrations/20261010090000_leads_are_companies.sql"
MIG_3B = ROOT / "supabase/migrations/20261010150000_lead_import.sql"
MIG_4A = ROOT / "supabase/migrations/20261011120000_activity_hardening.sql"
MIG_4B = ROOT / "supabase/migrations/20261012090000_lead_page.sql"
MIG_4C = ROOT / "supabase/migrations/20261013090000_tasks_queue.sql"
MIG_5A = ROOT / "supabase/migrations/20261015090000_deals_pipeline.sql"
MIG_5B = ROOT / "supabase/migrations/20261015120000_deal_links.sql"
MIG_5C = ROOT / "supabase/migrations/20261015150000_home_dashboard.sql"


class Region:
    """One function inside a migration: an edit aimed here applies only between `start` and the first `end` after it."""

    def __init__(self, path: pathlib.Path, start: str, end: str = "\n$$;\n"):
        self.path, self.start, self.end = path, start, end
        self.name = f"{path.name} ({start.strip()[:60]})"

    def bounds(self, text: str):
        s = text.find(self.start)
        if s < 0 or text.count(self.start) != 1:
            return None
        e = text.find(self.end, s + len(self.start))
        return None if e < 0 else (s, e)


TASK_GUARD_5A = Region(MIG_5A, "create or replace function private.task_guard()")
AUDIT_ROW_5A = Region(MIG_5A, "create or replace function private.audit_row()")
DEAL_GUARD = Region(MIG_5A, "create function private.deal_guard()")
DEAL_HISTORY = Region(MIG_5A, "create function private.deal_history()")
OPEN_FLOOD = Region(MIG_5A, "create function private.deal_open_flood()")
MOVE_FLOOD = Region(MIG_5A, "create function private.deal_move_flood()")
CANDIDATE = Region(MIG_5A, "create function private.deal_undo_candidate(")
MOVE_DEAL = Region(MIG_5A, "create function public.move_deal(")
OPEN_DEAL = Region(MIG_5A, "create function public.open_deal(")
DELETE_DEAL = Region(MIG_5A, "create function public.delete_deal(")
UPDATE_DEAL = Region(MIG_5A, "create function public.update_deal(")
BOARD = Region(MIG_5A, "create function public.pipeline_board(")
LIST_STAGE = Region(MIG_5A, "create function public.list_stage_deals(")
CARDS = Region(MIG_5A, "create function private.deal_cards(")
ORG_RECENT_PAGE = Region(MIG_5A, "  elsif not p_oldest then\n", "\n  else\n")
LOG_ACTIVITY_5B = Region(MIG_5B, "create function public.log_activity(")
UNDO_ACTIVITY_5B = Region(MIG_5B, "create or replace function public.undo_activity(")
GET_LEAD_5B = Region(MIG_5B, "create or replace function public.get_lead(")
QUEUE_CARD_5B = Region(MIG_5B, "create or replace function private.queue_card(")
INSERT_POLICY_5B = Region(MIG_5B, "create policy activities_insert on public.activities for insert to authenticated with check (", ";\n")
# The Day 4 originals of what Day 5b recreates (an earlier mutation aimed inside one of these is moved to the 5b copy).
RELIVE_5B = [
    (Region(MIG_4B, "create function public.log_activity("), LOG_ACTIVITY_5B),
    (Region(MIG_4B, "create function public.undo_activity("), UNDO_ACTIVITY_5B),
    (Region(MIG_4B, "create or replace function public.get_lead("), GET_LEAD_5B),
    (Region(MIG_4A, "create policy activities_insert on public.activities for insert to authenticated with check (", ";\n"),
     INSERT_POLICY_5B),
    # Day 4c's copies (on main since the 4c rebase): Day 5b re-copied them, so a row aimed at them moves to the 5b copy.
    (Region(MIG_4C, "create or replace function public.log_activity("), LOG_ACTIVITY_5B),
    (Region(MIG_4C, "create or replace function public.get_lead("), GET_LEAD_5B),
    (Region(MIG_4C, "create function private.queue_card("), QUEUE_CARD_5B),
]
# Day 5c: the Home figures. Mine and Team are separate statements, so a Region names the branch a row aims at.
HOME_WINDOW = Region(MIG_5C, "create function private.home_window(")
OPEN_DEALS_ORG = Region(MIG_5C, "  else\n    return query\n      select d.id, s.key", "\n  end if;\n")
SUMMARY = Region(MIG_5C, "create function public.home_summary(")
SUMMARY_TEAM_CLOSED = Region(MIG_5C, "  -- K2, K3 and the Lost line: closed deals in scope.\n  if v_team then\n", "\n  else\n")
SUMMARY_MINE_CLOSED = Region(MIG_5C, "     where d.status <> 'open' and d.owner_id = v_me and d.status = 'won' and d.closed_at >= w.month_start;",
                             "\n  end if;\n")
ATTENTION = Region(MIG_5C, "create function public.home_attention(")
RECENT = Region(MIG_5C, "create function public.home_recent_activity(")
RECENT_TEAM = Region(MIG_5C, "  if p_scope = 'team' then\n    return query\n      select f.item_id", "\n  else\n")
RECENT_MINE = Region(MIG_5C, "  else\n    return query\n      select f.item_id", "\n  end if;\n")
SCOPE_5C = ("  if p_scope = 'team' and not (select private.is_manager_or_admin()) then\n"
            "    raise exception 'only managers and admins see the team''s figures' using errcode = '42501', hint = 'scope';\n"
            "  end if;\n")
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
     [(MIG_4B, "  elsif tg_op = 'INSERT' and tg_table_name = 'companies' and rec ->> 'import_batch_id' is not null then\n    diff := jsonb_build_object('import_batch_id', rec -> 'import_batch_id');\n", "")]),
    ("Audit: search and key columns kept",
     [(MIG_4B, "(case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) - hidden;",
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
    ("Activities delete: no fresh code (the policy as Day 4b redefines it)",
     [(MIG_4B, "       ((select private.has_recent_aal2(600)) and ((select private.is_manager_or_admin()) or user_id = (select auth.uid())))",
       "       (((select private.is_manager_or_admin()) or user_id = (select auth.uid())))")]),
    ("Last activity on delete: newest remaining entry only (previous date ignored)",
     [("greatest((select max(a.created_at) from public.activities a where a.company_id = old.company_id),\n                                     old.prev_last_activity_at)",
       "(select max(a.created_at) from public.activities a where a.company_id = old.company_id)")]),
    ("Activities: contact FK back to cascade",
     [("foreign key (contact_id) references public.contacts (id) on delete set null,\n  drop constraint activities_deal_id_fkey",
       "foreign key (contact_id) references public.contacts (id) on delete cascade,\n  drop constraint activities_deal_id_fkey")]),
    ("Audit: a deleted entry keeps its text",
     [(MIG_4B, "    diff := jsonb_build_object('old', (rec - 'body') || jsonb_build_object('body_len', char_length(rec ->> 'body')));\n",
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
     [(MIG_4B, "       and not (is_activity and n.key = 'body');\n", ";\n"),
      (MIG_4B, "    if is_activity and (to_jsonb(new) -> 'body') is distinct from (to_jsonb(old) -> 'body') then", "    if false then")]),
    ("Audit: new entries copied",
     [(MIG_4B, "  if is_activity and tg_op = 'INSERT' then\n    return new;\n  end if;\n", "")]),
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
    ("Tasks delete: no fresh code (the policy as Day 4b redefines it)",
     [(MIG_4B, "       ((select private.has_recent_aal2(600))\n        and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin())))",
       "       ((assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin())))")]),
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
     [(MIG_4B, "  perform 1 from public.companies c where c.id = new.company_id for no key update;\n", "")]),
    ("Lead lock on insert: runs as the caller (locks nothing on a lead the caller cannot change)",
     [(MIG_4B, "create or replace function private.lock_activity_lead() returns trigger\nlanguage plpgsql security definer set search_path",
       "create or replace function private.lock_activity_lead() returns trigger\nlanguage plpgsql set search_path")]),
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
     [(MIG_4B, "    diff := jsonb_build_object('old', (rec - 'body') || jsonb_build_object('body_len', char_length(rec ->> 'body')));\n",
       "    diff := jsonb_build_object('old', rec - 'body');\n")]),
    ("Tasks delete: no role clause (a fresh code deletes any task of the org; the policy as Day 4b redefines it)",
     [(MIG_4B, "       ((select private.has_recent_aal2(600))\n        and (assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (select private.is_manager_or_admin())))",
       "       ((select private.has_recent_aal2(600)))")]),
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
       "  using (org_id = (select private.current_org_id()))\n  with check")]),
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
    ("Lead lock on insert: the contact is not locked first (deadlock with log_activity's contact-then-lead order)",
     [(MIG_4B, "  if new.contact_id is not null then\n    perform 1 from public.contacts k where k.id = new.contact_id and (caller is null or k.org_id = v_org) for key share;\n  end if;\n", "")]),
    ("Activity guard: flood window of 45 seconds",
     [("a.user_id = caller and a.created_at > now() - interval '60 seconds'", "a.user_id = caller and a.created_at > now() - interval '45 seconds'")]),
    ("Task guard: flood window of 45 seconds",
     [("t.created_by = caller and t.created_at > now() - interval '60 seconds'", "t.created_by = caller and t.created_at > now() - interval '45 seconds'")]),
]


# Day 4b (lead page). Rows 1 to 11 are the design's list (section 8.3, 4b), in order (row 11 is written as the two ways a
# non-editor's call could still mark a number: the code claiming a mark, and the function running as its owner); the
# rest remove every other protection the migration adds, one at a time. A protection with two layers is removed with
# its second layer, and says so.
LOG_LOCKS = """    if p_outcome = 'wrong_number' and p_dialled = 'contact' then
      select k.phone, k.phone_wrong_at into v_contact_phone, v_contact_wrong
        from public.contacts k where k.id = p_contact for update;
      v_contact_locked := found;
    elsif p_contact is not null then
      perform 1 from public.contacts k where k.id = p_contact for key share;
    end if;
    select c.id, c.owner_id, c.lead_status, c.phone, c.phone_wrong_at, c.next_action_at, c.timezone, c.country
      into v_lead from public.companies c where c.id = p_company for update;
    v_editable := found;
"""
LOG_LOCKS_REVERSED = """    select c.id, c.owner_id, c.lead_status, c.phone, c.phone_wrong_at, c.next_action_at, c.timezone, c.country
      into v_lead from public.companies c where c.id = p_company for update;
    v_editable := found;
    if p_outcome = 'wrong_number' and p_dialled = 'contact' then
      select k.phone, k.phone_wrong_at into v_contact_phone, v_contact_wrong
        from public.contacts k where k.id = p_contact for update;
      v_contact_locked := found;
    elsif p_contact is not null then
      perform 1 from public.contacts k where k.id = p_contact for key share;
    end if;
"""
MUTATIONS_4B = [
    ("Undo: no compare before restoring the status (a colleague's change overwritten)",
     [("      r_status := u.new_status is distinct from u.prev_status and v_lead.lead_status = u.new_status;",
       "      r_status := u.new_status is distinct from u.prev_status;")]),
    ("Entry delete without a code: no 'no undo record' condition (an outcome deleted around undo)",
     [("    or (user_id = (select auth.uid()) and created_at > now() - interval '120 seconds'\n        and not exists (select 1 from private.activity_undo u where u.activity_id = activities.id))));",
       "    or (user_id = (select auth.uid()) and created_at > now() - interval '120 seconds')));")]),
    ("Undo: no 2-minute window in undo_activity",
     [("   where a.id = p_id and a.user_id = caller and a.created_at > now() - interval '120 seconds';",
       "   where a.id = p_id and a.user_id = caller;")]),
    ("Outcome decisions applied for people who may not change the lead",
     [("    v_editable := found;\n    if not v_editable then", "    v_editable := true;\n    if not found then")]),
    ("Lock order reversed in log_activity: lead, then contact (deadlock test)",
     [(LOG_LOCKS, LOG_LOCKS_REVERSED)]),
    ("Lead guard: a country change keeps the picked zone",
     [("     and not (new.timezone is not null and new.timezone is distinct from old.timezone) then\n    new.timezone := null;\n",
       "     and not (new.timezone is not null and new.timezone is distinct from old.timezone) then\n    null;\n")]),
    ("Lead guard: next call bound checked even when unchanged (overdue or far leads stuck)",
     [("     and (tg_op = 'INSERT' or new.next_action_at is distinct from old.next_action_at)\n", "")]),
    ("Lead guard: no Cool off default",
     [("              and (tg_op = 'INSERT' or new.next_action_at is not distinct from old.next_action_at))) then\n    new.next_action_at := now() + interval '90 days';",
       "              and (tg_op = 'INSERT' or new.next_action_at is not distinct from old.next_action_at))) then\n    null;")]),
    ("Activities: request id index not unique (Day 4a migration)",
     [(MIG_4A, "create unique index activities_author_request_idx", "create index activities_author_request_idx")]),
    ("Timeline keyset: <= instead of < (an entry repeated across pages)",
     [("                 and (x.created_at, x.id) < (p_before_at, p_before_id)",
       "                 and (x.created_at, x.id) <= (p_before_at, p_before_id)")]),
    ("Wrong number: the dialled contact marked without the editor's lock (code claims a mark)",
     [("  if v_contact_locked and v_contact_wrong is null then", "  if p_dialled = 'contact' and p_outcome = 'wrong_number' and v_contact_wrong is null then")]),
    # Beyond the design's list.
    ("log_activity runs as its owner (marks and decisions for anyone, as a definer trigger would)",
     [(") returns jsonb\nlanguage plpgsql volatile set search_path = '' as $$\ndeclare\n  caller constant uuid := (select auth.uid());\n  v_follow",
       ") returns jsonb\nlanguage plpgsql volatile security definer set search_path = '' as $$\ndeclare\n  caller constant uuid := (select auth.uid());\n  v_follow")]),
    ("Undo: no compare before restoring the next call",
     [("                and v_lead.next_action_at is not distinct from u.new_next_action_at;", ";")]),
    ("Undo: no compare before restoring the owner",
     [("      r_owner := u.owner_changed and v_lead.owner_id is not distinct from u.new_owner_id;",
       "      r_owner := u.owner_changed;")]),
    ("Undo: clears the lead's mark whatever its time",
     [("      r_phone := u.wrong_company and v_lead.phone_wrong_at = v_created;", "      r_phone := u.wrong_company;")]),
    ("Undo: clears the contact's mark whatever its time",
     [("     where k.id = u.wrong_contact_id and k.phone_wrong_at = v_created;", "     where k.id = u.wrong_contact_id;")]),
    ("Undo: deletes the follow-up even when touched or done (a fresh code passes the policy)",
     [("     where t.id = u.created_task_id and t.updated_at = t.created_at and t.done_at is null and t.cancelled_at is null;",
       "     where t.id = u.created_task_id;")]),
    ("Undo: reopens completed tasks whatever their time",
     [("   where t.id = any (u.completed_task_ids) and t.done_at = v_created and t.completed_by = caller;",
       "   where t.id = any (u.completed_task_ids);")]),
    ("Undo: reopens dismissed tasks whatever their time",
     [("   where t.id = any (u.cancelled_task_ids) and t.cancelled_at = v_created;", "   where t.id = any (u.cancelled_task_ids);")]),
    ("Undo: the record is not consumed (a second undo runs again)",
     [("  delete from private.activity_undo d where d.activity_id = p_id returning d.* into u;",
       "  select d.* into u from private.activity_undo d where d.activity_id = p_id;")]),
    ("Entry delete without a code: no 2-minute bound in the policy",
     [("    or (user_id = (select auth.uid()) and created_at > now() - interval '120 seconds'\n        and not exists (select 1 from private.activity_undo u where u.activity_id = activities.id))));",
       "    or (user_id = (select auth.uid())\n        and not exists (select 1 from private.activity_undo u where u.activity_id = activities.id))));")]),
    ("Entry delete without a code: anyone's entry",
     [("    or (user_id = (select auth.uid()) and created_at > now() - interval '120 seconds'\n        and not exists (select 1 from private.activity_undo u where u.activity_id = activities.id))));",
       "    or (created_at > now() - interval '120 seconds'\n        and not exists (select 1 from private.activity_undo u where u.activity_id = activities.id))));")]),
    ("Task delete without a code: touched tasks too",
     [("    or (created_by = (select auth.uid()) and updated_at = created_at and done_at is null and cancelled_at is null",
       "    or (created_by = (select auth.uid()) and done_at is null and cancelled_at is null")]),
    ("Task delete without a code: anyone's task (both layers: the creator, and the source entry's author, who is the creator by the task guard)",
     [("    or (created_by = (select auth.uid()) and updated_at = created_at and done_at is null and cancelled_at is null",
       "    or (updated_at = created_at and done_at is null and cancelled_at is null"),
      ("                     where a.id = tasks.source_activity_id and a.user_id = (select auth.uid())\n                       and a.created_at > now() - interval '120 seconds')",
       "                     where a.id = tasks.source_activity_id\n                       and a.created_at > now() - interval '120 seconds')")]),
    ("Task delete without a code: while the undo record still exists",
     [("        and not exists (select 1 from private.activity_undo u where u.activity_id = tasks.source_activity_id))));",
       "        and true)));")]),
    ("Task delete without a code: from an entry of any age",
     [("                     where a.id = tasks.source_activity_id and a.user_id = (select auth.uid())\n                       and a.created_at > now() - interval '120 seconds')",
       "                     where a.id = tasks.source_activity_id and a.user_id = (select auth.uid()))")]),
    ("Undo records: no two-factor policy",
     [("create policy require_mfa on private.activity_undo as restrictive to authenticated\n  using ((select private.has_aal2())) with check ((select private.has_aal2()));\n", "")]),
    ("Undo records: everyone in the org sees and deletes them",
     [("  using (user_id = (select auth.uid()) and org_id = (select private.current_org_id()))\n  with check (user_id = (select auth.uid()) and org_id = (select private.current_org_id())\n",
       "  using (org_id = (select private.current_org_id()))\n  with check (user_id = (select auth.uid()) and org_id = (select private.current_org_id())\n")]),
    ("Undo records: a record may name a colleague's entry",
     [("  with check (user_id = (select auth.uid()) and org_id = (select private.current_org_id())\n              and exists (select 1 from public.activities a\n                           where a.id = activity_undo.activity_id and a.user_id = (select auth.uid())));",
       "  with check (user_id = (select auth.uid()) and org_id = (select private.current_org_id()));")]),
    ("Undo records: update granted",
     [("grant select, insert, delete on private.activity_undo to authenticated;", "grant select, insert, update, delete on private.activity_undo to authenticated;")]),
    ("log_activity: no second replay check after the lock, and no unique-violation answer (both layers)",
     [("    -- The same request may have been saved while this one waited for the lock.\n    if p_request_id is not null then",
       "    -- The same request may have been saved while this one waited for the lock.\n    if false then"),
      ("    if v_constraint is distinct from 'activities_author_request_idx' then\n      raise;\n    end if;\n    select a.id into v_id from public.activities a where a.user_id = caller and a.request_id = p_request_id;\n    return private.logged_activity(v_id, true);",
       "    raise;")]),
    ("log_activity: no unique-violation answer (a concurrent duplicate fails)",
     [("    if v_constraint is distinct from 'activities_author_request_idx' then\n      raise;\n    end if;\n    select a.id into v_id from public.activities a where a.user_id = caller and a.request_id = p_request_id;\n    return private.logged_activity(v_id, true);",
       "    raise;")]),
    ("Lead guard: no zone pre-check (the CHECK answers with the row)",
     [("    raise exception 'this time zone is not one of the zones of the lead''s country'\n      using errcode = '22023', hint = 'zone_not_in_country';\n  end if;\n  if (select auth.uid()) is not null",
       "    null;\n  end if;\n  if (select auth.uid()) is not null")]),
    ("Leads: no time zone CHECK (backstop)",
     [("add constraint companies_timezone_fits check (timezone is null or", "add constraint companies_timezone_fits check (true or timezone is null or")]),
    ("set_lead_timezone and the lead guard: no zone check at all (both layers)",
     [("  if p_timezone is not null and not private.zone_fits_country(p_timezone, v_country) then", "  if false then"),
      ("    raise exception 'this time zone is not one of the zones of the lead''s country'\n      using errcode = '22023', hint = 'zone_not_in_country';\n  end if;\n  if (select auth.uid()) is not null",
       "    null;\n  end if;\n  if (select auth.uid()) is not null"),
      ("add constraint companies_timezone_fits check (timezone is null or", "add constraint companies_timezone_fits check (true or timezone is null or")]),
    ("Lead guard: a country change always clears the zone (a zone picked with the new country lost)",
     [("     and not (new.timezone is not null and new.timezone is distinct from old.timezone) then\n    new.timezone := null;",
       "     then\n    new.timezone := null;")]),
    ("Lead guard: no next call bound",
     [("    raise exception 'the next call date is too far ahead' using errcode = '22023', hint = 'bounds';", "    null;")]),
    ("Lead guard: next call bound for maintenance sessions too",
     [("  if (select auth.uid()) is not null and new.next_action_at is not null", "  if new.next_action_at is not null")]),
    ("Lead guard: a new phone keeps the wrong-number mark",
     [("  if tg_op = 'UPDATE' then\n    if new.phone is distinct from old.phone then\n      new.phone_wrong_at := null;",
       "  if tg_op = 'UPDATE' then\n    if new.phone is distinct from old.phone then\n      null;")]),
    ("Lead guard: a mark keeps the client's time",
     [("    elsif old.phone_wrong_at is null and new.phone_wrong_at is not null then\n      new.phone_wrong_at := now();\n    elsif new.phone_wrong_at is not null then\n      new.phone_wrong_at := old.phone_wrong_at;\n    end if;\n  end if;\n  if new.lead_status",
       "    elsif old.phone_wrong_at is null and new.phone_wrong_at is not null then\n      null;\n    elsif new.phone_wrong_at is not null then\n      new.phone_wrong_at := old.phone_wrong_at;\n    end if;\n  end if;\n  if new.lead_status")]),
    ("Lead guard: a mark's time can be changed",
     [("    elsif new.phone_wrong_at is not null then\n      new.phone_wrong_at := old.phone_wrong_at;\n    end if;\n  end if;\n  if new.lead_status",
       "    end if;\n  end if;\n  if new.lead_status")]),
    ("Contact guard: a new phone keeps the mark",
     [("  if new.phone is distinct from old.phone then\n    new.phone_wrong_at := null;\n  elsif", "  if new.phone is distinct from old.phone then\n    null;\n  elsif")]),
    ("Contact guard: a mark keeps the client's time",
     [("  elsif old.phone_wrong_at is null and new.phone_wrong_at is not null then\n    new.phone_wrong_at := now();\n  elsif new.phone_wrong_at is not null then\n    new.phone_wrong_at := old.phone_wrong_at;\n  end if;\n  return new;",
       "  elsif old.phone_wrong_at is null and new.phone_wrong_at is not null then\n    null;\n  elsif new.phone_wrong_at is not null then\n    new.phone_wrong_at := old.phone_wrong_at;\n  end if;\n  return new;")]),
    ("Contact guard trigger dropped",
     [("create trigger contact_guard before update on public.contacts\n  for each row execute function private.contact_guard();", "")]),
    ("Lead guard: Cool off default only without a date (a past retry date brings the lead back at once: the design's literal rule)",
     [("     and (new.next_action_at is null\n          or (new.next_action_at <= now()\n"
       "              and (tg_op = 'INSERT' or new.next_action_at is not distinct from old.next_action_at))) then",
       "     and new.next_action_at is null then")]),
    ("Lead guard: Cool off default on every update of a Cool off lead (its date cannot be cleared)",
     [("  if new.lead_status = 'cool_off' and (tg_op = 'INSERT' or old.lead_status is distinct from 'cool_off')", "  if new.lead_status = 'cool_off'")]),
    ("Audit: next call and marks diffed",
     [("       and n.key not in ('updated_at', 'last_activity_at', 'next_action_at', 'phone_wrong_at')",
       "       and n.key not in ('updated_at', 'last_activity_at')")]),
    ("Lead columns: insert granted on the next call",
     [("grant update (timezone, next_action_at, phone_wrong_at) on public.companies to authenticated;",
       "grant update (timezone, next_action_at, phone_wrong_at), insert (next_action_at) on public.companies to authenticated;")]),
    ("Outcomes: the 6th try counts from 7 (>= 6)",
     [("      if private.call_attempts(p_company) >= 5 then", "      if private.call_attempts(p_company) >= 6 then")]),
    ("Outcomes: the 6th try sends any status to Cool off",
     [("        if v_status in ('cold', 'warm') then\n          v_status := 'cool_off';\n        end if;\n        v_next := now() + interval '30 days';",
       "        v_status := 'cool_off';\n        v_next := now() + interval '30 days';")]),
    ("Outcomes: voicemail waits one working day like no answer",
     [("case when p_outcome = 'no_answer' then 1 else 2 end, v_key)", "1, v_key)")]),
    ("Outcomes: Not interested moves Negotiation to Cool off",
     [("      if v_status in ('cold', 'warm', 'cool_off') then\n        v_status := 'cool_off';\n      end if;\n      v_next := now() + interval '90 days';",
       "      v_status := 'cool_off';\n      v_next := now() + interval '90 days';")]),
    ("Outcomes: Interested moves a lead down (Negotiation to Warm)",
     [("      if p_outcome = 'interested' and v_status in ('cold', 'cool_off') then", "      if p_outcome = 'interested' then")]),
    ("Outcomes: Book meeting moves Negotiation to Warm",
     [("      elsif p_outcome = 'meeting_booked' and v_status in ('cold', 'cool_off', 'warm') then", "      elsif p_outcome = 'meeting_booked' then")]),
    ("Outcomes: Do not contact keeps the next call",
     [("      v_status := 'do_not_contact';\n      v_next := null;", "      v_status := 'do_not_contact';")]),
    ("Outcomes: Spoke without a follow-up keeps the next call (no 30 days)",
     [("                     else now() + interval '30 days' end;", "                     else v_next end;")]),
    ("Outcomes: back on the follow-up day itself, not the day after",
     [("      v_next := case when p_follow_up_at is not null then p_follow_up_at + interval '1 day'",
       "      v_next := case when p_follow_up_at is not null then p_follow_up_at")]),
    ("Outcomes: a follow-up date read in Paris for every lead (not its zone)",
     [("then ((p_follow_up_date + 1) + time '09:00') at time zone v_east", "then ((p_follow_up_date + 1) + time '09:00') at time zone 'Europe/Paris'")]),
    ("Outcomes: an owned lead taken over too",
     [("      if p_outcome <> 'connected' and v_owner is null then", "      if p_outcome <> 'connected' then")]),
    ("Outcomes: Spoke takes over an unassigned lead too",
     [("      if p_outcome <> 'connected' and v_owner is null then", "      if v_owner is null then")]),
    ("Tasks: a call completes every open call task, due or not",
     [("         and (p_outcome = 'not_interested' or t.due_date <= v_today\n              or t.due_at < ((v_today + 1)::timestamp at time zone v_tz))",
       "         and true")]),
    ("Tasks: a call completes to-dos too",
     [("       where t.company_id = p_company and t.assignee_id = caller and t.kind = 'call'\n",
       "       where t.company_id = p_company and t.assignee_id = caller\n")]),
    ("Tasks: a call completes a colleague's call tasks",
     [("       where t.company_id = p_company and t.assignee_id = caller and t.kind = 'call'\n",
       "       where t.company_id = p_company and t.kind = 'call'\n")]),
    ("Tasks: Do not contact dismisses nothing",
     [("        update public.tasks t set cancelled_at = now() from picked where t.id = picked.id returning t.id",
       "        update public.tasks t set cancelled_at = now() from picked where t.id = picked.id and false returning t.id")]),
    ("Tasks: 'find the right number' although another number works",
     [("            or exists (select 1 from public.contacts k\n                        where k.company_id = p_company and k.phone is not null and k.phone_wrong_at is null\n                          and not (p_dialled = 'contact' and k.id = p_contact))) then",
       "            or false) then")]),
    ("Tasks: 'find the right number' always for the caller (not the owner)",
     [("      v_assignee := case when (select private.is_manager_or_admin()) and v_lead.owner_id is not null\n                         then v_lead.owner_id else caller end;",
       "      v_assignee := caller;")]),
    ("Input: Interested without a follow-up",
     [("        raise exception 'Interested needs a follow-up date' using errcode = '22023', hint = 'follow_up_required';", "        null;")]),
    ("Input: follow-up dates and times not bounded",
     [("    raise exception 'the follow-up must be between now and a year ahead' using errcode = '22023', hint = 'follow_up_range';", "    null;")]),
    ("Input: a follow-up on an outcome that takes none",
     [("      raise exception 'this outcome takes no follow-up' using errcode = '22023', hint = 'follow_up_range';", "      null;")]),
    ("Input: Wrong number without a title up front",
     [("  if (v_task_kind is not null or p_outcome = 'wrong_number') and (p_task_title is null or btrim(p_task_title) = '') then",
       "  if v_task_kind is not null and (p_task_title is null or btrim(p_task_title) = '') then")]),
    ("Input: a note without text",
     [("    raise exception 'a note needs text' using errcode = '22023', hint = 'body_required';\n  end if;\n  if (p_dialled", "    null;\n  end if;\n  if (p_dialled")]),
    ("Input: no check of the dialled number",
     [("    raise exception 'say which number was dialled: the lead''s or the contact''s' using errcode = '22023', hint = 'dialled';", "    null;")]),
    ("Input: an empty dialled number accepted",
     [("    raise exception 'the dialled number is empty' using errcode = '22023', hint = 'dialled';", "    null;")]),
    ("Input: a contact of another lead (the policy answers 42501 instead of P0002)",
     [("      from public.contacts k where k.id = p_contact and k.company_id = p_company;\n    if not found then\n      raise exception 'contact not found on this lead' using errcode = 'P0002';\n    end if;\n  end if;\n  if (p_dialled",
       "      from public.contacts k where k.id = p_contact;\n  end if;\n  if (p_dialled")]),
    ("Timeline: unknown kinds accepted",
     [("    raise exception 'unknown kind of entry' using errcode = '22023', hint = 'bad_types';", "    null;")]),
    ("Timeline: half a cursor accepted",
     [("    raise exception 'a cursor needs both its time and its id' using errcode = '22023', hint = 'bad_cursor';", "    null;")]),
    ("Timeline: any page size",
     [("    raise exception 'between 1 and 100 entries a page' using errcode = '22023', hint = 'bounds';", "    null;")]),
    ("delete_activity: no fresh-code pre-check (no step_up hint)",
     [("    raise exception 'confirm it is you first' using errcode = '42501', hint = 'step_up';", "    null;")]),
    ("get_lead: anyone may set the zone",
     [("    'can_set_timezone', e.can_edit and private.country_zone_choices(c.country) is not null,",
       "    'can_set_timezone', private.country_zone_choices(c.country) is not null,")]),
    ("bulk_update_leads: a return date with any status",
     [("    raise exception 'a return date goes with Cool off only' using errcode = '22023', hint = 'until_cool_off_only';", "    null;")]),
    ("next_working_day: weekends count",
     [("    if extract(isodow from d) < 6 then\n      n := n + 1;", "    if true then\n      n := n + 1;")]),
    ("next_working_day: a span on its western end",
     [("  z constant text := coalesce((private.span_zones(p_key))[1], p_key);", "  z constant text := coalesce((private.span_zones(p_key))[2], p_key);")]),
    ("call_attempts: a Spoke does not break the run",
     [("  select coalesce(min(rn) filter (where outcome not in ('no_answer', 'voicemail')) - 1, count(*))::integer from last6",
       "  select count(*) filter (where outcome in ('no_answer', 'voicemail'))::integer from last6")]),
    ("call_attempts: the 7 latest calls",
     [("             order by a.created_at desc, a.id desc\n             limit 6) x)", "             order by a.created_at desc, a.id desc\n             limit 7) x)")]),
    ("Zone map: France on London time",
     [("    when 'FR' then 'Europe/Paris'\n", "    when 'FR' then 'Europe/London'\n")]),
    ("Zone map: a US zone allowed for Canada",
     [("    when 'CA' then array['America/St_Johns',", "    when 'CA' then array['America/Chicago', 'America/St_Johns',")]),
    ("log_activity: a call naming a contact it does not mark takes the lead first (deadlock test)",
     [("    elsif p_contact is not null then\n      perform 1 from public.contacts k where k.id = p_contact for key share;\n", "")]),
    ("Insert lock: locks for a signed-in session without two-factor (holds a lead while being refused)",
     [("    if not (select private.has_aal2()) or v_org is null\n", "    if v_org is null\n")]),
    ("Insert lock: locks a lead of another organisation (holds it while being refused)",
     [("    if not (select private.has_aal2()) or v_org is null\n       or not exists (select 1 from public.companies c where c.id = new.company_id and c.org_id = v_org) then",
       "    if not (select private.has_aal2()) or v_org is null then")]),
    ("Insert lock: locks a contact of another organisation (holds it while being refused)",
     [("new.contact_id and (caller is null or k.org_id = v_org) for key share;", "new.contact_id for key share;")]),
    # Review round (finding 1): undo into a due Cool off lead keeps its date.
    ("Lead guard: a past date the statement writes is replaced on entering Cool off (undo of a due Cool off lead: +90 days)",
     [("     and (new.next_action_at is null\n          or (new.next_action_at <= now()\n"
       "              and (tg_op = 'INSERT' or new.next_action_at is not distinct from old.next_action_at))) then",
       "     and (new.next_action_at is null or new.next_action_at <= now()) then")]),
    ("bulk_update_leads: a return date that is not in the future accepted",
     [("  if p_next_action_at <= now() then  -- lead_guard keeps a past date a statement writes (undo), so it is refused here\n"
       "    raise exception 'the return date must be in the future' using errcode = '22023', hint = 'bounds';\n  end if;\n", "")]),
    ("Lead guard: a new Cool off lead keeps a past date (an imported old retry date brings it back at once)",
     [("              and (tg_op = 'INSERT' or new.next_action_at is not distinct from old.next_action_at))) then",
       "              and new.next_action_at is not distinct from old.next_action_at)) then")]),
    # Review round 2 (verifier note 3): undo reports the date as restored only when the stored date is the one put back.
    ("undo_activity: restored.next_action_at claimed when lead_guard gave the empty Cool off date +90 days",
     [("        r_next := r_next and v_next_after is not distinct from u.prev_next_action_at;\n", "")]),
]


# Day 4c (tasks and work queue). Rows 1 to 10 are the design's list (section 8.3, 4c), in order; the rest remove every
# other protection the migration adds, one at a time. A protection with two layers is removed alone (SURVIVES: the other
# layer stops the same thing) and with its second layer (caught).
SCOPE_QUEUE = """  if p_scope <> 'mine' and not (select private.is_manager_or_admin()) then
    raise exception 'only managers and admins can work beyond their own leads' using errcode = '42501', hint = 'scope';
  end if;
"""
TEAM_TASKS = """  if p_scope = 'team' and not v_mgr then
    raise exception 'only managers and admins see the team''s tasks' using errcode = '42501', hint = 'scope';
  end if;
"""
GUARD_LOCK = "  perform pg_advisory_xact_lock(hashtextextended('queue_claims:' || caller::text, 0));\n  if tg_op = 'INSERT' then"
RPC_LOCK = "  perform pg_advisory_xact_lock(hashtextextended('queue_claims:' || caller::text, 0));\n"
LOG_LOCKS_4C = """    if p_outcome = 'wrong_number' and p_dialled = 'contact' then
      select k.phone, k.phone_wrong_at into v_contact_phone, v_contact_wrong
        from public.contacts k where k.id = p_contact for update;
      v_contact_locked := found;
    elsif p_contact is not null then
      perform 1 from public.contacts k where k.id = p_contact for key share;
    end if;
    -- (4c: FOR NO KEY UPDATE, not FOR UPDATE: it still makes outcomes on one lead take turns, and it no longer blocks
    -- the key-share lock a foreign key check takes, so a teammate claiming this lead in the queue never waits for the
    -- call being saved, nor deadlocks with its claim release in step 9.)
    select c.id, c.owner_id, c.lead_status, c.phone, c.phone_wrong_at, c.next_action_at, c.timezone, c.country
      into v_lead from public.companies c where c.id = p_company for no key update;
    v_editable := found;
"""
LOG_LOCKS_4C_REVERSED = """    select c.id, c.owner_id, c.lead_status, c.phone, c.phone_wrong_at, c.next_action_at, c.timezone, c.country
      into v_lead from public.companies c where c.id = p_company for no key update;
    v_editable := found;
    if p_outcome = 'wrong_number' and p_dialled = 'contact' then
      select k.phone, k.phone_wrong_at into v_contact_phone, v_contact_wrong
        from public.contacts k where k.id = p_contact for update;
      v_contact_locked := found;
    elsif p_contact is not null then
      perform 1 from public.contacts k where k.id = p_contact for key share;
    end if;
"""
MUTATIONS_4C = [
    # The design's list (8.3, 4c).
    ("claim_next_lead and queue_candidates: no scope check (a rep works Team or the unassigned leads; both layers)",
     [(SCOPE_QUEUE + "  -- The caller's claims take turns", "  -- The caller's claims take turns"),
      ("  if p_scope is null or (p_scope <> 'mine' and not (select private.is_manager_or_admin())) then\n    raise exception 'only managers and admins can work beyond their own leads' using errcode = '42501', hint = 'scope';\n  end if;\n  if p_segment = 0 then",
       "  if p_segment = 0 then")]),
    ("Claims delete policy: no expiry condition (an expired claim stays until its holder lets go)",
     [("  org_id = (select private.current_org_id()) and (user_id = (select auth.uid()) or expires_at <= now()));",
       "  org_id = (select private.current_org_id()) and user_id = (select auth.uid()));")]),
    ("Claims: no primary key on company_id (two live claims on one lead)",
     [("  company_id uuid primary key references public.companies (id) on delete cascade,  -- one live claim per lead",
       "  company_id uuid not null references public.companies (id) on delete cascade,")]),
    ("Claim guard: keeps the client's end time (a claim stretched for a year)",
     [("  new.expires_at := now() + interval '10 minutes';\n  if (tg_op = 'INSERT'",
       "  new.expires_at := coalesce(new.expires_at, now() + interval '10 minutes');\n  if (tg_op = 'INSERT'")]),
    ("Claims insert policy: no editor condition (a rep locks a teammate out of their lead)",
     [("  org_id = (select private.current_org_id()) and user_id = (select auth.uid())\n  and exists (select 1 from public.companies c where c.id = queue_claims.company_id\n              and ((select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()))));",
       "  org_id = (select private.current_org_id()) and user_id = (select auth.uid()));")]),
    ("Queue rank: Do not contact leads ranked",
     [("      when lead_status = 'negotiation' then 0\n", "      when lead_status = 'do_not_contact' then 3\n      when lead_status = 'negotiation' then 0\n")]),
    ("Queue rank: no number-to-dial rule",
     [("      when not ((coalesce(phone ~ '[0-9]', false) and phone_wrong_at is null) or has_contact_phone) then null\n", "")]),
    ("claim_next_lead: no calling-hours filter",
     [("  v_open := case when p_any_hours then null else private.open_call_zones(now(), p_skip_lunch) end;", "  v_open := null;")]),
    ("Calling hours: a span judged on its eastern zone only",
     [("  foreach z in array coalesce(v_ends, array[p_key]) loop", "  foreach z in array coalesce(v_ends[1:1], array[p_key]) loop")]),
    ("Queue rank: Cool off without a date served",
     [("      when lead_status = 'cool_off' and next_action_at is not null then 2", "      when lead_status = 'cool_off' then 2")]),
    # Every other protection.
    ("claim_next_lead: no scope check (queue_candidates still refuses the scope)",
     [(SCOPE_QUEUE + "  -- The caller's claims take turns", "  -- The caller's claims take turns")], SURVIVES),
    ("queue_candidates: no scope check (a direct call lists the team's leads for a rep)",
     [("  if p_scope is null or (p_scope <> 'mine' and not (select private.is_manager_or_admin())) then\n    raise exception 'only managers and admins can work beyond their own leads' using errcode = '42501', hint = 'scope';\n  end if;\n  if p_segment = 0 then",
       "  if p_segment = 0 then")]),
    ("queue_summary: no scope check",
     [(SCOPE_QUEUE + "  v_open := private.open_call_zones(now(), p_skip_lunch);", "  v_open := private.open_call_zones(now(), p_skip_lunch);")]),
    ("list_tasks: Team for anyone",
     [(TEAM_TASKS + "  v_tz := private.caller_zone();", "  v_tz := private.caller_zone();")]),
    ("count_tasks: Team for anyone",
     [("  if p_scope = 'team' and not (select private.is_manager_or_admin()) then\n    raise exception 'only managers and admins see the team''s tasks' using errcode = '42501', hint = 'scope';\n  end if;\n", "")]),
    ("claim_lead: no editor pre-check (the policy answers without the scope hint)",
     [("  if not ((select private.is_manager_or_admin()) or v_owner is not distinct from caller) then\n    raise exception 'only the lead''s owner, a manager or an admin can claim it' using errcode = '42501', hint = 'scope';\n  end if;\n", "")]),
    ("Contact trigger: no lead lock before it looks (two contacts changed at once leave a wrong flag)",
     [("    perform 1 from public.companies c where c.id = v_lead for no key update;\n", "")]),
    ("Contact trigger: a number marked wrong still counts",
     [("where k.company_id = v_lead and k.phone ~ '[0-9]' and k.phone_wrong_at is null) as has_phone) s",
       "where k.company_id = v_lead and k.phone ~ '[0-9]') as has_phone) s")]),
    ("Contact trigger: a number without digits counts",
     [("where k.company_id = v_lead and k.phone ~ '[0-9]' and k.phone_wrong_at is null) as has_phone) s",
       "where k.company_id = v_lead and k.phone is not null and k.phone_wrong_at is null) as has_phone) s")]),
    ("Contact trigger: the old lead is left as it was when a contact moves",
     [("      from unnest(array[case when tg_op <> 'INSERT' then old.company_id end,\n                        case when tg_op <> 'DELETE' then new.company_id end]) as x (id)",
       "      from unnest(array[case when tg_op <> 'DELETE' then new.company_id end]) as x (id)")]),
    ("Contact trigger: not on delete",
     [("create trigger sync_contact_phone after insert or delete or update of phone, phone_wrong_at, company_id",
       "create trigger sync_contact_phone after insert or update of phone, phone_wrong_at, company_id")]),
    ("Contact trigger: not on a wrong-number mark",
     [("create trigger sync_contact_phone after insert or delete or update of phone, phone_wrong_at, company_id",
       "create trigger sync_contact_phone after insert or delete or update of phone, company_id")]),
    ("Contact trigger: SECURITY INVOKER (an editor's contact change fails on the ungranted column)",
     [("create function private.sync_contact_phone() returns trigger\nlanguage plpgsql security definer set search_path = '' as $$",
       "create function private.sync_contact_phone() returns trigger\nlanguage plpgsql set search_path = '' as $$")]),
    ("Queue rank: a main number without digits counts",
     [("      when not ((coalesce(phone ~ '[0-9]', false) and phone_wrong_at is null) or has_contact_phone) then null",
       "      when not ((phone is not null and phone_wrong_at is null) or has_contact_phone) then null")]),
    ("Queue rank: a main number marked wrong still counts",
     [("      when not ((coalesce(phone ~ '[0-9]', false) and phone_wrong_at is null) or has_contact_phone) then null",
       "      when not (coalesce(phone ~ '[0-9]', false) or has_contact_phone) then null")]),
    ("Claims: no two-factor policy",
     [("create policy require_mfa on private.queue_claims as restrictive to authenticated\n  using ((select private.has_aal2())) with check ((select private.has_aal2()));\n", "")]),
    ("Claims select policy: every organisation's claims",
     [("create policy claims_select on private.queue_claims for select to authenticated\n  using (org_id = (select private.current_org_id()));",
       "create policy claims_select on private.queue_claims for select to authenticated\n  using (true);")]),
    ("Claims delete policy: no organisation fence (the select policy still hides other organisations' claims from a delete)",
     [("  org_id = (select private.current_org_id()) and (user_id = (select auth.uid()) or expires_at <= now()));",
       "  user_id = (select auth.uid()) or expires_at <= now());")], SURVIVES),
    ("Claims update policy: anyone renews anyone's claim",
     [("  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));",
       "  using (true) with check (true);")]),
    ("Claims: insert grant names the person too",
     [("grant select, insert (company_id), update (expires_at), delete on private.queue_claims to authenticated;",
       "grant select, insert (company_id, user_id), update (expires_at), delete on private.queue_claims to authenticated;")]),
    ("Claim guard: the client's person kept (the grant and the insert policy still stop it)",
     [("    new.user_id := caller;\n    new.claimed_at := now();", "    new.user_id := coalesce(new.user_id, caller);\n    new.claimed_at := now();")], SURVIVES),
    ("Claim guard, grant and insert policy: a claim for someone else (all three layers)",
     [("    new.user_id := caller;\n    new.claimed_at := now();", "    new.user_id := coalesce(new.user_id, caller);\n    new.claimed_at := now();"),
      ("grant select, insert (company_id), update (expires_at), delete on private.queue_claims to authenticated;",
       "grant select, insert (company_id, user_id), update (expires_at), delete on private.queue_claims to authenticated;"),
      ("  org_id = (select private.current_org_id()) and user_id = (select auth.uid())\n  and exists (select 1 from public.companies c where c.id = queue_claims.company_id",
       "  org_id = (select private.current_org_id())\n  and exists (select 1 from public.companies c where c.id = queue_claims.company_id")]),
    ("Claim guard: no limit of 3",
     [("           where q.user_id = caller and q.expires_at > now() and q.company_id <> new.company_id) >= 3 then",
       "           where q.user_id = caller and q.expires_at > now() and q.company_id <> new.company_id) >= 1000 then")]),
    ("Claim guard: expired claims count toward the limit",
     [("           where q.user_id = caller and q.expires_at > now() and q.company_id <> new.company_id) >= 3 then",
       "           where q.user_id = caller and q.company_id <> new.company_id) >= 3 then")]),
    ("Claim guard: renewing an expired claim passes the limit",
     [("  if (tg_op = 'INSERT' or old.expires_at <= now())\n", "  if tg_op = 'INSERT'\n")]),
    ("Claim guard trigger dropped",
     [("create trigger claim_guard before insert or update on private.queue_claims\n  for each row execute function private.claim_guard();", "")]),
    ("Claim guard: other fields may change (the column grants still stop it)",
     [("    raise exception 'only the end of a claim can change' using errcode = '42501', hint = 'not_editable';\n", "    null;\n")], SURVIVES),
    ("Claim guard: no per-person lock (claim_lead and the queue still take it)",
     [(GUARD_LOCK, "  if tg_op = 'INSERT' then")], SURVIVES),
    ("Claims: no per-person lock anywhere (two tabs pass the limit)",
     [(GUARD_LOCK, "  if tg_op = 'INSERT' then"),
      ("  -- The caller's claims take turns (the claim guard takes the same lock), so two tabs never pass the limit together.\n" + RPC_LOCK,
       "  -- The caller's claims take turns (the claim guard takes the same lock), so two tabs never pass the limit together.\n"),
      ("    raise exception 'only the lead''s owner, a manager or an admin can claim it' using errcode = '42501', hint = 'scope';\n  end if;\n" + RPC_LOCK,
       "    raise exception 'only the lead''s owner, a manager or an admin can claim it' using errcode = '42501', hint = 'scope';\n  end if;\n")]),
    ("claim_next_lead: an expired claim is not removed first (a closed laptop keeps its leads)",
     [("      delete from private.queue_claims q where q.company_id = v_cand and q.expires_at <= now();\n", "")]),
    ("claim_next_lead: candidates include leads with a live claim (the primary key still refuses them)",
     [("         where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at is null\n           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))\n           and not exists (select 1 from private.queue_claims q where q.company_id = c.id and q.expires_at > now())\n",
       "         where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at is null\n           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))\n")], SURVIVES),
    ("claim_next_lead: no second look after winning a claim (a lead a teammate just called is served again)",
     [("      if v_got is not null and not exists (\n", "      if false and not exists (\n")]),
    ("claim_next_lead: the session's skips ignored",
     [("  v_skip := v_exclude || coalesce(p_keep, '{}'::uuid[]);", "  v_skip := coalesce(p_keep, '{}'::uuid[]);")]),
    ("claim_next_lead: the caller's other claims kept (the screen holds more than it shows)",
     [("     where q.user_id = caller and (not (q.company_id = any (p_keep)) or q.expires_at <= now());", "     where false;")]),
    ("claim_next_lead: a reload resumes claims that are no longer eligible",
     [("      if v_won < p_count and r.live and r.eligible then", "      if v_won < p_count and r.live then")]),
    ("claim_next_lead: no limit on kept plus new cards",
     [("     or coalesce(cardinality(p_keep), 0) + p_count > 3\n", "")]),
    ("claim_next_lead: follow-ups not first (the walk starts at Negotiation)",
     [("  v_seg integer := 0;", "  v_seg integer := 1;")]),
    ("Queue follow-ups: a task due today is not yet due",
     [("                   and (t.due_date <= p_today or t.due_at <= now() + interval '5 minutes')\n                 group by t.company_id) f\n          join public.companies c on c.id = f.company_id\n         where c.owner_id = caller and c.queue_rank is not null",
       "                   and (t.due_date < p_today or t.due_at <= now() + interval '5 minutes')\n                 group by t.company_id) f\n          join public.companies c on c.id = f.company_id\n         where c.owner_id = caller and c.queue_rank is not null")]),
    ("Queue follow-ups: the next call date wins over the task",
     [("         where c.owner_id = caller and c.queue_rank is not null\n",
       "         where c.owner_id = caller and c.queue_rank is not null and (c.next_action_at is null or c.next_action_at <= now())\n")]),
    ("Queue order: leads called before come first among first calls",
     [("         where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at is null\n           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))\n           and not exists (select 1 from private.queue_claims q where q.company_id = c.id and q.expires_at > now())\n         order by c.next_action_at, c.last_activity_at nulls first, c.id",
       "         where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at is null\n           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))\n           and not exists (select 1 from private.queue_claims q where q.company_id = c.id and q.expires_at > now())\n         order by c.next_action_at, c.last_activity_at nulls last, c.id")]),
    ("Queue Mine: anyone's leads (dated part)",
     [("         where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at <= now()\n           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))\n           and not exists",
       "         where c.queue_rank = v_rank and c.next_action_at <= now()\n           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))\n           and not exists")]),
    ("Queue Mine + unassigned: the second half takes anyone's leads",
     [("                 where c.owner_id is null and c.queue_rank = v_rank and c.next_action_at is null\n",
       "                 where c.queue_rank = v_rank and c.next_action_at is null\n")]),
    ("Queue Mine: future dates offered (no stop at now; the second look after the claim still lets them go)",
     [("         where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at <= now()\n           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))\n           and not exists",
       "         where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at is not null\n           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))\n           and not exists")], SURVIVES),
    ("log_activity: a call from the queue keeps its claim",
     [("    delete from private.queue_claims q where q.company_id = p_company and q.user_id = caller;\n", "    null;\n")]),
    ("log_activity: a call from the queue releases anyone's claim (the delete policy still stops it)",
     [("    delete from private.queue_claims q where q.company_id = p_company and q.user_id = caller;\n",
       "    delete from private.queue_claims q where q.company_id = p_company;\n")], SURVIVES),
    ("log_activity and the delete policy: a call from the queue releases a teammate's claim (both layers)",
     [("    delete from private.queue_claims q where q.company_id = p_company and q.user_id = caller;\n",
       "    delete from private.queue_claims q where q.company_id = p_company;\n"),
      ("  org_id = (select private.current_org_id()) and (user_id = (select auth.uid()) or expires_at <= now()));",
       "  org_id = (select private.current_org_id()));")]),
    ("log_activity: the lead locked FOR UPDATE again (a claim waits for the call)",
     [("      into v_lead from public.companies c where c.id = p_company for no key update;",
       "      into v_lead from public.companies c where c.id = p_company for update;")]),
    ("get_lead: worked_by names the caller",
     [("                   where q.company_id = c.id and q.expires_at > now() and q.user_id <> (select auth.uid()))",
       "                   where q.company_id = c.id and q.expires_at > now())")]),
    ("get_lead: worked_by from an expired claim",
     [("                   where q.company_id = c.id and q.expires_at > now() and q.user_id <> (select auth.uid()))",
       "                   where q.company_id = c.id and q.user_id <> (select auth.uid()))")]),
    ("Calling hours: the lunch switch also cuts a span (no span has a European end, so the Europe/* rule still spares them)",
     [("    if v_ends is null and coalesce(p_skip_lunch, false) and z like 'Europe/%' and m >= 720 and m < 840 then",
       "    if coalesce(p_skip_lunch, false) and z like 'Europe/%' and m >= 720 and m < 840 then")], SURVIVES),
    ("Calling hours: the lunch switch outside Europe",
     [("    if v_ends is null and coalesce(p_skip_lunch, false) and z like 'Europe/%' and m >= 720 and m < 840 then",
       "    if v_ends is null and coalesce(p_skip_lunch, false) and m >= 720 and m < 840 then")]),
    ("Calling hours: 18:00 still open",
     [("    if m < 540 or m >= 1080 then", "    if m < 540 or m > 1080 then")]),
    ("Calling hours: weekends open",
     [("    if extract(isodow from l) > 5 then\n      return false;\n    end if;\n    m :=", "    m :=")]),
    ("Calling zone keys: the zones a person may pick left out",
     [("          union all\n          select unnest(private.country_zone_choices(chr(a) || chr(b)))\n            from generate_series(65, 90) a, generate_series(65, 90) b\n", "")]),
    ("Audit: call_zone and queue_rank stored",
     [("  hidden constant text[] := array['search_text', 'email_key', 'phone_key', 'name_key', 'call_zone', 'queue_rank'];",
       "  hidden constant text[] := array['search_text', 'email_key', 'phone_key', 'name_key'];")]),
    ("Audit: the contact flag diffed",
     [("'next_action_at', 'phone_wrong_at', 'has_contact_phone')", "'next_action_at', 'phone_wrong_at')")]),
    ("list_tasks: days read in UTC, not the person's zone",
     [("  v_tz := private.caller_zone();\n  v_today := (now() at time zone v_tz)::date;\n  v_tomorrow := (v_today + 1)::timestamp at time zone v_tz;\n\n  if p_bucket = 'overdue' then",
       "  v_tz := 'UTC';\n  v_today := (now() at time zone v_tz)::date;\n  v_tomorrow := (v_today + 1)::timestamp at time zone v_tz;\n\n  if p_bucket = 'overdue' then")]),
    ("list_tasks: Today includes times already past",
     [("                 and (x.due_date = v_today or (x.due_at >= now() and x.due_at < v_tomorrow))\n",
       "                 and (x.due_date = v_today or x.due_at < v_tomorrow)\n")]),
    ("list_tasks: undated tasks missing from Upcoming",
     [("                 and (x.due_date > v_today or x.due_at >= v_tomorrow or (x.due_date is null and x.due_at is null))\n",
       "                 and (x.due_date > v_today or x.due_at >= v_tomorrow)\n")]),
    ("list_tasks: dismissed tasks listed in Today",
     [("               where (p_scope = 'team' or x.assignee_id = caller) and x.done_at is null and x.cancelled_at is null\n                 and (x.due_date = v_today",
       "               where (p_scope = 'team' or x.assignee_id = caller) and x.done_at is null\n                 and (x.due_date = v_today")]),
    ("list_tasks: Done keyset <= (a task repeated across pages)",
     [("                 and (p_after_id is null or (x.done_at, x.id) < (p_after_sort, p_after_id))",
       "                 and (p_after_id is null or (x.done_at, x.id) <= (p_after_sort, p_after_id))")]),
    ("list_tasks: Upcoming undated cursor >= (a task repeated across pages)",
     [("                      or (p_after_sort is null and s.sort_at is null and x.id > p_after_id))",
       "                      or (p_after_sort is null and s.sort_at is null and x.id >= p_after_id))")]),
    ("update_task: no contact pre-check (the policy answers 42501 instead of P0002)",
     [("  if p_contact is not null and not exists (select 1 from public.contacts k\n                                            where k.id = p_contact and k.company_id = v_company) then\n    raise exception 'contact not found on this lead' using errcode = 'P0002';\n  end if;\n  update public.tasks t",
       "  update public.tasks t")]),
    ("update_task: no person given leaves the task with nobody",
     [("         assignee_id = coalesce(p_assignee, t.assignee_id), contact_id = p_contact", "         assignee_id = p_assignee, contact_id = p_contact")]),
    ("delete_task: no fresh-code pre-check (no step_up hint)",
     [("    raise exception 'confirm it is you first' using errcode = '42501', hint = 'step_up';\n  end if;\n  if not exists (select 1 from public.tasks t where t.id = p_id) then",
       "  end if;\n  if not exists (select 1 from public.tasks t where t.id = p_id) then")]),
    ("Profile zone check trigger dropped",
     [("create trigger check_profile_timezone before update of timezone on public.profiles\n  for each row execute function private.check_profile_timezone();", "")]),
    ("set_my_timezone: no pre-check (the profile trigger still refuses it)",
     [("  if p_timezone is null or char_length(p_timezone) > 64\n     or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then",
       "  if false then")], SURVIVES),
    ("set_my_timezone and the profile trigger: any zone stored (both layers)",
     [("  if p_timezone is null or char_length(p_timezone) > 64\n     or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then",
       "  if false then"),
      ("create trigger check_profile_timezone before update of timezone on public.profiles\n  for each row execute function private.check_profile_timezone();", "")]),
    ("Claims: a lead delete is refused while it has a claim (claims must go with their lead)",
     [("  company_id uuid primary key references public.companies (id) on delete cascade,  -- one live claim per lead",
       "  company_id uuid primary key references public.companies (id),")]),
    ("renew_claims: brings back expired claims",
     [("     where q.user_id = caller and q.expires_at > now()\n    returning q.expires_at)", "     where q.user_id = caller\n    returning q.expires_at)")]),
    ("queue_summary: customers counted as having no number",
     [("count(*) filter (where c.queue_rank is null and c.lead_status in ('cold', 'warm', 'negotiation', 'cool_off')",
       "count(*) filter (where c.queue_rank is null")]),
    ("claim_next_lead: null in the skips accepted (every lead skipped)",
     [("     or array_position(p_keep, null) is not null or array_position(v_exclude, null) is not null\n", "")]),
    ("Queue Mine: future dates served (no stop at now, and no second look after the claim; both layers)",
     [("         where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at <= now()\n           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))\n           and not exists",
       "         where c.owner_id = caller and c.queue_rank = v_rank and c.next_action_at is not null\n           and (p_open is null or c.call_zone = any (p_open)) and not (c.id = any (p_skip))\n           and not exists"),
      ("      if v_got is not null and not exists (\n", "      if false and not exists (\n")]),
    ("Calling hours: the lunch switch cuts every zone, spans included (both layers)",
     [("    if v_ends is null and coalesce(p_skip_lunch, false) and z like 'Europe/%' and m >= 720 and m < 840 then",
       "    if coalesce(p_skip_lunch, false) and m >= 720 and m < 840 then")]),
    ("Claims delete and select policies: no organisation fence (another organisation clears expired claims; both layers)",
     [("  org_id = (select private.current_org_id()) and (user_id = (select auth.uid()) or expires_at <= now()));",
       "  user_id = (select auth.uid()) or expires_at <= now());"),
      ("create policy claims_select on private.queue_claims for select to authenticated\n  using (org_id = (select private.current_org_id()));",
       "create policy claims_select on private.queue_claims for select to authenticated\n  using (true);")]),
    ("Wrong number: a contact number without a digit counts as another working number (no find-the-number task)",
     [("                        where k.company_id = p_company and k.phone ~ '[0-9]' and k.phone_wrong_at is null\n",
       "                        where k.company_id = p_company and k.phone is not null and k.phone_wrong_at is null\n")]),
    ("Wrong number: a main line without a digit counts as another working number (no find-the-number task)",
     [("    if not ((coalesce(v_lead.phone ~ '[0-9]', false) and v_lead.phone_wrong_at is null and p_dialled <> 'lead')",
       "    if not ((v_lead.phone is not null and v_lead.phone_wrong_at is null and p_dialled <> 'lead')")]),
    ("Claim guard: a renewal of a lead that changed hands passes (renew_claims and the keep path still let it go)",
     [("  elsif not exists (select 1 from public.companies c\n                     where c.id = new.company_id\n                       and ((select private.is_manager_or_admin()) or c.owner_id = caller)) then\n    -- A lead that changed hands since it was claimed is never renewed (threat 13: nobody keeps a teammate's lead).\n    raise exception 'only a lead the caller may change can stay claimed' using errcode = '42501', hint = 'scope';\n", "")]),
    ("renew_claims: a reassigned lead's claim is renewed, not let go (the claim guard then refuses the renewal)",
     [('  delete from private.queue_claims q\n   where q.user_id = caller\n     and not exists (select 1 from public.companies c\n                      where c.id = q.company_id\n                        and ((select private.is_manager_or_admin()) or c.owner_id = caller));\n', "")]),
    ("claim_next_lead keep: a reassigned lead's claim is kept (the claim guard then refuses the renewal)",
     [("    delete from private.queue_claims q\n     where q.user_id = caller\n       and not exists (select 1 from public.companies c\n                        where c.id = q.company_id\n                          and (p_scope = 'team' or c.owner_id = caller\n                               or (p_scope = 'mine_unassigned' and c.owner_id is null)));\n", "")]),
    ("Renewals of a reassigned lead: the guard, renew_claims and the keep path all let it pass (all three layers)",
     [("  elsif not exists (select 1 from public.companies c\n                     where c.id = new.company_id\n                       and ((select private.is_manager_or_admin()) or c.owner_id = caller)) then\n    -- A lead that changed hands since it was claimed is never renewed (threat 13: nobody keeps a teammate's lead).\n    raise exception 'only a lead the caller may change can stay claimed' using errcode = '42501', hint = 'scope';\n", ""), ('  delete from private.queue_claims q\n   where q.user_id = caller\n     and not exists (select 1 from public.companies c\n                      where c.id = q.company_id\n                        and ((select private.is_manager_or_admin()) or c.owner_id = caller));\n', ""), ("    delete from private.queue_claims q\n     where q.user_id = caller\n       and not exists (select 1 from public.companies c\n                        where c.id = q.company_id\n                          and (p_scope = 'team' or c.owner_id = caller\n                               or (p_scope = 'mine_unassigned' and c.owner_id is null)));\n", "")]),
    ("claim_next_lead walk: no lead lock tried (waits on a teammate's claim; two crossing walks deadlock)",
     [("      continue when not pg_try_advisory_xact_lock(hashtextextended('queue_claim:' || v_cand::text, 0));\n", "")]),
]

# Day 4c redefines the audit trigger, get_lead and log_activity (create or replace, Day 4b's text kept): the earlier rows
# that edit those definitions now edit the Day 4c copy, where the live definition is. Rows whose Day 4b text changed in
# the copy get the Day 4c text (Day 4b row 5, the lock block; row 47, the audit's no-diff list).
REDEFINED_IN_4C = {
    "day3b": [28, 29],
    "day4a": [9, 32, 33, 83],
    "day4b": [4, 11, 12, 31, 32, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70,
              71, 72, 73, 74, 79, 87],
}
for _set, _rows, _default in (("day3b", MUTATIONS_3B, MIG_3B), ("day4a", MUTATIONS_4A, MIG_4A),
                              ("day4b", MUTATIONS_4B, MIG_4B)):
    for _n in REDEFINED_IN_4C[_set]:
        _title, _edits, *_flags = _rows[_n - 1]
        _rows[_n - 1] = (_title, [(MIG_4C, *_e[-2:]) if (_e[0] if len(_e) == 3 else _default) == MIG_4B else _e
                                  for _e in _edits], *_flags)
MUTATIONS_4B[4] = (MUTATIONS_4B[4][0], [(MIG_4C, LOG_LOCKS_4C, LOG_LOCKS_4C_REVERSED)])
# Row 65's text changed in Day 4c: another working number needs a digit (k.phone ~ '[0-9]').
MUTATIONS_4B[64] = (MUTATIONS_4B[64][0],
                    [(MIG_4C, "            or exists (select 1 from public.contacts k\n                        where k.company_id = p_company and k.phone ~ '[0-9]' and k.phone_wrong_at is null\n                          and not (p_dialled = 'contact' and k.id = p_contact))) then",
                      "            or false) then")])
MUTATIONS_4B[46] = (MUTATIONS_4B[46][0],
                    [(MIG_4C, "       and n.key not in ('updated_at', 'last_activity_at', 'next_action_at', 'phone_wrong_at', 'has_contact_phone')",
                      "       and n.key not in ('updated_at', 'last_activity_at', 'has_contact_phone')")])



# Day 5a (design 8.3, rows 1 to 31 in the design's order, then the builder's additions from 32). The default target is the
# Day 5a migration; a Region aims an edit at one function where the same text appears in several.
MUTATIONS_5A = [
    ("Grant update (status) on deals",
     [("      update (title, value, expected_close, fulfilment, contact_id, owner_id, stage_id, lost_reason, lost_note)",
       "      update (title, value, expected_close, fulfilment, contact_id, owner_id, stage_id, lost_reason, lost_note, status)")]),
    ("Grant update (stage_entered_at) on deals",
     [("      update (title, value, expected_close, fulfilment, contact_id, owner_id, stage_id, lost_reason, lost_note)",
       "      update (title, value, expected_close, fulfilment, contact_id, owner_id, stage_id, lost_reason, lost_note, stage_entered_at)")]),
    ("Guard: no value_required pre-check (the won-shape CHECK answers with the row)",
     [(DEAL_GUARD, "        if new.value is null or new.value <= 0 then\n          raise exception 'a won deal needs its final value'",
       "        if false then\n          raise exception 'a won deal needs its final value'")]),
    ("Guard: no fulfilment_required pre-check (the won-shape CHECK answers with the row)",
     [(DEAL_GUARD, "        if new.fulfilment is null then\n          raise exception 'a won deal needs how it ships'",
       "        if false then\n          raise exception 'a won deal needs how it ships'")]),
    ("Guard: no lost-reason pre-check (the hint test fails although the CHECK still raises)",
     [(DEAL_GUARD, "        if new.lost_reason is null or new.lost_reason not in (",
       "        if false and new.lost_reason not in (")]),
    ("Guard: won and lost reachable from a closed deal (no reopen_first)",
     [(DEAL_GUARD, "      if v_to in ('won', 'lost') and old.status <> 'open' then", "      if false then")]),
    ("Guard: reopening a won deal needs no fresh code",
     [(DEAL_GUARD, "        if not (select private.has_recent_aal2(600)) then\n          raise exception 'confirm it is you first' using errcode = '42501', hint = 'step_up';\n        end if;\n",
       "")]),
    ("Undo candidate: ignores who made the change",
     [(CANDIDATE, "     and h.actor_id = (select auth.uid())\n", "")]),
    ("Undo candidate: ignores the 120-second window",
     [(CANDIDATE, "     and h.created_at > now() - interval '120 seconds'\n", "")]),
    ("Undo candidate: ignores version_after (a colleague's change in between)",
     [(CANDIDATE, "\n     and h.version_after = p_old_version", "")]),
    ("move_deal: no version compare",
     [(MOVE_DEAL, "  if v_deal.version <> p_expected_version then", "  if false then")]),
    ("History: insert granted to clients",
     [("grant select on public.deal_stage_history to authenticated;", "grant select, insert on public.deal_stage_history to authenticated;")]),
    ("History: actor taken from the deal's owner",
     [(DEAL_HISTORY, "  values (new.org_id, new.id, (select auth.uid()), v_kind,", "  values (new.org_id, new.id, new.owner_id, v_kind,")]),
    ("Delete policy: no fresh code for managers and admins",
     [("       ((select private.has_recent_aal2(600)) and (select private.is_manager_or_admin()))\n    or (created_by",
       "       ((select private.is_manager_or_admin()))\n    or (created_by")]),
    ("Delete policy: the creator's branch without version = 0 (a moved deal deleted without a code)",
     [("    or (created_by = (select auth.uid()) and version = 0 and created_at > now() - interval '120 seconds'",
       "    or (created_by = (select auth.uid()) and created_at > now() - interval '120 seconds'")]),
    ("Deals: lead FK back to set null",
     [("references public.companies (id) on delete restrict", "references public.companies (id) on delete set null")]),
    ("Tasks: deal FK back to cascade",
     [("foreign key (deal_id) references public.deals (id) on delete set null;", "foreign key (deal_id) references public.deals (id) on delete cascade;")]),
    ("Task guard: deal_id not in the link-emptying exception",
     [(TASK_GUARD_5A, "'created_by', 'deal_id', 'source_activity_id']", "'created_by', 'source_activity_id']")]),
    ("Stages: the admin update policy and grant restored",
     [("revoke insert, update, delete on public.pipeline_stages from authenticated;  -- select (own org) and require_mfa stay",
       "revoke insert, update, delete on public.pipeline_stages from authenticated;\ngrant update on public.pipeline_stages to authenticated;\n"
       "create policy pipeline_stages_admin_update on public.pipeline_stages for update to authenticated\n"
       "  using (org_id = (select private.current_org_id()) and (select private.is_admin()))\n"
       "  with check (org_id = (select private.current_org_id()) and (select private.is_admin()));")]),
    ("Value CHECK: no NaN term (the 100,000,000 bound refuses NaN too: NaN sorts above every number)",
     [("check (value is null or (value >= 0 and value <> 'NaN' and value <= 100000000))",
       "check (value is null or (value >= 0 and value <= 100000000))")], SURVIVES),
    ("Value CHECK: no NaN term and no bound (both layers of the backstop)",
     [("check (value is null or (value >= 0 and value <> 'NaN' and value <= 100000000))", "check (value is null or value >= 0)")]),
    ("move_deal: locks the deal FOR UPDATE (blocks behind an entry's key lock; spike S8)",
     [(MOVE_DEAL, "    from public.deals d where d.id = p_id for no key update;", "    from public.deals d where d.id = p_id for update;")]),
    ("Lead coupling: a win overrides Do not contact",
     [(MOVE_DEAL, "      elsif p_stage = 'won' and v_lead_status in ('cold', 'warm', 'negotiation', 'cool_off') then",
       "      elsif p_stage = 'won' and v_lead_status in ('cold', 'warm', 'negotiation', 'cool_off', 'do_not_contact') then")]),
    ("Lead coupling: without the editor lock (row level security on the lead update still stops it)",
     [(MOVE_DEAL, "    v_lead_editable := found;\n  end if;",
       "    v_lead_editable := true;\n    if not found then\n      select c.lead_status, c.next_action_at into v_lead_status, v_lead_next from public.companies c where c.id = v_deal.company_id;\n    end if;\n  end if;")], SURVIVES),
    ("Lead coupling: without the editor lock, and move_deal runs as its owner (both layers)",
     [(MOVE_DEAL, "    v_lead_editable := found;\n  end if;",
       "    v_lead_editable := true;\n    if not found then\n      select c.lead_status, c.next_action_at into v_lead_status, v_lead_next from public.companies c where c.id = v_deal.company_id;\n    end if;\n  end if;"),
      (MOVE_DEAL, ") returns jsonb\nlanguage plpgsql volatile set search_path = '' as $$",
       ") returns jsonb\nlanguage plpgsql volatile security definer set search_path = '' as $$")]),
    ("Undo: the lead put back whatever it holds now",
     [(MOVE_DEAL, "         set lead_status = case when c.lead_status = v_move.new_lead_status then v_move.prev_lead_status\n                                else c.lead_status end,",
       "         set lead_status = v_move.prev_lead_status,"),
      (MOVE_DEAL, "       where c.id = v_deal.company_id\n         and (c.lead_status = v_move.new_lead_status\n              or (v_move.new_next_action_at is distinct from v_move.prev_next_action_at\n                  and c.next_action_at is not distinct from v_move.new_next_action_at));",
       "       where c.id = v_deal.company_id;")]),
    ("Guard: no open flood guard (since verifier round 2 the statement-level recount answers the same rate_limited)",
     [(DEAL_GUARD, "                               limit 30) recent) >= 30 then", "                               limit 30) recent) >= 30 and false then")], SURVIVES),
    ("Guard: no stage-change flood guard (since verifier round 2 the statement-level recount answers the same rate_limited)",
     [(DEAL_GUARD, "                               limit 120) recent) >= 120 then", "                               limit 120) recent) >= 120 and false then")], SURVIVES),
    ("Deals: request id index not unique",
     [("create unique index deals_creator_request_idx", "create index deals_creator_request_idx")]),
    ("Column keyset: <= instead of < (a deal repeated across pages)",
     [(ORG_RECENT_PAGE, "         and (d.stage_entered_at, d.id) < (coalesce(p_after_at, 'infinity'::timestamptz),",
       "         and (d.stage_entered_at, d.id) <= (coalesce(p_after_at, 'infinity'::timestamptz),")]),
    ("pipeline_board: a rep's team is not mapped to their own deals (42501 on first paint)",
     [(BOARD, "  v_owner := private.deal_scope_owner(p_scope, p_owner, false);", "  v_owner := private.deal_scope_owner(p_scope, p_owner, true);")]),
    ("Guard: an invisible stage answers P0002 instead of 42501",
     [(DEAL_GUARD, "      raise exception 'this stage is not one of your pipeline''s' using errcode = '42501', hint = 'stage';",
       "      raise exception 'this stage is not one of your pipeline''s' using errcode = 'P0002', hint = 'stage';")]),
    ("Guard: a lost note change is not a change (no version, no check)",
     [(DEAL_GUARD, "   where n.value is distinct from o.value and n.key <> 'updated_at';\n  if changed = '{}' then",
       "   where n.value is distinct from o.value and n.key not in ('updated_at', 'lost_note');\n  if changed = '{}' then")]),
    # Builder's additions
    ("Undo: the value is not restored from history (the client's or the won value stays)",
     [(DEAL_GUARD, "      new.value := v_hist.value_before;\n", "")]),
    ("Guard: no Do not contact check on insert",
     [(DEAL_GUARD, "    if v_lead_status = 'do_not_contact' then", "    if false then")]),
    ("Guard: created_by left to the client (empty)",
     [(DEAL_GUARD, "    new.created_by := caller;\n", "")]),
    ("Guard: an admin's deal left without an owner (G11)",
     [(DEAL_GUARD, "    new.owner_id := coalesce(new.owner_id, caller);\n", "")]),
    ("Guard: a closed deal's value, shipping and dates editable",
     [(DEAL_GUARD, "    if old.status <> 'open' and not changed <@ array['contact_id', 'owner_id', 'title'] then",
       "    if false then")]),
    ("Guard: the client's stage clock kept on insert (no insert grant on it, and its default is now())",
     [(DEAL_GUARD, "    new.stage_entered_at := now();\n    new.owner_id", "    new.owner_id")], SURVIVES),
    ("Guard: the client's stage clock kept on insert, and granted (both layers)",
     [(DEAL_GUARD, "    new.stage_entered_at := now();\n    new.owner_id", "    new.owner_id"),
      ("grant insert (company_id, contact_id, title, value, expected_close, fulfilment, owner_id, source_activity_id, request_id),",
       "grant insert (company_id, contact_id, title, value, expected_close, fulfilment, owner_id, source_activity_id, request_id, stage_entered_at),")]),
    ("Deals select: no organisation check",
     [("create policy deals_select on public.deals for select to authenticated using (\n  org_id = (select private.current_org_id())\n  and ((select",
       "create policy deals_select on public.deals for select to authenticated using (\n  true\n  and ((select")]),
    ("History select: no deal visibility (a colleague's deal history readable)",
     [("  and exists (select 1 from public.deals d where d.id = deal_stage_history.deal_id));  -- deals RLS decides",
       ");")]),
    ("Move records: a row for another person's change",
     [("                             and h.actor_id = (select auth.uid()) and d.company_id = deal_moves.company_id));",
       "                             and d.company_id = deal_moves.company_id));")]),
    ("delete_deal: no fresh-code pre-check (no step_up hint)",
     [(DELETE_DEAL, "    if not (select private.has_recent_aal2(600)) then\n      raise exception 'confirm it is you first'",
       "    if false then\n      raise exception 'confirm it is you first'")]),
    ("update_deal: no field whitelist",
     [(UPDATE_DEAL, "     or not p_fields <@ array['title', 'value', 'expected_close', 'fulfilment', 'contact_id', 'owner_id']\n", "")]),
    ("list_stage_deals: half a cursor accepted",
     [(LIST_STAGE, "  if (p_after_at is null) <> (p_after_id is null) then", "  if false then")]),
    ("Cards: stalled ignores the lead's last activity",
     [(CARDS, "           and greatest(d.stage_entered_at, coalesce(c.last_activity_at, '-infinity'::timestamptz))\n               < now()",
       "           and d.stage_entered_at\n               < now()")]),
    ("Lead coupling: a loss rests the lead although another deal is open",
     [(MOVE_DEAL, "            and not exists (select 1 from public.deals x\n                             where x.company_id = v_deal.company_id and x.id <> p_id and x.status = 'open') then",
       " then")]),
    ("Audit: the version diffed",
     [(AUDIT_ROW_5A, "       and not (is_deal and n.key in ('version', 'lost_note'));", "       and not (is_deal and n.key = 'lost_note');")]),
    ("Audit: the lost note copied",
     [(AUDIT_ROW_5A, "       and not (is_deal and n.key in ('version', 'lost_note'));", "       and not (is_deal and n.key = 'version');"),
      (AUDIT_ROW_5A, "    if is_deal and (to_jsonb(new) -> 'lost_note') is distinct from (to_jsonb(old) -> 'lost_note') then", "    if false then")]),
    ("open_deal: no lead lock (a non-editor's open reaches the policy; the answer loses its hint)",
     [(OPEN_DEAL, "  select c.lead_status, c.next_action_at into v_lead from public.companies c where c.id = p_company for update;\n  if not found then",
       "  select c.lead_status, c.next_action_at into v_lead from public.companies c where c.id = p_company;\n  if not found then")]),
    ("Guard: the value bound not checked on a same-stage change (the CHECK answers with the row)",
     [(DEAL_GUARD, "    if new.value is distinct from old.value\n       and new.value is not null and (new.value = 'NaN' or new.value < 0 or new.value > 100000000) then",
       "    if false then")]),
    ("Undo: a win undone without the Day 6 block check",
     [(DEAL_GUARD, "      if v_from = 'won' or new.fulfilment is distinct from old.fulfilment then\n        v_block := private.deal_closing_blocked(new.id);",
       "      if false then\n        v_block := private.deal_closing_blocked(new.id);")]),
    # Verifier round 1 (the Day 6 seam is tested with a blocking stub; opens counted after delete; owner; undo replay)
    ("Guard: a win that changes the shipping skips the Day 6 block check",
     [(DEAL_GUARD, "        if new.fulfilment is distinct from old.fulfilment then\n          v_block := private.deal_closing_blocked(new.id);",
       "        if false then\n          v_block := private.deal_closing_blocked(new.id);")]),
    ("Guard: reopening a won deal without the Day 6 block check",
     [(DEAL_GUARD, "        v_block := private.deal_closing_blocked(new.id);\n        if v_block is not null then\n          raise exception 'this deal is held by stock records' using errcode = '42501', hint = 'blocked_' || v_block;\n        end if;\n        new.status := 'open';",
       "        new.status := 'open';")]),
    ("Guard: a shipping change on the same stage without the Day 6 block check",
     [(DEAL_GUARD, "        raise exception 'unknown way of shipping' using errcode = '22023', hint = 'fulfilment';\n      end if;\n      v_block := private.deal_closing_blocked(new.id);",
       "        raise exception 'unknown way of shipping' using errcode = '22023', hint = 'fulfilment';\n      end if;\n      v_block := null;")]),
    ("delete_deal: no Day 6 block check",
     [(DELETE_DEAL, "  v_block := private.deal_closing_blocked(p_id);", "  v_block := null;")]),
    ("Guard: the open flood guard counts live deals only (since verifier round 2 the statement-level recount counts the open records)",
     [(DEAL_GUARD, "    if (select count(*) from (select 1 from private.deal_opens o\n                               where o.user_id = caller and o.created_at > now() - interval '1 hour'",
       "    if (select count(*) from (select 1 from public.deals o\n                               where o.created_by = caller and o.created_at > now() - interval '1 hour'")], SURVIVES),
    ("History trigger: no open record written",
     [(DEAL_HISTORY, "      insert into private.deal_opens (user_id) values ((select auth.uid()));\n", "")]),
    ("Open records: insert granted to clients",
     [("grant select on private.deal_opens to authenticated;", "grant select, insert, delete on private.deal_opens to authenticated;")]),
    ("move_deal: no move record for an Undo with a request id (a repeated Undo is not a replay)",
     [(MOVE_DEAL, "    if p_request_id is not null then\n      insert into private.deal_moves (history_id, org_id, user_id, deal_id, company_id, request_id, prev_lead_status,\n                                      new_lead_status)\n",
       "    if false then\n      insert into private.deal_moves (history_id, org_id, user_id, deal_id, company_id, request_id, prev_lead_status,\n                                      new_lead_status)\n")]),
    ("Guard: a deal's owner can be emptied on update (G11)",
     [(DEAL_GUARD, "  if new.owner_id is null and old.owner_id is not null then", "  if false then")]),
    ("update_deal: no owner pre-check (the guard answers the same 22023 owner_required)",
     [(UPDATE_DEAL, "  if 'owner_id' = any (p_fields) and p_owner is null then", "  if false then")], SURVIVES),
    ("update_deal: no owner pre-check, and the guard lets the owner be emptied (both layers)",
     [(UPDATE_DEAL, "  if 'owner_id' = any (p_fields) and p_owner is null then", "  if false then"),
      (DEAL_GUARD, "  if new.owner_id is null and old.owner_id is not null then", "  if false then")]),
    ("delete_deal: the creator's window ignores the call's undo record (a refused delete answers P0002)",
     [(DELETE_DEAL, "                      and (v_deal.source_activity_id is null  -- the policy's undo-record condition (verifier finding 8)\n                           or not exists (select 1 from private.activity_undo u\n                                           where u.activity_id = v_deal.source_activity_id));",
       ";")]),
    # Verifier round 2 (one statement with many rows: the limits are counted again after the statement)
    ("Open flood: no statement-level recount (a bulk insert passes the 30-an-hour limit)",
     [(OPEN_FLOOD, "                             limit 31) recent) > 30 then", "                             limit 31) recent) > 30 and false then")]),
    ("Open flood: the statement-level recount allows 31 an hour",
     [(OPEN_FLOOD, "                             limit 31) recent) > 30 then", "                             limit 32) recent) > 31 then")]),
    ("Stage flood: no statement-level recount (a bulk PATCH passes the 120-a-minute limit)",
     [(MOVE_FLOOD, "                             limit 121) recent) > 120 then", "                             limit 121) recent) > 120 and false then")]),
    ("Stage flood: the statement-level recount is INVOKER (history on a deal handed on is not counted)",
     [(MOVE_FLOOD, "language plpgsql security definer set search_path = '' as $$", "language plpgsql security invoker set search_path = '' as $$")]),
    ("Stage flood: the statement-level recount runs for edits that change no stage",
     [(MOVE_FLOOD, "\n     or not exists (select 1 from new_deals n join old_deals o on o.id = n.id where n.stage_id is distinct from o.stage_id) then", " then")]),
    ("Open flood: no guard and no statement-level recount (both layers of row 27)",
     [(DEAL_GUARD, "                               limit 30) recent) >= 30 then", "                               limit 30) recent) >= 30 and false then"),
      (OPEN_FLOOD, "                             limit 31) recent) > 30 then", "                             limit 31) recent) > 30 and false then")]),
    ("Stage flood: no guard and no statement-level recount (both layers of row 28)",
     [(DEAL_GUARD, "                               limit 120) recent) >= 120 then", "                               limit 120) recent) >= 120 and false then"),
      (MOVE_FLOOD, "                             limit 121) recent) > 120 then", "                             limit 121) recent) > 120 and false then")]),
    ("Open flood: the guard counts live deals only, and no statement-level recount (both layers of row 58)",
     [(DEAL_GUARD, "    if (select count(*) from (select 1 from private.deal_opens o\n                               where o.user_id = caller and o.created_at > now() - interval '1 hour'",
       "    if (select count(*) from (select 1 from public.deals o\n                               where o.created_by = caller and o.created_at > now() - interval '1 hour'"),
      (OPEN_FLOOD, "                             limit 31) recent) > 30 then", "                             limit 31) recent) > 30 and false then")]),
]


# Day 5a redefines the audit trigger and the task guard: the earlier sets' rows aimed at those functions in the Day 4a
# and 4b migrations now edit the live Day 5a copy (rewritten here once, so each row keeps its number). Rows whose text
# Day 5a changed (the task guard's link exception gained deal_id; the audit line gained the deals rule) have their own
# Day 5a edit below.
OVERRIDES_5A = {
    ("day4a", "Task guard: no link-emptying exception (a contact delete must then fail)"):
        [(TASK_GUARD_5A, "    if pg_trigger_depth() > 1\n       and changed <@", "    if false\n       and changed <@")],
    ("day4a", "Task guard: link-emptying exception without the depth condition"):
        [(TASK_GUARD_5A, "    if pg_trigger_depth() > 1\n       and changed <@", "    if true\n       and changed <@")],
    ("day4a", "Task guard: link-emptying exception without created_by (the design's list: a person delete fails)"):
        [(TASK_GUARD_5A, "changed <@ array['assignee_id', 'contact_id', 'created_by', 'deal_id', 'source_activity_id']",
          "changed <@ array['assignee_id', 'contact_id', 'deal_id', 'source_activity_id']")],
    ("day4a", "Task guard: link-emptying exception lets a link move to another record (depth 2)"):
        [(TASK_GUARD_5A, "\n       and (new.assignee_id is null or new.assignee_id is not distinct from old.assignee_id)\n       and (new.contact_id is null or new.contact_id is not distinct from old.contact_id)\n       and (new.created_by is null or new.created_by is not distinct from old.created_by)\n       and (new.deal_id is null or new.deal_id is not distinct from old.deal_id)\n       and (new.source_activity_id is null or new.source_activity_id is not distinct from old.source_activity_id) then",
          " then")],
    ("day4a", "Task guard: link-emptying exception lets any column change (depth 2)"):
        [(TASK_GUARD_5A, "    if pg_trigger_depth() > 1\n       and changed <@ array['assignee_id', 'contact_id', 'created_by', 'deal_id', 'source_activity_id']\n",
          "    if pg_trigger_depth() > 1\n")],
    ("day4a", "Audit: an edit keeps the text"):
        [(AUDIT_ROW_5A, "       and not (is_activity and n.key = 'body')\n", ""),
         (AUDIT_ROW_5A, "    if is_activity and (to_jsonb(new) -> 'body') is distinct from (to_jsonb(old) -> 'body') then", "    if false then")],
}


def _relive(name, default, mutations):
    out = []
    for title, edits, *flags in mutations:
        if (name, title) in OVERRIDES_5A:
            edits = OVERRIDES_5A[(name, title)]
        else:
            moved = []
            for edit in edits:
                target, old, new = edit if len(edit) == 3 else (default, *edit)
                if title.startswith("Task guard") and target == MIG_4A:
                    target = TASK_GUARD_5A
                elif title.startswith("Audit") and target in (MIG_4B, MIG_4C):
                    target = AUDIT_ROW_5A
                moved.append((target, old, new))
            edits = moved
        out.append((title, edits, *flags))
    return out


MUTATIONS_3B = _relive("day3b", MIG_3B, MUTATIONS_3B)
MUTATIONS_4A = _relive("day4a", MIG_4A, MUTATIONS_4A)
MUTATIONS_4B = _relive("day4b", MIG_4B, MUTATIONS_4B)
MUTATIONS_4C = _relive("day4c", MIG_4C, MUTATIONS_4C)


# Earlier rows whose text Day 5b changed around (the replay answer appends the deal part; the deal check sits between
# the contact check and the dialled check): the same protection removed from the Day 5b copy.
UNIQUE_ANSWER_5B = ("    if v_constraint is distinct from 'activities_author_request_idx' then\n      raise;\n    end if;\n"
                    "    select a.id into v_id from public.activities a where a.user_id = caller and a.request_id = p_request_id;\n"
                    "    return private.logged_activity(v_id, true) || private.logged_activity_deal(v_id);")
OVERRIDES_5B = {
    # (Found at the 4c rebase by a check that every edit lands in a live definition: this row's text ended where Day 5b's
    # policy goes on with the deal clause, so it still edited the dropped Day 4a policy.)
    ("day4a", "Activities insert policy: a contact of another lead"):
        [(INSERT_POLICY_5B, "\n  and (contact_id is null or exists (select 1 from public.contacts k\n       where k.id = activities.contact_id and k.company_id = activities.company_id))", "")],
    ("day4b", "log_activity: no second replay check after the lock, and no unique-violation answer (both layers)"):
        [(LOG_ACTIVITY_5B, "    -- The same request may have been saved while this one waited for the lock.\n    if p_request_id is not null then",
          "    -- The same request may have been saved while this one waited for the lock.\n    if false then"),
         (LOG_ACTIVITY_5B, UNIQUE_ANSWER_5B, "    raise;")],
    ("day4b", "log_activity: no unique-violation answer (a concurrent duplicate fails)"):
        [(LOG_ACTIVITY_5B, UNIQUE_ANSWER_5B, "    raise;")],
    ("day4b", "Input: a contact of another lead (the policy answers 42501 instead of P0002)"):
        [(LOG_ACTIVITY_5B, "      from public.contacts k where k.id = p_contact and k.company_id = p_company;\n    if not found then\n"
          "      raise exception 'contact not found on this lead' using errcode = 'P0002';\n    end if;\n  end if;\n  -- A linked deal",
          "      from public.contacts k where k.id = p_contact;\n  end if;\n  -- A linked deal")],
}


def _relive_5b(default, mutations, name):
    """Moves an edit aimed inside a Day 4 function that Day 5b recreates to the Day 5b copy (REBASE: and again at 4c)."""
    out = []
    for title, edits, *flags in mutations:
        if (name, title) in OVERRIDES_5B:
            out.append((title, OVERRIDES_5B[(name, title)], *flags))
            continue
        moved = []
        for edit in edits:
            target, old, new = edit if len(edit) == 3 else (default, *edit)
            if not isinstance(target, Region):
                text = target.read_text()
                for original, copy in RELIVE_5B:
                    b = original.path == target and original.bounds(text)
                    if b and old in text[b[0]:b[1]] and text.count(old) == 1:
                        target = copy
                        break
            moved.append((target, old, new))
        out.append((title, moved, *flags))
    return out


MUTATIONS_4A = _relive_5b(MIG_4A, MUTATIONS_4A, "day4a")
MUTATIONS_4B = _relive_5b(MIG_4B, MUTATIONS_4B, "day4b")
MUTATIONS_3B = _relive_5b(MIG_3B, MUTATIONS_3B, "day3b")
MUTATIONS_4C = _relive_5b(MIG_4C, MUTATIONS_4C, "day4c")

# Day 5b (design 8.3 "5b", rows 1 to 5 in the design's order, then the builder's additions from 6). The default target is
# the Day 5b migration.
UNDO_DEAL_BLOCK = """  if u.created_deal_id is not null then
    if u.prev_status is null then
      perform 1 from public.companies c where c.id = v_company for update;
    end if;
    delete from public.deals d where d.id = u.created_deal_id and d.version = 0 and d.created_by = caller;
    v_deal := case when found then 'removed' else 'kept' end;
  end if;
"""
MUTATIONS_5B = [
    ("Activities insert policy: no same-lead deal check",
     [(INSERT_POLICY_5B, "\n  and (deal_id is null or exists (select 1 from public.deals d\n       where d.id = activities.deal_id and d.company_id = activities.company_id))", "")]),
    ("undo_activity: removes the deal without version = 0 (a moved deal goes too)",
     [(UNDO_ACTIVITY_5B, "d.id = u.created_deal_id and d.version = 0 and d.created_by = caller", "d.id = u.created_deal_id and d.created_by = caller")]),
    ("undo_activity: deletes the deal before the lead lock (deadlock test)",
     [(UNDO_ACTIVITY_5B, UNDO_DEAL_BLOCK, ""),
      (UNDO_ACTIVITY_5B, "  if u.prev_status is not null then\n    select c.lead_status",
       UNDO_DEAL_BLOCK.replace("    if u.prev_status is null then\n      perform 1 from public.companies c where c.id = v_company for update;\n    end if;\n", "")
       + "  if u.prev_status is not null then\n    select c.lead_status")]),
    ("Deal delete policy: creator branch without the activity-undo condition",
     [(MIG_5A, "    or (created_by = (select auth.uid()) and version = 0 and created_at > now() - interval '120 seconds'\n        and (source_activity_id is null\n             or not exists (select 1 from private.activity_undo u where u.activity_id = deals.source_activity_id)))));",
       "    or (created_by = (select auth.uid()) and version = 0 and created_at > now() - interval '120 seconds')));")]),
    ("log_activity: opens deals for people who may not change the lead",
     [(LOG_ACTIVITY_5B, "    if not v_editable then\n      v_deal_answer := jsonb_build_object('opened', false, 'reason', 'not_editable');\n    elsif", "    if")]),
    ("log_activity: opens a deal on a Do not contact lead (the guard refuses the whole call)",
     [(LOG_ACTIVITY_5B, "    elsif v_status = 'do_not_contact' then\n      v_deal_answer := jsonb_build_object('opened', false, 'reason', 'dnc');\n", "")]),
    ("log_activity: no open-rate check before the deal (the guard refuses the whole call)",
     [(LOG_ACTIVITY_5B, "                                  limit 30) recent) >= 30 then\n      v_deal_answer", "                                  limit 30) recent) >= 1000 then\n      v_deal_answer")]),
    ("log_activity: a deal opens from any outcome",
     [(LOG_ACTIVITY_5B, "  if (p_open_deal and (p_type is distinct from 'call' or p_outcome is null\n                       or p_outcome not in ('interested', 'meeting_booked') or p_deal is not null))\n     or",
       "  if")]),
    ("log_activity: no deal title pre-check (a skipped open never checks it)",
     [(LOG_ACTIVITY_5B, "  if v_deal_title is not null and (char_length(v_deal_title) > 120", "  if false and (char_length(v_deal_title) > 120")]),
    ("log_activity: no deal value pre-check (3 decimals rounded by the column)",
     [(LOG_ACTIVITY_5B, "  if not private.deal_value_ok(p_deal_value) then", "  if false then")]),
    ("log_activity: no same-lead check for a linked deal (the policy answers 42501 instead of P0002)",
     [(LOG_ACTIVITY_5B, "  if p_deal is not null and not exists (select 1 from public.deals d where d.id = p_deal and d.company_id = p_company) then",
       "  if false then")]),
    ("undo_activity: never removes the deal the call opened",
     [(UNDO_ACTIVITY_5B, "    delete from public.deals d where d.id = u.created_deal_id and d.version = 0 and d.created_by = caller;\n", "    perform 1 where false;\n")]),
    ("log_activity: the undo record forgets the deal",
     [(LOG_ACTIVITY_5B, "          v_completed, v_cancelled, v_deal);", "          v_completed, v_cancelled, null);")]),
    ("Replay answer without the opened deal",
     [("    'deal', case when u.created_deal_id is not null\n", "    'deal', case when false\n")]),
    ("get_lead: can_open_deal ignores Do not contact",
     [(GET_LEAD_5B, "    'can_open_deal', e.can_edit and c.lead_status <> 'do_not_contact'", "    'can_open_deal', e.can_edit")]),
    ("get_lead: open_count counts closed deals too",
     [(GET_LEAD_5B, "from public.deals d where d.company_id = c.id and d.status = 'open') o)", "from public.deals d where d.company_id = c.id) o)")]),
    ("log_activity runs as its owner (DEFINER: deals and links for anyone)",
     [(LOG_ACTIVITY_5B, ") returns jsonb\nlanguage plpgsql volatile set search_path = ''", ") returns jsonb\nlanguage plpgsql volatile security definer set search_path = ''")]),
    # Added at the 4c rebase: the work queue's card (claim_next_lead) says how many open deals the lead has.
    ("Queue card: open_deal counts closed deals too",
     [(QUEUE_CARD_5B, "                   where d.company_id = c.id and d.status = 'open'))", "                   where d.company_id = c.id))")]),
    ("Queue card: open_deal's newest is the oldest",
     [(QUEUE_CARD_5B, "order by d.stage_entered_at desc, d.id desc))[1])", "order by d.stage_entered_at, d.id))[1])")]),
    ("Queue card runs as its owner (DEFINER: every deal in the org counted for a rep)",
     [(QUEUE_CARD_5B, "returns jsonb\nlanguage sql stable set search_path = ''", "returns jsonb\nlanguage sql stable security definer set search_path = ''")]),
]


MUTATIONS_5C = [
    ("home_summary: no scope check (a rep asking for the team gets the org's figures)",
     [(SUMMARY, SCOPE_5C, "")]),
    ("Month start in UTC, not the profile zone",
     [(HOME_WINDOW, "(w.today - (extract(day from w.today)::integer - 1))::timestamp at time zone p_tz",
       "date_trunc('month', p_at at time zone 'UTC') at time zone 'UTC'")]),
    ("Day end = day start + 24 h (a 23 or 25 hour day)",
     [(HOME_WINDOW, "(w.today + 1)::timestamp at time zone p_tz,", "w.today::timestamp at time zone p_tz + interval '24 hours',")]),
    ("Win rate counts Opened by mistake",
     [(SUMMARY_TEAM_CLOSED, "d.status = 'lost' and d.lost_reason <> 'mistake'", "d.status = 'lost'"),
      (SUMMARY_MINE_CLOSED, "d.status = 'lost' and d.lost_reason <> 'mistake'", "d.status = 'lost'")]),
    ("The feed selects the entry's text",
     [(RECENT_MINE, "a.type, a.outcome, null::text as to_stage,\n                  null::text as value",
       "a.type, a.outcome, null::text as to_stage,\n                  a.body as value")]),
    ("home_summary runs as its owner (SECURITY DEFINER: past the row rules)",
     [(SUMMARY, ") returns jsonb\nlanguage plpgsql stable set search_path = ''",
       ") returns jsonb\nlanguage plpgsql stable security definer set search_path = ''")]),
    # (Since the 4c rebase overdue and today come from count_tasks('mine'); the meetings of the day are still counted in
    # home_summary, so the row removes the caller filter there. Row 16 aims at the count_tasks call.)
    ("Tasks due ignores Mine (the org's meetings in Team)",
     [(SUMMARY, "                         where t.assignee_id = v_me and t.done_at is null and t.cancelled_at is null\n",
       "                         where t.done_at is null and t.cancelled_at is null\n")]),
    ("Stalled ignores the lead's last activity (Team)",
     [(OPEN_DEALS_ORG, "then greatest(d.stage_entered_at,\n                                    coalesce((select c.last_activity_at from public.companies c where c.id = d.company_id),\n                                             '-infinity'::timestamptz))",
       "then d.stage_entered_at")]),
    ("Calls today from midnight UTC (Mine)",
     [(SUMMARY, "where a.user_id = v_me and a.created_at >= w.day_start and a.type = 'call';",
       "where a.user_id = v_me and a.created_at >= (now() at time zone 'UTC')::date::timestamp at time zone 'UTC' and a.type = 'call';")]),
    ("Win rate shown from 3 closed deals",
     [(SUMMARY, ">= 5\n         then round(", ">= 3\n         then round(")]),
    ("home_attention: no scope check", [(ATTENTION, SCOPE_5C, "")]),
    ("home_attention: closing soon means 30 days",
     [(ATTENTION, "x.expected_close between v_today and v_today + 7)", "x.expected_close between v_today and v_today + 30)")]),
    ("home_attention: close date passed not first",
     [(ATTENTION, "row_number() over (order by (o.expected_close < v_today) is true desc,\n                                       ",
       "row_number() over (order by ")]),
    ("home_recent_activity: no scope check", [(RECENT, SCOPE_5C, "")]),
    ("home_recent_activity: undo pairs shown (Team)",
     [(RECENT_TEAM, "and h.kind <> 'undo'\n              and not exists (select 1 from public.deal_stage_history u where u.undoes = h.id)",
       "and true")]),
    # Row 16 aimed at the 5c stand-in home_today_tasks until the 4c rebase; the Today card now reads Day 4c's list_tasks
    # (its own rows), so the row aims at what Home still decides: K5/K6 are always the caller's own tasks.
    ("home_summary tasks: Team counts everyone's tasks (count_tasks('team') for Team)",
     [(SUMMARY, "    from public.count_tasks('mine') as k (v);",
       "    from public.count_tasks(case when v_team then 'team' else 'mine' end) as k (v);")]),
    # Rows 17 to 19: the low stock stub, Day 6's stock_alerts() signature since Haider's decision B (15 Oct 2026; row 17
    # aimed at the 5c draft home_low_stock(int) before).
    ("stock_alerts stub callable by anon",
     [("    grant execute on function public.stock_alerts() to authenticated;",
       "    grant execute on function public.stock_alerts() to authenticated, anon;")]),
    ("stock_alerts stub without the two-factor check (an aal1 session gets an answer)",
     [("      if (select auth.uid()) is null or not private.has_aal2() then\n        raise exception 'two-factor sign-in",
       "      if (select auth.uid()) is null then\n        raise exception 'two-factor sign-in")]),
    ("stock_alerts stub runs as its owner (SECURITY DEFINER)",
     [("    language plpgsql stable security invoker set search_path = '' as $f$",
       "    language plpgsql stable security definer set search_path = '' as $f$")]),
    # Rows 20 and 21 (advisor, 15 Oct 2026): home_attack accepts null (this stub) or exactly Day 6's shape (6d's real
    # body after its create or replace); any other answer fails, e.g. Day 6's keys plus a purchase cost, or an empty object.
    ("stock_alerts answers Day 6's keys plus an extra one (a purchase cost)",
     [("      return null;  -- inventory not set up yet",
       "      return jsonb_build_object('low', 0, 'sold_out', 0, 'arriving_late', 0, 'requests_new', 0, "
       "'holds_ending_soon', 0, 'deals_waiting', 0, 'sample', '[]'::jsonb, 'cost_per_piece', 4.1);")]),
    ("stock_alerts answers an empty object",
     [("      return null;  -- inventory not set up yet", "      return '{}'::jsonb;")]),
]


SETS = {"day3b": (MIG_3B, MUTATIONS_3B), "day4a": (MIG_4A, MUTATIONS_4A), "day4b": (MIG_4B, MUTATIONS_4B),
        "day4c": (MIG_4C, MUTATIONS_4C), "day5a": (MIG_5A, MUTATIONS_5A), "day5b": (MIG_5B, MUTATIONS_5B),
        "day5c": (MIG_5C, MUTATIONS_5C)}


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
            target, old, new = edit if len(edit) == 3 else (default, *edit)
            path = target.path if isinstance(target, Region) else target
            files.setdefault(path, path.read_text())
            text = files[path]
            lo, hi = 0, len(text)
            if isinstance(target, Region):
                b = target.bounds(text)
                if b is None:
                    print(f"| {i} | {title} | NOT APPLIED (function not found once: {target.name}) | |")
                    counts["unexpected"] += 1
                    applied = False
                    break
                lo, hi = b
            part = text[lo:hi]
            if part.count(old) != 1:
                where = target.name if isinstance(target, Region) else path.name
                print(f"| {i} | {title} | NOT APPLIED (pattern found {part.count(old)} times in {where}) | |")
                counts["unexpected"] += 1
                applied = False
                break
            files[path] = text[:lo] + part.replace(old, new) + text[hi:]
        if not applied:
            continue
        if ANCHORS_ONLY:
            print(f"| {i} | {title} | anchor found | |")
            counts["caught"] += 1
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


ANCHORS_ONLY = False


def main() -> int:
    global ANCHORS_ONLY
    args = sys.argv[1:]
    if args[:1] == ["--anchors"]:
        ANCHORS_ONLY, args = True, args[1:]
    chosen = "all"
    if args[:1] == ["--set"]:
        chosen, args = args[1], args[2:]
    only = {int(a) for a in args}  # optional: mutation numbers to run (within one set)
    names = list(SETS) if chosen == "all" else [chosen]
    unexpected = sum(run_set(n, only) for n in names)
    return 1 if unexpected else 0


if __name__ == "__main__":
    sys.exit(main())
