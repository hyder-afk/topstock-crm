-- Day 3b: importing leads from a CSV file (Master Plan section 7, Cloud Workflow section 7; design in
-- docs/evidence/day3b/design.md). An admin with an authenticator code from the last 10 minutes uploads the cleaned rows
-- of a file into a working table, checks them (problems, duplicates), imports them in chunks, and can undo the import.
-- Everything runs with the admin's own login: nothing here is SECURITY DEFINER except the existing audit trigger, so
-- every rule below (RLS, column grants, checks, the batch guard trigger) also holds for direct API calls.

-- ---------------------------------------------------------------------------
-- 1. Duplicate keys
-- ---------------------------------------------------------------------------
-- Keys are stored columns compared with "=", which is leakproof, so their indexes work under row level security (an
-- expression index or a LIKE would not). plpgsql keeps one cached plan per session; each function is one level deep.

-- Email: trimmed and lowercased.
create function private.lead_email_key(e text) returns text
language plpgsql immutable parallel safe set search_path = '' as $$
begin
  return nullif(lower(btrim(e)), '');
end;
$$;

-- Phone: the last 9 digits of an 8 to 15 digit number, so "+33 (0)6 12 34 56 78", "06.12.34.56.78" and
-- "0033 6 12 34 56 78" are the same number; more than 15 digits means two numbers in one cell (no key).
create function private.lead_phone_key(p text) returns text
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
begin
  if char_length(d) < 8 or char_length(d) > 15 then
    return null;
  end if;
  return right(d, 9);
end;
$$;

