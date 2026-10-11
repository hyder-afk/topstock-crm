# Day 4 final design: lead page, timeline, tasks, work queue, files

> **How this was produced (11 Oct 2026).** A design workflow wrote three independent designs: security-first, data/performance-first and owner-UX-first. Three judges scored them, and all three picked the **security-first design**. This document starts from that design and adds the ideas the judges listed from the other two:
> - from the data design: queue ranking that leaves out leads with no number, a precise "wrong number" mark, a file check on every open, checks for generic query plans, a lock order with a deadlock test, Merge Append for "Mine + unassigned", and the audit volume budget;
> - from the UX design: digit keys read through `event.code` (AZERTY), `dialString` for `tel:` links, a call panel that survives navigation, "How did it go?" after a phone call, J/K between leads, hand-built tabs and two time zones on time labels.
>
> Every risk the judges raised is answered in 2.3. Where the designs disagreed, 2.2 says which option won and why. The repo facts were re-checked at `1d2ea64`, where Day 3b is merged as `4fe5641`. Builder change on top of the judges: the PR split is **four PRs**, with a small database-hardening PR first. The judges asked for that because the winning design's first PR was too large.

## 1 Summary (plain words)

**What the team gets**

1. **A full lead page** at `/leads/<id>`, laid out like the reference.
   - Header: company name, status, owner, phone, email, city and country, the lead's **local time** ("14:05 in Lyon · good time to call"), and the next call date.
   - Quick actions: **Call** (red), WhatsApp, Email, Meeting, Note.
   - Tabs: Summary, Timeline, Deals, Stock, Files, Details. Deals and Stock show a calm empty state until Days 5 and 6.
   - The leads list preview gains "Open lead". On phones, tapping a lead opens the full page.
2. **A timeline** of calls, emails, WhatsApp messages, meetings and notes, newest first, 30 at a time.
   - A **composer** logs any of them.
   - Email opens the mail app and WhatsApp opens `wa.me`. Each is then logged with one tap.
   - Notes can be edited by their author only. Deleting asks for a fresh authenticator code.
3. **A call panel** (prototype behaviour) opens when someone presses Call, with a timer and the outcome buttons. It stays open while the person moves around the app. On a phone, coming back from the call shows "How did it go?".
4. **Call outcomes**: 1 No answer, 2 Voicemail, 3 Wrong number, 4 Not interested, 5 Interested, 6 Book meeting, 7 Do not contact, and 0 Spoke.
   - Each outcome writes the call to the timeline, changes the status when it should, creates the follow-up task, and decides when the lead comes back.
   - Undo works for 2 minutes. It puts the lead back exactly as it was, unless a colleague changed it in the meantime.
5. **Tasks** at `/tasks`: Overdue, Today, Upcoming and Done.
   - Quick add with date chips (Today, Tomorrow, Next week, Pick a date).
   - "Today" follows each person's own time zone, so Haider's "Today" is Karachi's today.
6. **The work queue** at `/leads/queue` shows one lead at a time, best first.
   - Order: follow-ups due, then Negotiation, Warm, retries, then first calls.
   - It only offers leads where it is a **working hour on their side** (Monday to Friday, 09:00 to 18:00 their time).
   - It never offers Do not contact, Disqualified or Customer leads, or leads with no number that works.
   - Outcome keys work on French keyboards. The next lead appears at once.
   - When Haider, Henri and Kais work at the same time, each lead goes to exactly one of them.
7. **Files** on each lead: PDF, PNG, JPG, Word and Excel, up to 10 MB each and 800 MB for the team.
   - Files sit in a private store.
   - Every file is checked to be what it claims, when it is uploaded **and again every time someone opens it**.
   - Links last 60 seconds and never appear in the page.
   - Deleting a file asks for a fresh code.

**How local time works.** A lead's local time comes from its country.
- Countries with one time zone (France, the UK, the rest of the EU) are exact, and every imported lead is covered on day one.
- For countries with several zones (US, Canada, Australia…), the queue calls only when it is office hours across the whole country. In the US that is 12:00 to 18:00 New York time. This lasts until someone picks the lead's zone on its Details tab.
- Changing a lead's country resets a hand-picked zone automatically.

**Protections**
- The database now forces the author of every entry to be the person signed in. Only the text of an entry can change later.
- Deleting a contact no longer erases its call history.
- The audit log no longer keeps a second copy of note text.
- Queue claims and undo records sit in a private schema with no API endpoint.
- Every rule holds even when someone calls the database directly with their own login.

**Proof**
- Database attack tests, each shown to fail when its protection is removed (mutations).
- Two- and three-session concurrency tests.
- Unit tests, and end-to-end tests in Chromium and WebKit.
- Timings at 30,000 leads and 300,000 activities.

**Four PRs**, each with its own migration, attack test file, evidence folder and advisor loop:

| PR | Contents | Why separate |
|---|---|---|
| **4a Activity hardening** | Database only: authors forced, history protected, contact and deal deletes keep history, column grants on activities and tasks, task columns, audit masking, import "untouched" rule, test fixtures | No screens. It changes rules that the Day 3 tests depend on, so it gets a short, focused review before anything is built on it |
| **4b Lead page** | Zone map, lead time zone, next call, wrong-number marks, the lead page, timeline, composer, notes, call panel, outcomes, Undo, the lead's tasks card | Everything on one lead |
| **4c Tasks and work queue** | Queue ranking, claims, the queue page, the Tasks page, profile time zone | Concurrency, the one new kind of risk here |
| **4d Files** | Private bucket, Storage policies, upload, check-on-open, delete, quota | The largest new attack surface, and the least needed for calling. It ships last, alone, after its storage spikes |

