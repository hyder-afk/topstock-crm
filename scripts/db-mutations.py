#!/usr/bin/env python3
"""Local only: proves the Day 3b database tests catch each protection being removed (design section 6A).

For each mutation below, the lead-import migration is changed in place, scripts/db-test.sh runs (migrations, RLS and
import attack tests, two-session test), and the migration is restored. A mutation is "caught" when the run fails.
Usage: python3 scripts/db-mutations.py [numbers...]  (about 40 s per mutation). Writes a Markdown table to stdout.
A protection with two layers is also removed together with its second layer (one mutation each way).
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase/migrations/20261010150000_lead_import.sql"

MUTATIONS = [
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
       "      and (select private.has_recent_aal2(600))\n      and (last_activity_at is null")]),
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
     [("     and not exists (select 1 from public.activities a where a.company_id = c.id)\n", "")]),
    ("Undo: leads with a contact count as untouched",
     [("     and not exists (select 1 from public.contacts k where k.company_id = c.id)\n", "")]),
    ("Undo: leads with a deal count as untouched",
     [("     and not exists (select 1 from public.deals d where d.company_id = c.id)\n", "")]),
    ("Undo: edited leads count as untouched",
     [("c.import_batch_id = p_batch and c.updated_at = c.created_at", "c.import_batch_id = p_batch")]),
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
     [("  elsif tg_op = 'INSERT' and tg_table_name = 'companies' and rec ->> 'import_batch_id' is not null then\n    diff := jsonb_build_object('import_batch_id', rec -> 'import_batch_id');\n", "")]),
    ("Audit: search and key columns kept",
     [("(case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) - hidden;",
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


def main() -> int:
    only = {int(a) for a in sys.argv[1:]}  # optional: mutation numbers to run
    original = MIG.read_text()
    print("| # | Protection removed | Result | First failure |")
    print("|---|---|---|---|")
    survived = 0
    try:
        for i, (title, edits) in enumerate(MUTATIONS, 1):
            if only and i not in only:
                continue
            text = original
            for old, new in edits:
                if text.count(old) != 1:
                    print(f"| {i} | {title} | NOT APPLIED (pattern found {text.count(old)} times) | |")
                    survived += 1
                    break
                text = text.replace(old, new)
            else:
                MIG.write_text(text)
                run = subprocess.run(["bash", str(ROOT / "scripts/db-test.sh")], capture_output=True, text=True)
                out = run.stdout + run.stderr
                first = next((l.strip() for l in out.splitlines() if "FAIL" in l or "ERROR" in l), "")
                first = first.split("ERROR:", 1)[-1].strip().replace("|", "/")[:140]
                # Invisible characters (a file-name test prints a bidi override) as escapes, so the table reads right.
                first = "".join(c if c.isprintable() else f"\\u{ord(c):04X}" for c in first)
                caught = run.returncode != 0
                survived += 0 if caught else 1
                print(f"| {i} | {title} | {'caught' if caught else '**NOT CAUGHT**'} | {first} |", flush=True)
    finally:
        MIG.write_text(original)
    return 1 if survived else 0


if __name__ == "__main__":
    sys.exit(main())