-- Name + city + country, used only for rows with neither email nor phone. Accents are folded with a fixed map (no
-- dictionary, no locale), punctuation and spaces are removed, and legal forms (SARL, SAS, Ltd, GmbH...) are dropped as
-- whole words unless nothing else is left. No city, no key: a name alone never makes two companies the same.
-- The key must not depend on the database's locale: Supabase runs ICU (en-US), the local test runner libc (C.UTF-8),
-- and the two disagree on [[:punct:]], word boundaries and lower() (a Turkish locale even lower-cases "I" to "ı"). So
-- the map lower-cases A-Z and the Latin accents itself, both character sets below are fixed code point ranges, and a
-- legal form is a word between two spaces. lower() only sees the other scripts (Greek, Cyrillic, full-width...), where
-- ICU and libc give the same letter, except that ICU writes a Greek sigma at the end of a word as "ς" and libc as "σ":
-- "ς" becomes "σ" afterwards. (Only a letter newer than one side's Unicode tables could still differ.)
create function private.lead_name_key(name text, city text, country text) returns text
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  -- a-z, space, digits and "-" come first, mapped to themselves, only for speed: translate() looks each character up
  -- from the start of the map, so the common ones are found at once (the whole key takes half the time). Then A-Z and
  -- the Latin-1 Supplement and Latin Extended-A letters to lower-case ASCII (Æ æ Œ œ ß are replaced afterwards).
  fold_from constant text := 'abcdefghijklmnopqrstuvwxyz 0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝàáâãäåçèéêëìíîïðñòóôõöøùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĐđĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħĨĩĪīĬĭĮįİıĴĵĶķĸĹĺĻļĽľĿŀŁłŃńŅņŇňŉŊŋŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŧŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžſ';
  fold_to constant text := 'abcdefghijklmnopqrstuvwxyz 0123456789-abcdefghijklmnopqrstuvwxyzaaaaaaceeeeiiiidnoooooouuuuyaaaaaaceeeeiiiidnoooooouuuuyyaaaaaaccccccccddddeeeeeeeeeegggggggghhhhiiiiiiiiiijjkkkllllllllllnnnnnnnnnoooooorrrrrrssssssssttttttuuuuuuuuuuuuwwyyyzzzzzzs';
  -- Deleted from the name, as part of the word they sit in: dots (S.A.R.L.), soft hyphens, combining accents (a
  -- decomposed "é"), zero-width characters and the byte order mark.
  glue constant text := '[\u002E\u00AD\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u200B-\u200D\u2060\u20D0-\u20FF\uFE20-\uFE2F\uFEFF]';
  -- Removed from the city and turned into spaces in the name: ASCII other than letters and digits (so "|", which
  -- separates the parts of the key, never stays in a name or city), controls, Latin-1 punctuation and symbols, × ÷, the
  -- modifier apostrophe, combining accents, Greek and Arabic punctuation, every Unicode space, General Punctuation to
  -- Miscellaneous Symbols and Arrows (dashes, quotes, super- and subscripts, currencies such as €, ™, arrows, maths,
  -- shapes, dingbats), Supplemental Punctuation, CJK and full-width punctuation and symbols (not the letters 々 〆 〇
  -- and ー), variation selectors and small forms, the specials block, emoji and flags, and tag characters.
  punct constant text := '[\u0001-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u00BF\u00D7\u00F7\u02BC\u0300-\u036F\u037E\u0384-\u0385\u0387\u060C-\u060D\u061B-\u061C\u061F\u066A-\u066D\u06D4\u1680\u1AB0-\u1AFF\u1DC0-\u1DFF\u2000-\u2BFF\u2E00-\u2E7F\u3000-\u3004\u3008-\u3020\u302A-\u3030\u3036-\u3037\u303D-\u303F\u30A0\u30FB\uFE00-\uFE6F\uFEFF\uFF00-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\uFFE0-\uFFFF\U0001F000-\U0001FBFF\U000E0000-\U000E007F\U000E0100-\U000E01EF]';
  n text;
  c text;
  stripped text;
begin
  c := lower(replace(replace(replace(replace(replace(translate(coalesce(city, ''), fold_from, fold_to),
         'Œ', 'oe'), 'œ', 'oe'), 'Æ', 'ae'), 'æ', 'ae'), 'ß', 'ss'));
  c := replace(regexp_replace(c, punct, '', 'g'), 'ς', 'σ');
  if c = '' then
    return null;
  end if;
  n := lower(replace(replace(replace(replace(replace(translate(coalesce(name, ''), fold_from, fold_to),
         'Œ', 'oe'), 'œ', 'oe'), 'Æ', 'ae'), 'æ', 'ae'), 'ß', 'ss'));
  n := ' ' || replace(regexp_replace(regexp_replace(n, glue, '', 'g'), punct, ' ', 'g'), 'ς', 'σ') || ' ';
  -- A legal form with a space before and after it; the lookahead leaves the space after it for the next match, so
  -- "durand sarl sas" loses both, and "sasha" keeps its "sa".
  stripped := regexp_replace(n, ' (sarl|sas|sasu|sa|eurl|snc|sci|selarl|ltd|limited|llc|inc|gmbh|bv|srl|plc)(?= )', ' ', 'g');
  if btrim(stripped) <> '' then
    n := stripped;
  end if;
  n := replace(n, ' ', '');
  if n = '' then
    return null;
  end if;
  return n || '|' || c || '|' || coalesce(country, '');
end;
$$;

-- The first rule of the leads table a staged row would break (null when none). The import checks this per row, so a
-- rules mismatch between the browser and the database rejects one row instead of failing a constraint, whose error
-- detail ("Failing row contains ...") would put lead data in the database log.
create function private.lead_db_problem(name text, phone text, email text, city text, country text, lead_status text)
returns text
language sql immutable parallel safe set search_path = '' as $$
  select case
    when name is null or char_length(name) not between 1 and 200 then 'db_name'
    when phone is not null and (char_length(phone) > 40 or phone !~ '^[0-9+(). /-]*$') then 'db_phone'
    when email is not null and (char_length(email) > 254 or email !~ '^[^@[:space:]]+@[^@[:space:]]+$') then 'db_email'
    when city is not null and char_length(city) > 120 then 'db_city'
    when country is not null and country !~ '^[A-Z]{2}$' then 'db_country'
    when lead_status is null
      or lead_status not in ('cold', 'warm', 'negotiation', 'customer', 'cool_off', 'do_not_contact', 'disqualified')
      then 'db_status'
  end
$$;

-- Generated columns need EXECUTE on their functions for whoever inserts or updates the row.
grant execute on function private.lead_email_key(text), private.lead_phone_key(text),
  private.lead_name_key(text, text, text), private.lead_db_problem(text, text, text, text, text, text) to authenticated;

alter table public.companies
  add column email_key text generated always as (private.lead_email_key(email)) stored,
  add column phone_key text generated always as (private.lead_phone_key(phone)) stored,
  add column name_key text generated always as (private.lead_name_key(name, city, country)) stored;
-- (created_at, id) in each index: "the oldest matching lead" is one index probe.
create index companies_email_key_idx on public.companies (org_id, email_key, created_at, id) where email_key is not null;
create index companies_phone_key_idx on public.companies (org_id, phone_key, created_at, id) where phone_key is not null;
create index companies_name_key_idx on public.companies (org_id, name_key, created_at, id) where name_key is not null;

-- ---------------------------------------------------------------------------
-- 2. Audit log
-- ---------------------------------------------------------------------------
-- Same as Day 3a, plus: the generated key columns are never stored (no second copy of names, emails and phones); a lead
-- added by an import gets one small row (which import, who) instead of a full copy, and so does a lead removed by
-- undoing that import. Values are read from the row as jsonb because this trigger is shared by every table.
create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  hidden constant text[] := array['search_text', 'email_key', 'phone_key', 'name_key'];
  rec jsonb := (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) - hidden;
  diff jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
      into diff
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value
       and n.key not in ('updated_at', 'last_activity_at')
       and not n.key = any (hidden);
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
  else
    diff := jsonb_build_object('old', rec);
  end if;
  insert into public.audit_log (org_id, actor_id, action, table_name, record_id, diff_json)
  values ((rec ->> 'org_id')::uuid, (select auth.uid()), lower(tg_op), tg_table_name, rec ->> 'id', diff);
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Import batches: one row per file, kept as history
-- ---------------------------------------------------------------------------
alter table public.import_batches
  add column file_sha256 text check (file_sha256 ~ '^[0-9a-f]{64}$'),
  -- The spreadsheet row number of the last data row (the header is row 1).
  add column last_row_no integer not null default 0 check (last_row_no between 0 and 50001),
  add column source_timezone text not null default 'Europe/Paris' check (char_length(source_timezone) between 1 and 64),
  add column issue_counts jsonb not null default '{}'
    check (jsonb_typeof(issue_counts) = 'object' and pg_column_size(issue_counts) <= 4096),
  add column kept integer not null default 0 check (kept >= 0),
  add column checked_at timestamptz,
  add column imported_at timestamptz,
  add column rolled_back_at timestamptz,
  add column rolled_back_by uuid;  -- no foreign key, like audit_log.actor_id
alter table public.import_batches drop constraint import_batches_status_check;
alter table public.import_batches add constraint import_batches_status_check
  check (status in ('staged', 'dry_run', 'committing', 'imported', 'rolling_back', 'rolled_back', 'discarded'));
alter table public.import_batches
  add constraint import_batches_row_count_max check (row_count <= 50000),
  add constraint import_batches_filename_safe check (char_length(filename) >= 1 and filename !~ '[[:cntrl:]/\\]');
-- One import or undo at a time per organisation.
create unique index import_batches_one_writer_idx on public.import_batches (org_id)
  where status in ('committing', 'rolling_back');
create index import_batches_history_idx on public.import_batches (org_id, created_at desc, id desc);

-- Clients name only the file facts; who uploaded it, its status and every counter are set by defaults and the guard
-- trigger. Batches are never deleted.
revoke insert, update, delete on public.import_batches from authenticated;
grant insert (filename, file_sha256, row_count, last_row_no, source_timezone) on public.import_batches to authenticated;
grant update (status) on public.import_batches to authenticated;

drop policy import_batches_admin on public.import_batches;
-- History is readable by admins without a fresh code; every write needs one.
create policy import_batches_select on public.import_batches for select to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_admin()));
create policy import_batches_insert on public.import_batches for insert to authenticated
  with check (org_id = (select private.current_org_id()) and (select private.is_admin())
              and (select private.has_recent_aal2(600)));
create policy import_batches_update on public.import_batches for update to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_admin())
         and (select private.has_recent_aal2(600)))
  with check (org_id = (select private.current_org_id()) and (select private.is_admin())
              and (select private.has_recent_aal2(600)));