**Changes from the winning design** (each comes from a judge's finding):
1. Database checks that run when an entry is added or changed (**guard triggers**) now let a deleted contact, deal or call clear its link to null. Before, deleting a contact or undoing a call would have failed with 42501.
2. A country change clears a hand-picked time zone first. The time-zone CHECK can then never fire with lead data in the Postgres log.
3. The next-call date limit applies only when the value changes, so overdue leads stay editable.
4. Leads with no working number get no queue rank. A Cool off lead with no date gets no rank either. Moving a lead to Cool off without a date sets a return in 90 days.
5. The no-code delete inside the undo window works only through `undo_activity`. It is not a direct API delete.
6. `tasks.source_activity_id` is in the insert grant and checked by the guard, so `log_activity` works.
7. The file quota counts real stored bytes. It does not trust the size the client declares.
8. Claims last 10 minutes with renewal, at most 3 per person, and are released when the tab closes.
9. Undo-record clean-up works. The design's policy hid exactly the rows it tried to delete.

## 2 Decisions

### 2.1 Facts checked in the repo (at `1d2ea64`)

**Gaps that exist today** (the winning design's G1 to G7, all confirmed):

| # | Gap | Where |
|---|---|---|
| G1 | An admin or manager can log an activity as any org member | `activities_insert` has a manager exception (`20261010090000` line 231). `enforce_org_and_owner('user_id')` leaves `user_id` as sent, or null when an admin sends none |
| G2 | Activity rows can be rewritten | Table-wide `insert, update` grant on activities (`20261009180000` line 452) |
| G3 | Every task column is written by the client | Same grant line covers tasks, including `done_at` and `assignee_id` |
| G4 | The client writes `files.storage_path`, which is unique across orgs | Core schema, `files` table |
| G5 | Deleting a contact deletes its activities, tasks and files | `on delete cascade` on `contact_id` in all three (core schema) |
| G6 | The audit log copies whole activity rows, note text included | `private.audit_row` (`20261010150000`) |
| G7 | Import Undo's "untouched" rule and its test know only activities, contacts and deals | `private.lead_import_untouched`; the `import_fk_coverage` check (`import_attack.sql` around line 139) compares `conrelid::regclass::text`, so a private table prints as `private.queue_claims` |

**Other facts the design relies on:**
- **Last activity.** Day 3a's rule is "deleting an activity leaves the date as it was" (`20261010090000` line 130). This design changes it (decision D9, open question 12).
- **Admin delete fixture.** `rls_attack.sql` around line 609 has an admin with a fresh code delete lead `mine`. Its contacts and activities cascade.
- **Old test fixtures.** `rls_attack.sql` fixtures insert tasks and files by `contact_id`, and insert a `call` with no outcome and a `deal_id` (line 305). Section 3b updates `updated_at` on tasks and files (line 251), and section 3d inserts an activity with `created_at`. All of these change with the column grants (build order, 4a).
- **API and storage config.**
  - `config.toml`: `[api] schemas = ["public"]`, so `private` has no REST endpoint.
  - `[storage.s3_protocol] enabled = true`. S3 keys bypass RLS; 4d turns it off.
  - `[storage] file_size_limit = "50MiB"`.
- **CI.** `storage-api` is excluded in `ci.yml:72` (auth-journey) and `db.yml:27`.
- **CSP** (`src/proxy.ts`): `connect-src` includes the Supabase origin, so direct uploads work. `img-src 'self' blob: data:`, so there are no remote image previews.
- **Next 16.4** (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md` line 28): "Next.js dispatches Server Actions one at a time per client."
- **Existing app code.**
  - `src/lib/leads.ts` has `telHref` (digits as written) and `mailHref` (percent-encoded).
  - The Day 3a status menu writes through `bulk_update_leads` (`setLeadsStatus` in `src/app/(app)/leads/actions.ts`).
  - The step-up dialog (`useStepUp().ensureFresh`) and the e2e helper `ageStepUp` exist.
  - There is no `tabs.tsx` or textarea component.
  - The profile form has no time zone field. `profiles.timezone` is granted but checked only for length.
  - `goKeys` uses h, l, p, i, t, a and m, so `G then Q` is free.
- **Generated columns.** Day 3b's spike showed a stored generated column needs EXECUTE on its function for the inserting role (`grant` at `20261010150000` line 108). It also showed PG16 recomputes such a column only when a base column is in the UPDATE.
- **Time zone data.** `/usr/share/zoneinfo/zone1970.tab` lists 33 countries with more than one zone.
- **Pinned versions:** `@supabase/supabase-js` 2.117.3, Supabase CLI 2.120.0, `motion` 14.0.0, `@tanstack/react-virtual` 3.14.13.

### 2.2 Where the designs disagreed, and what we chose

| # | Topic | Chosen | Rejected | Why |
|---|---|---|---|---|
| D1 | PR split | 4 PRs: hardening, lead page, queue and tasks, files | 3 PRs (all designs) | Judges: the first PR was too large and advisor loops would drag. The hardening PR has no UI, so it reviews fast |
| D2 | Undo | Server-side, 120 s, own entries, compare-and-restore (security) | 5-second deferred commit with a browser outbox (data) | The deferral can lose an outcome on a crash or in a second tab. Teammates would not see a call for 5 s. Two judges said not to graft it |
| D3 | Queue hot path | One combined server action per key press (`logOutcomeAndClaim`), so serial dispatch costs nothing. A keepalive route handler releases claims on `pagehide`. Measured switch rule: if p95 "key to outcome saved" goes over 400 ms or the buffer empties in the 10-key test, move `claim`/`log` to POST route handlers with `assertSameOrigin` | Route handlers for everything (data) | Server actions carry Next's Origin check for free. One dispatch per key never queues behind another. The rule keeps data's fix ready |
| D4 | Time zone storage | Explicit `companies.timezone` (multi-zone countries only) plus a generated `call_zone` key (security). The country-change trigger clears the zone (data's rule) | Zone worked out at query time (UX); city and region tables (data) | Leakproof `= any(array)` filtering needs a stored key. City lists wait for open question 11 |
| D5 | Queue rank | Security's ranks (0 Negotiation, 1 Warm, 2 retry or due, 3 first call), plus data's rule "no working number → no rank". Cool off without a date → no rank. Walked one rank at a time, so "due" is an index range | Tier by status only (data); top-N sort (UX) | Leads with no number never enter the index (judges' graft). A per-rank walk stops at `now()` instead of passing every future retry |
| D6 | Wrong number | Mark the dialled number (`phone_wrong_at` on the company or the contact). The mark clears itself when the number changes. It is set only in `log_activity`'s editor branch | +30 days on the lead (security); a definer activity trigger (data) | Precise, and fixing a number brings the lead back. Data's trigger let any org member pull a colleague's lead out of the queue |
| D7 | Outcomes | 7 keys (Master Plan's 6 + Do not contact), plus 0 Spoke (the existing `connected` outcome, with an optional follow-up) | A separate "Call back" outcome (data, UX) | Judges called 8 outcomes scope creep. "Spoke + follow-up time" covers call-backs with no new concept |
| D8 | Audit of activities | Inserts not copied (the row is its own record: author and time server-set, only the text editable). Updates and deletes audited with the body replaced by its length | Masked insert rows (security); full copies (today) | Privacy (no second copy of notes) and the 500 MB free-tier budget (3.5) |
| D9 | Last activity on delete or undo | Moves back to the newest remaining entry, or the date before this entry (security), using the trigger-set `prev_last_activity_at` | Unchanged (Day 3a rule); left moved forward (UX) | An undone call must not leave a date with no call behind it. Logged as a decision; open question 12 |
| D10 | Task dates | `due_date date` for all-day tasks plus `due_at` for timed ones (security) | `all_day` with a midnight instant (data, UX) | A calendar date never shifts a day between Paris and Karachi |
| D11 | Visibility of tasks and files | As today: the assignee or uploader, the creator, the lead's owner (files), managers and admins (security; plan item 6; `rls_attack` 3b) | Lead tasks and files visible to the whole team (data, UX) | No change to a tested rule without Haider. All three users are admins, so today everyone sees everything. Open question 7 |
| D12 | Tabs component | Hand-built WAI-ARIA tabs in `src/components/ui/tabs.tsx` (UX) | `@radix-ui/react-tabs` (security) | No new dependency, and consistent with the hand-built dock |
| D13 | Long timelines | `content-visibility: auto` with `contain-intrinsic-size` per entry (data). TanStack Virtual only if the 1,000-entry scroll test misses 60 fps | Virtualising from 100 entries (security) | Entries vary in height. This keeps the find bar and screen-reader order working, with zero JavaScript |
| D14 | Call script | Static text in `messages/*.json` (EN and FR), collapsible | `call_scripts` table with admin editing (data, UX) | Judges: scope creep. Haider can send his script (open question 9) |
| D15 | Phone layout of the lead page | No sticky bar. The Note action opens the composer sheet | A sticky "Log activity" bar above the dock (security) | The dock owns the bottom of the screen |
| D16 | Files tab before 4d | Hidden until 4d merges | An empty tab saying "next update" | No placeholder UI for something days away |
| D17 | Extras | Kept: J/K between leads, Back restores filters and scroll, draft per lead, "Henri is on this lead", the "Show leads outside calling hours" escape, a lunch switch. Deferred: Cmd+K lead search, dock badge, "Work these" from list filters, "Callable now" list filter, snooze key, status rows in the timeline | | The deferred items either change approved Day 3 signatures (`list_leads`) or add optional filters that break the queue's index walk and plan discipline. Section 12 |

### 2.3 Judges' risks and where each is handled

| Risk raised | Handled in |
|---|---|
| Timezone CHECK fails with lead data on a country change | `lead_guard` clears the zone on a country change and pre-checks a set zone with a constant error. The CHECK is a backstop that cannot fire (3.2). Test `country_change_clears_zone`, `timezone_bad_constant_error` |
| Next-call limit makes overdue leads uneditable | Upper limit only, checked only when the value changes. Undo restores without a limit problem (3.2). Test `overdue_lead_still_editable` |
| `source_activity_id` missing from the insert grant | In the grant. The guard requires the caller's own activity, under 10 s old, on the same lead (3.1). Test `log_activity_creates_task_as_invoker` |
| Guard triggers against ON DELETE SET NULL | The guards allow FK columns to become null only at `pg_trigger_depth() > 1` with every other column unchanged (3.1). Spike S5. Tests `contact_delete_keeps_activities`, `lead_delete_with_contact_activities`, `undo_with_touched_task`, `deal_delete_keeps_activities`. A mutation removes the exception |
| Storage unknowns (metadata keys, amr in Storage policies, CI schema, Range) | Spikes S1 to S4, done first in 4d, each with a decision rule (2.4) |
| Quota trusts the declared size | Quota sums real `storage.objects` sizes under the org prefix, plus pending reservations (5.7) |
| Server byte check can be skipped | Check on every open in `/api/files/[id]` (5.7) |
| 120 s no-code delete window through PostgREST | The no-code branch requires that no undo record exists. `undo_activity` consumes the record first, so outcomes can only be undone through it. Direct inserts (no lead changes) can be removed (3.2) |
| First PR too large | 4 PRs (D1) |
| Private functions in generated columns and CHECKs | `queue_rank` uses no function. `call_zone` and `zone_fits_country` get `grant execute … to authenticated`. Zone-map change procedure in 3.3. Check query `call_zone_matches_map` |
| Visibility of files and tasks | Unchanged; open question 7 (D11) |
| Fixture and FK changes; lead delete with files | Listed per PR (section 10). A lead delete with files gives 23503, and the UI says "Delete this lead's files first". Lead delete UI deferred |
| Masked note bodies cannot be recovered | Open question 13 (for Haider's information) |
| Closed laptop holds claims | At most 3 claims, 10 minutes, renewed only while visible and in use, released on `pagehide` (5.4) |
| Leads with no phone at the head of the walk | No rank, so not in the index (D5) |
| Cool off with no date served at once | No rank without a date. Entering Cool off without a date sets +90 days. The status menu asks "Until when?" (3.2) |
| Generic plans | Every hot RPC run 10 times, with plans 6 and later logged. `force_custom_plan` where an ordered scan is lost (8.6) |
| Server actions run one at a time | D3 |
| Last-activity semantics | D9, log line, open question 12 |
| AZERTY | `event.code` for digits (7.7) |
| Dialling from Karachi | `dialString` for `tel:` and `wa.me` (5.2) |
| Free-tier budget | 3.5, plus a Gate 1 size query. Day 3b import and undo re-timed (P7) |
| Deadlocks, replays, two tabs | Lock order contact then lead; `request_id` per author; tests in 8.2 |

### 2.4 Facts to prove before building on them (spikes)

| # | When | Question | Decision rule |
|---|---|---|---|
| S5 | 4a, first commit | On PG16: (a) ON DELETE SET NULL fires BEFORE UPDATE row triggers on the child at `pg_trigger_depth() = 2` with the session's claims still set; (b) `SELECT … FOR UPDATE` under RLS returns no row, and no error, when the UPDATE policy fails; (c) `INSERT … ON CONFLICT (pk) DO NOTHING RETURNING` under RLS checks only INSERT policies | (a) is the guard exception's premise: if it fails, the guards compare against `TG_LEVEL` instead and the design is revisited. If (b) fails, `log_activity` uses an explicit editor check. If (c) fails, claims use a two-step insert with `exception when unique_violation` |
| S1 | 4d | Without `storage-api`, does the CI image have `storage.buckets.file_size_limit` / `allowed_mime_types`? Do project migrations run after storage's own? | If not, enable `storage-api` in `db.yml`. If migrations still run first, the bucket row moves to `config.toml [storage.buckets.lead-files]` plus seeding, and policies stay in the migration behind `to_regclass('storage.objects')` |
| S2 | 4d | Does storage-api forward the full JWT (with `amr`) as `request.jwt.claims`, so `has_aal2` and `has_recent_aal2` work in `storage.objects` policies? | If not, the step-up for delete stays in `files_guard_update` (database), and the Storage delete policy requires a `deleting` row only. Proved by e2e `file_delete_needs_fresh_code` |
| S3 | 4d | Do signed URLs honour `Range`? | If not, check-on-open streams the body and stops after 8 KiB (PDF, PNG, JPEG) or reads the whole file (≤ 10 MiB, Office files) |
| S4 | 4d | `storage.objects.metadata` keys (`size`, `mimetype`) on the pinned image, and whether they are written before or after the RLS insert check | The ready guard and the quota read these keys. If they are written after insert, the ready guard (run at finish) still works. If the keys differ, use the real names |

## 3 Data model and migration outline

All new functions use `set search_path = ''`. Every RPC is SECURITY INVOKER with static SQL: no `format()` and no `EXECUTE` with user text. Definer code is limited to trigger functions, which clients cannot call, plus one private audit helper in 4d. Server-kept columns are set by BEFORE triggers; Day 3b's spike showed these need no column privilege. Clients get column grants only. Every CHECK that could fire on user input has a pre-check with a constant message first, so "Failing row contains …" never reaches the log.

**Before each migration**, the builder runs a read-only MCP check on dev and logs it:
- `select count(*) from activities`, then tasks, then files: expect 0;
- `select type, outcome, count(*) from activities group by 1, 2`.

### 3.1 4a: `supabase/migrations/20261011120000_activity_hardening.sql` (database only)

**Activities (G1, G2, G5)**
```sql
alter table public.activities
  add column request_id uuid,                   -- idempotency key from the browser, unique per author
  add column edited_at timestamptz,             -- set by trigger when the text changes
  add column prev_last_activity_at timestamptz, -- the lead's date before this entry; trigger-set, never granted
  drop constraint activities_outcome_check,     -- was char_length <= 60
  add constraint activities_outcome_fits_type check (
       (type = 'call' and outcome in ('no_answer','voicemail','wrong_number','not_interested','interested',
                                      'meeting_booked','do_not_contact','connected'))
    or (type in ('email','whatsapp') and (outcome is null or outcome = 'sent'))
    or (type = 'meeting' and (outcome is null or outcome in ('held','no_show')))
    or (type = 'note' and outcome is null)),
  -- tab and newline only; no other C0 controls, DEL, or bidi overrides (a note cannot reorder what sits next to it)
  add constraint activities_body_safe check (body is null or body !~ '[\u0001-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]');
drop index public.activities_company_idx, public.activities_user_idx, public.activities_org_user_idx;
create index activities_company_keyset_idx on public.activities (company_id, created_at desc, id desc);
create index activities_user_created_idx on public.activities (user_id, created_at desc);   -- rate guard, "my calls today", FK
create unique index activities_author_request_idx on public.activities (user_id, request_id) where request_id is not null;
alter table public.activities
  drop constraint activities_contact_id_fkey,
  add constraint activities_contact_id_fkey foreign key (contact_id) references public.contacts (id) on delete set null,
  drop constraint activities_deal_id_fkey,
  add constraint activities_deal_id_fkey foreign key (deal_id) references public.deals (id) on delete set null;
revoke insert, update on public.activities from authenticated;
grant insert (company_id, contact_id, type, outcome, body, request_id), update (body) on public.activities to authenticated;
-- deal_id returns to the grant on Day 5, with a policy that requires the deal to belong to the same lead.
```

**`private.activity_guard()`** (SECURITY INVOKER, BEFORE INSERT OR UPDATE). Its name sorts before `enforce_org_and_owner` and `set_activity_time`. It skips sessions with no `auth.uid()` (fixtures, maintenance), as Day 3a does.
- **INSERT:**
  - `new.user_id := auth.uid()` (G1) and `new.edited_at := null`;
  - `new.prev_last_activity_at := (select last_activity_at from public.companies where id = new.company_id)`;
  - CRLF in the body becomes LF;
  - pre-checks, each 22023 with a constant message: body ≤ 10,000 characters (hint `body_too_long`), safe characters (`body_chars`), outcome fits type (`outcome`);
  - rate guard: more than 60 inserts by this author in the last 60 s gives 22023 hint `rate_limited`. It is one range read on `activities_user_created_idx`, with `limit 61`.
- **UPDATE:**
  - *FK exception:* if `pg_trigger_depth() > 1`, every changed column is one of `contact_id`, `deal_id`, `user_id`, and each changed value is null, return `new`. This is a referential SET NULL from a contact, deal or profile delete.
  - Otherwise, if `to_jsonb(new) - '{body,updated_at}'` differs from the same for `old`, raise 42501 hint `not_editable` ("only the text of an entry can change").
  - Otherwise `new.edited_at := now()` and run the body pre-checks again.

**Policies** (replace Day 3a's insert and update; select stays org-wide; `require_mfa` stays):
```sql
create policy activities_insert on public.activities for insert to authenticated with check (
  org_id = (select private.current_org_id()) and user_id = (select auth.uid())         -- no manager exception (G1)
  and exists (select 1 from public.companies c where c.id = activities.company_id)
  and (contact_id is null or exists (select 1 from public.contacts k
       where k.id = activities.contact_id and k.company_id = activities.company_id)));
create policy activities_update on public.activities for update to authenticated
  using (org_id = (select private.current_org_id()) and user_id = (select auth.uid()))  -- nobody edits a colleague's words
  with check (org_id = (select private.current_org_id()) and user_id = (select auth.uid()));
-- activities_delete stays as Day 3a (fresh code; author, manager or admin) until 4b adds the undo branch.
```

**Last activity on delete (D9).** `private.untouch_company_activity()` is SECURITY DEFINER like `touch_company_activity`, AFTER DELETE, revoked from everyone:
```sql
update public.companies c
   set last_activity_at = greatest((select max(a.created_at) from public.activities a where a.company_id = old.company_id),
                                   old.prev_last_activity_at)
 where c.id = old.company_id and c.last_activity_at = old.created_at;
```
- `prev_last_activity_at` is trigger-set and has no grant, so neither delete nor undo can move a lead's date backwards or forwards beyond the truth.
- Deleting an older entry changes nothing.
- In a lead delete cascade the update finds no row, which is harmless and tested.

**Tasks (G3, G5, G7)**
```sql
alter table public.tasks
  add column company_id uuid references public.companies (id) on delete cascade,   -- null: a personal task
  add column kind text not null default 'todo' check (kind in ('todo','call','meeting')),
  add column due_date date,                                                          -- all-day (calendar date, no zone)
  add column created_by uuid references public.profiles (id) on delete set null,
  add column completed_by uuid,                                                      -- no FK, like audit_log.actor_id
  add column cancelled_at timestamptz,                                               -- "Dismiss": reversible, no code needed
  add column source_activity_id uuid references public.activities (id) on delete set null,
  add column request_id uuid;
update public.tasks t set company_id = k.company_id from public.contacts k where k.id = t.contact_id;  -- dev: expect 0
alter table public.tasks
  drop constraint tasks_contact_id_fkey,
  add constraint tasks_contact_id_fkey foreign key (contact_id) references public.contacts (id) on delete set null,
  add constraint tasks_one_due check (due_date is null or due_at is null),
  add constraint tasks_meeting_timed check (kind <> 'meeting' or due_at is not null),
  add constraint tasks_not_done_and_cancelled check (done_at is null or cancelled_at is null),
  add constraint tasks_contact_needs_lead check (contact_id is null or company_id is not null),
  add constraint tasks_title_safe check (title !~ '[\u0001-\u001F\u007F\u202A-\u202E\u2066-\u2069]');
create index tasks_company_idx on public.tasks (company_id);                  -- FK, import undo, lead page
create index tasks_created_by_idx on public.tasks (created_by);
create index tasks_source_activity_idx on public.tasks (source_activity_id) where source_activity_id is not null;
create unique index tasks_creator_request_idx on public.tasks (created_by, request_id) where request_id is not null;
revoke insert, update on public.tasks from authenticated;
grant insert (company_id, contact_id, title, kind, due_date, due_at, assignee_id, source_activity_id, request_id),
      update (title, due_date, due_at, assignee_id, contact_id, done_at, cancelled_at) on public.tasks to authenticated;
```

**`private.task_guard()`** (SECURITY INVOKER, BEFORE INSERT OR UPDATE). It runs after `enforce_org_and_owner('assignee_id')`, which keeps reps to themselves and checks org membership.
- **INSERT:**
  - `created_by := auth.uid()`;
  - `done_at`, `completed_by` and `cancelled_at` become null;
  - an empty assignee becomes the caller;
  - title trimmed, 1 to 300 characters, safe (22023 `task_title`);
  - `due_date` and `due_at` within ±5 years (22023 `bounds`);
  - `source_activity_id`, when set, must be the caller's own activity on the same lead, created under 10 s ago (42501 hint `source`);
  - 60 inserts a minute per person at most (`rate_limited`).
- **UPDATE:**
  - the same FK exception at depth > 1 for `contact_id`, `source_activity_id` and `assignee_id` going to null;
  - `created_by`, `company_id`, `kind`, `source_activity_id` and `request_id` are immutable (42501);
  - a change of `done_at` is rewritten to `now()` with `completed_by := auth.uid()`, or to null with `completed_by := null`;
  - the same for `cancelled_at`;
  - setting one of done or cancelled while the other is set gives 22023 `state`.
  - The client can only toggle. It never chooses the time.

**Task policies** (replace `tasks_rw`; visibility as today plus the creator, D11):
- `tasks_select`: org, and (assignee = me, or creator = me, or manager/admin).
- `tasks_insert`: org; manager/admin or assignee = me; the lead is visible when set; the contact belongs to the task's lead.
- `tasks_update`: `using` is the select rule; `with check` is the select rule plus the parent checks.
- `tasks_delete`: org, `has_recent_aal2(600)` and the select rule. 4b adds the undo branch.

**Audit (G6, D8).** `private.audit_row` gains per-table rules:
- `activities` INSERT: no row.
- `activities` UPDATE: the diff shows `body: {changed: true, old_len, new_len}` instead of the text.
- `activities` DELETE: the old row without `body`, plus `body_len`.

**Import Undo (G7).**
- `private.lead_import_untouched` gains `and not exists (select 1 from public.tasks t where t.company_id = c.id)`.
- `import_fk_coverage` now expects `{activities, contacts, deals, tasks}`.
- `perf_import.sql` undo is re-timed.

### 3.2 4b: `supabase/migrations/20261012090000_lead_page.sql`

**Zone map** (literal data generated by `scripts/make-zone-map.mjs`; see 5.1). All three functions are plpgsql IMMUTABLE PARALLEL SAFE with a CASE over the generated literal, between `-- zone-map:start` and `-- zone-map:end`:
- `private.country_call_zone(country text) returns text`: the country's zone, or a span key (`US`, `CA`, `AU`, `MX`, `BR`, `ID`).
- `private.zone_fits_country(zone text, country text) returns boolean`.
- `private.lead_call_zone(zone text, country text) returns text`: `coalesce(zone, country_call_zone(country), 'Europe/Paris')`.
- `grant execute` on all three to authenticated. The generated column (4c) and the CHECK need it on every insert, including import commits.

**Leads and contacts**
```sql
alter table public.companies
  add column timezone text,             -- explicit IANA zone, only for multi-zone countries
  add column next_action_at timestamptz,
  add column phone_wrong_at timestamptz,
  add constraint companies_timezone_fits check (timezone is null or private.zone_fits_country(timezone, country));
alter table public.contacts add column phone_wrong_at timestamptz;
grant update (timezone, next_action_at, phone_wrong_at) on public.companies to authenticated;   -- RLS: owner, manager, admin
grant update (phone_wrong_at) on public.contacts to authenticated;                              -- RLS: lead editors
```
There is no insert grant: imports and `create_lead` leave these columns null, except the Cool off default below.

**`private.lead_guard()`** (INVOKER, BEFORE INSERT OR UPDATE ON companies; sorts after `enforce_org_and_owner`). Rules marked *app user* skip maintenance sessions.
1. **Country changed** (update): `timezone := null`, unless the same statement sets a timezone that fits the new country. This closes the CHECK hole.
2. **Timezone set or changed, not null**: it must fit the country, or 22023 hint `zone_not_in_country`, constant message. The CHECK above is only a backstop.
3. **`next_action_at` set or changed** (*app user*): at most `now() + 2 years` (22023 `bounds`). There is no lower limit: an editor can already raise a lead's rank through its status. Unchanged values are never checked, so overdue leads stay editable.
4. **Phone changed**: `phone_wrong_at := null`. Otherwise a change of `phone_wrong_at` from null to set becomes `now()`, set to null stays null, and any other change keeps the old value. The client never chooses the time.
5. **Status enters `cool_off`** (insert or update) with `next_action_at` null: `next_action_at := now() + interval '90 days'`. This covers imports, the edit form and direct writes (open question 3).

**`private.contact_guard()`** (INVOKER, BEFORE INSERT OR UPDATE ON contacts) applies rule 4 to contacts.

**Audit:** `next_action_at` and `phone_wrong_at` join the no-diff list (the activity that moved them is the record). `timezone` stays audited.

**Undo records** (private: no endpoint)
```sql
create table private.activity_undo (
  activity_id uuid primary key references public.activities (id) on delete cascade,
  org_id uuid not null references public.orgs (id),
  user_id uuid not null,
  prev_status text, new_status text,
  prev_next_action_at timestamptz, new_next_action_at timestamptz,
  prev_owner_id uuid, new_owner_id uuid, owner_changed boolean not null default false,
  wrong_company boolean not null default false, wrong_contact_id uuid,
  created_task_id uuid,
  completed_task_ids uuid[] not null default '{}' check (cardinality(completed_task_ids) <= 20),
  cancelled_task_ids uuid[] not null default '{}' check (cardinality(cancelled_task_ids) <= 50),
  created_at timestamptz not null default now());
alter table private.activity_undo enable row level security;
create policy require_mfa on private.activity_undo as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
create policy undo_own on private.activity_undo for all to authenticated   -- own rows, no time bound (clean-up must see them)
  using (user_id = (select auth.uid()) and org_id = (select private.current_org_id()))
  with check (user_id = (select auth.uid()) and org_id = (select private.current_org_id()));
grant select, insert, delete on private.activity_undo to authenticated;   -- no update; not audited (no lead text)
```
- `log_activity` deletes the caller's rows older than 10 minutes.
- `undo_activity` checks the 120 s window itself.

**Delete policies with the undo branch** (replace 4a's):
```sql
create policy activities_delete on public.activities for delete to authenticated using (
  org_id = (select private.current_org_id()) and (
       ((select private.has_recent_aal2(600)) and ((select private.is_manager_or_admin()) or user_id = (select auth.uid())))
    -- no code: own entry, under 120 s, and no undo record. undo_activity consumes the record first, so a logged outcome
    -- can only be removed through it (which puts the lead back). A directly inserted entry changed no lead.
    or (user_id = (select auth.uid()) and created_at > now() - interval '120 seconds'
        and not exists (select 1 from private.activity_undo u where u.activity_id = activities.id))));
```
`tasks_delete` gains a parallel branch: creator = me, untouched (`updated_at = created_at`, open), and the source activity is mine, under 120 s old, with its undo record already consumed.

**Status menu "Until when?".** `bulk_update_leads` is dropped and recreated with a 5th parameter, `p_next_action_at timestamptz default null`. It is allowed only with `p_status = 'cool_off'` (22023 otherwise) and bounded by `lead_guard`. Same revoke and grant loop. This changes an approved Day 3a signature only to fix a real bug. Rule 5 already covers every path without a date.

**Helpers**
- `private.next_working_day(p_at timestamptz, p_days int, p_key text) returns timestamptz` (STABLE): 09:00 local on the Nth weekday after `p_at`, in the key's zone. A span key uses its eastern zone. It is DST-safe through `(local_date + time '09:00') at time zone z`.
- `private.call_attempts(p_company uuid) returns int` (STABLE): consecutive `no_answer`/`voicemail` among the lead's 6 latest calls (keyset index, `limit 6`).

### 3.3 4c: `supabase/migrations/20261013090000_tasks_queue.sql`

**Queue facts on leads**
```sql
alter table public.companies add column has_contact_phone boolean not null default false;  -- a contact has a working number
alter table public.companies
  add column call_zone text generated always as (private.lead_call_zone(timezone, country)) stored,
  add column queue_rank smallint generated always as (
    case
      when not ((phone is not null and phone_wrong_at is null) or has_contact_phone) then null   -- nothing to dial
      when lead_status = 'negotiation' then 0
      when lead_status = 'warm' then 1
      when lead_status = 'cold' then case when next_action_at is null then 3 else 2 end
      when lead_status = 'cool_off' and next_action_at is not null then 2
    end) stored;   -- null: never served (customer, do not contact, disqualified, no number, cool off without a date)
create index companies_queue_owner_idx on public.companies
  (org_id, owner_id, queue_rank, next_action_at, last_activity_at nulls first, id) where queue_rank is not null;
create index companies_queue_team_idx on public.companies
  (org_id, queue_rank, next_action_at, last_activity_at nulls first, id) where queue_rank is not null;
```
- **Adding the generated columns** rewrites the table without firing triggers, so `updated_at` and the Day 3b "untouched" rule are unaffected.
- **`private.sync_contact_phone()`** (SECURITY DEFINER, AFTER INSERT OR DELETE OR UPDATE OF phone, phone_wrong_at, company_id ON contacts; trigger-only, revoked). It sets `has_contact_phone` for the old and the new lead, only where the value changes. Lock order is contact, then lead.
- **Backfill:** `update companies set has_contact_phone = true where exists (contact with phone and phone_wrong_at is null)`. It only touches leads that have contacts, which already count as worked on, so Day 3b's Undo is unaffected.
- **Audit:** `call_zone` and `queue_rank` are added to the hidden list. `has_contact_phone` joins the no-diff list.
- **Zone-map change procedure** (comment in the migration): a later change to the zone map is a new migration that redefines the functions and then runs `update companies set country = country` with `set_updated_at` and `audit_row` disabled, so the stored `call_zone` is recomputed. The check query `call_zone_matches_map` (`select count(*) … where call_zone <> private.lead_call_zone(timezone, country)`) must return 0. It runs in `queue_attack.sql` and is part of the Gate 1 checks.

**Call window functions** (static):
- `private.call_zone_keys() returns text[]` (IMMUTABLE): every value `lead_call_zone` can return, about 250.
- `private.call_zone_open(p_key text, p_at timestamptz, p_skip_lunch boolean) returns boolean` (STABLE):
  - Monday to Friday, 09:00 to 18:00 local;
  - a span key needs both its eastern and western zone open;
  - the lunch switch skips 12:00 to 14:00 for `Europe/*` zones only. Spans ignore it, because their overlap is already short.
- `private.open_call_zones(p_at timestamptz, p_skip_lunch boolean) returns text[]` (STABLE): about 250 evaluations, around 1 ms warm.
- Migration comment, the **leakproof rule**: under RLS, only leakproof operators can be index conditions. Queue and timeline queries therefore use `= any(text[])`, `uuid`/`timestamptz` comparisons, `IS NULL` and row comparisons. They never use `AT TIME ZONE` per row, `@>` or `LIKE`. (Checked in PG16's `postgres.bki`: `texteq`, `uuid_ne` and `timestamptz_le` are leakproof; `timezone()`, `arraycontains` and `array_eq` are not.)

**Claims** (private: no endpoint)
```sql
create table private.queue_claims (
  company_id uuid primary key references public.companies (id) on delete cascade,
  org_id uuid not null references public.orgs (id),
  user_id uuid not null references public.profiles (id) on delete cascade,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null);
create index queue_claims_user_idx on private.queue_claims (user_id, claimed_at);
alter table private.queue_claims enable row level security;   -- plus require_mfa (restrictive)
create policy claims_select on private.queue_claims for select to authenticated
  using (org_id = (select private.current_org_id()));          -- "Henri is on this lead"
create policy claims_insert on private.queue_claims for insert to authenticated with check (
  org_id = (select private.current_org_id()) and user_id = (select auth.uid())
  and exists (select 1 from public.companies c where c.id = queue_claims.company_id      -- only leads the caller may change:
              and ((select private.is_manager_or_admin()) or c.owner_id = (select auth.uid()))));  -- no locking teammates out
create policy claims_update on private.queue_claims for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy claims_delete on private.queue_claims for delete to authenticated using (
  org_id = (select private.current_org_id()) and (user_id = (select auth.uid()) or expires_at <= now()));
grant select, insert (company_id), update (expires_at), delete on private.queue_claims to authenticated;
```
- **`private.claim_guard()`** (BEFORE INSERT OR UPDATE):
  - forces `org_id`, `user_id := auth.uid()`, `claimed_at` (insert) and `expires_at := now() + interval '10 minutes'`;
  - more than 3 live claims for this user gives 22023 `busy`.
  - A client can neither choose a claim's length nor claim for someone else.
- **Not audited** (short-lived, no personal data).
- **`import_fk_coverage`** expects `{activities, contacts, deals, private.queue_claims, tasks}`, with the comment "a claim is not work; it goes with the lead".

**Tasks and profiles**
```sql
create index tasks_assignee_open_idx on public.tasks (assignee_id, due_date, due_at, id)
  where done_at is null and cancelled_at is null;
create index tasks_assignee_done_idx on public.tasks (assignee_id, done_at desc, id desc) where done_at is not null;
create index tasks_queue_idx on public.tasks (assignee_id, due_date, due_at)
  where kind = 'call' and done_at is null and cancelled_at is null;
drop index public.tasks_org_assignee_idx;
```
`private.check_profile_timezone()` (BEFORE UPDATE OF timezone ON profiles): the value must be in `pg_catalog.pg_timezone_names`, or 22023 with a constant message.

### 3.4 4d: `supabase/migrations/20261014090000_lead_files.sql` (after spikes S1 to S4)

**Files (G4)**
```sql
alter table public.files
  drop column contact_id,                                         -- files belong to the lead (dev: 0 rows, checked first)
  add column company_id uuid not null references public.companies (id) on delete restrict,   -- no orphaned bytes
  add column name text not null check (char_length(name) between 1 and 180 and name !~
    '[\u0001-\u001F\u007F-\u009F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB\U000E0000-\U000E007F/\\"]'),
  add column status text not null default 'pending' check (status in ('pending','ready','deleting')),
  add column ready_at timestamptz;
alter table public.files drop constraint files_size_check, add constraint files_size_check check (size between 1 and 10485760);
alter table public.files add constraint files_path_shape check (storage_path ~
  '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|png|jpg|docx|xlsx)$');      -- org/lead/file.ext
create index files_company_idx on public.files (company_id);
create index files_company_ready_idx on public.files (company_id, created_at desc, id desc) where status = 'ready';
create index files_pending_idx on public.files (uploaded_by, created_at) where status = 'pending';
revoke insert, update, delete on public.files from authenticated;
grant insert (company_id, name, mime, size), update (status), delete on public.files to authenticated;
```

**Triggers**
- **`private.file_guard_insert()`** (SECURITY DEFINER, BEFORE INSERT; runs after `enforce_org_and_owner`):
  - `new.id := gen_random_uuid()`, `status := 'pending'`, `ready_at := null`;
  - `storage_path := org_id || '/' || company_id || '/' || id || '.' || ext(mime)` (the extension comes from the type, never the name);
  - constant-error pre-checks on name and size;
  - limits, 22023 with a hint: at most 5 pending uploads per user (`too_many_pending`); at most 30 uploads per user per hour (`rate_limited`); and the **team quota** under `pg_advisory_xact_lock(hashtextextended('files:' || org_id, 0))`:
    `private.org_storage_bytes(org_id)` (the real `metadata->>'size'` of `storage.objects` under the org prefix in `lead-files`) + declared sizes of pending rows under 15 minutes old with no object yet + `new.size` must be ≤ 838,860,800 bytes (800 MiB, hint `quota`).
  - It is definer only so the sums see every org file. It returns nothing to the caller, and the helper is not granted to anyone.
- **`private.file_guard_update()`** (INVOKER, BEFORE UPDATE): only `status` may change (42501 otherwise). Allowed moves:
  - `pending → ready`: uploader only. Requires an object in `lead-files` with `name = storage_path`, `(metadata->>'size')::bigint = size` and `metadata->>'mimetype' = mime`. Sets `ready_at`. Otherwise 22023 `object_mismatch`.
  - `pending → deleting`: the uploader.
  - `ready → deleting`: the uploader, the lead's owner or a manager/admin, **and** `has_recent_aal2(600)`. Otherwise 42501 `step_up`.
- **`private.file_guard_delete()`** (INVOKER, BEFORE DELETE): the row must be `deleting` and its object must be gone.

**Policies on `public.files`** (D11):
- `files_select`: org and (uploader = me, or (status in ('ready','deleting') and (manager/admin or lead owner = me))).
- `files_insert`: org, and the lead is visible.
- `files_update` and `files_delete`: org and (uploader, lead owner or manager/admin). The guards hold the per-move rules.

**Bucket and Storage policies** (no UPDATE policy: no overwrite, upsert or move)
```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lead-files', 'lead-files', false, 10485760, array['application/pdf','image/png','image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;
create policy lead_files_select on storage.objects for select to authenticated using (
  bucket_id = 'lead-files' and (select private.has_aal2())
  and (storage.foldername(name))[1] = (select private.current_org_id())::text            -- second, independent org fence
  and exists (select 1 from public.files f where f.storage_path = storage.objects.name));   -- files RLS decides
create policy lead_files_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'lead-files' and (select private.has_aal2())
  and (storage.foldername(name))[1] = (select private.current_org_id())::text
  and exists (select 1 from public.files f where f.storage_path = storage.objects.name and f.status = 'pending'
              and f.uploaded_by = (select auth.uid()) and f.created_at > now() - interval '15 minutes'));
create policy lead_files_delete on storage.objects for delete to authenticated using (
  bucket_id = 'lead-files' and (select private.has_aal2())
  and (storage.foldername(name))[1] = (select private.current_org_id())::text
  and exists (select 1 from public.files f where f.storage_path = storage.objects.name and f.status = 'deleting'));
```

**Also in 4d:**
- `audit_log.action` gains `'file_access'`. `private.audit_file_access(p_file uuid)` is the one new callable definer function. It is private, so it has no endpoint. It inserts only for a `ready` file in the caller's org.
- `lead_import_untouched` gains `not exists files`. `import_fk_coverage` adds `files`.
- `config.toml`: `[storage.s3_protocol] enabled = false`. If `config push` refuses this on the free plan, the change is kept and the log records that no S3 access key exists. Haider checks Storage > S3 Connection: none.

### 3.5 Audit and free-tier budget (500 MB database)

| Item | Year-1 estimate |
|---|---|
| 300k activities (3 people × ~150 calls a day + emails and notes), keyset, author and FK indexes | ~135 MB |
| Audit rows for activities: 0 inserts; edits and deletes only (rare, no text) | < 5 MB |
| Lead diffs: status and owner changes from outcomes (~1 in 4 calls); `next_action_at`, `phone_wrong_at`, `last_activity_at` and queue facts not diffed | ~20 MB |
| Tasks (50k) and their audit | ~35 MB |
| Leads (30k, 16 indexes after 4c), contacts, files metadata | ~60 MB |
| Claims and undo records | < 1 MB (short-lived) |
| **Total** | **~255 MB (about 51%)** |

Without the D8 change, activity audit copies alone would add about 135 MB a year. Day 7 (Gate 1) adds a size query to the evidence:

```sql
select relname, pg_size_pretty(pg_total_relation_size(oid))
  from pg_class
 where relname in ('audit_log', 'activities', 'tasks', 'companies')
 order by 2;
```

plus audit rows per table per day.

## 4 RPCs, server actions and routes

Every RPC is revoked from `public, anon` and granted to `authenticated` through the Day 3a loop.

**Error contract** (extends Day 3b's). Messages never contain values.

| Code | Meaning |
|---|---|
| 42501 | Hints `step_up`, `scope`, `not_editable`, `source` |
| 22023 | Hints `outcome`, `body_too_long`, `body_chars`, `rate_limited`, `follow_up_required`, `follow_up_range`, `task_title`, `bounds`, `state`, `undo_expired`, `zone_not_in_country`, `bad_cursor`, `busy`, `too_many_pending`, `quota`, `object_mismatch` |
| P0002 | Not found or not visible |
| 23503 | `lead_has_files` |

`src/lib/db-errors.ts` maps these to:
- `step_up`: opens the Confirm-it's-you dialog, then retries;
- `forbidden`;
- `invalid`;
- `rate_limited`;
- `expired`;
- `busy`, `quota`, `type_mismatch`, `not_found`;
- `unavailable`.

Raw database text never leaves the server. ESLint `no-console` covers every new server file.

### 4.1 4b (lead page)

| RPC | Who | Notes |
|---|---|---|
| `get_lead(p_id uuid) returns jsonb` (same signature, extended) | org | Adds `timezone`, `call_zone_key`, `next_action_at`, `phone_wrong_at`, `contacts[].phone_wrong_at`, `can_set_timezone` (multi-zone country and `can_edit`), `next_task` (the earliest open task the caller can see), `open_task_count`, `attempts`, `import {filename, created_at}` (admins only, via import_batches RLS). 4c adds `worked_by {first_name, until}`; 4d adds `file_count` |
| `list_lead_activities(p_company uuid, p_types text[] default null, p_before_at timestamptz default null, p_before_id uuid default null, p_limit int default 30) returns table (id, type, outcome, body, truncated, contact_id, contact_name, user_id, user_first_name, user_last_name, created_at, edited_at, is_mine, undo_until, task_title, task_due_date, task_due_at, task_done_at)` | org | Keyset `(created_at, id) <`. Body is `left(body, 2000)` with `truncated`. `p_types` must be a subset of the five types (checked with `<@`). Cursor needs both parts; limit 1 to 100 (22023). Left join to the visible task from `source_activity_id` |
| `get_activity(p_id uuid) returns jsonb` | org | One entry with its full text ("Show more") |
| `log_activity(p_company uuid, p_type text, p_outcome text default null, p_body text default null, p_contact uuid default null, p_dialled text default null, p_follow_up_date date default null, p_follow_up_at timestamptz default null, p_task_title text default null, p_request_id uuid default null, p_from_queue boolean default false) returns jsonb` | anyone in the org on any lead; lead changes for editors only | 5.2 |
| `undo_activity(p_id uuid) returns jsonb` | author, 120 s | 5.3 |
| `edit_activity(p_id uuid, p_body text) returns void` | author | 42501 when not the author or gone |
| `delete_activity(p_id uuid) returns void` | author or manager/admin, with a fresh code | `has_recent_aal2(600)` is checked first (hint `step_up`) |
| `set_lead_timezone(p_id uuid, p_timezone text)`, `set_lead_next_action(p_id uuid, p_at timestamptz)` | lead editors | Pre-checks before the trigger and CHECK |
| `create_task(p_title text, p_company uuid default null, p_contact uuid default null, p_kind text default 'todo', p_due_date date default null, p_due_at timestamptz default null, p_assignee uuid default null, p_request_id uuid default null) returns uuid` | policy | Idempotent on `(created_by, request_id)` |
| `set_task_done(p_id uuid, p_done boolean) returns jsonb`, `set_task_cancelled(p_id uuid, p_cancelled boolean) returns jsonb` | assignee, creator, manager/admin | Return the server times. Idempotent |
| `list_lead_tasks(p_company uuid, p_include_done boolean default false, p_limit int default 20)` | tasks RLS | `tasks_company_idx` |
| `bulk_update_leads(p_ids uuid[], p_status text default null, p_set_owner boolean default false, p_owner uuid default null, p_next_action_at timestamptz default null) returns integer` | as Day 3a | Recreated (3.2) |

**Server actions** (`src/app/(app)/leads/[id]/actions.ts`): `logActivity`, `editActivity`, `undoActivity`, `deleteActivity`, `setLeadTimezone`, `setNextAction`, `createTask`, `setTaskDone`, `setTaskCancelled`. Each one:
- parses with `z.strictObject` (schemas in `src/lib/activities.ts` and `src/lib/tasks.ts`; type, outcome and kind lists shared with SQL through `tests/unit/day4-parity.spec.ts`);
- calls `requireSession()` and then one RPC;
- returns `{ok:true,data}` or `{ok:false,error}`.

`logActivity` fills `p_task_title` from `messages/*` in the caller's locale ("Follow up with {lead}").

**Routes:**
- `GET /api/leads/[id]/activities?types=&before_at=&before_id=`: `apiSession`, Zod, `Cache-Control: private, no-store`, 400 on a bad cursor.
- `GET /api/leads/[id]` (exists) returns the extended `get_lead`.

### 4.2 4c (tasks and queue)

| RPC | Who | Notes |
|---|---|---|
| `claim_next_lead(p_scope text default 'mine', p_keep uuid[] default null, p_exclude uuid[] default '{}', p_count int default 1, p_any_hours boolean default false, p_skip_lunch boolean default false) returns jsonb` | `mine` for everyone; `mine_unassigned` and `team` for managers/admins (42501 `scope`) | 5.4. `p_keep` ≤ 2, `p_exclude` ≤ 200, `p_count` 1 to 2 |
| `claim_lead(p_company uuid) returns boolean` | claim policy | Re-claims the undone lead in the queue |
| `renew_claims() returns timestamptz`, `release_claims(p_ids uuid[] default null) returns integer` | own claims | |
| `queue_summary(p_scope text default 'mine', p_skip_lunch boolean default false) returns jsonb` | same scope rule | `{callable_now, later_today, no_number, claimed_by_others, waiting_by_zone: [{key, count}]}` from one scan with FILTER counts. The browser works out when each zone next opens |
| `list_tasks(p_bucket text, p_scope text default 'mine', p_after_sort timestamptz default null, p_after_id uuid default null, p_limit int default 50) returns table (id, title, kind, due_date, due_at, done_at, assignee_id, assignee_first_name, assignee_last_name, company_id, company_name, company_call_zone, contact_id, contact_name, created_by, sort_at, can_edit)` | `team` for managers/admins | One static query per bucket (IF branches). Zone = the caller's `profiles.timezone`, read in SQL. Buckets in 5.6 |
| `count_tasks(p_scope text default 'mine') returns jsonb` | same | `{overdue, today, upcoming}` |
| `update_task(p_id uuid, p_title text, p_due_date date, p_due_at timestamptz, p_assignee uuid, p_contact uuid)`, `delete_task(p_id uuid)` (fresh code) | policy | |

**Server actions:**
- `src/app/(app)/leads/queue/actions.ts`:
  - `startQueue` (`claim_next_lead`, `p_keep => null`, `p_count => 2`);
  - `logOutcomeAndClaim` (`log_activity` with `p_from_queue`, then `claim_next_lead` with `p_keep` = the buffered card, `p_count 1`);
  - `skipAndClaim`, `undoOutcome` (`undo_activity` then `claim_lead`), `renewClaims`, `releaseClaims`.
- `src/app/(app)/tasks/actions.ts`: `createTask`, `updateTask`, `setTaskDone`, `setTaskCancelled`, `deleteTask`.
- `src/app/(app)/more/actions.ts`: `saveTimezone` (Zod: in `Intl.supportedValuesOf('timeZone')`; the database checks `pg_timezone_names`).

**Routes:**
- `POST /api/queue/release`: `apiSession`; `assertSameOrigin` (`src/lib/http.ts`: Origin equals the request origin, or `Sec-Fetch-Site: same-origin`); `Content-Type: application/json`; body ≤ 32 KB; Zod `{ids?: uuid[] ≤ 3}`; `no-store`. Called with `fetch(..., {keepalive: true})` on `pagehide`.
- `GET /api/tasks?bucket=&scope=&after_sort=&after_id=`.
- **No side effects on GET or render:** the queue page's server component calls only `queue_summary`. Claims start on an explicit Start (↩). Queue links use `prefetch={false}`.

### 4.3 4d (files)

| RPC | Who | Notes |
|---|---|---|
| `begin_file_upload(p_company uuid, p_name text, p_mime text, p_size integer) returns jsonb` | org, lead visible | First marks the caller's own pending uploads older than 15 min as `deleting` and returns their paths for clean-up. Returns `{id, path, stale_paths}` |
| `get_pending_upload(p_id uuid) returns jsonb` | uploader | `{path, mime, size}` |
| `finish_file_upload(p_id uuid)`, `abort_file_upload(p_id uuid) returns text` | uploader | The guard checks the object |
| `list_lead_files(p_company uuid, p_before_at timestamptz default null, p_before_id uuid default null, p_limit int default 50)` | files RLS | `ready` rows, plus the caller's own `deleting` rows ("Couldn't finish deleting · Retry") |
| `open_file(p_id uuid) returns jsonb` | files RLS, `ready` only | `{path, name, mime}`; writes the `file_access` audit row |
| `begin_file_delete(p_id uuid) returns text`, `finish_file_delete(p_id uuid)` | guard (fresh code) | |
| `file_usage() returns bigint` | managers/admins see every ready file | Ready sizes are real (checked at finish). Shown only to them |

**Server actions** (`src/app/(app)/leads/[id]/file-actions.ts`): `beginUpload`, `finishUpload`, `abortUpload`, `deleteFile`.

**Routes:**
- `GET /api/files/[id]?disposition=attachment|inline` (5.7).
- `GET /api/leads/[id]/files`.
- `src/app/(app)/files/unavailable/page.tsx`.

## 5 Flows

### 5.1 Local time and calling hours

**One map, two copies.** `scripts/make-zone-map.mjs` reads `/usr/share/zoneinfo/zone.tab` (one line per country and zone), cross-checks with `zone1970.tab`, and applies reviewed overrides in `scripts/zone-map.overrides.json`:
- main zones: RU → Europe/Moscow, ES → Europe/Madrid, PT → Europe/Lisbon, DE → Europe/Berlin, KZ → Asia/Almaty, CL → America/Santiago, EC → America/Guayaquil, CD → Africa/Kinshasa, …;
- span entries: US New_York/Los_Angeles, CA Halifax/Vancouver, AU Sydney/Perth, MX Mexico_City/Tijuana, BR Sao_Paulo/Manaus, ID Jakarta/Jayapura;
- the closed list of zones a person may pick per multi-zone country.

It writes `src/lib/zone-map.generated.ts` and the literal block in the 4b migration. The script fails if a multi-zone country has neither a span nor an override.

**The rule:**

| Lead | Calling zone |
|---|---|
| Explicit zone set | That zone |
| Single-zone country | The country's zone |
| Multi-zone country, no zone | The span key: open only while both ends are in hours |
| No country | Europe/Paris, shown as "Local time unknown · add the country" |

**In the browser** (`src/lib/timezones.ts`):
- `callZone(timezone, country)`, `isOpen(key, at, skipLunch)`, `nextOpening(key, at)`;
- `localTime(key, at, locale)`: Intl with `timeZone`; for a span, "13:05–16:05";
- `CALL_WINDOW = {weekdays: [1,2,3,4,5], start: 540, end: 1080, lunch: [720, 840]}`.
- Zone names come from Intl (`longGeneric`), so they need no i18n keys. `zoneLabel` moves here from `src/components/import/zones.ts`.

**Parity:**
- `tests/unit/zone-map.spec.ts`: the migration literal equals the generated TS, and every zone formats in Intl.
- SQL `zone_map_zones_exist`: every zone is in `pg_timezone_names`.
- About 60 call-window cases (key, instant, lunch, expected) sit between `call-window:start/end` markers in `tests/unit/call-window.spec.ts` and `queue_attack.sql`, the Day 3b shared-literal pattern. They include:
  - the autumn change weeks: EU 25 Oct 2026, US 1 Nov 2026, when Paris and New York are 5 h apart;
  - spring 29 Mar and 8 Mar 2026;
  - weekends, span edges and lunch edges.

### 5.2 Logging an activity or an outcome (`log_activity`, one transaction)

1. **Validate:**
   - the type, the outcome for that type, the body (CRLF → LF), and `p_dialled` in (`lead`, `contact`);
   - follow-up rules: `interested` needs `p_follow_up_date` or `p_follow_up_at` (default next working day, set by the client); `meeting_booked` needs `p_follow_up_at` between `now() - 5 min` and +366 days; `connected` takes either, optionally; everything else takes neither;
   - a date must be between the caller's today and +366 days;
   - when a task will be made, `p_task_title` must be 1 to 300 characters.
2. **Replay:** if the caller already has an activity with `p_request_id`, return its stored result with `replayed: true` and apply nothing again. A concurrent duplicate hits the unique index (23505), which is caught and answered the same way.
3. **Lock order: contact, then lead.** This matches a contact edit, whose trigger updates the lead.
   - If `wrong_number` and the dialled number is a contact's, lock that contact with `select … for update` (RLS: lead editors only).
   - Then `select … from companies where id = p_company` (P0002 if not visible), and `select … for update` on it. A row comes back only for editors, which sets `v_editable`.
4. **Work out the new state** from the rules in 5.5. The "6th in a row" rule reads `private.call_attempts`.
5. **Insert the activity.** The guard sets the author and `prev_last_activity_at`. The touch trigger moves `last_activity_at`.
6. **If editable:**
   - one `update companies` for status, `next_action_at`, owner (an unassigned lead becomes the caller's on Interested or Book meeting; open question 5) and `phone_wrong_at`;
   - or `update contacts set phone_wrong_at`, which fires `sync_contact_phone` under the contact lock already held.
7. **Tasks:**
   - complete the caller's open `call` tasks on this lead due by today (`returning id` → `completed_task_ids`);
   - for Do not contact, cancel the open tasks on the lead the caller may update;
   - create the follow-up, meeting or "find the right number" task with `source_activity_id`. It is created even for non-editors, because they had the conversation.
8. Insert `private.activity_undo`, and delete the caller's undo rows older than 10 min.
9. If `p_from_queue`, delete the caller's claim on this lead.
10. Return `{activity_id, replayed, editable, status_before, status_after, next_action_at, owner_changed, task_id, completed_task_ids, undo_until}`.

A non-editor's call is still logged. The screen says "Logged. Status not changed: only {owner} or an admin can change this lead."

### 5.3 Undo (`undo_activity`)

1. Read the activity (own, under 120 s) and `select … for update` its undo row. If either is missing, 22023 `undo_expired`. A second undo gets the same.
2. **Delete the undo row.** This opens the no-code delete branch for this activity only.
3. **Lock order** as in 5.2 (contact, then lead). Restore each field **only if it still equals the value this outcome wrote**:
   - status, `next_action_at` and owner;
   - `phone_wrong_at` on the company or the contact.

   A colleague's later change is never overwritten. The result says which fields came back.
4. Delete the created task if it is untouched (`updated_at = created_at`, open). This uses the task delete branch.
5. Reopen the tasks this outcome completed (`completed_by = me`) or cancelled.
6. Delete the activity. The untouch trigger puts `last_activity_at` back.

Undo is offered from:
- the toast, for 10 s (U or ⌘Z when not typing);
- the timeline entry menu, for 120 s.

### 5.4 Work queue

**Who sees what:**

| Scope | Who | Leads |
|---|---|---|
| Mine (default) | everyone | owner = me |
| Mine + unassigned | managers and admins | owner = me or none; a UNION ALL of two ordered scans under one ORDER BY/LIMIT, planned as a **Merge Append** (asserted in `perf_day4.sql`) |
| Team | managers and admins | every lead in the org |

All three users are admins today. A future rep only ever gets Mine, because the RPC says 42501 and the claim policy refuses others' leads anyway.

**Eligibility.** A lead is served only when all of these hold:
- `queue_rank is not null` (so not Do not contact, Disqualified or Customer; it has a working number; a Cool off lead has a date);
- `next_action_at is null or next_action_at <= now()`;
- `call_zone = any(open zones)`, unless "Show leads outside calling hours" is on;
- no live claim by someone else;
- not in `p_exclude` (this session's skips) or `p_keep`.

**Order:**
1. **Follow-ups due:** my open `call` tasks with `due_date ≤ my today` or `due_at ≤ now() + 5 min`, on an eligible lead the caller may claim (next-call date ignored: the task is the reason), by due time (`tasks_queue_idx`).
2. **Then one rank at a time**, each a static query with an index condition:
   - rank 0 (Negotiation) and rank 1 (Warm): small sets, due filter;
   - rank 2 (retry or due): `next_action_at <= now()` as an **index range** that stops at now;
   - rank 3 (first calls): `next_action_at is null` ordered by `last_activity_at nulls first, id`, so never-called leads come first.
   - The walk never passes the thousands of future retries.

**Claiming (`claim_next_lead`):**
1. Check the scope and the limits.
2. `p_keep is null` (start or reload): the caller's own live, still-eligible claims come back first and are renewed. Otherwise delete the caller's claims not in `p_keep`.
3. `v_open := open_call_zones(now(), p_skip_lunch)`, worked out once.
4. Fetch candidates (needed + 5 spares). For each: delete an expired claim on it, then `insert … on conflict (company_id) do nothing returning`. A row back means the lead is mine. No row means someone else won, so try the next. Stop when `p_count` are won.
5. Return the cards:
   `{id, name, lead_status, owner, phone, phone_wrong, email, city, country, timezone, call_zone, local_time_open, contacts ≤ 10, recent 3 (body ≤ 500), my_open_tasks ≤ 3, reason ('follow_up'|'negotiation'|'warm'|'retry'|'first_call'|'returning'), attempts, claimed_until, can_edit}`,
   or `[]` plus the summary when nothing is callable.

**Why there are no double calls:**
- The primary key on `company_id` allows one live claim.
- A claim can only be taken over after it expires (policy and explicit check).
- `on conflict do nothing` never raises under RLS (S5c).
- Nothing locks the lead row, so serving a lead never blocks someone editing it.
- A claim does not gate logging: a call made from the lead page is always logged, and its next-call date keeps the lead out of the queue.

**Buffer and life cycle:**
- The screen holds the current card plus one **claimed** buffered card. After a key press the buffered card shows at once (from memory). `logOutcomeAndClaim` saves the outcome and claims the next buffer in one dispatch.
- Claims last 10 minutes. The page renews them every 4 minutes while it is visible and the person has pressed a key or clicked in the last 10 minutes.
- `pagehide` sends `POST /api/queue/release` with `keepalive`. Leaving through the app calls `releaseClaims`.
- A closed laptop therefore holds at most 2 leads for at most 10 minutes. A reload gets the same lead back (it is still first in the order, and a missed release is resumed by `p_keep => null`).
- **A failed save** keeps the outcome in `sessionStorage['topstock.queue.pending']` with its `request_id`. It retries at 0.5, 1 and 2 s, then shows "1 outcome not saved · Retry". It can never be stored twice.

### 5.5 One-key outcomes and exactly what each writes

Lead changes apply only for editors. "Working day" means 09:00 local on a later weekday in the lead's calling zone (a span uses its eastern zone), from `private.next_working_day`.

| Key | Outcome (EN / FR) | Activity | Status | `next_action_at` | Task | Also |
|---|---|---|---|---|---|---|
| 1 | No answer / Pas de réponse | call · no_answer (+ note) | unchanged; on the **6th** call in a row without reaching anyone, cold or warm → `cool_off` | next working day; after the 6th, +30 days | none | my due call tasks on the lead completed; claim released |
| 2 | Voicemail / Message laissé | call · voicemail | same counter as 1 | +2 working days | none | same |
| 3 | Wrong number / Mauvais numéro | call · wrong_number | unchanged | unchanged | if no working number is left: todo "Find the right number for {lead}", due today, for the owner (if I may assign) or me | the dialled number gets `phone_wrong_at`; with no other number the lead has no rank until a number changes |
| 4 | Not interested / Pas intéressé | call · not_interested | cold, warm or cool_off → `cool_off`; negotiation and customer unchanged | +90 days | none | my open call tasks here completed |
| 5 | Interested / Intéressé | call · interested | cold or cool_off → `warm` (never moves a lead down) | follow-up date + 1 day (the task brings it back first) | call "Follow up with {lead}" on the chosen date (default next working day), for me | an unassigned lead becomes mine (open question 5); Day 5 adds "open a deal" |
| 6 | Book meeting / Rendez-vous pris | call · meeting_booked | cold, cool_off or warm → `warm` | meeting day + 1 day | meeting "Meeting with {lead}" at the chosen date and time (required), for me | same owner rule |
| 7 | Do not contact / Ne plus contacter | call · do_not_contact | **any → `do_not_contact`** (compliance wins) | null | open tasks on the lead that I may update → cancelled | leaves every queue at once; Call, WhatsApp and Email hidden on its page |
| 0 | Spoke / Échangé | call · connected | unchanged | follow-up date + 1 day, or +30 days without one | optional call task on the chosen date or time | the attempt counter starts again |
| S | Skip / Passer | nothing written | | | | claim released; excluded for this session |
| U, ⌘Z | Undo / Annuler | `undo_activity` | restored if unchanged since | restored if unchanged since | created task removed if untouched; completed or cancelled tasks reopened | |

### 5.6 Tasks buckets (database, in the caller's profile zone `tz`; `v_today := (now() at time zone tz)::date`)

| Bucket | Rule |
|---|---|
| Overdue | open, and (`due_date < v_today` or `due_at < now()`) |
| Today | open, and (`due_date = v_today` or (`due_at >= now()` and `(due_at at time zone tz)::date = v_today`)) |
| Upcoming | open, and (`due_date > v_today`, or `(due_at at time zone tz)::date > v_today`, or no date, last) |
| Done | `done_at desc, id desc` (keyset). Cancelled tasks are listed nowhere |

- Order: `sort_at = coalesce(due_at, due_date::timestamp at time zone tz)`. All-day tasks sort at the start of their day.
- Open tasks per person stay in the low thousands, so the per-bucket sort fits the budget (P5, measured).

### 5.7 Files

**Upload:**
1. **Browser** (`src/components/files/upload-zone.tsx`), up to 5 files per drop:
   - pre-checks size, extension, `file.type` and `sniffFile()` on the first 8 bytes, plus the last 64 KiB for DOCX and XLSX;
   - bad files get a reason inline.
2. **`beginUpload`** (strictObject):
   - the name goes through `cleanFileName()` (`src/lib/files/name.ts`): invisible, bidi and control characters removed, at most 180 characters, extension forced to match the type;
   - then `begin_file_upload`;
   - it removes `stale_paths` through Storage `remove()` with the user's JWT and runs `finish_file_delete` for each.
3. **The browser uploads with `XMLHttpRequest`** straight to `POST {SUPABASE_URL}/storage/v1/object/lead-files/{path}`:
   - headers: `Authorization: Bearer <session token>`, `x-upsert: false`, `content-type`, `cache-control: max-age=0`;
   - `upload.onprogress` drives a real progress bar, so there is no spinner;
   - checked with Context7 before coding;
   - Cancel aborts the request and calls `abortUpload`.
4. **`finishUpload`**:
   - `get_pending_upload`, then a 30 s signed URL;
   - `fetch` with `Range` to the origin pinned from `env` (no user URL, so no SSRF), with a 3 s timeout;
   - `sniffFile()`. A mismatch runs abort → remove → `finish_file_delete` and returns `type_mismatch`. A match runs `finish_file_upload`, where the database also checks the stored size and type.

**`sniffFile(bytes, mime)`** (`src/lib/files/sniff.ts`, shared by browser and server):
- PDF `%PDF-`; PNG `89 50 4E 47 0D 0A 1A 0A`; JPEG `FF D8 FF`.
- DOCX and XLSX: `PK\x03\x04`, then the end-of-central-directory record. Requires `[Content_Types].xml` plus `word/document.xml` or `xl/workbook.xml`, at most 10,000 entries, and **refuses `vbaProject.bin`**.
- Nothing is decompressed (no zip bomb). Parsing is bounds-checked; an odd file gives "unknown", never a throw.

**Opening: checked every time** (`GET /api/files/[id]`):
1. `apiSession()`; Zod; `Sec-Fetch-Site` must be `same-origin` or `none`.
2. `open_file` (RLS, ready only, writes the audit row).
3. Re-read the first 8 KiB, plus the central directory for Office files, through a 30 s signed URL from the pinned origin, and run `sniffFile`. An insider who skipped `finish_file_upload`'s check can now only fool themselves.
4. `createSignedUrl(path, 60, attachment ? {download: name} : undefined)`. Check the URL origin.
5. **303** with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
6. Any failure: 303 to `/files/unavailable` ("This file is no longer available or isn't yours to open").

Rows link with a plain `<a>`, never Next `Link`, so hovering never prefetches. Open (PDF and images only) uses `target="_blank" rel="noopener noreferrer"`. The token exists only in one `Location` header: never in the DOM, the query cache, React state, logs or storage.

**Delete:**
- `useStepUp().ensureFresh()`, then `begin_file_delete` (the database requires the code), Storage `remove([path])` (the `deleting` policy), then `finish_file_delete`.
- If Storage fails, the row stays `deleting`: hidden from others, and shown to the uploader and admins as "Couldn't finish deleting · Retry".

**Quota:**
- Real object bytes plus pending reservations, ≤ 800 MiB, checked under an advisory lock.
- Bytes land after the check, so concurrent uploads can overshoot by at most 5 pending × 10 MiB × 3 people = 150 MiB, inside the 224 MiB headroom of the 1 GiB plan.
- Stray objects of someone who never uploads again wait for the Gate 1 sweeper, which needs the service key.

## 6 Security: threats and how each is blocked

SQL tests sit in `supabase/tests/*_attack.sql` and e2e tests in `tests/auth/*`. Every control is listed with the test that proves it.

| # | Threat | Control | Tests |
|---|---|---|---|
| 1 | Stolen aal1 session | restrictive `require_mfa` on every new table, the private tables and the bucket's objects; `requireSession`/`apiSession` | `day4_aal1_blocked` (every new RPC 42501; 0 rows from each table) |
| 2 | Another org (lead, timeline, tasks, files, claims, objects) | `org_id = current_org_id()` in every policy; `enforce_org_and_owner`; Storage path prefix **and** files-row check; `get_lead` null → same 404 | `other_org_activity_invisible`, `other_org_task_invisible`, `other_org_claim_invisible`, `other_org_file_row_invisible`, `other_org_object_select_zero`, `other_org_object_insert_denied`; e2e `api_refuses_other_org_ids` |
| 3 | **Logging as someone else (G1)** | guard forces `user_id`; no manager exception; no `user_id` grant | `activity_author_forced_for_admin` (admin sends Kais's id: stored as admin), `activity_insert_user_id_column_denied` |
| 4 | **Rewriting history (G2)** | update grant on `body` only; guard refuses any other change; author-only update policy | `activity_update_only_body` (type, outcome, company_id, contact_id each 42501), `admin_cannot_edit_others_entry`, `activity_created_at_server_time` |
| 5 | FK actions blocked by guards, or used to smuggle changes | exception only at depth > 1, FK columns to null, all else equal | `contact_delete_keeps_activities`, `deal_delete_keeps_activities`, `lead_delete_with_contact_activities`, `undo_with_touched_task`, `direct_update_contact_to_null_refused` (depth 1) |
| 6 | Back- or forward-dating the last activity | `prev_last_activity_at` trigger-set, no grant; definer trigger uses only it | `prev_last_activity_not_writable`, `undo_restores_previous_date`, `delete_old_entry_keeps_date`, `delete_on_lead_delete_ok` |
| 7 | Forging server columns (G3, G4) | column grants; triggers set `done_at`, `completed_by`, `cancelled_at`, `created_by`, `phone_wrong_at` time, `storage_path`, `status`, `uploaded_by`, `id`; generated `call_zone`/`queue_rank` | `task_done_at_is_server_time`, `task_created_by_forced`, `phone_wrong_time_forced`, `file_path_server_built`, `file_status_insert_ignored`, `queue_rank_not_writable`, `day4_server_columns_not_writable` |
| 8 | Skipping step-up for deletes; stretching the undo window | `has_recent_aal2(600)` in delete policies and the file guard; no-code branch only for own entries under 120 s **with no undo record** | `activity_delete_stale_code_denied`, `outcome_direct_delete_refused_while_undo_record` (direct PostgREST delete of a fresh outcome: 0 rows), `undo_at_119s_ok_at_121s_denied`, `task_delete_stale_code_denied`, `file_delete_stale_code_denied`; e2e `delete_note_asks_for_code` |
| 9 | Undo overwrites a colleague's change | compare-and-restore per field | `undo_skips_changed_status`, `undo_skips_changed_owner` |
| 10 | Double submit or replay | `request_id` unique **per author**; stored result returned | `log_activity_idempotent` (same id twice: 1 activity, 1 task, 1 status change), `undo_twice_second_refused`, `request_id_other_author_no_collision` |
| 11 | Outcome on a lead the caller may not change | `FOR UPDATE` row only for editors; activity logged, nothing else | `outcome_not_editable_logs_only` |
| 12 | Wrong-number mark used to pull a colleague's lead out of the queue | set only in `log_activity`'s editor branch or by an editor's direct update (RLS); no definer activity trigger | `rep_wrong_number_on_others_lead_no_mark`, `rep_direct_phone_wrong_patch_zero_rows` |
| 13 | Queue scope escalation | RPC role check; claim policy needs an editable lead | `rep_scope_team_42501`, `rep_scope_mine_unassigned_42501`, `rep_cannot_claim_others_lead` |
| 14 | **Two people get the same lead** | PK on `company_id`; take-over only after expiry; `on conflict do nothing` | `queue_concurrency.sh`: `three_workers_distinct`, `expired_claim_taken_over_once`, `fresh_claim_not_stolen` |
| 15 | Claims forged, stretched or hoarded | private schema (no endpoint); guard forces user and times; 3 live per person; 10 min | `claim_guard_forces_fields`, `claim_cap_3`, `claim_delete_other_fresh_zero_rows`; e2e `private_tables_not_exposed` (404/406 through PostgREST) |
| 16 | Do not contact ignored | rank null; outcome 7 from any status; UI hides contact actions | `dnc_never_served`, `dnc_from_customer`; e2e `dnc_lead_hides_call` |
| 17 | Calling at night in the lead's zone | `open_call_zones`; spans need both ends | `queue_skips_closed_zones`, `queue_span_needs_both_ends`, `queue_lunch_europe_only` |
| 18 | Cool off lead served at once | rank null without a date; +90 days default on entry | `cool_off_without_date_not_served`, `cool_off_entry_defaults_90_days` |
| 19 | Time-zone value injection or a raw CHECK with lead data | closed list per country; country change clears; pre-check with a constant error; profile zone in `pg_timezone_names` | `timezone_outside_country_refused`, `country_change_clears_zone`, `timezone_bad_constant_error` (planted text absent from SQLERRM and DETAIL), `profile_timezone_garbage_refused` |
| 20 | Public or listable bucket | `public = false`; three exact policies; no update policy; S3 off | `bucket_private`, `storage_policies_exact`, `object_update_denied`, `lead_files_only_bucket` |
| 21 | Arbitrary path or overwrite | insert only to the caller's own pending path under 15 min; path from UUIDs and type | `object_insert_other_path_denied`, `object_insert_after_15min_denied`, `object_overwrite_denied` |
| 22 | Signed URL leakage | 60 s; only in a same-origin 303; `no-store`; `no-referrer`; `Sec-Fetch-Site`; origin check; `max-age=0` objects | e2e `file_link_has_no_token_in_dom`, `signed_url_dead_after_60s`, `cross_site_file_request_refused`, `deleted_file_url_404` |
| 23 | File type spoofing, including a direct-API insider | browser sniff, server sniff at finish, **sniff on every open**; bucket allowlist; size and type match at finish | unit `sniff_*` (exe renamed pdf, html renamed pdf, svg, docm renamed docx, truncated zip, `%PDF` polyglot in HTML); SQL `finish_size_mismatch_refused`; e2e `renamed_exe_rejected`, `direct_api_html_as_pdf_refused_at_open` |
| 24 | Path traversal or name injection | path from UUIDs and type; name cleaned plus database CHECK | `file_name_invisible_refused` (13 names), e2e `name_dotdot_stored_as_text` |
| 25 | Quota or rate abuse, including lying about size | bucket 10 MiB; real object bytes; advisory lock; 5 pending, 30 per hour | `files_concurrency.sh quota_race` (two sessions for the last 15 MB: one wins), `declared_1_byte_counted_at_real_size`, `sixth_pending_refused`, `thirty_first_upload_refused` |
| 26 | XSS through notes, task titles, file names | React text only; no `dangerouslySetInnerHTML`; no auto-linking; `dir="auto"` | e2e `xss_note_is_text` (`<img onerror>`, `<script>`: no dialog event) |
| 27 | SQL or filter injection | static SQL; whitelisted types and buckets; Zod | `bad_types_22023`; e2e names `'); drop …` and `),id.eq.` stored verbatim |
| 28 | CSRF | server actions' Origin check; release route `assertSameOrigin`, JSON only, 32 KB; file route `Sec-Fetch-Site` | e2e `cross_site_action_refused`, `cross_origin_release_403` |
| 29 | Personal data in logs | constant pre-checks before every CHECK; no `console`; signed URLs never logged | `bad_body_constant_error`, ESLint `no-console` on new server files |
| 30 | Audit gaps or copies of notes | activity edits and deletes audited without text; outcome status changes audited; `file_access` rows | `audit_activity_insert_not_logged`, `audit_activity_delete_has_no_body`, `audit_outcome_status_change_logged`, `audit_queue_columns_not_diffed`, `audit_file_access_row` |
| 31 | Lost history or orphaned objects (G5, G7) | contact and deal FKs set null; files FK restrict; untouched rule includes tasks and files | `lead_with_files_delete_refused_23503`, `import_undo_keeps_lead_with_task`, `import_undo_keeps_lead_with_file`, `import_fk_coverage` (updated) |
| 32 | Flooding | 60 activities and 60 tasks per minute per person | `activity_rate_refused`, `task_rate_refused` |
| 33 | External links leak the lead URL, or tabnabbing | `noopener noreferrer`; digits only in `tel:` and `wa.me`; mail parts percent-encoded | unit `dial_*`, `whatsapp_*`, `mailto_crlf_blocked`; e2e `external_links_rel` |

**Residual risks accepted** (written into each `security-review.md`):
1. A signed URL works for whoever holds it, for 60 seconds. It is never in the page, the cache or the logs.
2. There is no antivirus on the free plan. PDFs open in the browser's sandboxed viewer; Office files download.
3. A stolen aal2 session without a fresh code can undo its own entries from the last 2 minutes, only through `undo_activity`, which puts the lead back. It can also delete entries it inserted directly in that window, which changed no lead.
4. A lead called from its page is not claimed. The outcome's next-call date keeps it out of the queue. At worst two calls happen minutes apart.
5. A user can add `file_access` audit rows about their own access to visible files. That is noise, not forgery.
6. Time zone data can differ between PostgreSQL and browsers. Parity tests use fixed instants, and a zone missing on either side fails CI.
7. An abandoned upload's object stays until its owner's next upload, or the Gate 1 sweeper. It is counted in the quota.

## 7 UX (DESIGN.md is the source of truth)

General rules for every screen:
- Outfit for text, DM Mono for times, counts, phone numbers and sizes.
- **Signal Red only on Call and the one primary button per screen**, with black text on red.
- Status is always a dot plus a word.
- 8 pt grid, radius 20/12, skeletons only.
- Taste Skill dials 3/5/7 before building.

### 7.1 Lead page (`/leads/[id]`, 4b)

**Server page** (`src/app/(app)/leads/[id]/page.tsx`):
- `requireSession()`; a bad UUID gives `notFound()`.
- Fetches `get_lead`, the first timeline page and `list_team` in parallel.
- `null` gives the same 404 for "missing" and "not visible".
- `loading.tsx` matches block for block: header, action row, tab strip, two-column body. Measured against the real page at 390 and 1440, as on Day 2.

**Header:**
- 44 px building tile; name (h1, Outfit 700, wraps); status badge (the status menu for editors); owner (menu for managers and admins).
- Line two: city · country (Intl name) · local time chip:
  - "14:05 in Lyon · good time to call", or "Outside calling hours · opens 09:00 (in 50 min)";
  - for a span: "13:05–16:05, US · time zone not set", with **Set** for editors;
  - when the viewer's zone differs: "14:05 there · 17:05 for you".
- Line three: "Next call: tomorrow" (Intl relative), the latest outcome, "2 tries, no answer".
- 4c adds "Henri is on this lead in the queue (until 10:24)".

**Quick actions:**
- **Call** (red): a `tel:` link built by `dialString`, opening the call panel.
- **WhatsApp:** `https://wa.me/<digits>` from `dialString`. Without a country code, the button reads "Add the country code (+33…) to use WhatsApp".
- **Email:** `mailHref`, or a menu when the lead and its contacts have several addresses.
- **Meeting:** opens the composer in "Book a meeting".
- **Note:** focuses the composer (a sheet on phones).
- After WhatsApp or Email opens, a chip offers "Log WhatsApp message" or "Log email": one tap, with Undo.
- Do not contact leads hide Call, WhatsApp and Email behind a banner: "Asked not to be contacted · Kais, 12 Oct". Numbers stay readable on Details.
- A missing channel is a hint, not a disabled button: "No phone yet · Add one" for editors.
- Zoom is not shown (Release 3).

**`dialString(phone, country)`** (`src/lib/phone.ts`; display stays as written):
- `+` keeps the digits;
- `00` becomes `+`;
- a leading `0` with a known calling code becomes `+code` without the 0, except where the trunk 0 stays (IT, SM, VA);
- 10 digits in US or CA become `+1`;
- otherwise null: Call uses the digits as written, WhatsApp shows the hint.
- The table covers about 60 market countries (EU, UK, US, CA, North Africa, Gulf, PK).
- Without this, Haider in Karachi dialling a French `06…` would reach a Pakistani number.

**Tabs:** hand-built WAI-ARIA tabs (`src/components/ui/tabs.tsx`): roving focus, arrows, Home and End, a sliding pill with Motion `layoutId` and the `smooth` spring. The current tab is in `?tab=`, written with `replaceState`. Hovering or focusing a tab prefetches its data.

| Tab | Content |
|---|---|
| Summary | Next step card (next task with its check circle and Undo, or "Next call attempt Thu ≈ 10:00 their time · Change", or "No next step" with date chips); latest 3 timeline entries; contacts (Day 3a list, each with Call, Email, WhatsApp; wrong numbers struck through with "Marked wrong · Fix"); deal card placeholder |
| Timeline | 7.2 |
| Deals (before Day 5) | "No deals yet. Deals open from this page once the pipeline is ready." No data call |
| Stock (before Day 6) | "What this lead wants and what's available will show here once inventory is set up." No data call |
| Files | hidden until 4d (D16); then 7.6 |
| Details | the Day 3a lead form; time zone (multi-zone countries only, closed list, "Automatic: US hours on both coasts"); next call date (editors, bounded); created; import (admins: "From leads.csv, 12 Oct", linking `/leads?batch=`); contacts add and edit |

**Changes to the leads list:**
- The preview gains **Open lead** (Enter, or O on a selected row; prefetched on hover).
- Rows prefetch on a 120 ms hover intent: `['lead', id]`, the first timeline page and `router.prefetch('/leads/' + id)`.
- Below `lg`, tapping a row opens `/leads/<id>`.
- On the lead page, **J/K** move to the next or previous lead of the same filtered list ("3 of 1,204"), read from the TanStack cache of the list query (hidden after a deep link).
- **Back** returns to the same list URL and scroll position (`sessionStorage`, in try/catch).

| State | 1440 | 390 |
|---|---|---|
| Layout | header full width; actions on the right; body grid `minmax(0,1fr) 360px`: tabs left, sticky rail right (composer card, next task, contacts) | back link; header stacked (name 22/28, status and owner, place and time); 5 equal labelled icon actions (Call red); tabs as a snap strip; rail sections fold into Summary; no horizontal scroll |
| Loading | `loading.tsx` skeleton | same, stacked |
| Not found | the app's translated not-found with "Back to leads" | same |
| Error | `(app)/error.tsx` keeps shell and dock, with Retry | same |
| Read-only | no edit or status menu; "Only {owner} or an admin can change this lead"; composer works | same |
| Do not contact | red-dot badge, banner, contact actions hidden | same |
| No phone / no email | hint instead of the action | same |
| Span zone | time range and "Set time zone" | same |
| Worked by someone (4c) | "Henri is on this lead in the queue" line | same |
| Offline | Save disabled: "You're offline. Your note is kept." | same |

### 7.2 Timeline and composer

**Timeline** (`src/components/activity/timeline.tsx`):
- An `ol` of `article`s, grouped under "Today / Yesterday / Mon 6 Oct" in the viewer's zone. Each entry has:
  - a type tile and title ("Call · No answer");
  - "You" or the author's name, and the contact chip;
  - `<time>` relative, with the absolute time in `title` and screen-reader text;
  - the body as text (`whitespace-pre-wrap`, `dir="auto"`, `unicode-bidi: plaintext`; never HTML, never auto-linked), clamped to 6 lines with "Show more" (`get_activity` when truncated);
  - the follow-up chip ("Follow-up Tue 14 Oct", or "done Wed").
- Filter chips: All, Calls, Emails, WhatsApp, Meetings, Notes.
- Pages of 30, loaded by an observer at the end, with a "Show older" button for keyboard users. The end says "That's the whole history". `useInfiniteQuery(['timeline', id, types])`.
- Entry menu (author only): Edit text (inline; "Edited" marker), Undo (120 s), Delete (fresh code via `useStepUp`; managers and admins also on others' entries).
- Optimistic insert with the `request_id`, confirmed or rolled back with a toast that keeps the text.

**Composer** (`src/components/activity/composer.tsx`; right rail at 1440, bottom sheet at 390):
- Segmented type: Note · Call · Email · WhatsApp · Meeting.
  - **Call:** the outcome pad (shared with the queue) plus a note.
  - **Email:** To, Subject and Body (1,500 characters at most in the link). "Open in Mail and log" opens a `mailto:` with every part encoded and logs `email · sent` with "Subject: …" and the note.
  - **WhatsApp:** "Open WhatsApp and log".
  - **Meeting:** "Held / No-show" for a past meeting, or "Book a meeting" (date chips plus a time, with the dual label "10:00 for you · 09:00 in London").
- Textarea (auto-grow, counter from 9,000); optional contact; follow-up chips Today, Tomorrow, In 2 days, Next week, Pick a date (plus an optional time).
- ⌘↩ saves. Save is disabled with a reason while invalid.
- A draft is kept per lead in `localStorage['topstock.draft.<leadId>']` (try/catch, 50 most recent), cleared on save.

### 7.3 Call panel

- `src/components/activity/call-panel.tsx`, mounted once through `CallPanelProvider` in `(app)/layout.tsx`, so a call started from the preview or the lead page survives navigation.
- A 320 px floating glass panel at the bottom right, above the dock (DESIGN.md names it). It scales up from the Call button (transform origin from its rectangle, `sheet` spring).
- Content: "Calling Maison Verdane · Amélie Laurent", the number and timer in DM Mono (client only, not stored), and **End call** (neutral dark).
- End call turns into the outcome pad, the note and "Save to timeline" (⌘↩).
- ✕ or Esc with nothing chosen gives "Call not logged · Log it". The header drags down to dismiss (rubber band and velocity projection from `src/lib/motion.ts`).
- On phones it is a bottom sheet. After `tel:` the page is hidden. On `visibilitychange` back after at least 5 s it shows "How did it go?" with "Away about 3 min". The "about" is deliberate: it is time away, not the call's length.
- `role="region"` "Call in progress", `aria-modal="false"`. End call moves focus to the pad.

### 7.4 Work queue (`/leads/queue`, 4c)

- Entry points: a "Work queue" button in the Leads toolbar, Cmd+K "Start work queue", and `G then Q`. The dock bead stays on Leads.
- **Start screen:**
  - scope control (Mine · Mine + unassigned · Team for admins);
  - counts in DM Mono: "412 to call now · 1,030 later today (from 15:00 your time)";
  - "Skip lunch (12–14) for European leads" switch (remembered for the session);
  - **Start (↩)**.

| State | 1440 | 390 |
|---|---|---|
| Working | Left (about 2/3), the card: name, status, reason chip ("Follow-up due 10:00", "First call", "Retry · 3rd try"), "Lyon, France · 10:42 their time · open until 18:00", numbers in large DM Mono each with its own Call (main line red; C dials it), contacts, last 3 notes, my open tasks, collapsible script (EN/FR by country, with a switch), "Next: Durand SARL (Lyon)". Right (360 px): outcome pad 1–7 and 0 as a vertical list with Kbd hints, note field (N), Skip (S), today's stats ("23 calls · 4 talks") | card full width with a big red Call at the top; a 2 × 4 pad of 56 px buttons resting above the dock (safe-area aware); the note opens a sheet; Skip as a link |
| Outcome 5, 6 or 0 | the pad expands inline: chips (default highlighted, ↩ confirms, Esc cancels); 6 needs a time, with the dual label | the same, in a sheet |
| Outcome 7 | one extra ↩ to confirm "Mark as do not contact?" | same |
| After an outcome | the card exits left and the buffered card enters (under 100 ms); toast "Logged: No answer · back Tue · Undo (U)" for 10 s | same |
| Loading | card-shaped skeleton | same |
| Nothing in hours | "Nobody to call right now. UK leads open at 09:00 London time (in 50 min)." plus **Show leads outside calling hours** (cards then marked amber "Outside calling hours · 05:12 their time") | same |
| All done | "Everyone due has been called. 1,203 leads have no number." | same |
| Nothing in Mine | "No leads are assigned to you." plus "Work unassigned leads" (admins) | same |
| Lost a claim race | quiet swap; toast "Henri is on that one. Here's the next." | same |
| Not saved | the rail says "1 outcome not saved · Retry"; the note is kept | a chip above the pad |
| Lead changed meanwhile | the buffered card is re-read when shown; if it became Do not contact, a banner appears and only 7 and Skip stay | same |

### 7.5 Tasks (`/tasks`, 4c; replaces the placeholder and its skeleton)

- **1440:** a single column of 880 px at most, centred.
  - Title with counts; segmented tabs Overdue · Today · Upcoming · Done (counts from `count_tasks`); scope Mine / Team (admins).
  - Quick add: input "Add a task…"; date chips Today, Tomorrow, Next week, Pick a date, plus an optional time; kind (To-do / Call / Meeting, and a meeting needs a time); "Link a lead" (combobox over `list_leads` with `p_search`, limit 8). Enter adds.
  - Rows of 56 px:
    - round check;
    - title;
    - lead link (prefetch on hover);
    - due label in DM Mono ("Today", "Tomorrow 10:00", "Mon 14 Oct"; call tasks add "10:00 their time");
    - "Overdue" in the red text token (`#B61C29` light) with the word;
    - kind icon; assignee initials in Team;
    - a ⋯ menu with Edit, Dismiss and Delete.
- **390:** a tab strip; quick add with a chips row below (horizontal scroll inside the row only); 44 px check targets; no swipe gestures (accidental completions).
- **Keyboard:** T focuses quick add (the `G then T` chord still goes to Tasks); J/K move; X or Space toggles done (optimistic, Undo); Enter opens the lead; E edits inline; D dismisses; ⌫ deletes (fresh code).
- **States:** loading skeleton rows per tab; empty per tab ("Nothing overdue.", "Nothing due today.", "Nothing planned.", "Nothing done yet."); error with Retry; a failed toggle reverts with a toast; a task on a Do not contact lead shows "Asked not to be contacted".
- **More page:** "Your time zone" (picker, plus "Use this device's zone (Asia/Karachi)").

### 7.6 Files tab (4d)

| | 1440 | 390 |
|---|---|---|
| Layout | drop-zone card "Drop files here or choose files · PDF, PNG, JPG, Word or Excel, up to 10 MB"; rows: type icon, name (truncated in the middle), size (DM Mono, Intl), uploader, date, menu Open / Download / Delete; admins see "312 MB of 800 MB" | "Add file" button (`accept` lists the types, so iPhone Safari converts HEIC to JPEG); stacked rows |

States:
- uploading row with a real progress bar and Cancel, then "Checking the file…", then the row;
- per-file errors: too big, type, "This file isn't really a PDF", storage full, too many uploads, connection lost;
- empty ("No files yet. Add quotes, price lists or photos.");
- loading, error, and "Couldn't finish deleting · Retry".

### 7.7 Keyboard

- **Digits are matched on `event.code`** (`Digit0`–`Digit7`, `Numpad0`–`Numpad7`). On Henri's and Kais's AZERTY keyboards the top row types `& é " ' ( - è à` without Shift, so `event.key` would never be "1".
- **Letters are matched on `event.key`** (C, N, S, U, T, J, K, X, E, D, O).
- Keys stay quiet while typing (`isTyping`), during IME composition (`event.isComposing`) and while a dialog is open.
- ⌘Z / Ctrl+Z undoes the last outcome when not typing.
- Every pad button has `aria-keyshortcuts`. The "?" dialog gains Lead page, Work queue and Tasks sections.

### 7.8 Motion (springs from `src/lib/motion.ts`; transform and opacity only; interruptible)

| Element | Motion |
|---|---|
| Queue advance | out x −32 with opacity 0, in from +32, `snappy`; a key mid-flight starts from where the card is |
| Tab pill | `smooth` with `layoutId` |
| Call panel | `sheet`, scaling from the Call button; drag to dismiss |
| New timeline entry or task | fades in and rises 8 px, first appearance only; others move with transforms |
| Task completion | check fill, then the row fades; the list closes the gap with Motion `layout` |
| Upload progress | `scaleX` with `smooth` |
| Presses | scale 0.97 within 100 ms |
| Toasts | `gentle` |

`prefers-reduced-motion`: instant swaps (a 120 ms fade at most), no pill slide, no rise, progress without springs.

### 7.9 Accessibility

- Tabs follow the full WAI-ARIA pattern.
- The queue card is a `region` labelled by its `h2`. After an advance, focus goes to the new `h2` (`tabIndex=-1`) in an effect after commit (Day 3b's focus-race lesson). One polite live region says "Logged No answer for Café Gamma. Next: Durand SARL, Lyon, 10:42 their time."
- The local time is not announced every minute.
- Timeline: `ol` of `article`s with `time`.
- Composer and file input are labelled, with limits in `aria-describedby`. The drop zone has a real button. `role="progressbar"` carries values.
- Status is never colour alone: dot plus word, and struck-through numbers with "Marked wrong".
- 44 px targets on phones (56 px for the pad); visible focus rings; AA contrast in both themes.
- French labels can wrap; no fixed label widths.

### 7.10 i18n

New namespaces in `messages/en.json` and `fr.json`, with ICU plurals and Intl dates, times, numbers and sizes. `messages.spec.ts` keeps EN and FR key parity.

| Namespace | Keys |
|---|---|
| `LeadPage` | `back`, `position`, `tabs.{summary,timeline,deals,stock,files,details}`, `localTime`, `localTimeRange`, `bothZones`, `goodTime`, `outsideHours`, `opensAt`, `zoneUnknown`, `setTimezone`, `nextCall`, `attempts`, `dncBanner`, `workedBy`, `readOnly`, `dealsEmpty`, `stockEmpty`, `fromImport`, `details.{timezone,auto,nextCall}`, `noPhone`, `noEmail` |
| `QuickActions` | `call`, `whatsapp`, `whatsappNeedsCode`, `email`, `meeting`, `note`, `logWhatsapp`, `logEmail` |
| `CallPanel` | `calling`, `end`, `dismissed`, `logIt`, `howDidItGo`, `away`, `save` |
| `Composer` | `types.*`, `placeholder.*`, `contact`, `followUp`, `chips.{today,tomorrow,in2days,nextWeek,pick}`, `time`, `forYou`, `inLead`, `subject`, `openMailAndLog`, `openWhatsAppAndLog`, `bookMeeting`, `held`, `noShow`, `save`, `offline`, `counter` |
| `Outcomes` | `{no_answer,voicemail,wrong_number,not_interested,interested,meeting_booked,do_not_contact,connected,sent,held,no_show}`, `effect.*` ("Status → Cool off · back on {date}"), `notEditable`, `confirmDnc`, `taskTitle.{followUp,meeting,rightNumber}`, `notSaved`, `retry` |
| `Timeline` | `filters.*`, `today`, `yesterday`, `empty`, `error`, `edited`, `you`, `showMore`, `loadOlder`, `end`, `undo`, `undone`, `edit`, `delete`, `deleteConfirm.*`, `followUp`, `followUpDone` |
| `Queue` | `title`, `start`, `scope.{mine,mineUnassigned,team}`, `callableNow`, `laterToday`, `skipLunch`, `reason.*`, `attempt`, `skip`, `next`, `script.title`, `script.body`, `lastNotes`, `stats`, `empty.{allDone,outsideHours,noneMine,noNumber}`, `showOutside`, `outsideCard`, `lostClaim`, `keysHint` |
| `Tasks` | `title`, `tabs.*`, `scope.*`, `quickAdd.*`, `chips.*`, `kinds.*`, `linkLead`, `overdue`, `theirTime`, `empty.*`, `error`, `done`, `dismiss`, `undo`, `deleteConfirm`, `dncLead` |
| `Files` | `drop`, `choose`, `limits`, `uploading`, `checking`, `cancel`, `open`, `download`, `delete`, `deleteConfirm`, `usage`, `empty`, `errors.{tooBig,type,mismatch,quota,rateLimited,tooManyPending,unavailable}`, `unavailable.*`, `retryDelete` |
| Existing | `Profile.timezone*`, `Shortcuts.*`, `Palette.startQueue`, `Leads.{openLead,workQueue,untilWhen}`, `StepUp.bodyDelete` |

**FR wording:** "File d'appels", "Historique", "Résumé", "Affaires", "Stock", "Fichiers", "Détails", "Tâches · En retard · Aujourd'hui · À venir · Terminées", and the outcome labels in 5.5. French typography (non-breaking space before `:` and `?`, "le 1er") follows the Day 3b pattern.

## 8 Tests and evidence

### 8.1 Database attack tests (`scripts/db-test.sh` and `db.yml`; each file redefines `pg_temp.as_user` and reuses the fixtures `a`, `a1`, `b1`, `c1`)

| PR | File | Covers |
|---|---|---|
| 4a | `supabase/tests/activity_attack.sql` | threats 3 to 7, 10 (indexes), 29 to 32 for activities and tasks; the FK-exception cases; untouch cases; `audit_*`; `import_undo_keeps_lead_with_task` |
| 4b | `supabase/tests/outcome_attack.sql` | the **outcome table** (8 outcomes × 4 starting statuses → status, next action window, tasks made, completed or cancelled, wrong-number marks, owner rule); the 6-in-a-row rule; `undo_*`; `outcome_not_editable_logs_only`; timezone rules; `overdue_lead_still_editable`; `cool_off_entry_defaults_90_days`; `next_working_day` cases (Friday 17:30 → Monday 09:00 local; DST days); `timeline_keyset_stable` (20 rows with the same `created_at`, pages of 7: no repeats or gaps); `bulk_update_cool_off_with_date` |
| 4c | `supabase/tests/queue_attack.sql` | scope and claim rules; the shared call-window cases; **`queue_order_fixture`**: 12 leads (a due follow-up on a cold lead, negotiation, warm, cold never called, cold retry due, cool off returning, cool off without a date, a future retry, do not contact, disqualified, customer, no number, wrong main line with a contact number) must come back in exactly that expected order, with the excluded ones absent; `call_zone_matches_map`; `has_contact_phone_follows_contacts`; task buckets in Europe/Paris and Asia/Karachi |
| 4d | `supabase/tests/files_attack.sql` | threats 20 to 25 and 31; real storage schema in CI; a storage stand-in in `shim.sql` locally (`storage.buckets`, `storage.objects` with RLS on, `storage.foldername`) |

**Fixture updates:**
- `rls_attack.sql`:
  - tasks get `company_id`;
  - the rep's call gets an outcome and loses `deal_id`;
  - section 3b updates `title` instead of `updated_at`;
  - section 3d expects 42501 for a client-sent `created_at`;
  - in 4d, files move to `company_id`, and the admin lead-delete case first deletes that lead's file rows, plus `lead_with_files_delete_refused_23503`.
- `import_attack.sql`: the FK list and the untouched cases.

### 8.2 Concurrency (two or three psql sessions; wired into `db-test.sh` and `db.yml`)

`supabase/tests/queue_concurrency.sh`:
- `three_workers_distinct`: 3 sessions × 50 claims on 120 eligible leads. Results go to an unlogged superuser table, and overlapping live claims must be 0.
- `claim_race_one_winner`: one session holds its transaction with `pg_sleep`.
- `expired_claim_taken_over_once`.
- `outcome_parallel_attempts_two`: two `no_answer` at once give 2 attempts and the 2-day rule.
- `outcome_vs_contact_edit_no_deadlock`: a wrong-number outcome against a contact phone edit on the same lead, `deadlock_timeout = 200ms`, no deadlock.
- `outcome_replay_idempotent`.

`supabase/tests/files_concurrency.sh`: `quota_race`.

### 8.3 Mutations (each must fail at least one check; `docs/evidence/day4x/mutations.md`)

**4a:**
1. Put back the manager exception in `activities_insert`.
2. Drop the guard's author line.
3. Grant `update (outcome)`.
4. Drop the FK-exception depth condition, so a depth-1 null update passes.
5. Remove the FK exception, so contact delete must fail the test.
6. Remove `has_recent_aal2` from `activities_delete`.
7. Let the untouch trigger use the max of remaining activities only.
8. Contact FK back to cascade.
9. Put the body back in audit rows.
10. Drop `tasks` from untouched.
11. Let `task_guard` keep the client's `done_at`.
12. Remove the `source_activity_id` ownership check.
13. Remove the rate guard.

**4b:**
1. Remove the compare in undo.
2. Drop the "no undo record" condition from the delete branch.
3. Drop the undo time bound.
4. Apply decisions for non-editors.
5. Reverse the lock order (deadlock test).
6. Remove the country-change clear.
7. Check `next_action_at` bounds when unchanged.
8. Remove the Cool off default.
9. Drop the `request_id` unique index.
10. Change the keyset `<` to `<=`.
11. Mark the wrong number for non-editors.

**4c:**
1. Remove the scope check.
2. Remove `expires_at <= now()` from the claim delete policy.
3. Drop the claim PK.
4. Let the claim guard keep the client's `expires_at`.
5. Remove the editor condition from `claims_insert`.
6. Let `queue_rank` include `do_not_contact`.
7. Drop the no-number rule from the rank.
8. Drop the hours filter.
9. Judge a span on its eastern zone only.
10. Serve Cool off without a date.

**4d:**
1. Remove the path prefix check.
2. Remove `status = 'pending'` from the insert policy.
3. Add an update policy.
4. Remove step-up from `ready → deleting`.
5. Remove the size and type match at finish.
6. Count declared sizes in the quota.
7. Remove the advisory lock.
8. Files FK to cascade.
9. Make `storage_path` client-written.
10. Make the bucket public.
11. Skip the sniff on open.

### 8.4 Unit tests (`npm run test:unit`, no browser)

- `day4-parity.spec.ts`: activity types, outcomes, task kinds, file types, `STEP_UP_SECONDS`, the 120 s undo, the 09:00/18:00 and lunch constants, all against the migrations.
- `activities.spec.ts`, `tasks.spec.ts`: strictObject; outcome by type; follow-up rules; extra keys, control characters and over-long fields rejected.
- `zone-map.spec.ts`, `call-window.spec.ts` (5.1); `next-working-day.spec.ts` (shared-literal cases with SQL).
- `phone.spec.ts`:
  - FR `06 12 34 56 78` → `+33612345678`;
  - UK `07700 900123` → `+447700900123`;
  - IT `02 1234 5678` → `+390212345678`;
  - US `(212) 555-0149` → `+12125550149`;
  - `+` and `00` prefixes; 5 digits → null.
- `mailto.spec.ts`: subject and body with `? & \r\n` and emoji are encoded; CRLF cannot add headers.
- `outcome-keys.spec.ts`: `{code:'Digit1', key:'&'}` → no_answer; `Numpad7` → do_not_contact; `Digit0` → Spoke; typing in the note or during composition is ignored.
- `task-dates.spec.ts`: chips in Europe/Paris and Asia/Karachi, across DST, "next week" on a Sunday, and the dual-zone labels.
- `file-sniff.spec.ts` (minimal fixtures built in the test, including stored-zip DOCX and XLSX with and without `vbaProject.bin`) and `file-name.spec.ts`.
- `messages.spec.ts` (exists).

### 8.5 End-to-end (CI `auth-journey`, real local Supabase; WebKit `testMatch` gains `lead-page|queue|tasks`; `storage-api` enabled from 4d)

- **4b** `tests/auth/lead-page.spec.ts`:
  - `open_from_list_and_back_keeps_filters_and_scroll`, `j_k_through_list`, `header_local_time_london` (`page.clock`), `span_zone_shows_range_then_set_zone`;
  - `call_panel_each_outcome` (activity, status, next action and task checked through the API), `call_panel_survives_navigation`, `phone_return_how_did_it_go` (dispatches `visibilitychange`);
  - `email_open_mail_then_one_tap_log` (the `mailto:` href asserted), `whatsapp_link_international`;
  - `note_edit_marks_edited`, `undo_within_window`, `delete_note_asks_for_code` (`ageStepUp`), `draft_survives_reload`;
  - `read_only_lead_logs_but_no_status`, `dnc_lead_hides_call`, `xss_note_is_text`, `timeline_pages_keyset` (60 entries), `deals_stock_empty_states`, `status_menu_cool_off_until_when`;
  - `phone_390_full_flow` (`scrollWidth === clientWidth`).
- **4c** `tests/auth/queue.spec.ts`:
  - `keys_each_outcome`, `azerty_digits` (`code: 'Digit1', key: '&'`), `skip_and_undo`, `undo_reclaims_lead`, `interested_chips_enter`, `meeting_requires_time`;
  - `outside_hours_state_then_show_outside` (clock at 07:00 Paris), `dnc_never_served`, `keyboard_only`, `note_typing_does_not_trigger_keys`;
  - `offline_outcome_retried_once` (`page.route` aborts, then restores: one activity), `pagehide_releases_claims`, `rep_sees_only_mine`.
- **4c** `tests/auth/queue-multi.spec.ts`: three browser contexts (Haider, Henri, Kais test users) start together on 30 eligible leads. No lead is on two screens at once, and every outcome lands once.
- **4c** `tests/auth/tasks.spec.ts`: `quick_add_chips_buckets`, `toggle_done_undo`, `dismiss_and_undo`, `karachi_today_boundary` (profile Asia/Karachi, clock 23:30 Paris), `team_scope_admin_only`, `delete_needs_code`, `keyboard_only`.
- **4d** `tests/auth/files.spec.ts` (CI only, because it needs the real storage-api; the local skip is logged as a waiver):
  - `upload_pdf_progress_then_open`, `renamed_exe_rejected`, `docm_renamed_docx_rejected`, `too_big_rejected_before_upload`;
  - `direct_api_html_as_pdf_refused_at_open`, `delete_needs_fresh_code`, `file_link_has_no_token_in_dom`;
  - `signed_url_dead_after_60s` (one real 61 s wait), `rep_cannot_open_others_file`, `quota_message` (quota lowered by a test-only SQL fixture), `name_accents_download`.
- **Every PR** `tests/auth/day4-security.spec.ts`: `rep_direct_rpc_scope_403`, `private_tables_not_exposed` (`activity_undo`, `queue_claims`: 404, and `Accept-Profile: private` → 406), `cross_site_action_refused`, `cross_origin_release_403`, `external_links_rel`, `error_copy_has_no_sql`, `no_console_errors_no_csp_violations`.
- **Screens** `tests/auth/day4-screens.spec.ts`: every screen and state in section 7 at 1280, 1440, 1728 and 390, plus 768 and 1024 (new layouts), light and dark, EN and FR. URL asserted before each shot. Output to `test-results/day4-screens`.

### 8.6 Performance (numbers to hit)

**Database:** `scripts/db-perf.sh` with a new `supabase/tests/perf_day4.sql`, on the same throwaway PG16.

- **Seed:**
  - 30,015 leads (10k per owner): 60% FR, 15% GB, 15% US (two thirds with an explicit zone), 10% DE/BE/ES; 40% outside hours at the test instant; 8% with no number; 3% with a wrong main line but a contact number; 2% Do not contact;
  - 300,000 activities (250k spread, plus 50k on 25 leads, one lead with 10,000);
  - 15,000 tasks (5k per person, 30% done); 200 live claims.
- **Seeding method:** activities are inserted with `session_replication_role = replica`, then the lead facts are set in one update, then `vacuum analyze`.
- **Timing method:** average of 5 warm runs; **each case executed 10 times, with plans 6 and later logged by `auto_explain`** (generic-plan check). If a generic plan loses the ordered index scan, that function gets `set plan_cache_mode = force_custom_plan`. Three full runs.

| # | Case | Budget (database time) |
|---|---|---|
| P1 | `get_lead` (typical / lead with 10k entries) | ≤ 8 / ≤ 12 ms |
| P2 | `list_lead_activities` page 1 / at row 5,000 / Calls filter | ≤ 5 / ≤ 8 / ≤ 10 ms |
| P3 | `claim_next_lead` Mine typical | ≤ 25 ms |
| P3b | worst case: 90% of Mine closed, never-called US leads at the head of rank 3 (Tue 08:00 UTC) | ≤ 60 ms |
| P3c | Team / Mine + unassigned (plan shows Merge Append) / with 200 excluded | ≤ 40 / ≤ 40 / ≤ 30 ms |
| P4 | `log_activity` with task creation, auto-complete and contact mark | ≤ 15 ms |
| P4b | `undo_activity` | ≤ 15 ms |
| P5 | `list_tasks` per bucket / `count_tasks` | ≤ 15 / ≤ 10 ms |
| P6 | `queue_summary` | ≤ 80 ms |
| P7 | Day 3b import commit chunk with `lead_guard` and generated `call_zone`; Day 3b undo chunk with the new untouched rule | average within +10% of `day3b/perf.md` (169–207 ms and 140–206 ms) |
| P8 | Day 3a list cases | no case more than 20% slower than `day3a/perf.md` |
| P9 | `open_call_zones` cold backend / warm | ≤ 50 / ≤ 2 ms |
| P10 | 3 concurrent sessions × 100 claim-plus-outcome rounds | p95 claim ≤ 60 ms; 0 duplicates; 0 deadlocks |
| P11 | `begin_file_upload` / `finish_file_upload` (stand-in objects, 5k files) | ≤ 10 ms each |

**Browser:** `tests/auth/day4-perf.spec.ts` (`PERF=1`, Chromium, 4× CPU).
- Queue key to next card painted: ≤ 100 ms p95 over 30 advances (from the buffer).
- Key to "outcome saved": recorded p95. This number feeds the D3 switch rule (400 ms).
- 10 keys in a row: the buffer never shows a skeleton card more than once.
- Longest task during an advance: ≤ 50 ms.
- Lead page route change with hover prefetch: ≤ 200 ms to content. Cold deep-link LCP ≤ 2 s; CLS ≤ 0.05.
- Tab switch: ≤ 100 ms.
- Timeline with 1,000 loaded entries scrolls at 60 fps (frame times recorded). Otherwise fall back to TanStack Virtual (D13).
- Route chunk sizes from `next build`: lead page ≤ 60 KB extra gzip, queue ≤ 40 KB, tasks ≤ 35 KB.

### 8.7 Evidence bundle (per PR: `docs/evidence/day4a|day4b|day4c|day4d/`)

- This design as `docs/evidence/day4/design.md`, referenced by each folder, with "as built" corrections.
- `perf.md` (3 runs and plans) and `mutations.md`.
- `security-review.md`: `/security-review` on the final head, the threat table re-checked, and the residual risks.
- UI PRs (4b to 4d): `apple-design-audit.md`, `web-design-guidelines.md` (unresolved: none), and `screens/` (a representative set; the full matrix as a CI artifact).
- Supabase advisors:
  - local splinter in CI: 0 ERROR; accepted WARN `set_user_role`, plus `private.audit_file_access` in 4d if flagged;
  - dev dashboard advisors through read-only MCP after each `deploy-dev-db`.
- Context7 lookups named per PR:
  - Next 16 route handlers and `redirect` 303, `router.prefetch`, `loading.tsx`;
  - TanStack Query v5 infinite queries and optimistic mutations;
  - Motion `layoutId`, `AnimatePresence`, `layout`;
  - next-intl `useFormatter` with `timeZone`;
  - storage-js `upload`, `createSignedUrl` with `download`, `remove`, the REST upload endpoint and headers, and Range;
  - Supabase CLI bucket config and seeding;
  - MDN `KeyboardEvent.code` and `Intl.supportedValuesOf`.
- CI links: quality, semgrep, gitleaks, rls, auth-journey (Chromium and WebKit), Vercel preview. `npm audit`.
- `docs/log.md` lines: decisions D1 to D17 (D9 explicitly reverses the Day 3a rule), the read-only MCP pre-checks, spike results S1 to S5, waivers (files e2e local skip).
- The advisor's final verdict pasted into the REPORT (START_HERE section H).

## 9 Dependencies

- **No new runtime dependency.**
  - Tabs are hand-built (D12).
  - Time zones, dialling strings, file sniffing, file names and date chips are own code with unit tests.
  - Uploads use `XMLHttpRequest` for real progress.
- **Deliberately not added:**
  - `@radix-ui/react-tabs` (D12);
  - `libphonenumber-js` (phones stay as written; `dialString` covers the markets; E.164 stays deferred, Day 3b);
  - a date library (Intl plus `AT TIME ZONE` in SQL);
  - a zip library (the sniffer reads the central directory without decompressing);
  - an antivirus service (none free on Vercel or Supabase Free).
- **CI:** `storage-api` stops being excluded in `auth-journey` from 4d, and in `db.yml` per S1. New steps in `db.yml`: `activity_attack.sql`, `outcome_attack.sql`, `queue_attack.sql`, `queue_concurrency.sh`, `files_attack.sql`, `files_concurrency.sh`.

## 10 Build order (four PRs; each one branch, small commits, merged under Haider's standing permission only after advisor APPROVED and every check green)

**4a Activity hardening** (database only; branch from `main`)
1. Read-only MCP pre-check on dev (activities, tasks and files counts; activity type and outcome groups). Log it.
2. Spike S5 on PG16. Record the result in `docs/log.md`.
3. Migration part 1: activities columns, constraints, indexes, FKs, grants, guard, policies, untouch trigger.
4. Part 2: tasks columns, FKs, constraints, indexes, grants, guard, policies.
5. Part 3: `audit_row` activity rules; `lead_import_untouched` plus tasks.
6. Fixture updates in `rls_attack.sql` and `import_attack.sql`.
7. `activity_attack.sql`; wire it into `db-test.sh` and `db.yml`; mutations.
8. `perf_day4.sql` part 1 (P2, P7, P8); 3 runs.
9. Splinter.
10. `/security-review`, gitleaks, npm audit, Semgrep, lint, typecheck, full Playwright (no UI change, so existing suites must pass unchanged).
11. Evidence in `day4a/`; log lines (D8, D9); advisor loop; REPORT; merge; `deploy-dev-db`; dev advisors.

**4b Lead page**
1. `scripts/make-zone-map.mjs` and the overrides; the generated TS and SQL; parity tests.
2. Migration: zone functions and grants; companies and contacts columns; `lead_guard`, `contact_guard`; audit exclusions; `activity_undo`; the undo delete branches; `bulk_update_leads` recreated; helpers; RPCs.
3. `outcome_attack.sql`; mutations; perf part 2 (P1, P4, P4b).
4. `src/lib/{activities,tasks,timezones,phone,db-errors}.ts`; unit specs.
5. Actions and the activities route.
6. UI: `ui/tabs.tsx`, `ui/textarea.tsx`; `CallPanelProvider` in `(app)/layout.tsx`; `/leads/[id]` (page, `loading.tsx`, `src/components/lead/*`, `src/components/activity/*`); preview Open; hover prefetch; J/K; Back restore; status menu "Until when?".
7. Messages EN and FR.
8. E2e, screenshots, `/apple-design` and web-design-guidelines audits, fixes.
9. Reviews, evidence, advisor, REPORT, merge, deploy, dev advisors.

**4c Tasks and work queue**
1. Migration: `has_contact_phone` and its trigger plus backfill; generated `call_zone`/`queue_rank` and indexes; window functions; claims; task indexes; profile zone check; RPCs; `get_lead` `worked_by`; FK coverage.
2. `queue_attack.sql`, `queue_concurrency.sh`, shared call-window cases, mutations.
3. Perf part 3 (P3 to P6, P9, P10), with the generic-plan check.
4. `src/lib/{queue,http}.ts`; unit specs.
5. Queue actions and the release route; task actions and route.
6. UI: `/tasks` (replaces the placeholder and its skeleton), `/leads/queue` (page, `loading.tsx`, `src/components/queue/*`, `use-queue.ts` with buffer, renewal, `pagehide` release and the pending-outcome store); More time zone; entry points (toolbar, Cmd+K, `G then Q`, `T`).
7. Messages; e2e including `queue-multi` and `day4-perf`; screenshots; audits; reviews; evidence; advisor; REPORT; merge.

**4d Files**
1. Spikes S1 to S4, logged with their decisions.
2. Read-only MCP pre-check (0 file rows).
3. Migration; the `shim.sql` storage stand-in; `files_attack.sql`, `files_concurrency.sh`; mutations; P11.
4. `sniff.ts`, `name.ts`, `upload.ts` with unit tests.
5. File actions, `/api/files/[id]` (with the open check), `/files/unavailable`.
6. Files tab UI; enable `storage-api` in `auth-journey` (and `db.yml` per S1); `config.toml` S3 off, with the push checked.
7. E2e (CI), screenshots, audits, reviews, evidence, advisor, REPORT, merge.

## 11 Open questions for Haider (recommendation first)

Haider is away. The build follows each recommendation, and each one is a small change if he says otherwise. The answers are collected for his check-in.

1. **Calling hours: Monday to Friday, 9:00 to 18:00 in the lead's own time (recommended).** A switch on the queue can skip 12:00 to 14:00 for European leads. It is **off by default**; turn it on if lunchtime calls go badly. Different hours?
2. **Trying again (recommended):**
   - after no answer, the next working day;
   - after a voicemail, two working days later;
   - after 6 tries in a row without reaching anyone, the lead rests in Cool off for 30 days;
   - after "Spoke" with no next step, it comes back in 30 days.
3. **"Not interested" puts the lead in Cool off for 90 days, then it comes back (recommended).** Any lead put in Cool off without a date also comes back after 90 days, including the Cool off rows in your sheet. The alternative is Disqualified, never called again.
4. **A 7th key, "Do not contact" (recommended, for GDPR).** It takes the lead out of every queue at once and hides Call, WhatsApp and Email on its page.
5. **Unassigned leads:** you three can work them from "Mine + unassigned". Whoever marks one Interested or books a meeting becomes its owner (recommended). Or keep them unassigned?
6. **Files:** 10 MB per file and 800 MB for the team on the free plan. PDF, photos (PNG, JPG), Word and Excel only. No virus scanning (there is no free option); every file is checked to be a real PDF, photo, Word or Excel file when it is uploaded and every time it is opened. OK? For large catalogues, 20 MB per file is possible, but the 1 GB fills faster.
7. **Who sees tasks and files on a lead: keep today's rule (recommended).** A person sees their own, the lead's owner sees the lead's files, and managers and admins see everything. All three of you are admins, so nothing changes for you. It only matters for future reps. The alternative shows every lead's tasks and files to the whole team.
8. **Deals and Stock tabs: show them now with a "nothing yet" message (recommended),** so the page layout stays the same when Days 5 and 6 fill them. Or hide them until then?
9. **Call script:** send me yours in English and French, or I write a short default. Editing it inside the app comes later.
10. **Your time zone:** "Today" on your tasks follows the zone on your profile. The app will suggest Asia/Karachi from your browser. Please confirm.
11. **US, Canadian and Australian leads:** we only know the country, so the queue calls them only when it suits the whole country (US: 12:00 to 18:00 New York, which is 9:00 to 15:00 Los Angeles), until someone picks the lead's zone with one click (recommended). The alternative is a city list that guesses the zone (the Master Plan's "and city where present"), about half a day of work. Worth it if many of your leads are American.
12. **"Last activity" when the newest call is undone or deleted (recommended: it goes back to the previous date).** Day 3a kept the date as it was. Now an undone call no longer leaves a date with no call behind it, so the date stays accurate, as you asked.
13. **For your information:** when a note is deleted, its text is gone for good. The audit log keeps who, when, the type and the length, not a hidden copy (good for GDPR). Say so if you would rather keep deleted text for admins.

## 12 Deferred (with reasons)

**Later days and releases**
- **Opening a deal from Interested; deal cards; the Deals tab content:** Day 5. `activities.deal_id` returns to the insert grant then, with a same-lead check.
- **Stock tab content:** Day 6 (products don't exist yet).
- **Zoom, call recording, stored call length and talk metrics:** Release 3. The panel's timer is not stored: a browser-reported length could be faked, and nothing uses it before Release 3.
- **Dock badge for tasks due:** Day 5 Home shows tasks due. Judges called the badge scope creep for Day 4.
- **Swipe gestures on phones:** Day 7 animation polish. Accidental completions are a risk.
- **Offline outcomes beyond this tab's session:** PWA work on Day 7.

**Gate 1**
- **Rate-limit table and the daily security digest including `file_access`:** Gate 1 (Master Plan items 28 and 43). Activity, task and upload guards are already in.
- **Sweeping stray objects of people who never upload again:** needs the service key, which belongs only in the Gate 1 ops setup.

**Changes to approved Day 3 screens and queries**
- **A "Callable now" or time zone filter on the leads list:** it would recreate the approved `list_leads`/`count_leads` signatures again. The queue covers it.
- **"Work these" (start the queue from the list's filters):** optional filters in the claim query would break the per-rank index walk and the generic-plan discipline. Revisit after real use.
- **Cmd+K lead search:** scope creep for Day 4; the leads list search covers it.

**Rejected designs**
- **The 5-second deferred commit:** rejected (D2).
- **Status and owner changes as timeline entries:** they would change the Day 3a timeline meaning and double its volume. The audit log records them for admins.

**Product features not needed for Release 1**
- **City → time zone inference for multi-zone countries:** open question 11.
- **Editable call scripts, hours per person, public holidays in the calling window:** a settings surface and a per-country calendar; Release 2.
- **Snooze key, bulk "next call" and bulk time zone:** single-lead Details first; bulk after real use.
- **Task reminders, notifications, recurring tasks, calendar view:** there is no push or email channel until the PWA and custom SMTP work.
- **Files on contacts, file versions, renaming, folders:** not needed for Release 1; files belong to the lead.
- **A lead delete screen:** files must go first (`on delete restrict`, 23503 "Delete this lead's files first") and it needs step-up. Not in Release 1's scope.
- **Back-dating a logged call ("I called this morning"):** server time only, so last activity and analytics stay honest. The note can say when.

**Free-plan limits and tooling**
- **Image thumbnails and inline previews:** they need CSP `img-src` for the Supabase origin and add egress (5 GB a month). Image transformation is a paid feature.
- **Virus scanning:** no free scanner. Mitigated by the type allowlist, the macro refusal, checks on upload and on every open, attachment downloads and team-only uploads. Revisit at the Pro upgrade.
- **E.164 rewriting and libphonenumber:** deferred since Day 3b. `dialString` covers the main markets.
- **Search across all activities:** at 300k rows a year, under RLS it needs its own design.
