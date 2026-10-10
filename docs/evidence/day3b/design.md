# Day 3b final design: importing leads from a CSV file

> Produced 10 Oct 2026 by a design workflow: three independent designs (security-first, data/performance-first, owner-UX-first), three judges (all picked the security design), one synthesis. Builder change on top: the leads list gets the "from this import" filter (promised in the Day 3a report), so section 10's deferral of it does not apply.

## 1 Summary (plain words)

Admins get a new page at **/leads/import**. Reps and managers get a 404 there, and the database refuses them too.

**Reading the file.** Haider picks a CSV file and it stays in his browser. The browser:
- reads the file as UTF-8, or as Western (Windows-1252) text if UTF-8 fails, and says which one it used;
- finds the separator (comma or semicolon);
- parses the rows with papaparse, in small slices so the screen keeps responding.

**Matching (one screen).** He checks how columns match fields. Headers are suggested from English and French names, so his header matches with no clicks, and any other header can be matched by hand. Below that he confirms how the file's values translate: owner names to CRM users, status words to the 7 statuses, countries we don't recognise, and day/month order for dates.

**Check.** The browser cleans every row with one shared rules module. It sends only the cleaned fields, 1,000 rows per call, through server actions that check every field with Zod. For a row it already knows is bad, it sends only the row number and the problem codes, never the values.

The database is the final judge. Using Haider's own login, with no service key and no new privileged function, it:
- checks every row again against the same rules the leads table enforces;
- finds duplicates by email, then phone, then name + city + country (the name rule only for rows that have no email and no phone);
- shows four numbers: **Will be added / Already in the CRM / Repeated in this file / Can't be imported**.

The browser then builds a "rows not imported" CSV from the file in memory. It is safe to open in Excel. Re-checking is allowed; importing waits for him.

**Import.** "Import 28,410 leads" adds them 1,000 per call. Each call re-checks for leads the team added in the meantime. If the tab closes, the import shows as Paused and resumes later. A row is never added twice.

**Undo.** Undo removes only leads nobody has touched since: no edit, call, note, contact or deal. Leads someone worked on stay and are counted.

**Protections.** Every import write needs an admin with an authenticator code from the last 10 minutes. A reusable "Confirm it's you" dialog asks for a new code when needed. The working copy of the rows is deleted when the import finishes, is undone, is discarded, or sits unused for 24 h. The raw file is never stored. The audit log gets one small row per imported lead (batch id only, no name, email or phone) and a full history of the import's status changes.

**Proof:**
- database attack tests, each shown to fail when its protection is removed;
- Playwright end-to-end tests on a 500-row fake sample (Chromium + WebKit);
- unit tests (no browser);
- timings at 30k and 50k rows.

**Changes from the candidate designs.** The security design is the base, with every fatal flaw fixed:
1. Every counter is recomputed at each final status change, so a late duplicate can no longer leave an import stuck.
2. Undo locks the rows first, then deletes them in a second statement that sees the latest data.
3. Late duplicates are checked in every import call, using stored, indexed key columns.
4. The name rule needs a city and applies only to rows without email or phone.
5. A rules mismatch between browser and database rejects one row instead of blocking the whole chunk.
6. Batch counters and status moves are written only by a trigger, never by a client.
7. Discard needs a fresh code, and import history rows are never deleted.

Taken from the other designs: the gateway fix for its 128 KB argument limit, the CI wiring for the new tests, the empty-state entry point, the Excel-file message, and re-importing a fixed problems file with no remapping.

One new finding: papaparse's file streamer decodes each 256 KB byte slice on its own. This can corrupt accented characters at slice boundaries (`FileStreamer` calls `readAsText` per slice, papaparse.js line 714). So we decode the whole file once and parse the text.

## 2 Database

Migration: `supabase/migrations/20261010150000_lead_import.sql`, reviewed in git; `deploy-dev-db` applies it to dev only.

**Facts checked against the repo before writing this:**
- `private` already denies execute to PUBLIC by default (core schema), so every new private function needs an explicit `grant execute ... to authenticated`.
- Public functions use the Day 3a revoke/grant loop.
- `config.toml` exposes only `["public"]`, so `private` has no REST endpoint, and `deploy-dev-db` runs `supabase config push`.
- PostgREST `max_rows = 1000`.
- No `serverActions.bodySizeLimit` is set, so the 1 MB default applies.

**Verified on PG16 for this design (spike):**
1. A stored generated column needs EXECUTE on its function for the inserting role.
2. PG16 recomputes a stored generated column only when one of its base columns changes, not on unrelated updates (tested with a counting function).
3. A column set by a BEFORE trigger needs no column privilege; a direct insert of that column is refused.
4. `min(row_no) filter (where ...) over (partition by ...)` works.
5. `'2025-03-30 02:30'::timestamp at time zone 'Europe/Paris'` moves forward to 03:30 CEST.
6. In the pinned GoTrue, verifying TOTP again upserts `mfa_amr_claims.updated_at` and issues a new token (`internal/models/amr.go`, `api/token.go updateMFASessionAndClaims`), so a step-up really renews the code's timestamp.

### 2.1 Dedupe keys (private, plpgsql, IMMUTABLE, PARALLEL SAFE, `set search_path = ''`, execute granted to authenticated)

plpgsql is used because a SQL function with a SET clause is re-planned on every call. Each function is single-level: the fold is written inline, not called. In the spike, a nested-call name key took 774 ms per 30k rows; the target is under 300 ms per 30k.

**`private.lead_email_key(e text)`**
- `nullif(lower(btrim(e)), '')`.

**`private.lead_phone_key(p text)`**
- Take the digits only.
- `null` if fewer than 8 or more than 15 digits; more than 15 means two numbers in one cell.
- Otherwise `right(digits, 9)`, so `+33 (0)6 12 34 56 78`, `06.12.34.56.78` and `0033 6 12 34 56 78` all give `612345678`, and UK and US national and international forms match too.
- Belgian 8-digit numbers do not match across formats (accepted).