-- ---------------------------------------------------------------------------
-- 4. The working copy of the rows (private schema: no REST or GraphQL endpoint; row level security still on)
-- ---------------------------------------------------------------------------
create table private.lead_import_staging (
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  row_no integer not null check (row_no between 2 and 50001),  -- the row number Excel shows (header = row 1)
  org_id uuid not null references public.orgs (id),
  -- Loose bounds only: the exact rules of the leads table are checked per row by lead_db_problem.
  name text check (char_length(name) <= 500),
  owner_id uuid,  -- no foreign key: membership is checked when checking and when importing
  lead_status text check (char_length(lead_status) <= 40),
  phone text check (char_length(phone) <= 100),
  email text check (char_length(email) <= 500),
  city text check (char_length(city) <= 300),
  country text check (char_length(country) <= 8),
  last_activity_local timestamp,  -- local time in the batch's source_timezone
  problems text[] not null default '{}' check (cardinality(problems) <= 16 and problems <@ array[
    'name_missing', 'name_too_long', 'columns_extra', 'cell_too_long', 'email_invalid', 'phone_invalid', 'phone_mangled',
    'phone_too_long', 'date_invalid', 'date_future', 'date_too_old', 'city_too_long']),
  fixes text[] not null default '{}' check (cardinality(fixes) <= 16 and fixes <@ array[
    'email_dropped', 'phone_dropped', 'date_dropped', 'city_dropped', 'owner_unassigned', 'country_dropped']),
  outcome text not null default 'pending'
    check (outcome in ('pending', 'ready', 'rejected', 'duplicate_file', 'duplicate_existing', 'imported')),
  reason text check (reason in ('owner_unknown', 'date_out_of_range', 'db_name', 'db_phone', 'db_email', 'db_city',
                                'db_country', 'db_status')),
  match_key text check (match_key in ('email', 'phone', 'name')),
  match_row_no integer,
  match_company_id uuid,  -- no foreign key on purpose: one would make every lead delete scan this table
  email_key text generated always as (private.lead_email_key(email)) stored,
  phone_key text generated always as (private.lead_phone_key(phone)) stored,
  name_key text generated always as (private.lead_name_key(name, city, country)) stored,
  -- The first leads-table rule the row breaks, worked out once when the row arrives (spread over the upload calls).
  db_problem text generated always as (private.lead_db_problem(name, phone, email, city, country, lead_status)) stored,
  primary key (batch_id, row_no)
) with (fillfactor = 60);  -- room on each page, so marking rows (no indexed column changes) rewrites no index
create index lead_import_staging_org_idx on private.lead_import_staging (org_id);

alter table private.lead_import_staging enable row level security;
create policy require_mfa on private.lead_import_staging as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
-- Staged rows are lead data: even reading them needs an admin with a fresh code.
create policy staging_select on private.lead_import_staging for select to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_admin())
         and (select private.has_recent_aal2(600)));
create policy staging_insert on private.lead_import_staging for insert to authenticated
  with check (org_id = (select private.current_org_id()) and (select private.is_admin())
              and (select private.has_recent_aal2(600))
              and exists (select 1 from public.import_batches b
                          where b.id = lead_import_staging.batch_id and b.kind = 'leads' and b.status = 'staged'
                            and b.uploaded_by = (select auth.uid())
                            and lead_import_staging.row_no between 2 and b.last_row_no));
create policy staging_update on private.lead_import_staging for update to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_admin())
         and (select private.has_recent_aal2(600)))
  with check (org_id = (select private.current_org_id()) and (select private.is_admin())
              and (select private.has_recent_aal2(600)));
create policy staging_delete on private.lead_import_staging for delete to authenticated
  using (org_id = (select private.current_org_id()) and (select private.is_admin())
         and (select private.has_recent_aal2(600)));

revoke all on private.lead_import_staging from public, anon, authenticated;
grant select, delete on private.lead_import_staging to authenticated;
grant insert (batch_id, row_no, org_id, name, owner_id, lead_status, phone, email, city, country, last_activity_local,
              problems, fixes) on private.lead_import_staging to authenticated;
grant update (outcome, reason, match_key, match_row_no, match_company_id) on private.lead_import_staging to authenticated;
-- Not audited: the rows are temporary, and auditing them would copy lead data into the log.

-- Counts of a batch's staged rows: outcomes, duplicate kinds, and one key per problem, fix and reason code. Fix codes
-- are counted only on rows that are (or will be) added, because the screen shows them as "Added with a change".
create function private.lead_import_tally(p_batch uuid) returns jsonb
language sql stable set search_path = '' as $$
  with s as (
    select outcome, match_key, problems, fixes, reason
      from private.lead_import_staging where batch_id = p_batch
  )
  select jsonb_build_object(
           'ready', count(*) filter (where outcome = 'ready'),
           'imported', count(*) filter (where outcome = 'imported'),
           'rejected', count(*) filter (where outcome = 'rejected'),
           'duplicate_file', count(*) filter (where outcome = 'duplicate_file'),
           'duplicate_existing', count(*) filter (where outcome = 'duplicate_existing'),
           'by_email', count(*) filter (where match_key = 'email'),
           'by_phone', count(*) filter (where match_key = 'phone'),
           'by_name', count(*) filter (where match_key = 'name'),
           'with_fixes', count(*) filter (where cardinality(fixes) > 0 and outcome in ('ready', 'imported')))
         || coalesce((select jsonb_object_agg(code, n)
                        from (select code, count(*) as n
                                from s, unnest(s.problems || case when s.outcome in ('ready', 'imported') then s.fixes
                                                                  else '{}' end) as code
                               group by code) x),
                     '{}')
         || coalesce((select jsonb_object_agg(reason, n)
                        from (select s.reason, count(*) as n from s where s.reason is not null group by s.reason) y),
                     '{}')
    from s
$$;

-- ---------------------------------------------------------------------------
-- 5. Leads: the only way to set import_batch_id and last_activity_at
-- ---------------------------------------------------------------------------
-- Insert only (there is still no UPDATE grant on either column, so nobody can tag an existing lead into an import, and
-- undo can only reach leads that an import added). A restrictive policy: create_lead and the add-lead form are untouched.
grant insert (import_batch_id, last_activity_at) on public.companies to authenticated;
create policy companies_import_columns on public.companies as restrictive for insert to authenticated with check (
  (import_batch_id is null and last_activity_at is null)
  or (import_batch_id is not null
      and (select private.is_admin()) and (select private.has_recent_aal2(600))
      and (last_activity_at is null or (last_activity_at >= '1990-01-01' and last_activity_at <= now()))
      and exists (select 1 from public.import_batches b
                  where b.id = companies.import_batch_id and b.kind = 'leads' and b.status = 'committing'
                    and b.uploaded_by = (select auth.uid()))));

-- The one definition of a lead nobody has worked on since its import: never edited (any change, including a new owner
-- or status, moves updated_at; so does a logged activity, through touch_company_activity), no activity, no contact, no
-- deal. Leads with a deal always stay (deals.company_id is "on delete set null": removing the lead would orphan the
-- deal). Only admins run it (they see every deal).
create function private.lead_import_untouched(p_batch uuid, p_limit integer) returns setof uuid
language sql stable set search_path = '' as $$
  select c.id from public.companies c
   where c.import_batch_id = p_batch and c.updated_at = c.created_at
     and not exists (select 1 from public.activities a where a.company_id = c.id)
     and not exists (select 1 from public.contacts k where k.company_id = c.id)
     and not exists (select 1 from public.deals d where d.company_id = c.id)
   order by c.id
   limit p_limit
$$;

-- ---------------------------------------------------------------------------
-- 6. The batch guard: every status change and every counter goes through this trigger
-- ---------------------------------------------------------------------------
-- It also holds for a direct API update (the update grant is on status only). Counters are recomputed from the staged
-- rows at every final move, so they always add up. It runs after enforce_org_and_owner (alphabetical), so org_id is
-- set; like that trigger it does nothing for the superuser (fixtures and performance seeding).
create function private.import_batch_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  tally jsonb;
  n_total integer;
  n_pending integer;
begin
  if caller is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Before-insert triggers run before the insert policy: refuse non-admins here first, so nothing else is said.
    if not coalesce(private.is_admin(), false) or not private.has_recent_aal2(600) then
      raise exception 'admins with a fresh two-factor code only' using errcode = '42501';
    end if;
    new.uploaded_by := caller;
    if new.row_count < 1 or new.row_count > 50000 or new.last_row_no <= new.row_count or new.last_row_no > 50001 then
      raise exception 'row counts out of range' using errcode = '22023';
    end if;
    if (select count(*) from public.import_batches b
         where b.org_id = new.org_id and b.status in ('staged', 'dry_run')) >= 3 then
      raise exception 'too many open imports' using errcode = '22023', hint = 'too_many_open';
    end if;
    return new;
  end if;

  if new.status = old.status and new.status <> 'dry_run' then
    return new;
  end if;

  if old.status in ('staged', 'dry_run') and new.status = 'dry_run' then
    if old.uploaded_by is distinct from caller then
      raise exception 'only the person who started this import can check it' using errcode = '42501';
    end if;
    select count(*), count(*) filter (where s.outcome = 'pending') into n_total, n_pending
      from private.lead_import_staging s where s.batch_id = new.id;
    if n_total <> old.row_count or n_pending > 0 then
      raise exception 'rows are missing or not checked' using errcode = '22023', hint = 'incomplete';
    end if;
    tally := private.lead_import_tally(new.id);
    new.imported := 0;
    new.checked_at := now();
  elsif old.status in ('staged', 'dry_run') and new.status = 'discarded' then
    return new;
  elsif old.status = 'dry_run' and new.status = 'committing' then
    if old.uploaded_by is distinct from caller then
      raise exception 'only the person who started this import can import it' using errcode = '42501';
    end if;
    return new;
  elsif old.status = 'committing' and new.status = 'imported' then
    if old.uploaded_by is distinct from caller then
      raise exception 'only the person who started this import can import it' using errcode = '42501';
    end if;
    if exists (select 1 from private.lead_import_staging s where s.batch_id = new.id and s.outcome <> all
               (array['imported', 'rejected', 'duplicate_file', 'duplicate_existing'])) then
      raise exception 'rows are still waiting' using errcode = '22023', hint = 'not_ready';
    end if;
    tally := private.lead_import_tally(new.id);
    new.imported := (tally ->> 'imported')::integer;
    new.imported_at := now();
  elsif old.status in ('committing', 'imported') and new.status = 'rolling_back' then
    new.rolled_back_by := caller;
    if old.status = 'imported' then
      return new;
    end if;
    tally := private.lead_import_tally(new.id);
    new.imported := (select count(*) from public.companies c where c.import_batch_id = new.id);
  elsif old.status = 'rolling_back' and new.status = 'rolled_back' then
    if exists (select 1 from private.lead_import_untouched(new.id, 1)) then
      raise exception 'some leads are still waiting to be removed' using errcode = '22023', hint = 'not_ready';
    end if;
    new.kept := (select count(*) from public.companies c where c.import_batch_id = new.id);
    new.rolled_back_at := now();
    return new;
  else
    raise exception 'this change is not allowed' using errcode = '22023', hint = 'bad_transition';
  end if;

  new.duplicates := (tally ->> 'duplicate_file')::integer + (tally ->> 'duplicate_existing')::integer;
  new.rejected := (tally ->> 'rejected')::integer;
  new.issue_counts := tally;
  if new.status = 'imported' and new.imported + new.duplicates + new.rejected <> new.row_count then
    raise exception 'import counts do not add up' using errcode = '22023', hint = 'not_ready';
  end if;
  return new;
end;
$$;
create trigger import_batch_guard before insert or update on public.import_batches
  for each row execute function private.import_batch_guard();

-- ---------------------------------------------------------------------------
-- 7. Import functions (SECURITY INVOKER, static SQL only: the rules above decide; these add batching and clear codes)
-- ---------------------------------------------------------------------------
-- Error contract for the app: 42501 hint 'step_up' (ask for a fresh code), 42501 otherwise (not allowed), 22023 with
-- hint incomplete / not_staged / not_ready / too_many_open / bad_transition / busy, 22023 without hint (bad input),
-- P0002 (no such import). Messages never contain row values.
create function private.assert_import_admin(p_fresh boolean) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not coalesce(private.is_admin(), false) or not private.has_aal2() then
    raise exception 'admins only' using errcode = '42501', hint = 'admin';
  end if;
  if p_fresh and not private.has_recent_aal2(600) then
    raise exception 'a fresh two-factor code is needed' using errcode = '42501', hint = 'step_up';
  end if;
end;
$$;

-- Starts an import. Also tidies up: open imports untouched for 24 hours are discarded, and the working rows of
-- finished, undone and discarded imports are deleted.
create function public.create_lead_import(
  p_filename text,
  p_file_sha256 text,
  p_row_count integer,
  p_last_row_no integer,
  p_timezone text default 'Europe/Paris'
) returns uuid
language plpgsql volatile set search_path = '' as $$
declare
  new_id uuid;
begin
  perform private.assert_import_admin(true);
  if p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception 'unknown time zone' using errcode = '22023';
  end if;
  update public.import_batches set status = 'discarded'
   where kind = 'leads' and status in ('staged', 'dry_run') and updated_at < now() - interval '24 hours';
  delete from private.lead_import_staging s
   using public.import_batches b
   where b.id = s.batch_id and b.status in ('discarded', 'imported', 'rolled_back', 'rolling_back');
  insert into public.import_batches (filename, file_sha256, row_count, last_row_no, source_timezone)
  values (btrim(p_filename), p_file_sha256, p_row_count, p_last_row_no, p_timezone)
  returning id into new_id;
  return new_id;
end;
$$;