**`private.lead_name_key(name text, city text, country text)`**
- **Same key under any locale**: Supabase runs ICU (en-US) and the local test runner libc (C.UTF-8); they disagree on `[[:punct:]]`, `\m`/`\M` and `lower()` (a Turkish locale even lower-cases `I` to `ı`). So the function uses no character class and no word boundary, lower-cases Latin letters with its own map, and writes both character sets as fixed code point ranges with escapes only. A test over every code point and 20,000 random names found no difference between the two.
- **Fold**: `lower(translate(x, <fixed map: A-Z, Latin-1 Supplement + Latin Extended-A, upper and lower case>, <lower-case ASCII>))`, then `œ→oe`, `æ→ae`, `ß→ss`, and Greek final `ς→σ` after `lower()` (ICU writes a final sigma, libc does not). The map starts with a-z, space, digits and `-` mapped to themselves, only so that `translate()` finds the common characters at once (the key takes half the time). There is no `unaccent` dictionary and no locale-dependent folding of accented letters. Unit-tested: `Łódź → lodz` (the spike map had a misalignment, which this test catches).
- **Punctuation set**: ASCII other than letters and digits (so `|`, the key's separator, is never kept), controls, Latin-1 punctuation and symbols, `×` `÷`, the modifier apostrophe, combining accents, Greek and Arabic punctuation, every Unicode space, U+2000–U+2BFF (punctuation, super- and subscripts, currencies such as €, ™, arrows, maths, shapes, dingbats), Supplemental Punctuation, CJK and full-width punctuation and symbols (not the letters 々 〆 〇 ー), variation selectors, the specials block, emoji and flags (U+1F000–U+1FBFF) and tag characters. Letters of any script are kept.
- **City part**: fold, then strip the punctuation set. An empty city gives `null`, so a name never matches without a city.
- **Name part**: fold; delete dots, soft hyphens, combining accents (a decomposed `é`), zero-width characters and the byte order mark, which belong to the word they sit in; turn the punctuation set into spaces; then remove legal forms as whole words: pad with spaces and remove `' (sarl|sas|sasu|sa|eurl|snc|sci|selarl|ltd|limited|llc|inc|gmbh|bv|srl|plc)(?= )'`, so adjacent forms all go ("Durand SARL SAS") and "Sasha" keeps its "sa". If that leaves nothing, keep the unstripped name (so "SARL" stays "sarl"). Then remove spaces; empty gives `null` ("!!!" has no key; CJK names keep their characters).
- **Result**: `name || '|' || city || '|' || coalesce(country, '')`.

**`private.lead_db_problem(name, phone, email, city, country, lead_status) returns text`** (SQL, IMMUTABLE)
- Returns the first `companies` CHECK constraint the values would fail, or `null`:
  - `db_name`: name is null or not 1–200 characters
  - `db_phone`: more than 40 characters, or `!~ '^[0-9+(). /-]*$'`
  - `db_email`: more than 254 characters, or `!~ '^[^@[:space:]]+@[^@[:space:]]+$'`
  - `db_city`: more than 120 characters
  - `db_country`: `!~ '^[A-Z]{2}$'`
  - `db_status`: not one of the 7 statuses
- A parity unit test reads the migration text to keep this list in step with the constraints.

**Companies get stored keys.** Equality on a stored text column uses `texteq`, which is leakproof, so the index works under RLS. An expression index or LIKE would not.
```sql
alter table public.companies
  add column email_key text generated always as (private.lead_email_key(email)) stored,
  add column phone_key text generated always as (private.lead_phone_key(phone)) stored,
  add column name_key  text generated always as (private.lead_name_key(name, city, country)) stored;
create index companies_email_key_idx on public.companies (org_id, email_key, created_at, id) where email_key is not null;
create index companies_phone_key_idx on public.companies (org_id, phone_key, created_at, id) where phone_key is not null;
create index companies_name_key_idx  on public.companies (org_id, name_key,  created_at, id) where name_key  is not null;
```
- `(created_at, id)` is in each index so the "oldest match" lookup (`order by created_at, id limit 1`) is one index-only probe.
- `list_leads`, `count_leads` and `get_lead` name their columns explicitly, so they are unaffected. Day 3a list timings are re-run as evidence.

### 2.2 import_batches (extended; the Day 6 stock import reuses it)

**Columns and constraints**
```sql
alter table public.import_batches
  add column file_sha256 text check (file_sha256 ~ '^[0-9a-f]{64}$'),
  add column last_row_no integer not null default 0 check (last_row_no between 0 and 50001),  -- spreadsheet row number of the last data row
  add column source_timezone text not null default 'Europe/Paris' check (char_length(source_timezone) between 1 and 64),
  add column issue_counts jsonb not null default '{}' check (jsonb_typeof(issue_counts) = 'object' and pg_column_size(issue_counts) <= 4096),
  add column kept integer not null default 0 check (kept >= 0),
  add column checked_at timestamptz, add column imported_at timestamptz, add column rolled_back_at timestamptz,
  add column rolled_back_by uuid;  -- no FK, like audit_log.actor_id
alter table public.import_batches drop constraint import_batches_status_check;
alter table public.import_batches add constraint import_batches_status_check
  check (status in ('staged','dry_run','committing','imported','rolling_back','rolled_back','discarded'));
alter table public.import_batches add constraint import_batches_row_count_max check (row_count <= 50000),
  add constraint import_batches_filename_safe check (char_length(filename) >= 1 and filename !~ '[[:cntrl:]/\\]');
create unique index import_batches_one_writer_idx on public.import_batches (org_id) where status in ('committing','rolling_back');
create index import_batches_history_idx on public.import_batches (org_id, created_at desc, id desc);
```
- `failed` is dropped. The build checks dev first with a read-only MCP query: there must be 0 rows with status `failed`.
- `duplicates` keeps its meaning as the total of both duplicate kinds; the breakdown is in `issue_counts`.

**Grants**
```sql
revoke insert, update, delete on public.import_batches from authenticated;
grant insert (filename, file_sha256, row_count, last_row_no, source_timezone) on public.import_batches to authenticated;
grant update (status) on public.import_batches to authenticated;
```
- No delete: batches are history.
- `uploaded_by`, `kind`, `status`, the counters and the timestamps are never client-writable. Defaults and the trigger set them.

**Policies** (they replace `import_batches_admin`; helpers wrapped in `(select …)`)
- `import_batches_select` (select): `org_id = current_org_id() and is_admin()`. History loads without a fresh code.
- `import_batches_insert` (insert, with check): the same, plus `has_recent_aal2(600)`.
- `import_batches_update` (update, using and with check): the same three. This also covers `SELECT … FOR UPDATE/SHARE`.
- The restrictive `require_mfa` policy stays.

**Trigger `private.import_batch_guard()`** (plpgsql, SECURITY INVOKER, BEFORE INSERT OR UPDATE)
- It fires after `enforce_org_and_owner` (alphabetical), so `org_id` is already set.
- It skips everything when `auth.uid()` is null (superuser fixtures and perf seeding), like `enforce_org_and_owner`.
- On INSERT it sets `uploaded_by := auth.uid()` and checks:
  - `row_count` between 1 and 50,000, and `row_count < last_row_no <= 50001`;
  - fewer than 3 open (`staged`/`dry_run`) batches in the org, otherwise `22023` with hint `too_many_open`.
- On UPDATE with a status change, only these moves are allowed (otherwise `22023` with hint `bad_transition`). Each precondition is checked inside the trigger, so a direct PATCH cannot skip a step.

| From → to | Who | Precondition (in trigger) | Trigger sets |
|---|---|---|---|
| staged/dry_run → dry_run | uploader only (42501) | staging rows = `row_count`, none `pending` | `duplicates`, `rejected`, `issue_counts`, `checked_at` |
| staged/dry_run → discarded | any admin | none | none |
| dry_run → committing | uploader only | the one-writer index (raises 23505; RPCs turn it into hint `busy`) | none |
| committing → imported | uploader only | no `ready` rows; recount; assert `imported + duplicates + rejected = row_count` | `imported`, `duplicates`, `rejected`, `issue_counts`, `imported_at` |
| committing/imported → rolling_back | any admin | one-writer index | `rolled_back_by`; from `committing`: `imported` = tagged companies, and duplicates/rejected/issue_counts from staging |
| rolling_back → rolled_back | any admin | `private.lead_import_untouched(id, 1)` returns nothing | `kept` = companies still tagged, `rolled_back_at` |

- **Every final move recomputes every counter from the staging rows.** Rows that changed during the import (late duplicates) can therefore never leave a batch stuck in `committing`. This fixes the judges' fatal flaw.
- Counts are read under the caller's RLS. Callers are always admins with a fresh code, because the update policy already requires one.
- `issue_counts` keys hold counts only: `ready`, `duplicate_file`, `duplicate_existing`, `by_email`, `by_phone`, `by_name`, `with_fixes`, plus one key per problem, fix and reason code.
- The existing `audit_row` trigger records the insert and every status change with its counters (filename, hash and counts; no lead data).

### 2.3 Staging table (private schema: no REST or GraphQL endpoint; RLS still on)

```sql
create table private.lead_import_staging (
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  row_no integer not null check (row_no between 2 and 50001),   -- the row number Excel shows (header = row 1)
  org_id uuid not null references public.orgs (id),
  -- Loose bounds only: exact companies rules are checked per row by lead_db_problem, so a rules mismatch rejects one
  -- row instead of failing a constraint (whose "Failing row contains" detail would put lead data in the Postgres log).
  name text check (char_length(name) <= 500),
  owner_id uuid,                                     -- no FK: membership is checked in validate and commit
  lead_status text check (char_length(lead_status) <= 40),
  phone text check (char_length(phone) <= 100),
  email text check (char_length(email) <= 500),
  city text check (char_length(city) <= 300),
  country text check (char_length(country) <= 8),
  last_activity_local timestamp,                     -- local time in the batch's source_timezone
  problems text[] not null default '{}' check (cardinality(problems) <= 16 and problems <@ array[
    'name_missing','name_too_long','columns_extra','cell_too_long','email_invalid','phone_invalid','phone_mangled',
    'phone_too_long','date_invalid','date_future','date_too_old','city_too_long']),
  fixes text[] not null default '{}' check (cardinality(fixes) <= 16 and fixes <@ array[
    'email_dropped','phone_dropped','date_dropped','city_dropped','owner_unassigned','country_dropped']),
  outcome text not null default 'pending'
    check (outcome in ('pending','ready','rejected','duplicate_file','duplicate_existing','imported')),
  reason text check (reason in ('owner_unknown','date_out_of_range','db_name','db_phone','db_email','db_city','db_country','db_status')),
  match_key text check (match_key in ('email','phone','name')),
  match_row_no integer,
  match_company_id uuid,                             -- no FK on purpose: an FK would make every undo delete scan this table
  email_key text generated always as (private.lead_email_key(email)) stored,
  phone_key text generated always as (private.lead_phone_key(phone)) stored,
  name_key  text generated always as (private.lead_name_key(name, city, country)) stored,
  primary key (batch_id, row_no)
);
create index lead_import_staging_outcome_idx on private.lead_import_staging (batch_id, outcome, row_no);
create index lead_import_staging_org_idx on private.lead_import_staging (org_id);
```
Generated keys are computed once at insert, spread over the upload calls. They are not recomputed when outcome columns change (verified).

**RLS** (enabled):
- Restrictive `require_mfa` (`has_aal2`), as on every table.
- Every permissive policy requires `org_id = current_org_id() and is_admin() and has_recent_aal2(600)`. Staged rows are lead data, so even reading them counts as an export.
- `staging_insert` also requires `exists (select 1 from public.import_batches b where b.id = batch_id and b.kind = 'leads' and b.status = 'staged' and b.uploaded_by = (select auth.uid()) and row_no between 2 and b.last_row_no)`.
- `staging_select`, `staging_update` and `staging_delete` use the base condition.

**Grants:**
- `select, delete`;
- `insert (batch_id, row_no, org_id, name, owner_id, lead_status, phone, email, city, country, last_activity_local, problems, fixes)`. `org_id` is pinned by the policy, and the RPC copies it from the locked batch, which is cheaper than a per-row org trigger;
- `update (outcome, reason, match_key, match_row_no, match_company_id)`.
- `outcome` can never be set on insert, and the keys are generated.

**No audit trigger**: staging is temporary, and auditing it would copy personal data.

### 2.4 Companies: the only way to set `import_batch_id` and `last_activity_at`

```sql
grant insert (import_batch_id, last_activity_at) on public.companies to authenticated;   -- still no UPDATE grant on either
create policy companies_import_columns on public.companies as restrictive for insert to authenticated with check (
  (import_batch_id is null and last_activity_at is null)
  or (import_batch_id is not null
      and (select private.is_admin()) and (select private.has_recent_aal2(600))
      and (last_activity_at is null or (last_activity_at >= '1990-01-01' and last_activity_at <= now()))
      and exists (select 1 from public.import_batches b where b.id = companies.import_batch_id
                  and b.kind = 'leads' and b.status = 'committing' and b.uploaded_by = (select auth.uid()))));
```
- It is restrictive, so the existing permissive `companies_insert` (org check) is untouched and `create_lead` is unaffected.
- The Day 3a checks in `rls_attack.sql` still pass: a backdated insert and a tagged insert by a rep are now refused by this policy, which raises the same `42501` that the tests catch. `update ... set import_batch_id` is still refused by the column grant.
- Nobody can tag an existing lead into a batch, so Undo can only reach leads that an import inserted.

### 2.5 The one definition of an untouched lead

```sql
create function private.lead_import_untouched(p_batch uuid, p_limit integer) returns setof uuid
language sql stable set search_path = '' as $$
  select c.id from public.companies c
   where c.import_batch_id = p_batch and c.updated_at = c.created_at
     and not exists (select 1 from public.activities a where a.company_id = c.id)
     and not exists (select 1 from public.contacts k where k.company_id = c.id)
     and not exists (select 1 from public.deals d where d.company_id = c.id)
   order by c.id limit p_limit $$;
```
- Any edit, including an owner or status change or a bulk change, bumps `updated_at` through `set_updated_at`. A logged activity also bumps it through `touch_company_activity`.
- Tasks and files hang off contacts and deals, so they are covered.
- Leads with a deal are never removed, because `deals.company_id` is `on delete set null` and removing the lead would leave a deal with no lead.
- It is only ever run by admins, who see every deal. A rep calling it would miss other reps' deals; the RPCs assert admin first.
- An FK-coverage test fails if any table other than contacts, activities and deals ever references companies.

### 2.6 `private.audit_row` (existing SECURITY DEFINER, replaced)

- `rec` drops `search_text`, `email_key`, `phone_key` and `name_key`, using `jsonb - text[]`. Update diffs skip the same keys plus `updated_at` and `last_activity_at`, as today.
- **INSERT on companies with `rec->>'import_batch_id'` set** writes `diff_json = {"import_batch_id": …}`: one small row per imported lead, with the actor, no name, email or phone.
- **DELETE on companies** where `rec->>'import_batch_id'` is set, `rec->>'updated_at' = rec->>'created_at'`, and the batch's status is `rolling_back` (a primary-key lookup; the function is definer) writes `{"import_batch_id": …, "undo": true}`.
- Everything else is unchanged.
- Values are read from `rec` (jsonb), never `new.import_batch_id`, because the trigger is shared by tables without that column.
- Volume: 30k imported leads add about 30k small rows (roughly 9 MB with indexes), within the free tier.

### 2.7 Helper and RPCs (all SECURITY INVOKER, `set search_path = ''`, static SQL only (no EXECUTE or format), revoked from public and anon, granted to authenticated)

**`private.assert_import_admin(p_fresh boolean)`**
- Raises `42501` with hint `admin` unless `is_admin()`.
- If `p_fresh`, raises `42501` with hint `step_up` unless `has_recent_aal2(600)`.
- This gives clean codes for the step-up dialog; RLS is the real gate.

**`create_lead_import(p_filename text, p_file_sha256 text, p_row_count int, p_last_row_no int, p_timezone text) returns uuid`**
1. Fresh-admin check.
2. `p_timezone` must be in `pg_timezone_names`.
3. Clean up: this org's `staged`/`dry_run` batches untouched for more than 24 h (by `updated_at`) become `discarded`. Staging rows of `discarded`, `imported` and `rolled_back` batches are deleted.
4. Insert the batch. The trigger enforces the caps.

**`stage_lead_import_rows(p_batch uuid, p_rows jsonb) returns int`**
1. Fresh-admin check. Lock the batch `FOR SHARE`; it must be `staged` and yours (otherwise hint `not_staged` or 42501).
2. Size checks: `jsonb_typeof = 'array'`, 1–1,000 elements, `octet_length(p_rows::text) <= 1048576`.
3. Pre-check every element read **as text**, with `jsonb_to_recordset(p_rows) as r(row_no text, owner_id text, last_activity text, name text, lead_status text, phone text, email text, city text, country text, problems jsonb, fixes jsonb)`:
   - `row_no` matches `^[0-9]{1,6}$` and is between 2 and `last_row_no`;
   - `owner_id` passes `pg_input_is_valid(…,'uuid')`;
   - `last_activity` matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$` and passes `pg_input_is_valid(…,'timestamp')`;
   - lengths are within the staging bounds;
   - `problems`/`fixes` are arrays of at most 16 strings from the code lists.
   - Any failure raises a constant `22023 'invalid rows'` with no DETAIL, so a bad uuid or date never shows up in an error message (`invalid input syntax for type uuid: "…"`).
4. `insert … select` with casts and `org_id` from the batch, `on conflict (batch_id, row_no) do nothing`, so retries are safe.
5. Returns the number of rows inserted.

**`validate_lead_import(p_batch uuid) returns jsonb`** (the check / dry run)
1. Fresh-admin check and uploader. Lock the batch `FOR UPDATE`; status must be `staged` or `dry_run`.
2. Staged count must equal `row_count`, otherwise hint `incomplete`.
3. One read of the batch's rows computes, per row:
   1. **reject**:
      - `cardinality(problems) > 0`;
      - else `lead_db_problem(…)`;
      - else `owner_unknown` (owner not a profile visible to the caller, so not in the org);
      - else `date_out_of_range` (`last_activity_local at time zone tz > now()` or before 1990).
   2. **keepers among non-rejected rows**, with `has_contact = email_key or phone_key`:
      - `e_keep = min(row_no) over (partition by email_key)`;
      - `p_keep = min(row_no) over (partition by phone_key)`;
      - for rows with no contact, `n_keep = coalesce(min(row_no) filter (where has_contact) over (partition by name_key), min(row_no) over (partition by name_key))`.
   3. **existing match**: `LEFT JOIN LATERAL` probes on `companies` (`org_id = v_org and email_key = s.email_key order by created_at, id limit 1`), then phone, then name for rows with no contact only.
   4. **outcome**, in this order: `rejected`; existing email → existing phone → existing name (`duplicate_existing`, with `match_key` and `match_company_id`); `e_keep < row_no` → `p_keep < row_no` → `n_keep <> row_no` (`duplicate_file`, with `match_key` and `match_row_no`); else `ready`.
4. Results go into arrays (`array_agg`), then `update … from unnest(…) as u(row_no, …) where s.batch_id = p_batch and s.row_no = u.row_no and (s.outcome, s.reason, …) is distinct from (u.outcome, u.reason, …)`.
   - Why arrays: freshly staged rows have no statistics, and authenticated cannot ANALYZE. A self-join of staging could be planned as a nested loop; updating by primary key from arrays cannot.
5. `update import_batches set status = 'dry_run'`; the trigger recounts.
6. Returns the counts.

**`list_lead_import_issues(p_batch uuid, p_after_row int default 0, p_limit int default 1000)`**
- Returns a table of `row_no, outcome, problems, fixes, reason, match_key, match_row_no, match_company_id, match_company_name`.
- Admin; staging RLS requires a fresh code.
- Rows that are not `ready`/`imported`, or that have fixes, keyset on `row_no`, `p_limit` 1–1,000.
- **No staged values are returned**: the browser already holds them. `match_company_name` is read from companies under normal RLS.

**`commit_lead_import(p_batch uuid, p_max_rows int default 1000) returns jsonb`** (`p_max_rows` 1–2,000)
1. Fresh-admin check and uploader. Lock the batch.
   - `imported`: return `{status:'imported', imported_now:0, remaining:0}`, so a replay is harmless.
   - `dry_run`: set `committing`; a unique violation becomes `22023` with hint `busy`.
   - Any other status except `committing`: hint `not_ready`.
2. One statement:
   - `picked`: the next `ready` rows by `row_no`, `limit p_max_rows for update`;
   - `late`: the same three lateral probes on companies (leads added since the check);
   - `ins`: `insert into public.companies (name, owner_id, lead_status, phone, email, city, country, last_activity_at, import_batch_id)` for rows with no late match. `owner_id` is kept only if still a visible profile, otherwise null (a removed owner becomes Unassigned instead of a refused chunk). `last_activity_at = last_activity_local at time zone tz`;
   - `upd`: mark staging rows `imported`, or `duplicate_existing` with `match_*`, `returning outcome`.
   - A row is marked in the same transaction that inserts it.
3. If no `ready` rows remain: `status = 'imported'` (the trigger recounts and checks the sum), then `delete from private.lead_import_staging where batch_id = p_batch`.
4. Returns `{status, imported_now, late_duplicates, remaining}`.

**`preview_lead_import_rollback(p_batch uuid) returns jsonb`**
- Admin, any code freshness. Counts only: `{tagged, removable (lead_import_untouched(p_batch, 50001)), kept}`.

**`rollback_lead_import(p_batch uuid, p_max_rows int default 2000) returns jsonb`** (`p_max_rows` 1–5,000; any admin)
1. Fresh-admin check. Lock the batch.
   - `imported`/`committing`: set `rolling_back` (unique violation becomes hint `busy`), then delete all of the batch's staging rows.
   - `rolled_back`: return done.
   - Other statuses: `not_ready`.
2. **Statement A**: `ids := array(select c.id from public.companies c where c.id in (select private.lead_import_untouched(p_batch, p_max_rows)) order by c.id for update of c)`.
3. **Statement B**, which takes a new snapshot: `delete from public.companies c where c.id = any(ids) and c.id in (select private.lead_import_untouched(p_batch, p_max_rows))`. It goes through `companies_delete` (manager or admin plus fresh code).
   - Why two statements: a contact or activity committed while A waited, or after A's snapshot, is seen by B and its lead is kept. A's locks then block new links (their FK check needs `FOR KEY SHARE`) until the call ends.
4. If A returned fewer than `p_max_rows`: `status = 'rolled_back'` (the trigger checks nothing untouched remains and sets `kept`).
5. Returns `{status, removed_now, kept}`.
6. Kept leads keep their `import_batch_id` for history.

**`discard_lead_import(p_batch uuid) returns void`**
- Fresh-admin check (CLAUDE.md: deletes need step-up).
- `staged`/`dry_run` → `discarded`, then delete the staging rows. The batch row stays.

**`list_lead_imports(p_limit int default 20, p_before_created timestamptz default null, p_before_id uuid default null, p_id uuid default null)`**
- Admin, no fresh code. Keyset on `(created_at desc, id desc)`, `p_limit` 1–50; `p_id` selects one batch (deep links).
- Returns the batch fields including `file_sha256` (used for the "same file as before" warning without an extra call), the counters, `issue_counts`, timestamps, uploader id, first and last name, and the undoer's first name.

**Error contract** (server actions and the route map these to codes; raw messages never leave the server):

| SQLSTATE | Hint | Code shown to the screen |
|---|---|---|
| 42501 | `step_up` | `step_up`: the dialog opens and the call is retried |
| 42501 | other or none | `forbidden` |
| 22023 | `incomplete`, `not_staged`, `not_ready`, `too_many_open`, `bad_transition` | same name |
| 22023 `busy` or 23505 | | `busy` |
| 22023 (no hint) | | `invalid` |
| P0002 | | `not_found` |
| 57014 | | `timeout`: the client halves the chunk |
| anything else | | `unavailable` |

**Invoker or definer**
- Nothing new is SECURITY DEFINER.
- Every rule is in RLS, column grants, check constraints and the invoker guard trigger, so it also holds for direct PostgREST calls. The RPCs add batching and clean error codes.
- The only definer code touched is the existing `audit_row` (one new branch, plus key stripping). It is needed because it writes `audit_log`, which clients cannot write, and it reads one batch status by primary key.

**Advisors:** after migrating, run splinter locally (`db-test.sh`, the CI `db` job) and the Supabase security and performance advisors on dev after the merge deploy, and report them.
- Expected: no new WARN (no new definer, every function has `search_path` set, policies use `(select …)`); INFO for unused indexes on an empty database.

## 3 Pipeline

**3.1 Entry and gate**
- The Leads toolbar "Import" button (admins only; prefetched on hover), Cmd+K "Import leads" (admins only; the layout reads `profiles.role` once and passes `isAdmin`), and the admin empty state all lead to `/leads/import`.
- `page.tsx` calls `requireSession()` (aal2), then a new `requireAdmin()` in `src/lib/auth.ts` (`profiles.select('role').eq('id', sub).maybeSingle()`, a pattern the local gateway already supports), and answers `notFound()` for anyone else.
- In parallel it loads `list_lead_imports`, `list_team` and `stepUpSecondsLeft(claims)`: the totp `amr` timestamp + 600 − now − 30 s margin, computed on the server so the browser clock does not matter.

**3.2 Read and parse** (browser only; papaparse 5.7.0 loaded with a dynamic import when a file is picked)
- **Refused up front** with a plain message:
  - not `.csv`/`.txt`;
  - more than 15 MB;
  - Excel magic bytes `PK\x03\x04` or `D0 CF 11 E0` ("This is an Excel file. In Excel: File > Save a copy > CSV UTF-8");
  - empty file, or no header row.
- **Decoding**: bytes are read once. SHA-256 comes from `crypto.subtle`. `new TextDecoder('utf-8', {fatal:true})`; if that fails, `windows-1252` with a visible notice. The BOM is stripped, and an Excel `sep=;` first line is honoured.
- **Parsing the decoded string**, not a Blob (papaparse's `FileStreamer` would decode byte slices on their own):
  ```
  Papa.parse(text, { header: false, dynamicTyping: false, skipEmptyLines: false,
    delimitersToGuess: [',', ';', '\t', '|'], chunkSize: 256 * 1024,
    chunk: (r, parser) => { handle(r.data); parser.pause(); setTimeout(() => parser.resume(), 0) } })
  ```
  - `header:false` gives plain arrays, so header names never become object keys (no `__proto__` pollution).
  - There is no Web Worker, so the CSP stays unchanged.
  - A determinate bar shows progress; each slice yields to the main thread.
- **Limits:**
  - at most 50,000 data rows, counting blank rows inside the data; otherwise "split it in two";
  - at most 100 columns;
  - header cells at most 200 characters; duplicate headers get " (2)";
  - data cells at most 2,000 characters, otherwise row problem `cell_too_long`.
- **Quote errors** (`MissingQuotes`/`InvalidQuotes`) stop the read: "Row 1,204 has an opening quote without a closing one".
- **Row numbers**: `row_no` is the record index + 1, which is the number Excel shows (header = row 1; a quoted multi-line cell is one row).
  - Fully empty rows keep their numbering, but are counted as "ignored" and never sent.
  - `row_count` = non-empty data rows; `last_row_no` = number of the last data row.
- **Column count**: more cells than headers gives row problem `columns_extra`; missing trailing cells count as empty.
- The raw rows stay in memory only.

**3.3 Column mapping** (`src/lib/import/headers.ts`)
- Targets: `name` (required), `owner`, `phone`, `email`, `status`, `last_activity`, `city`, `country`, or "Don't import".
- Headers are normalised: NFD, accents removed, lower case, text in parentheses removed, punctuation turned into spaces.
- Matching order: exact synonym, then a "contains" synonym. Synonyms include:
  - company name / company / société / entreprise / raison sociale / nom de la société
  - company owner / owner / lead owner / propriétaire / responsable / commercial
  - phone number / phone / téléphone / tel / mobile
  - email / e-mail / mail / courriel
  - lead status / status / statut
  - last activity date / last activity / dernière activité
  - city / ville
  - country/region / country / pays / région
- `Row` / `Ligne` / `Problem` / `Problème` default to "Don't import", so a fixed problems file re-imports with no remapping.
- Haider's exact header maps with zero clicks.
- Each column feeds at most one field and each field one column; picking a field already in use swaps the two.
- The last mapping for the same header row is remembered in `localStorage` under a hash of the header (per viewer; every access in try/catch).

**3.4 Value mapping** (same screen; `Map` objects, never plain object keys)
- **Status**: every distinct value with its count.
  - Suggestions come from EN/FR aliases and HubSpot internal values: `Warm (in Progress)`/`in progress`/`IN_PROGRESS` → warm, `Cool off`/`Cool-off` → cool_off, `client` → customer, `ne pas contacter`/`dnc` → do_not_contact, `unqualified`/`non qualifié` → disqualified.
  - An unrecognised value must be chosen explicitly ("Continue" is disabled with the reason).
  - Blank uses a default status (Cold, changeable).
- **Owner**: matched to `list_team` by accent- and case-insensitive full name, "last first", or a first name that is unique in the team.
  - Anything else is preselected to Unassigned with an amber dot, and adds fix `owner_unassigned`.
- **Country**: matched by ISO code, the `Intl.DisplayNames` en and fr names for the 249 codes in `src/lib/countries.ts`, and aliases (UK, England, Scotland, Wales, Great Britain, USA, US, États-Unis, Holland, Pays-Bas, Deutschland, España, Italia, Belgie, Schweiz, Türkiye, UAE, Czech Republic, Ivory Coast).
  - An unknown country is preselected to "Leave blank" and adds fix `country_dropped`.
- **Dates**: the whole column is scanned. A first part above 12 means DMY; a second part above 12 means MDY.
  - If neither appears, DD/MM/YYYY is preselected with live examples ("03/04/2025 → 3 April 2025").
  - If both appear, the file is "mixed" and conflicting cells become `date_invalid`.
  - Source time zone defaults to the profile's (Europe/Paris), checked with `Intl.supportedValuesOf('timeZone')`.
- More than 200 distinct unmatched values in one field: "Is this the right column?"

**3.5 Normalisation** (`src/lib/import/normalise.ts`; pure; unit-tested; the bad-field rule is one constant `BAD_FIELD_POLICY = 'reject_row'` in `rules.ts`, see question 1)
- **Every cell**:
  - NFC;
  - NBSP, narrow NBSP and tabs become spaces;
  - zero-width characters, BOM, controls (U+0000–U+001F, U+007F) and bidi overrides (U+202A–E, U+2066–9) are removed;
  - newlines become a space; spaces are collapsed and trimmed;
  - one leading `'` is removed before `= + - @` (so a fixed problems file round-trips).
  - Placeholders `n/a, na, none, null, -, --, /, ?, aucun, néant, inconnu, unknown, tbd` become empty.
- **Name**: empty gives `name_missing`; more than 200 characters gives `name_too_long`.
- **Email**:
  - remove `mailto:` and lowercase;
  - must match `^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$` and be at most 254 characters, otherwise `email_invalid`;
  - more than one address in a cell is `email_invalid`.
- **Phone**:
  - kept as written; whitespace collapsed; Unicode dashes become `-`; `tel:` removed;
  - scientific notation such as `3.36E+11` gives `phone_mangled` ("Excel changed this number");
  - characters outside `[0-9+(). /-]`, or fewer than 6 digits, give `phone_invalid`;
  - more than 40 characters gives `phone_too_long`.
- **Last activity**: the accepted formats are
  - `YYYY-MM-DD`, with an optional `[ T]HH:mm[:ss]` and an optional `Z`/`±hh:mm` (an offset is converted into the source time zone with Intl);
  - `D/M/YYYY`, `D.M.YYYY` or `D-M-YYYY` in the chosen DMY or MDY order, optionally with `HH:mm[:ss]` (AM/PM only in MDY), and 2-digit years read as 20YY;
  - Excel serial numbers 20000–80000 (days from 1899-12-30, fraction = time).
  - The calendar date is checked (31/02 → `date_invalid`). A date with no time means 00:00 local. Output is a canonical local `YYYY-MM-DDTHH:MM:SS`.
  - Later than now gives `date_future`; before 1990-01-01 gives `date_too_old`.
  - SQL converts with `AT TIME ZONE`, so a DST spring-gap time moves forward (verified).
- **City**: more than 120 characters gives `city_too_long`.
- **Country**: from the map, an ISO code or empty.
- **Bad fields** (email, phone, date, city): with `reject_row` (default) the row is rejected with those problem codes. With `blank_field` the field is left empty and a fix code (`email_dropped`, …) is added.
- **Row problems** (`name_*`, `columns_extra`, `cell_too_long`) always reject the row.

**3.6 Upload to staging**
- "Check" calls `startImport` (Zod) → `create_lead_import`.
- **Chunks**: at most 1,000 rows and at most 750 KB of UTF-8 JSON (measured with `TextEncoder`). That is under the unchanged 1 MB server-action limit and far under Vercel's 4.5 MB.
- Rejected rows travel as `{row_no, problems}` only, with no values.
- Each chunk goes to `stageRows(batchId, rows)`: Zod → `requireSession` → `stage_lead_import_rows`. Next runs one server action at a time per client, so chunks go in order.
- **Retries**: network, 5xx or `unavailable` → 3 retries (0.5, 1, 2 s), then "Connection lost at row 12,000 [Try again]". Resuming is safe because of `on conflict do nothing`.
- On `step_up`, the dialog opens and the same chunk is retried.
- 30k rows ≈ 30 calls.

**3.7 Who validates what**
- **TypeScript** interprets: decoding, mapping, value decisions, dates, placeholders, Excel damage. It gives canonical values and friendly codes.
- **The server action** checks only shapes with Zod `strictObject` (extra keys refused):
  - a union of a rejected row `{row_no 2..50001, problems: enum[] 1..16}` and a staged row `{row_no, name 1..200, owner_id uuid|null, lead_status enum, phone ≤40 + charset|null, email ≤254 + regex|null, city ≤120|null, country enum(countryCodes)|null, last_activity regex|null, fixes enum[] ≤16}`;
  - every string free of control characters; the array 1–1,000.
  - Any failure answers `invalid` and nothing is written.
  - A unit test runs every normalised row of the 500-row sample through the schema, so the browser rules and the schema cannot drift.
- **SQL is the authority**: the constant-error pre-check, per-row `lead_db_problem`, owner in org, the date relative to `now()`, every duplicate rule, a late re-check in every import call, and finally the companies policy and constraints.

**3.8 Dedupe rules and order** (one place: `validate_lead_import`, plus the commit re-check)
1. Rejected rows never block anyone and are never matched.
2. Keys: email key, phone key (last 9 digits, 8–15 digits), name key (name + city + country; city required). The name key is used only for rows with **no email and no phone key**.
3. **Already in the CRM** takes precedence: email, then phone, then name (for rows with no contact only). The match is the oldest lead by `(created_at, id)`.
4. **Repeated in this file**: an earlier row shares the email or phone key (`match_row_no` = the first row with that key). For a row with no contact, the keeper of its name group is the first row in the group *with* contact details, else the first row. Because each keeper is the earliest row of its group, no two imported rows ever share a key, and a chain of repeats always points at an earlier row.
5. Duplicates are skipped and never merged; the import never changes existing leads.
6. Every import call re-checks its rows against companies, so leads the team added between Check and Import (or during a pause) are skipped and counted as "Already in the CRM".
7. Two rows of the same chain ("Carrefour City", Paris) with different phones are both imported.

**3.9 Dry run (Check).** Shows Ready N / Already in the CRM D1 (by email, phone or name) / Repeated in this file D2 / Can't be imported R.
- Below: reasons with counts (from `issue_counts`), and fixes ("6 owners aren't CRM users: those leads come in unassigned").
- A breakdown of the ready rows by status, owner and country, computed in the browser: all canonical rows minus the issue rows fetched from `GET /api/imports/[id]/issues?after=N` (`apiSession`, Zod, RPC, `Cache-Control: private, no-store`, `403 {error:'step_up'}` when the code is stale; pages of 1,000).
- Nothing is written to the CRM. Re-checking is allowed.

**3.10 Problems CSV** (browser; `src/lib/import/csv-out.ts`)
- **Rows**: every rejected or duplicate row.
- **Columns**: `Row`, `Problem` (in the UI language, joined with " · "; for example "Email address doesn't look right", "Same phone as row 12", "Already in the CRM: Maison Verdane (same email)"), then **all original columns in source order with their original header names**.
- Same delimiter as the source, UTF-8 BOM, CRLF, every cell quoted, quotes doubled.
- `csvCell()` prefixes `'` when a cell, after leading spaces, starts with `= + - @ \t \r` or the full-width `＝ ＋ － ＠`.
- File name `<basename>-problems-YYYY-MM-DD.csv`, downloaded through a Blob URL.
- The problems file is **not kept after the import**, because staging is purged. The Review screen says "Download it now". After a reload, choosing the same file again (hash checked) rebuilds it while the batch is still checked.

**3.11 Commit**
- `ensureFresh(120)`, then `commitImportStep(batchId, size)` in a loop until `imported`.
- `size` starts at 1,000 and is halved on `timeout`, down to 250.
- A network error re-sends the same call, which is safe: the batch row lock serialises callers, rows are marked in the insert's transaction, and an imported batch answers done.
- A determinate bar shows "Imported 12,000 of 28,410", with a `beforeunload` guard.
- If the tab closes, the batch stays `committing` and history shows **Paused** (Resume for the uploader; Undo for any admin).
- `busy` shows: "Another import is running (leads.csv, Henri)."

**3.12 Rollback (Undo)**
- `preview_lead_import_rollback` → dialog with exact numbers → `ensureFresh(120)` → `rollbackImportStep` loop (2,000 per call) until `rolled_back`.
- It works on a paused import, and has no time limit, because the "untouched" rule protects work.
- Kept leads stay tagged. Undo of a finished undo is not offered.

**3.13 Discard, expiry, retention**
- Discard (`staged`/`dry_run`, fresh code) deletes the staging rows.
- Batches untouched for 24 h are discarded on the next import start.
- Staging is deleted when a batch becomes imported or rolling_back.
- A paused (`committing`) batch keeps its remaining rows until Resume or Undo, and the import page shows an amber banner.
- The raw file is never uploaded anywhere: there is no Storage bucket, and rejected rows carry no values.

**3.14 Audit.** Recorded:
- the batch insert and each status change with counters (actor = admin);
- one small row per imported lead (`{import_batch_id}`) and per undone lead (`{import_batch_id, undo:true}`);
- normal full rows for everything else.

Staging is not audited. `import_batch_id` with the audited batch row is each lead's source (Master Plan compliance: "record where each lead came from").

**3.15 Work per call** (targets checked by `perf_import.sql`)

| Call | Size | Target (local PG16) |
|---|---|---|
| stage | 1,000 rows | ~100–300 ms |
| validate | whole batch | under 3 s at 50k |
| issues page | 1,000 rows | |
| commit | 1,000 rows | ~300 ms |
| rollback | 2,000 rows | |

- Every call stays under 2 s, against the ~8 s statement timeout and short Vercel functions.
- If validate at 50k misses 3 s, split it into two calls (existing pass, then file pass) run in sequence by the browser.

## 4 Security

Database tests live in `supabase/tests/import_attack.sql` (and `import_concurrency.sh` for the two-session cases). End-to-end tests are in `tests/auth/import*.spec.ts`; unit tests in `tests/unit/*`.

| # | Threat | Control | Attack tests |
|---|---|---|---|
| 1 | Stolen aal1 session | restrictive `require_mfa` on staging too; `requireSession` | `import_aal1_blocked` (every RPC 42501, zero batches or staging rows), `import_anon_no_execute` |
| 2 | Stolen aal2 session, or admin away (code older than 10 min) | `has_recent_aal2(600)` in batch insert/update, every staging policy, `companies_import_columns`, `companies_delete`; RPCs raise hint `step_up`; re-verifying renews the amr time (GoTrue upsert, verified) | `import_stale_code_every_write_denied` (totp age 660: create, stage, validate, issues, commit, rollback, discard), `import_no_totp_in_amr_denied`, `import_stale_direct_batch_insert_denied`, `import_stale_direct_status_patch_no_effect`, `import_stale_direct_staging_insert_denied`, `import_stale_staging_select_zero_rows`, `import_history_readable_without_fresh_code`; e2e `step_up_dialog_flow` (decoded JWT shows a newer totp timestamp) |
| 3 | Rep or manager | `is_admin()` in every import policy and RPC; page `notFound()` (cosmetic) | `import_rep_every_rpc_42501`, `import_rep_reads_no_batches_or_staging`, `import_manager_cannot_import_or_rollback`, `import_demoted_uploader_cannot_tag` (rep b1 promoted to admin, starts a batch in `committing`, is demoted, then a direct tagged insert must fail); e2e `rep_gets_404_and_no_entry_points`, `rep_direct_rpc_403` |
| 4 | Another organisation | `org_id = current_org_id()` in every policy; `enforce_org_and_owner`; staging `org_id` pinned; batch subqueries run under RLS; owner must be visible | `import_other_org_admin_cannot_touch_batch` (P0002 or 42501 on every RPC, zero staging rows), `import_other_org_owner_rejected` (reason `owner_unknown`) |
| 5 | Another admin's batch | uploader only for stage, validate and commit (policy, trigger and RPC); any admin may undo or discard | `import_other_admin_cannot_stage_validate_commit`, `import_any_admin_can_rollback` |
| 6 | Going around the RPCs (direct PostgREST) | staging in unexposed `private`; batch update grant on `status` only; guard trigger checks every move and computes counters; companies import columns insert-only and gated | `import_status_skip_refused` (staged→committing, dry_run→imported, staged→dry_run with missing rows), `import_counters_not_writable`, `import_batch_delete_denied`, `import_companies_tag_rules` (last activity without batch; batch staged, dry_run or imported; someone else's committing batch; future or pre-1990 date with the batch held in committing), `update_import_batch_id_still_denied` (3a); e2e `staging_not_exposed` (404, and `Accept-Profile: private` → 406 on real PostgREST) |
| 7 | Mass assignment | Zod `strictObject`; `jsonb_to_recordset` fixed column list; column grants; `uploaded_by`, `status`, counters and `kind` from defaults or trigger | unit `schema_rejects_extra_keys`; `import_batch_insert_server_fields` (cannot name uploader, status or counters), `import_staging_columns_not_writable` (insert outcome, update problems → 42501; other `org_id` → 42501) |
| 8 | SQL or filter injection | static SQL in every import function; values only as parameters or jsonb; no PostgREST filter strings | e2e: names `'); drop table companies; --` and `),id.eq.` stored verbatim |
| 9 | CSV formula injection | `csvCell()` on every cell including full-width forms; importer strips one leading `'` | unit `csv_cell_*` (= + - @ tab CR, leading spaces, ＝, quotes, newlines, round trip); e2e parses the downloaded file and checks the `'` prefix on formula and `+33` cells |
| 10 | XSS or spoofing through cells | React text only; bidi and control characters stripped | e2e `xss_name_is_text` (no dialog event); unit `bidi_and_control_stripped` |
| 11 | Crafted CSV | `header:false` arrays plus `Map`; limits (15 MB, 50k rows, 100 columns, 2,000 characters per cell, 200 distinct unmatched values); quote errors stop; Excel magic bytes | unit `parse_proto_header`, `parse_quote_error_row`, `parse_sep_line`, `parse_bom`, `parse_multibyte_across_chunks`; e2e `xlsx_empty_too_many_rows_messages` |
| 12 | Oversized or abusive requests | 1 MB action limit unchanged; Zod caps; SQL: 1,000 elements, 1 MiB payload, `row_no ≤ last_row_no` in policy, `row_count ≤ 50000`, 3 open batches, one writer per org | `import_stage_1001_rows_22023`, `import_payload_too_big`, `import_row_no_beyond_last_row_denied`, `import_row_count_50001_refused`, `import_fourth_open_batch_refused`, `import_second_writer_busy` |
| 13 | Lead data in logs | constant-error pre-check (no value ever in SQLERRM or DETAIL); per-row `lead_db_problem` so CHECK "Failing row contains" never fires; actions log nothing; ESLint `no-console` on import code | `import_bad_values_constant_error` (planted uuid and date absent from SQLERRM and `PG_EXCEPTION_DETAIL`); e2e `rejected_rows_send_no_values` (inspects request bodies) |
| 14 | Lead data in the audit log | minimal insert and undo rows; key columns and `search_text` stripped; staging not audited | `import_audit_minimal` (no name, email, phone or `*_key` in any audit row for the batch's leads; batch status rows present) |
| 15 | Data kept too long | purge at imported, rolling_back, discard and 24 h idle; no file storage | `import_staging_purged` (each path, including back-dated `updated_at`) |
| 16 | Partial failure | one transaction per chunk; resumable states; validate refuses an incomplete upload; Undo works on a partial import | `import_validate_incomplete_refused`, `import_rollback_partial_commit`; e2e `resume_after_aborted_commit` |
| 17 | Replay or double commit | batch row lock; mark-in-same-statement; `on conflict do nothing`; final states answer done; one-writer index | `import_restage_same_chunk_idempotent`, `import_commit_after_imported_noop`, `import_stage_after_check_refused`, `import_parallel_commits_insert_once` (two psql sessions) |
| 18 | Late duplicates or stuck counters | re-check in every chunk; counters recomputed at every final move | `import_late_duplicate_skipped`, `import_counters_add_up` |
| 19 | Undo abuse or data loss | admin plus fresh code (RPC and `companies_delete`); only tagged rows (no retagging); untouched only; deals always stay; two-statement delete | `import_rollback_keeps_worked_on` (edit, activity, contact, deal each keep one lead: kept = 4), `import_rollback_cannot_reach_untagged`, `import_rollback_twice_noop`, `import_rollback_waits_for_new_contact_and_keeps_lead` (two sessions), `import_fk_coverage` |
| 20 | CSRF and error leakage | server actions' Origin check; GET route read-only, aal2, no-store; fixed error codes | e2e `error_copy_has_no_sql` |
| 21 | Step-up brute force | Zod `^\d{6}$`; GoTrue verify rate limits; generic messages | e2e `wrong_code_message`, `rate_limited_message` (429 at the action boundary) |

## 5 UX

**Entry points (admins only)**
- "Import" button (Lucide Upload, neutral style) next to "Add lead" in the Leads toolbar; an icon with a label on phones.
- Cmd+K "Import leads".
- The admin empty state: primary "Import from a spreadsheet" with "Add lead" second. The copy drops "Importing your lead sheet comes next."
- Route `/leads/import` (the dock bead stays on Leads), with a `loading.tsx` skeleton matching the step card and 3 history rows.
- `?batch=<id>` reopens a batch from history.
- Non-admins get the standard 404 and see no entry points.

**Layout**
- At 1024 and wider (designed at 1440): the wizard (max 880 px) and a 320 px "Past imports" rail.
- At 768: the rail goes under the wizard.
- At 390:
  - one column with a "Step 2 of 4" header;
  - mapping and values as stacked cards;
  - a sticky bottom action bar above the dock (safe-area aware);
  - "Choose file" instead of drag and drop;
  - no horizontal page scroll.
- Steps: `ol` with `aria-current` (1 Choose file · 2 Match · 3 Check · 4 Import). Focus moves to the step heading.
- Spring on transform and opacity only; instant with reduced motion. Progress bars grow with a `scaleX` spring, never a spinner.

**Step 1, Choose file**
- Drop zone (radius 20): "Drop your CSV here or choose a file. Up to 50,000 rows. In Excel: File > Save a copy > CSV UTF-8. Nothing changes in your CRM until you confirm."
- While reading: a byte or row progress bar.
- Errors, each with a next step: too big; Excel file; empty; no header; more than 50,000 rows ("split it in two"); quote error with its row number.
- Notices:
  - "We read this file as Western European text. Check the accents in the preview."
  - Same file as before: "You imported this exact file on 12 Oct (28,410 leads). Every row would show as already in the CRM."
- Success line: "leads.csv · 30,214 rows · 8 columns · separated by ;".

**Step 2, Match**
- Table: Column in your file | 3 example values | Goes to (select). Auto-matches carry a "Matched" badge.
- Required: "Choose the column with the company name."
- **Values to check** (only sections that need attention):
  - owners ("We matched 3 of 4 owner names." "Former Rep, 6 leads → Unassigned"; hint: "Invite them first, or reassign later from Leads");
  - statuses with counts;
  - unrecognised countries (picker or "Leave blank");
  - date order with live examples, and time zone.
- Live preview: "Ready to check: 29,410 · Need fixing: 590".
- "Check file" (⌘↩) stays disabled with the reason ("2 status values still need a choice").

**Step 3, Check**
- The step-up dialog first if needed.
- Progress: "Sending rows… 12,000 of 30,214", then "Looking for duplicates…" with skeleton tiles.
- Four tiles in DM Mono, each with a small labelled dot:
  - Will be added (green dot)
  - Already in the CRM ("skipped")
  - Repeated in this file ("only the first is kept")
  - Can't be imported (red dot)
- Reasons with counts; fixes; the split by status, owner and country (thin neutral bars).
- A virtualised list (Row | Company | What happened) with filter chips (All / Can't import / Repeated / Already in CRM / Changed).
  - Without the file in memory, the Company column says "Choose the same file to see names".
- "Download rows not imported (CSV)" with the line "Download it now: we don't keep a copy after the import."
- Primary (Signal Red, black text; the one accent on the screen): "Import 28,410 leads" (⌘↩). Quiet "Discard".
- With nothing to add, the primary is disabled: "Nothing new to import."

**Step 4, Import**
- "Imported 12,000 of 28,410 · Keep this tab open."
- Connection lost: "Connection lost. Nothing was added twice." Automatic retries, then Continue.
- Done: "28,410 leads added", with "See newest leads" (`/leads?sort=created`), the problems download (while in memory) and a quiet "Undo import". TanStack `['leads']` queries are invalidated.

**Past imports** (history rail)
- Each row: file name (truncated in the middle), "10 Oct 2026, 14:05 · Haider", a badge (dot + word), and counts in DM Mono ("28,410 added · 1,203 already in CRM · 210 repeated · 175 not imported").
- Badges and actions by state:

| State | Badge | Actions |
|---|---|---|
| staged | Upload not finished | Continue (choose the same file) / Discard |
| dry_run | Checked, not imported | Review / Discard |
| committing | Paused | Resume (uploader) / Undo |
| imported | Imported (green) | Undo |
| rolling_back | Undo paused | Resume undo |
| rolled_back | Undone · 37 kept | none |
| discarded | Discarded | none |

- Loading: skeleton rows. Empty: "No imports yet. Your first import will show up here." Error: "Couldn't load past imports. [Try again]".

**Undo dialog**
- Text: "Undo this import? This removes the 28,373 leads added from leads.csv on 12 Oct that nobody has worked on. 37 leads your team worked on since (a call, note, contact, deal or any change, including a new owner) stay."
- Buttons: "Remove 28,373 leads" (neutral black, keeping red the single accent) and "Keep everything".
- Then the code if needed, progress, and "Removed 28,373. Kept 37."

**Step-up dialog** (`src/components/auth/step-up-dialog.tsx`, Radix; a bottom sheet on phones; Day 6 adjustments, exports and deletes reuse it)
- Title: "Confirm it's you" / "Confirmez votre identité".
- Body: "Imports change many leads at once. Enter the 6-digit code from your authenticator app. You'll stay confirmed for 10 minutes." / "Les imports modifient beaucoup de prospects d'un coup. Saisissez le code à 6 chiffres de votre application d'authentification. Vous restez confirmé pendant 10 minutes."
- One input: `inputMode="numeric"`, `autocomplete="one-time-code"`, autofocus. It submits by itself on the 6th digit or Enter; Esc cancels.
- Errors: "That code didn't work. Check your phone's clock, or wait for the next code." and "Too many tries. Wait a minute."
- On success it closes and the waiting action continues without another click.
- When it opens: before Check, Import, Undo and Discard when fewer than 120 s are left (the server-computed `secondsLeft`), and whenever an action answers `step_up`.
- Server action `verifyStepUp(code)` in `src/app/(app)/step-up-actions.ts`: `requireSession`, Zod `^\d{6}$`, `listFactors().totp[0]`, `challengeAndVerify`. It returns `{ok, secondsLeft}` or a code, and never redirects.

**Copy**
- Plain words for a sales owner. Never "staging", "batch", "dry run", "dedupe" or "rollback"; use Check, Import, Undo, Already in the CRM, Repeated in this file, Can't be imported.
- FR uses "prospects": "Importer des prospects", "Choisissez votre fichier", "Associez vos colonnes", "Vérifier le fichier", "Importer 28 410 prospects", "Déjà dans le CRM", "En double dans le fichier", "Impossible à importer", "Annuler l'import".
- All strings live in the new `Import` and `StepUp` namespaces in `messages/en.json` and `fr.json`, with problem codes under `Import.problems.*`. Numbers, dates and plurals use Intl and ICU.

**Keyboard and accessibility**
- ⌘/Ctrl+Enter is the step's primary action (Kbd hint inside the button on desktop). Esc closes dialogs only, never the import.
- Every select has a label. Progress uses `role="progressbar"` with values; results are announced in a polite `aria-live` region every 10%.
- Press feedback within 100 ms. Status is never shown by colour alone.

## 6 Tests and evidence

**A) Database tests: `supabase/tests/import_attack.sql`** (new)
- Runs in `scripts/db-test.sh` after `rls_attack.sql`. `db.yml` gets a new step running it on the real Supabase image; today `db.yml` runs only `rls_attack.sql`.
- It **redefines `pg_temp.as_user(sub, aal, totp_age_s)`** (temporary functions do not survive into a new psql session) and reuses the persisted fixtures: admin `a`, manager `a1`, rep `b1`, other-org admin `c1`. It creates its own batches.
- Test names are listed in section 4. Plus:
  - **14-row happy-path fixture**, one case per row: valid; name missing (problem row); email repeat (case and space); phone repeat (+33 / 0 / 0033); name+city repeat with no contact (accents and S.A.R.L.); a no-contact row before a contact row (keeper = the contact row); existing match by email, by phone and by name; other-org owner (`owner_unknown`); a future date staged directly (`date_out_of_range`); a CJK name (no false match); "!!!" (no name key); a row repeating a *rejected* row (imported).
  - Asserts: exact `outcome`, `match_key` and `match_row_no`; leads carry `import_batch_id`, owner and org; `last_activity_at` converted from Europe/Paris including the DST gap; reps see the leads; `imported + duplicates + rejected = row_count`.
  - Key-function tables: emails; phones (including multi-number cells and fewer than 8 digits); names (Łódź, legal forms only, punctuation, city required).
  - `import_reimport_same_file_adds_zero`; `import_last_activity_moves_forward` (a later activity moves the date forward).
- **`supabase/tests/import_concurrency.sh`** (`db-test.sh` and `db.yml`): two psql sessions for `import_parallel_commits_insert_once` and `import_rollback_waits_for_new_contact_and_keeps_lead`.
  - In the second: session 1 inserts a contact and sleeps 2 s before committing; session 2 runs a rollback chunk meanwhile. The lead must be kept.
- **Mutation runs** recorded in `docs/evidence/day3b/mutations.md`; each must fail at least one check:
  1. remove `has_recent_aal2` from the staging insert policy
  2. remove `is_admin` from `companies_import_columns`
  3. remove the `committing` check there
  4. remove the org check from the batch select policy
  5. `grant update (imported)`
  6. drop the guard trigger
  7. remove `row_no ≤ last_row_no`
  8. drop the one-writer index
  9. remove the activities `not exists` from untouched
  10. remove the deals `not exists`
  11. remove statement B's recheck
  12. remove the late-duplicate probes
  13. remove the uploader check in commit
  14. remove the stage pre-check
  15. remove the minimal-audit branch
  16. skip the purge at imported
  17. remove the counter recount at `->imported`
  - The e2e REST check catches a mutation that moves staging into `public`.

**B) Playwright end-to-end** (CI `auth-journey` on the real local Supabase stack; add `import` to the WebKit `testMatch` for the main journey)
- E2e users: Haider Test (admin), Henri Test (admin), Kais Test (rep).
- `tests/auth/import.spec.ts`:
  1. `import_existing_20`: open from the Leads toolbar; import `existing-20.csv` (auto-mapped) → 20 added.
  2. `import_sample_500`:
     - every field auto-matched;
     - map "Hot lead"→Warm and "Prospect"→Cold; "Former Rep"→Unassigned and "Atlantis"→Leave blank preselected; DD/MM detected;
     - tiles equal `expected.json` (400 / already 20 / repeated 30 / can't 50);
     - the problems CSV downloaded and parsed: 100 rows, EN reasons, `'` on formula and `+33` cells, row numbers match;
     - Import → "400 leads added"; leads count +400; an imported lead shows the sheet's date and time;
     - request bodies for problem rows carry no values.
  3. `reimport_problems_file`: `Row` and `Problem` are ignored automatically; result "Nothing new to import" (50 can't import, 50 already in CRM) → Discard.
  4. `undo_keeps_worked_on`: Kais logs a call on lead X, Henri adds a contact on Y, Haider changes Z's owner. Undo preview "remove 397, keep 3" → count back to 23 → badge "Undone · 3 kept".
  5. `french_cp1252_other_header`: Windows-1252 notice, `;` detected, French headers reordered plus a "Notes" column auto-mapped, "Chargé de compte" mapped by hand, accents correct, 20 added; then Undo.
  6. `resume_after_aborted_commit`: a generated 2,500-row fake file in a temp folder; `page.route` aborts the 2nd commit request; reload → Paused → Resume → exactly 2,500; Undo.
  7. `xss_name_is_text`, injection names verbatim (part of the sample).
  8. `phone_390_flow` (existing-20 flow at 390: sticky bar, `scrollWidth === clientWidth` on every step).
  9. `keyboard_only`.
- `tests/auth/import-security.spec.ts`:
  - `rep_gets_404_and_no_entry_points`
  - `rep_direct_rpc_403` (rep JWT → `/rest/v1/rpc/create_lead_import`)
  - `staging_not_exposed` (404, 406, or the local gateway's 404; never rows)
  - `step_up_dialog_flow`: local-only `expireStepUp(page)`, guarded like `env()`, back-dates `auth.mfa_amr_claims.updated_at` by 15 minutes and back-dates `expires_at` in the auth cookie so the next request refreshes. Then Check opens the dialog, a wrong code shows the error, and the right code (`totp()` after `nextWindow()`) continues with a newer amr.
  - `wrong_code_message`, `rate_limited_message`, `error_copy_has_no_sql`, `xlsx_empty_too_many_rows_messages`, `no_console_errors_no_csp_violations`
- Screenshots of every step, both dialogs and history, at 1280/1440/1728/390 plus 768/1024, light and dark, EN and FR → `test-results/import-screens`.

**C) Unit tests with Playwright only**
- New `playwright.unit.config.ts` (`testDir: tests/unit`, no webServer, no page fixture so no browser starts), script `test:unit`. Added to the `ci.yml` quality job and to `npm run verify`.
- Specs:
  - `headers.spec`: Haider's exact header, French, shuffled, HubSpot `Country/Region`, duplicate and empty headers, `Row`/`Problem` ignored.
  - `values.spec`: every status alias EN/FR/HubSpot; countries (codes, EN and FR names, aliases, unknown); owners (full, "last first", unique first, ambiguous).
  - `normalise.spec`: cell cleaning, placeholders, email, phone (letters, `E+11`, more than 40), dates (DMY/MDY/ISO with offset, times, 31/02, leap years, serials, future, pre-1990, mixed file), DST strings; both bad-field modes.
  - `schema.spec`: strict keys, 1,001 rows, control characters, codes.
  - `chunk.spec`: at most 1,000 rows and 750 KB with multibyte text.
  - `csv-out.spec`.
  - `parse.spec`: `;` detection, quoted newlines, extra columns, `sep=;`, BOM, `__proto__` header, quote error row number, accented text across a tiny `chunkSize` with no U+FFFD, Excel row numbers with blank and multi-line rows.
  - `parity.spec`: TS problem, fix and reason codes and statuses equal the migration's lists; `STEP_UP_SECONDS === 600` is in the SQL.
  - `sample.spec`: every row of the 500 sample normalises to its `expected.json` label and passes the Zod schema.

**D) The fake sample.** `scripts/make-fake-leads.mjs` (seeded, deterministic; `--rows N --out DIR` for perf files, never committed) writes `tests/fixtures/import/`:
- **`leads-500-fake.csv`**: Haider's exact header `Company name,Company owner,Phone Number,Email,Lead Status,Last Activity Date,City,Country/Region`, UTF-8 BOM, comma, 500 data rows plus 3 blank lines (`last_row_no` 504).
- Fake data only: invented names; addresses at example.com/.org/.net; fictional phones (FR 01 99 00 xx xx, 06 39 98 xx xx; UK 020 7946 0xxx, 07700 900xxx; US 555-01xx).
- **400 importable**:
  - all 7 statuses in Haider's spelling plus case and space variants, 30 blank, 3 "Hot lead", 2 "Prospect";
  - owners Haider Test, Henri Test and "kais test", 40 blank, 6 "Former Rep";
  - countries France, FR, fr, Royaume-Uni, UK, USA, États-Unis, Deutschland, Belgique, España, Côte d'Ivoire, Maroc, 25 blank, 2 "Atlantis";
  - dates 15/03/2025, 15/03/2025 14:32, 2025-03-15, 15.03.2025, 15-03-25; 10 ambiguous like 03/04/2025; 40 empty; 2 DST times;
  - 10 rows with a name only;
  - quoted commas and quotes, an embedded newline in a city, NBSP, zero-width, U+202E, a bell character, emoji, CJK, accents;
  - injection, XSS and formula-like names imported as text;
  - near misses that must import: same name in another city; same name with no city twice; two "Carrefour City, Paris" with different phones; a row repeating a rejected row.
- **30 repeated in the file**: 12 by email, 10 by phone (5 formats), 5 by name+city with no contact (accent, case, S.A.R.L., punctuation), 3 no-contact rows placed before a contact row of the same name+city.
- **20 already in the CRM** (against `existing-20.csv`): 10 by email, 5 by phone, 5 by name+city.
- **50 can't be imported**:
  - 10 missing names (blank, spaces, NBSP, zero-width; one with a `+33…` phone);
  - 3 names over 200 characters;
  - 12 bad emails (4 with formula names `=HYPERLINK("http://example.invalid")`, `+SUM(1,1)`, `-2+3`, `@cmd`);
  - 8 bad phones (`ext 12`, letters, `3.36E+11`, `6.12345678E+8`, 41 characters, `12345`, …);
  - 11 bad dates (31/02/2024, 32/01/2023, 00/00/0000, 12/2023, 2024-13-01, "yesterday", 3 future, 15/06/1985, 01/01/1970);
  - 3 with extra columns; 3 cities over 120 characters.
- **Expected** with `reject_row`: added 400, repeated 30, already 20, can't 50, ignored 3; fixes: `owner_unassigned` 6, `country_dropped` 2. With `blank_field`: added 434, can't 16 (unit-checked).
- Also: `existing-20.csv`, `leads-fr-20-cp1252.csv` (`;`, Windows-1252, French headers reordered plus "Notes" and "Chargé de compte"), `not-a-csv.xlsx` (magic bytes), `empty.csv`, `expected.json`.
- The real CSV never enters the session.

**E) Evidence at 30k**
- **`scripts/db-perf.sh`** runs `perf_leads.sql` and then the new `supabase/tests/perf_import.sql` on the same throwaway PG16 (30,015 existing leads; an admin whose claims carry a fresh code):
  - P1: stage 30 × 1,000 (5% existing duplicates, 2% in-file, 1% problems, 1% no-contact name rows), average and maximum.
  - P2: validate, with auto_explain. Expect index-only probes on `companies_*_key_idx` or a hash join, and no unindexed nested loop over staging.
  - P3: one issues page.
  - P4: commit 30 chunks (average, maximum, total; one chunk's plan) with 281 team-added late duplicates, which must be skipped.
  - P5: 100 leads touched.
  - P6: preview, then rollback in chunks of 2,000; kept must equal 100.
  - P7: 50,000-row batch: stage, validate (under 3 s), discard.
  - P8: Day 3a list cases 1–5 re-timed against `docs/evidence/day3a/perf.md`.
  - Pass: every call under 2 s; validate under 3 s at 50k; the whole 30k flow under 20 s of database time.
  - Three runs go into `docs/evidence/day3b/perf.md`.
- **Browser**: `tests/auth/import-perf.spec.ts` (runs only with `PERF=1`, Chromium, local) generates a 30k fake file in a temp folder and records:
  - parse and normalise time at 4× CPU throttling (CDP);
  - the longest task (must be under 200 ms);
  - every action body under 1 MB;
  - end-to-end under 90 s.
  - Results go into `perf.md`.

## 7 Dependencies

- **papaparse 5.7.0** (runtime, exact pin). Published 24 Aug 2026 (47 days ago), MIT, no dependencies, npm signatures present (checked with `npm view`). It is already named in the Master Plan stack. Used only with `header:false` on a string and `chunk` plus pause/resume; it is not used for writing.
- **@types/papaparse 5.5.2** (devDependency, exact pin). Published 13 Dec 2025; papaparse ships no types.
- Check papaparse with Context7 before coding (string streaming, pause/resume, delimiter guessing, error types). Run `npm audit signatures` and `npm audit` after installing.
- **Deliberately not added**: libphonenumber-js (phones stay as written; keys are made in SQL), a date library (own parser plus Intl, and `AT TIME ZONE` in SQL), SheetJS/xlsx (CSV only), a CSV writer (`csvCell` is about 20 lines and unit-tested), a Web Worker (it would need a CSP change), a unit test runner (Playwright runs the pure tests).

## 8 Build order (one PR, small commits)

1. **Local gateway**:
   - send RPC arguments through stdin as a dollar-quoted literal with a random 16-byte tag (refuse if the value contains it), instead of `psql -v` (Linux caps one argument at 128 KB);
   - forward the `HINT:` line into the JSON `hint`;
   - smoke test with a 700 KB call.
2. Read-only MCP check on dev: `select status, count(*) from import_batches group by 1` (expect no rows). Log it.
3. **Migration part 1**: key functions (inline fold), `lead_db_problem`, companies key columns and indexes, `audit_row` (key stripping plus the minimal branches). Run `db-test.sh` (`rls_attack` must pass unchanged) and `db-perf.sh` (no list regression).
4. **Migration part 2**: `import_batches` columns, checks, indexes, grants, policies, guard trigger.
5. **Migration part 3**: staging table, RLS, grants; `companies_import_columns` and the insert grants; `lead_import_untouched`.
6. **Migration part 4**: helper and the 9 RPCs, plus the revoke/grant loop.
7. `import_attack.sql` and `import_concurrency.sh`; wire them into `db-test.sh` and `db.yml`; run the mutations and write `mutations.md`.
8. `perf_import.sql` plus the `db-perf.sh` extension; 3 runs → `perf.md`. Split validate only if it misses 3 s at 50k.
9. Splinter locally; record the advisor output.
10. Install papaparse and its types (Context7 first).
11. `src/lib/import/` (`rules`, `parse`, `headers`, `values`, `normalise`, `schema`, `chunk`, `csv-out`); `playwright.unit.config.ts`; unit specs; `test:unit` in `ci.yml` and `verify`; ESLint `no-console` override for the import paths.
12. `requireAdmin` and `stepUpSecondsLeft` in `src/lib/auth.ts`; `verifyStepUp` action; `step-up-dialog.tsx`.
13. Import server actions (`src/app/(app)/leads/import/actions.ts`, error map) and `GET /api/imports/[id]/issues`.
14. UI: `page.tsx` and `loading.tsx`, `src/components/import/*` (wizard steps, history, undo dialog, progress); entry points (toolbar, Cmd+K via the layout's `isAdmin`, admin empty state); `Import` and `StepUp` messages in EN and FR.
15. `scripts/make-fake-leads.mjs` and the fixtures; `expected.json`.
16. E2e specs; WebKit `testMatch`; run locally on Chromium, then CI.
17. Screenshots and the DESIGN.md pass; `/apple-design` and web-design-guidelines audits; fixes.
18. `deploy-dev-db.yml`: after `config push`, prove the dev API exposes only `public` (Management API PostgREST config), as the sign-up proof does.
19. `/security-review`, gitleaks, npm audit, Semgrep, lint, typecheck, full Playwright; evidence bundle in `docs/evidence/day3b/`; decisions in `docs/log.md`.
20. `advisor` subagent loop until APPROVED; REPORT (START_HERE section H) with "What I need from you" (preview check with the 500-row sample; the questions below).

## 9 Open questions for Haider (recommendation first)

1. **Rows with a bad email, phone or date: skip the whole row** and list it in the problems file, which re-imports cleanly once fixed (recommended; this is the Master Plan wording). The alternative is to import the lead without that field. It is a one-line switch.
2. **Duplicates by name**: count two rows as the same company only when the name, city and country match *and* the row has no email or phone of its own (recommended; chain stores in one city with different phones stay separate). The alternative is to match on name + city always.
3. **An import never changes leads already in the CRM**: duplicates are skipped, never merged or filled in (recommended).
4. **Undo**: keep every lead someone worked on (call, note, contact, deal or any change, including a new owner), with no time limit. Any admin may undo; only the person who started an import can continue it. OK?
5. **Dates in your export**: day first (31/12/2024), in Paris time, and a date without a time counts as midnight Paris? Please confirm.
6. **Before the real import (Day 8)**: Henri and Kais sign in once and set their names, so the owner names in the sheet match. Otherwise their leads come in unassigned and you reassign them in bulk.

## 10 Deferred (out of scope, with reason)

- **Real 30k import and free-tier timing**: the first step of Day 8 is a fake 30k run on dev through the preview. It needs Haider's browser because of Vercel Authentication. Today's evidence is local PG16 timings with 4× headroom.
- **Owner round-robin or territory assignment** (Master Plan 7.7): owners come from the sheet or Unassigned; bulk reassign already exists.
- **Time zone from country** (7.8): there is no timezone field on leads yet; it belongs with the Day 4 work queue.
- **Contacts import** (7.6): Haider's sheet has no contact-person columns.
- **Merging or upserting duplicates**: skip only (question 3); merging would make Undo unsafe.
- **E.164 phone rewriting and libphonenumber** (7.4): Day 3a decided phones stay as written; dedupe uses the last 9 digits.
- **Domain-based dedupe** (7.4): no website column in the sheet; name + city replaces it.
- **A separate `source` field**: `import_batch_id` plus the audited batch records each lead's origin.
- **XLSX import**: CSV only, with a "save as CSV" message.
- **Web Worker parsing**: chunked main-thread parsing keeps the CSP unchanged.
- **A "from this import" filter on the leads list**: it would change Day 3a's approved `list_leads`/`count_leads` signatures; "See newest leads" covers it.
- **Removing worked-on leads in Undo**: deliberately never offered, because it would delete the team's work.
- **Keeping problem details after the import**: not stored (privacy). Download at Check.
- **Stock-sheet import** (Day 6): reuses `import_batches`, the guard trigger and the step-up dialog, with its own staging table.