-- Adds up to 1,000 cleaned rows. Every value is checked as text first, so a bad value raises one constant error
-- (never "invalid input syntax for type uuid: <value>"). Sending the same rows again does nothing (safe retries).
create function public.stage_lead_import_rows(p_batch uuid, p_rows jsonb) returns integer
language plpgsql volatile set search_path = '' as $$
declare
  b public.import_batches%rowtype;
  n integer;
begin
  perform private.assert_import_admin(true);
  select * into b from public.import_batches where id = p_batch for share;
  if not found then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if b.uploaded_by is distinct from (select auth.uid()) then
    raise exception 'only the person who started this import can add rows' using errcode = '42501';
  end if;
  if b.status <> 'staged' then
    raise exception 'this import is not taking rows' using errcode = '22023', hint = 'not_staged';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 1000
     or octet_length(p_rows::text) > 1048576
     or exists (select 1 from jsonb_array_elements(p_rows) e where jsonb_typeof(e) <> 'object') then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_to_recordset(p_rows) as r(row_no text, owner_id text, last_activity text, name text, lead_status text,
                                           phone text, email text, city text, country text, problems jsonb, fixes jsonb)
     where r.row_no is null or r.row_no !~ '^[0-9]{1,6}$' or r.row_no::integer not between 2 and b.last_row_no
        or (r.owner_id is not null and not pg_input_is_valid(r.owner_id, 'uuid'))
        or (r.last_activity is not null
            and (r.last_activity !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$'
                 or not pg_input_is_valid(r.last_activity, 'timestamp')))
        or char_length(r.name) > 500 or char_length(r.lead_status) > 40 or char_length(r.phone) > 100
        or char_length(r.email) > 500 or char_length(r.city) > 300 or char_length(r.country) > 8
        or (r.problems is not null and (jsonb_typeof(r.problems) <> 'array' or jsonb_array_length(r.problems) > 16
            or exists (select 1 from jsonb_array_elements(r.problems) p
                        where jsonb_typeof(p) <> 'string' or not (p #>> '{}') = any (array[
                          'name_missing', 'name_too_long', 'columns_extra', 'cell_too_long', 'email_invalid',
                          'phone_invalid', 'phone_mangled', 'phone_too_long', 'date_invalid', 'date_future',
                          'date_too_old', 'city_too_long']))))
        or (r.fixes is not null and (jsonb_typeof(r.fixes) <> 'array' or jsonb_array_length(r.fixes) > 16
            or exists (select 1 from jsonb_array_elements(r.fixes) f
                        where jsonb_typeof(f) <> 'string' or not (f #>> '{}') = any (array[
                          'email_dropped', 'phone_dropped', 'date_dropped', 'city_dropped', 'owner_unassigned',
                          'country_dropped']))))
  ) then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  insert into private.lead_import_staging (batch_id, row_no, org_id, name, owner_id, lead_status, phone, email, city,
                                           country, last_activity_local, problems, fixes)
  select p_batch, r.row_no::integer, b.org_id, r.name, r.owner_id::uuid, r.lead_status, r.phone, r.email, r.city,
         r.country, r.last_activity::timestamp,
         array(select jsonb_array_elements_text(coalesce(r.problems, '[]'))),
         array(select jsonb_array_elements_text(coalesce(r.fixes, '[]')))
    from jsonb_to_recordset(p_rows) as r(row_no text, owner_id text, last_activity text, name text, lead_status text,
                                         phone text, email text, city text, country text, problems jsonb, fixes jsonb)
  on conflict (batch_id, row_no) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- The check (dry run): marks every row ready, rejected, repeated in the file or already in the CRM, and returns the
-- counts. Nothing is written to the leads. Can run again after more rows or after leads were added meanwhile.
-- Order: rejected rows never match anything; "already in the CRM" wins (email, then phone, then name + city for rows
-- with neither); then "repeated in this file" (an earlier row with the same email or phone; for a row with neither, the
-- first row of its name + city group that has contact details, else the first row of the group).
create function public.validate_lead_import(p_batch uuid) returns jsonb
language plpgsql volatile set search_path = '' set work_mem = '32MB' as $$  -- three in-memory sorts of up to 50,000 rows
declare
  b public.import_batches%rowtype;
  v_rows integer[];
  v_outcomes text[];
  v_reasons text[];
  v_keys text[];
  v_match_rows integer[];
  v_match_companies uuid[];
  v_team uuid[];
begin
  perform private.assert_import_admin(true);
  select * into b from public.import_batches where id = p_batch for update;
  if not found then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if b.uploaded_by is distinct from (select auth.uid()) then
    raise exception 'only the person who started this import can check it' using errcode = '42501';
  end if;
  v_team := array(select p.id from public.profiles p);  -- the caller's organisation (RLS)
  if b.status not in ('staged', 'dry_run') then
    raise exception 'this import cannot be checked now' using errcode = '22023', hint = 'not_ready';
  end if;
  if (select count(*) from private.lead_import_staging s where s.batch_id = p_batch) <> b.row_count then
    raise exception 'some rows have not arrived' using errcode = '22023', hint = 'incomplete';
  end if;

  with s as (
    select st.row_no, st.problems, st.owner_id, st.last_activity_local, st.email_key, st.phone_key, st.name_key,
           st.db_problem
      from private.lead_import_staging st
     where st.batch_id = p_batch
  ), r as (
    select s.*,
           case
             when cardinality(s.problems) > 0 then null
             when s.db_problem is not null then s.db_problem
             when s.owner_id is not null and not s.owner_id = any (v_team) then 'owner_unknown'
             when s.last_activity_local is not null
                  and (s.last_activity_local at time zone b.source_timezone > now()
                       or s.last_activity_local < '1990-01-01') then 'date_out_of_range'
           end as reason
      from s
  ), j as materialized (
    -- Materialized: each row's reason is computed once, not again inside each window filter below.
    select r.*, (cardinality(r.problems) > 0 or r.reason is not null) as rejected from r
  ), w as (
    -- Keepers as window aggregates over every row with FILTER (no join: the staged rows have no statistics yet, and a
    -- join between two row sets could be planned as a nested loop over 30,000 x 30,000 rows).
    select j.*,
           case when j.email_key is not null then
             min(j.row_no) filter (where not j.rejected) over (partition by j.email_key) end as e_keep,
           case when j.phone_key is not null then
             min(j.row_no) filter (where not j.rejected) over (partition by j.phone_key) end as p_keep,
           case when j.email_key is null and j.phone_key is null and j.name_key is not null then
             coalesce(min(j.row_no) filter (where not j.rejected and (j.email_key is not null or j.phone_key is not null))
                        over (partition by j.name_key),
                      min(j.row_no) filter (where not j.rejected) over (partition by j.name_key))
           end as n_keep
      from j
  ), x as (
    select w.row_no, w.rejected, w.reason, w.e_keep, w.p_keep, w.n_keep,
           case when not w.rejected and w.email_key is not null then
             (select c.id from public.companies c where c.org_id = b.org_id and c.email_key = w.email_key
               order by c.created_at, c.id limit 1) end as ex_email,
           case when not w.rejected and w.phone_key is not null then
             (select c.id from public.companies c where c.org_id = b.org_id and c.phone_key = w.phone_key
               order by c.created_at, c.id limit 1) end as ex_phone,
           case when not w.rejected and w.email_key is null and w.phone_key is null and w.name_key is not null then
             (select c.id from public.companies c where c.org_id = b.org_id and c.name_key = w.name_key
               order by c.created_at, c.id limit 1) end as ex_name
      from w
  ), o as (
    select x.row_no, x.reason,
           case
             when x.rejected then 'rejected'
             when x.ex_email is not null or x.ex_phone is not null or x.ex_name is not null then 'duplicate_existing'
             when x.e_keep < x.row_no or x.p_keep < x.row_no or x.n_keep <> x.row_no then 'duplicate_file'
             else 'ready'
           end as outcome,
           case
             when x.rejected then null
             when x.ex_email is not null then 'email'
             when x.ex_phone is not null then 'phone'
             when x.ex_name is not null then 'name'
             when x.e_keep < x.row_no then 'email'
             when x.p_keep < x.row_no then 'phone'
             when x.n_keep <> x.row_no then 'name'
           end as match_key,
           case
             when x.rejected or x.ex_email is not null or x.ex_phone is not null or x.ex_name is not null then null
             when x.e_keep < x.row_no then x.e_keep
             when x.p_keep < x.row_no then x.p_keep
             when x.n_keep <> x.row_no then x.n_keep
           end as match_row_no,
           case when not x.rejected then coalesce(x.ex_email, x.ex_phone, x.ex_name) end as match_company_id
      from x
  )
  select array_agg(o.row_no), array_agg(o.outcome), array_agg(o.reason), array_agg(o.match_key),
         array_agg(o.match_row_no), array_agg(o.match_company_id)
    into v_rows, v_outcomes, v_reasons, v_keys, v_match_rows, v_match_companies
    from o;

  -- Write back by primary key from arrays: freshly staged rows have no statistics (authenticated cannot ANALYZE),
  -- so a self-join could be planned badly; this cannot.
  update private.lead_import_staging s
     set outcome = u.outcome, reason = u.reason, match_key = u.match_key, match_row_no = u.match_row_no,
         match_company_id = u.match_company_id
    from unnest(v_rows, v_outcomes, v_reasons, v_keys, v_match_rows, v_match_companies)
           as u(row_no, outcome, reason, match_key, match_row_no, match_company_id)
   where s.batch_id = p_batch and s.row_no = u.row_no
     and (s.outcome, s.reason, s.match_key, s.match_row_no, s.match_company_id)
         is distinct from (u.outcome, u.reason, u.match_key, u.match_row_no, u.match_company_id);

  update public.import_batches set status = 'dry_run' where id = p_batch returning * into b;
  return jsonb_build_object('status', b.status, 'row_count', b.row_count, 'ready', b.issue_counts -> 'ready',
                            'duplicates', b.duplicates, 'rejected', b.rejected, 'issue_counts', b.issue_counts);
end;
$$;

-- The rows a check did not mark plainly ready (rejected, repeated, already in the CRM, or ready with a fix), with the
-- name of the matching lead. No staged values: the browser still holds the file.
create function public.list_lead_import_issues(p_batch uuid, p_after_row integer default 0, p_limit integer default 1000)
returns table (
  row_no integer,
  outcome text,
  problems text[],
  fixes text[],
  reason text,
  match_key text,
  match_row_no integer,
  match_company_id uuid,
  match_company_name text
)
language plpgsql stable set search_path = '' as $$
begin
  perform private.assert_import_admin(true);
  if p_limit is null or p_limit not between 1 and 1000 or p_after_row is null or p_after_row < 0 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  return query
    select s.row_no, s.outcome, s.problems, s.fixes, s.reason, s.match_key, s.match_row_no, s.match_company_id, c.name
      from private.lead_import_staging s
      left join public.companies c on c.id = s.match_company_id
     where s.batch_id = p_batch and s.row_no > p_after_row
       and (s.outcome not in ('ready', 'imported') or cardinality(s.fixes) > 0)
     order by s.row_no
     limit p_limit;
end;
$$;

-- Imports the next ready rows (up to p_max_rows) and returns how many remain; call again until status is 'imported'.
-- Each call re-checks its rows against leads added since the check (skipped as already in the CRM) and marks each row
-- in the same statement that inserts it, so a retry after a dropped connection never adds a lead twice.
create function public.commit_lead_import(p_batch uuid, p_max_rows integer default 1000) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  b public.import_batches%rowtype;
  v_imported integer := 0;
  v_late integer := 0;
  v_remaining integer;
begin
  perform private.assert_import_admin(true);
  if p_max_rows is null or p_max_rows not between 1 and 2000 then
    raise exception 'invalid chunk size' using errcode = '22023';
  end if;
  select * into b from public.import_batches where id = p_batch for update;
  if not found then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if b.uploaded_by is distinct from (select auth.uid()) then
    raise exception 'only the person who started this import can import it' using errcode = '42501';
  end if;
  if b.status = 'imported' then
    return jsonb_build_object('status', 'imported', 'imported_now', 0, 'late_duplicates', 0, 'remaining', 0);
  elsif b.status = 'dry_run' then
    begin
      update public.import_batches set status = 'committing' where id = p_batch;
    exception when unique_violation then
      raise exception 'another import or undo is running' using errcode = '22023', hint = 'busy';
    end;
  elsif b.status <> 'committing' then
    raise exception 'this import cannot be imported now' using errcode = '22023', hint = 'not_ready';
  end if;

  with picked as (
    select s.row_no, s.name, s.owner_id, s.lead_status, s.phone, s.email, s.city, s.country, s.last_activity_local,
           s.email_key, s.phone_key, s.name_key,
           (cardinality(s.problems) > 0 or s.db_problem is not null
            or (s.last_activity_local is not null
                and (s.last_activity_local at time zone b.source_timezone > now()
                     or s.last_activity_local < '1990-01-01'))) as bad
      from private.lead_import_staging s
     where s.batch_id = p_batch and s.outcome = 'ready'
     order by s.row_no
     limit p_max_rows
       for update
  ), late as (
    select p.*,
           case when not p.bad and p.email_key is not null then
             (select c.id from public.companies c where c.org_id = b.org_id and c.email_key = p.email_key
               order by c.created_at, c.id limit 1) end as ex_email,
           case when not p.bad and p.phone_key is not null then
             (select c.id from public.companies c where c.org_id = b.org_id and c.phone_key = p.phone_key
               order by c.created_at, c.id limit 1) end as ex_phone,
           case when not p.bad and p.email_key is null and p.phone_key is null and p.name_key is not null then
             (select c.id from public.companies c where c.org_id = b.org_id and c.name_key = p.name_key
               order by c.created_at, c.id limit 1) end as ex_name
      from picked p
  ), ins as (
    insert into public.companies (name, owner_id, lead_status, phone, email, city, country, last_activity_at,
                                  import_batch_id)
    select l.name,
           case when exists (select 1 from public.profiles pr where pr.id = l.owner_id) then l.owner_id end,
           l.lead_status, l.phone, l.email, l.city, l.country, l.last_activity_local at time zone b.source_timezone,
           p_batch
      from late l
     where not l.bad and l.ex_email is null and l.ex_phone is null and l.ex_name is null
  ), upd as (
    update private.lead_import_staging s
       set outcome = case
                       when l.bad then 'rejected'
                       when l.ex_email is null and l.ex_phone is null and l.ex_name is null then 'imported'
                       else 'duplicate_existing'
                     end,
           match_key = case
                         when l.bad then null
                         when l.ex_email is not null then 'email'
                         when l.ex_phone is not null then 'phone'
                         when l.ex_name is not null then 'name'
                       end,
           match_company_id = case when not l.bad then coalesce(l.ex_email, l.ex_phone, l.ex_name) end
      from late l
     where s.batch_id = p_batch and s.row_no = l.row_no
    returning s.outcome
  )
  select count(*) filter (where upd.outcome = 'imported'), count(*) filter (where upd.outcome = 'duplicate_existing')
    into v_imported, v_late
    from upd;

  select count(*) into v_remaining
    from private.lead_import_staging s where s.batch_id = p_batch and s.outcome = 'ready';
  if v_remaining = 0 then
    update public.import_batches set status = 'imported' where id = p_batch;
    delete from private.lead_import_staging where batch_id = p_batch;
  end if;
  return jsonb_build_object('status', case when v_remaining = 0 then 'imported' else 'committing' end,
                            'imported_now', v_imported, 'late_duplicates', v_late, 'remaining', v_remaining);
end;
$$;

-- What an undo would do: leads added by this import, how many nobody has worked on (those go), and how many stay.
create function public.preview_lead_import_rollback(p_batch uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_tagged integer;
  v_removable integer;
begin
  perform private.assert_import_admin(false);
  if not exists (select 1 from public.import_batches b where b.id = p_batch) then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  select count(*) into v_tagged from public.companies c where c.import_batch_id = p_batch;
  select count(*) into v_removable from private.lead_import_untouched(p_batch, 50001);
  return jsonb_build_object('tagged', v_tagged, 'removable', v_removable, 'kept', v_tagged - v_removable);
end;
$$;

-- Undo: removes, up to p_max_rows per call, the leads of this import that nobody has worked on; call again until
-- status is 'rolled_back'. Any admin (fresh code), including on a paused import. Statement A locks the candidates
-- (a new contact or activity then has to wait: its foreign key check needs a share lock); statement B takes a new
-- snapshot, so one committed while A waited is seen and its lead stays.
create function public.rollback_lead_import(p_batch uuid, p_max_rows integer default 2000) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  b public.import_batches%rowtype;
  v_ids uuid[];
  v_removed integer;
  v_done boolean;
begin
  perform private.assert_import_admin(true);
  if p_max_rows is null or p_max_rows not between 1 and 5000 then
    raise exception 'invalid chunk size' using errcode = '22023';
  end if;
  select * into b from public.import_batches where id = p_batch for update;
  if not found then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if b.status = 'rolled_back' then
    return jsonb_build_object('status', 'rolled_back', 'removed_now', 0, 'kept', b.kept);
  elsif b.status in ('imported', 'committing') then
    begin
      update public.import_batches set status = 'rolling_back' where id = p_batch;
    exception when unique_violation then
      raise exception 'another import or undo is running' using errcode = '22023', hint = 'busy';
    end;
    delete from private.lead_import_staging where batch_id = p_batch;
  elsif b.status <> 'rolling_back' then
    raise exception 'this import cannot be undone now' using errcode = '22023', hint = 'not_ready';
  end if;

  v_ids := array(select c.id from public.companies c
                  where c.id in (select private.lead_import_untouched(p_batch, p_max_rows))
                  order by c.id
                    for update of c);
  delete from public.companies c
   where c.id = any (v_ids) and c.id in (select private.lead_import_untouched(p_batch, p_max_rows));
  get diagnostics v_removed = row_count;
  v_done := cardinality(v_ids) < p_max_rows;
  if v_done then
    update public.import_batches set status = 'rolled_back' where id = p_batch returning * into b;
  end if;
  return jsonb_build_object('status', case when v_done then 'rolled_back' else 'rolling_back' end,
                            'removed_now', v_removed, 'kept', case when v_done then b.kept end);
end;
$$;

-- Gives up an import that was not imported (needs a fresh code: it deletes the working rows). The history row stays.
create function public.discard_lead_import(p_batch uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  b public.import_batches%rowtype;
begin
  perform private.assert_import_admin(true);
  select * into b from public.import_batches where id = p_batch for update;
  if not found then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if b.status not in ('staged', 'dry_run') then
    raise exception 'this import cannot be discarded' using errcode = '22023', hint = 'not_ready';
  end if;
  update public.import_batches set status = 'discarded' where id = p_batch;
  delete from private.lead_import_staging where batch_id = p_batch;
end;
$$;

-- Import history, newest first (keyset on created_at, id). Admins, without a fresh code. p_id: one import.
create function public.list_lead_imports(
  p_limit integer default 20,
  p_before_created timestamptz default null,
  p_before_id uuid default null,
  p_id uuid default null
) returns table (
  id uuid,
  filename text,
  file_sha256 text,
  status text,
  row_count integer,
  last_row_no integer,
  imported integer,
  duplicates integer,
  rejected integer,
  kept integer,
  issue_counts jsonb,
  source_timezone text,
  created_at timestamptz,
  updated_at timestamptz,
  checked_at timestamptz,
  imported_at timestamptz,
  rolled_back_at timestamptz,
  uploaded_by uuid,
  uploader_first_name text,
  uploader_last_name text,
  undone_by_first_name text
)
language plpgsql stable set search_path = '' as $$
begin
  perform private.assert_import_admin(false);
  if p_limit is null or p_limit not between 1 and 50 or (p_before_created is null) <> (p_before_id is null) then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  return query
    select b.id, b.filename, b.file_sha256, b.status, b.row_count, b.last_row_no, b.imported, b.duplicates, b.rejected,
           b.kept, b.issue_counts, b.source_timezone, b.created_at, b.updated_at, b.checked_at, b.imported_at,
           b.rolled_back_at, b.uploaded_by, u.first_name, u.last_name, r.first_name
      from public.import_batches b
      left join public.profiles u on u.id = b.uploaded_by
      left join public.profiles r on r.id = b.rolled_back_by
     where b.kind = 'leads'
       and (p_id is null or b.id = p_id)
       and (p_before_id is null or (b.created_at, b.id) < (p_before_created, p_before_id))
     order by b.created_at desc, b.id desc
     limit p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Leads list: "from this import" filter (Master Plan leads filters; promised in the Day 3a report)
-- ---------------------------------------------------------------------------
-- Same as Day 3a with one more positional parameter ($8 import batch); the cursor and limit move to $9-$11.
drop function public.list_leads(text, text[], uuid[], boolean, text[], text, integer, text, text, uuid, integer);
drop function public.count_leads(text, text[], uuid[], boolean, text[], text, integer);

create or replace function private.lead_filter_sql() returns text
language sql immutable set search_path = '' as $f$
  select $q$
        ($2::text[] is null or c.lead_status = any ($2))
    and (($3::uuid[] is null and not $4) or c.owner_id = any ($3) or ($4 and c.owner_id is null))
    and ($5::text[] is null or c.country = any ($5))
    and ($6::text is null or c.city ilike $6)
    and ($7::integer is null or c.last_activity_at is null
         or c.last_activity_at < now() - make_interval(days => greatest($7, 0)))
    and ($8::uuid is null or c.import_batch_id = $8)
    and ($1::text is null or c.search_text like $1
         or c.id in (select k.company_id from public.contacts k where k.search_text like $1))
  $q$
$f$;

create function public.list_leads(
  p_search text default null,
  p_statuses text[] default null,
  p_owners uuid[] default null,
  p_unowned boolean default false,
  p_countries text[] default null,
  p_city text default null,
  p_inactive_days integer default null,
  p_import_batch uuid default null,
  p_sort text default 'activity',
  p_after_value text default null,
  p_after_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid,
  name text,
  owner_id uuid,
  owner_first_name text,
  owner_last_name text,
  phone text,
  email text,
  lead_status text,
  last_activity_at timestamptz,
  city text,
  country text,
  contact_count integer,
  created_at timestamptz,
  sort_value text
)
language plpgsql stable set search_path = '' as $$
declare
  sort_key text;
  after_cond text;
  direction text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'limit must be between 1 and 200' using errcode = '22023';
  end if;
  if p_sort is null or p_sort not in ('activity', 'name', 'created') then
    raise exception 'unknown sort' using errcode = '22023';
  end if;
  if (p_after_value is null) <> (p_after_id is null) then
    raise exception 'cursor needs both value and id' using errcode = '22023';
  end if;
  if p_sort <> 'name' and not pg_input_is_valid(p_after_value, 'timestamptz') then
    raise exception 'cursor value must be a time for this sort' using errcode = '22023';
  end if;
  sort_key := case p_sort
    when 'name' then 'lower(c.name)'
    when 'created' then 'c.created_at'
    else 'coalesce(c.last_activity_at, ''-infinity''::timestamptz)'
  end;
  after_cond := case p_sort
    when 'name' then '(lower(c.name), c.id) > ($9, $10)'
    else format('(%s, c.id) < ($9::timestamptz, $10)', sort_key)
  end;
  direction := case p_sort when 'name' then 'asc' else 'desc' end;

  return query execute format(
    $q$select c.id, c.name, c.owner_id, o.first_name, o.last_name, c.phone, c.email, c.lead_status,
              c.last_activity_at, c.city, c.country,
              (select count(*)::integer from public.contacts k where k.company_id = c.id), c.created_at,
              (%1$s)::text
         from public.companies c
         left join public.profiles o on o.id = c.owner_id
        where %2$s
          and ($10::uuid is null or %3$s)
        order by %1$s %4$s, c.id %4$s
        limit $11$q$,
    sort_key, private.lead_filter_sql(), after_cond, direction)
  using lower(private.like_pattern(p_search, 100, 2)), p_statuses, p_owners, coalesce(p_unowned, false), p_countries,
        private.like_pattern(p_city, 120, 1), p_inactive_days, p_import_batch, p_after_value, p_after_id, p_limit;
end;
$$;

create function public.count_leads(
  p_search text default null,
  p_statuses text[] default null,
  p_owners uuid[] default null,
  p_unowned boolean default false,
  p_countries text[] default null,
  p_city text default null,
  p_inactive_days integer default null,
  p_import_batch uuid default null
) returns bigint
language plpgsql stable set search_path = '' as $$
declare
  n bigint;
begin
  execute format('select count(*) from public.companies c where %s', private.lead_filter_sql())
    into n
    using lower(private.like_pattern(p_search, 100, 2)), p_statuses, p_owners, coalesce(p_unowned, false), p_countries,
          private.like_pattern(p_city, 120, 1), p_inactive_days, p_import_batch;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Function privileges
-- ---------------------------------------------------------------------------
revoke all on function private.lead_import_tally(uuid), private.lead_import_untouched(uuid, integer),
  private.import_batch_guard(), private.assert_import_admin(boolean) from public, anon;
grant execute on function private.lead_import_tally(uuid), private.lead_import_untouched(uuid, integer),
  private.assert_import_admin(boolean) to authenticated;
revoke all on function private.import_batch_guard() from authenticated;
revoke all on function private.lead_email_key(text), private.lead_phone_key(text), private.lead_name_key(text, text, text),
  private.lead_db_problem(text, text, text, text, text, text) from public, anon;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.list_leads(text, text[], uuid[], boolean, text[], text, integer, uuid, text, text, uuid, integer)',
    'public.count_leads(text, text[], uuid[], boolean, text[], text, integer, uuid)',
    'public.create_lead_import(text, text, integer, integer, text)',
    'public.stage_lead_import_rows(uuid, jsonb)',
    'public.validate_lead_import(uuid)',
    'public.list_lead_import_issues(uuid, integer, integer)',
    'public.commit_lead_import(uuid, integer)',
    'public.preview_lead_import_rollback(uuid)',
    'public.rollback_lead_import(uuid, integer)',
    'public.discard_lead_import(uuid)',
    'public.list_lead_imports(integer, timestamptz, uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
