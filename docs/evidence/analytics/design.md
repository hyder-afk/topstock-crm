# Analytics v1: design (data that exists today)

Status: design only, nothing built. Branch `analytics` (from origin/main 7cf424e), 17 Oct 2026.
Why: Haider, 16 Oct 2026: "nothing shows on analytics i want visuals". The Analytics tab
(`src/app/(app)/analytics/page.tsx`) is still the Day 2 placeholder. Master Plan section 11 puts sales analytics in
Release 3 together with Zoom. This design brings forward an **Analytics v1 built only from tables that already exist**:
no Zoom, no targets table, no new tables. Sources of truth: CLAUDE.md, DESIGN.md (visuals), Master Plan sections 4, 5,
6, 8 and 11. Where this file and the Master Plan disagree on visuals, DESIGN.md wins.

Contents: 0 Summary · 1 Scope and metric definitions · 2 Filters · 3 Data layer · 4 UI · 5 Tests · 6 Build order and
open questions · Appendix A, facts checked in the repo.

---

## 0 Summary (plain words)

- One page with two sections. **This period** has KPI tiles, Calls over time, Speed-to-lead, the deal funnel, lost
  reasons, best time to call, sales, and a per-person table for managers and admins. It follows the date range and
  person filters. **Right now** shows coverage (untouched leads, no next step, overdue tasks) and list quality for each
  import. It is a current snapshot, so it follows the person filter but not the dates, and the page says so.
- The database does all the counting. There are seven read-only SQL functions, each SECURITY INVOKER with static SQL,
  one per block. The browser only ever gets totals and buckets, never rows of leads.
- Who sees what:
  - **Reps** see only their own numbers.
  - **Managers and admins** see the team and can pick one person.
  - **Admins** also see list quality per import, because import batches are admin-only under RLS today.
  - All three current users are admins, so today everyone sees everything.
- Look: monochrome ink marks on cards, with Signal Red only on the datum under the pointer or keyboard focus. Status
  colours appear only as labelled dots, as everywhere else. Recharts 3.10.1 is pinned and lazy-loaded, its own
  animation is off, and entrances are transform/opacity springs on first visit only. Every chart has a caption, a
  keyboard path and a "Show as table" view. Text is in EN and FR, and numbers, money (EUR) and dates use Intl.
- Deferred to R3, with reasons in 1.9: Zoom call metrics, targets, leaderboard, weighted forecast and velocity,
  per-source and per-country quality, and coaching.
- Build in six small PRs (section 6). The first is database only: functions, attack tests and timings.

---

## 1 Scope v1, block by block

### 1.0 Rules shared by every block

| Rule | Definition |
|---|---|
| Time zone | **Europe/Paris** for every bucket, range bound and hour (the business's zone; `list_sales` already uses it: `20261019090000_sales_requests.sql:1667`). A range `from..to` (dates, inclusive) is the instants `[from 00:00 Paris, to+1 00:00 Paris)`, computed as `p_from::timestamp at time zone 'Europe/Paris'`, so a 23 or 25 hour DST day is still one day. Home uses the caller's profile zone (`private.caller_zone()`); all three profiles are `Europe/Paris` (the column default), so the numbers agree today. See open question Q2. |
| Buckets | Ranges of 31 days or fewer use **day** buckets. Longer ranges use **ISO weeks** (Monday start, `date_trunc('week', ts at time zone 'Europe/Paris')`). The first and last week may be partial; they are flagged `partial: true` and the tooltip says "partial week". The server fills empty buckets with zeros (`generate_series`), so charts never skip a day. |
| Range limits | `from <= to`, at most 366 days, `to` no later than Paris today. Anything else is refused: 22023, hint `bounds`. |
| "Reached" call | `outcome in ('connected','interested','meeting_booked','not_interested','do_not_contact')`. This is exactly Home's K4 list (`20261015150000_home_dashboard.sql`, calls_today). `no_answer`, `voicemail` and `wrong_number` are dials that did not reach anyone. A call always has an outcome (`activities_outcome_fits_type`). One TS constant `REACHED_OUTCOMES` is checked against both SQL texts by a parity test. |
| Who a number belongs to (rep filter) | Activities: `activities.user_id` (the author, always the signed-in person: Day 4a). Deals: `deals.owner_id` (the **current** owner; Q5). Leads: `companies.owner_id`. Tasks: `tasks.assignee_id`. Sales: `private.orders.created_by` (who recorded it; Q6). Team view: unassigned leads and deals count in team totals only. Entries whose author was deleted (`user_id` null) count under "Former team members". |
| Money | `numeric` sums are returned as text `numeric(16,2)`, the same as Home (`total` regex in `src/lib/home.ts`). Deal values are summed, never compared (the Day 5a leakproof rule). EUR only (`deals_currency_eur`). Sales are excluding VAT (`order_lines.unit_price`). |
| Minimum samples | A win rate shows from 5 closed deals (Home's D27, `WIN_RATE_MIN_CLOSED`). The median cycle shows from 3 won deals. A heatmap cell shows from 5 calls. Connect rate always shows, with its "x of y" counts next to it. |

### 1.1 Activity

| | |
|---|---|
| Source | `public.activities (user_id, type, outcome, created_at)`; types `call`, `email`, `whatsapp`, `meeting`, `note` |
| Metrics | Per bucket: calls, reached calls, emails, WhatsApp messages, meetings logged (meetings held = `outcome='held'` in the totals). Totals, and connect rate = reached / calls (null when there are 0 calls). Team view adds one row per person with the same totals. |
| Date column | `activities.created_at`. It is server time for app entries (`set_activity_time`) and can never be moved later. |
| Edge cases | Notes are not activity: they are left out of every count. Emails and WhatsApp messages are counted when logged (`outcome` null or `sent`), because the app opens the mail app and logs on one tap. Entries undone within 2 minutes are deleted rows, so they never count. Import or maintenance sessions may write historical `created_at`, and those land in their real Paris day. A deleted author's entries (`user_id` null) are included in team totals. |

### 1.2 Pipeline

| Metric | Definition (deals in scope; RLS also limits a rep to their own deals) |
|---|---|
| Opened | `deals.created_at` in range: count, `sum(value)`, and how many have no value yet (`value is null`) |
| Won | `status='won' and closed_at` in range: count and `sum(value)`. Current status: a deal won and then reopened leaves the count, as Home's K2 does. |
| Lost | `status='lost' and closed_at` in range, excluding `lost_reason='mistake'`. "Opened by mistake" is shown separately as a footnote and never counts as a loss. |
| Win rate | won / (won + lost without mistake) among deals closed in range. null below 5 closed, and the UI then says "Not enough closed deals yet". |
| Cycle | For deals won in range: `closed_at - created_at` in days. The **median** is the headline (robust with a handful of deals); the mean and n go in the table. null below 3 won. A reopened-then-won deal measures from its first open to its last close. |
| Funnel | Cohort = deals opened in range. A deal "reached" a stage when it has a **non-undone** `deal_stage_history` row with that `to_stage` or a later one (positions lead 1, qualified 2, negotiations 3), so a jump from Lead straight to Negotiations counts Qualified as passed. A row is undone when `kind='undo'`, or when another row has `undoes = id`. Won uses current `status='won'`. Also returned: still open, lost (excluding mistake), mistake. The UI notes that a recent cohort is still maturing. |
| Days in stage | For each non-undone history row whose next non-undone row (`lead()` over `(deal_id order by id)`) falls in the range: `next.created_at - this.created_at`, grouped by this row's `to_stage` in (lead, qualified, negotiations). Median days and n. |
| Lost reasons | Deals lost in range, grouped by `lost_reason`, using the 8 codes of `deals_lost_reason_code` and the existing `LostReasons` messages. `lost_note` is never read. |
| Team view | Per owner: opened, won count and value, lost, win rate (with the same min-5 rule). |

Sources: `public.deals (owner_id, status, value, created_at, closed_at, lost_reason)`,
`public.deal_stage_history (deal_id, kind, to_stage, undoes, created_at)` (its RLS follows deals:
`deal_history_select`), and `public.pipeline_stages (key, position)`.

### 1.3 Speed-to-lead

| | |
|---|---|
| Source | `public.companies (id, owner_id, created_at, import_batch_id)`, plus the first activity per lead from `activities_company_keyset_idx (company_id, created_at desc, id desc)` |
| Population | Leads **added by hand** (`import_batch_id is null`) created in range. Imported leads arrive 30k at a time, so their "created" time is the import, not an enquiry; they are measured in List quality instead (1.5). |
| Metric | First touch = earliest activity on the lead with `type in ('call','email','whatsapp','meeting')` and `created_at >= lead.created_at`, by anyone (activities are readable org-wide, so a colleague's first call counts). The headline is the median time to first touch over touched leads. Also returned: % touched within 1 h and within 24 h of **all** leads in the cohort, and counts in buckets `lt1h`, `lt24h`, `lt3d`, `gte3d`, `none` (not touched yet). |
| Edge cases | Wall-clock time, not business hours (Q4): a lead added Friday 19:00 and called Monday 09:00 counts as 62 h. Notes do not count as a touch. A lead created near the end of the range is "not yet" until touched; the bucket is labelled "Not yet", not "missed". A lead later deleted no longer counts. A lead later imported again (dedupe) keeps its manual origin. |

### 1.4 Coverage (Right now)

The figures below are the state now, not inside the range. The scope is the lead owner (rep or picked person) or the
team.

| Tile | Definition | Link (the count matches the target list exactly) |
|---|---|---|
| Untouched N days | `lead_status in ('cold','warm','negotiation') and (last_activity_at is null or last_activity_at < now() - N days)`. N is 7, 30 or 90 (default 30), the Leads list's own `inactivityOptions`. This is exactly `private.lead_filter_sql()`'s `$7` rule, so the count matches the Leads list. Sub-line: of which never contacted (`last_activity_at is null`). | `/leads?inactive=N&status=cold,warm,negotiation[&owner=<rep>]` |
| No next step | `lead_status in ('warm','negotiation') and next_action_at is null and not exists (open task on the lead: done_at is null and cancelled_at is null)` | none in v1 (no exact Leads filter exists) |
| Overdue tasks | Open tasks (`done_at is null and cancelled_at is null`) with `due_at < now()` or `due_date < Paris today` | `/tasks?tab=overdue` (own scope) |

Edge cases:
- Imported leads start with the sheet's last-activity date (`companies.last_activity_at`, Day 3a). "Never contacted"
  therefore means never contacted in the CRM or in the sheet, the same as the Leads list.
- Tasks RLS shows a rep only tasks they are assigned or created. A colleague's open task on a rep's lead is invisible
  to that rep, so their "No next step" may count that lead. The manager's team view is exact. This is accepted and
  documented.
- `cool_off`, `customer`, `do_not_contact` and `disqualified` are left out on purpose.

### 1.5 List quality per import (admins only; Right now)

| | |
|---|---|
| Source | `public.import_batches (id, kind='leads', status='imported', filename, created_at, imported)`, `public.companies.import_batch_id`, activities, deals |
| Rows | The 20 most recent imported lead batches (`rolled_back`, `failed`, `staged` and `dry_run` are left out), newest first |
| Columns | Leads in the batch now. **Contacted %**: leads with ≥ 1 call, email, WhatsApp or meeting at or after the batch's `created_at`. **Reached %**: leads with ≥ 1 reached call. **Deal %**: leads with ≥ 1 deal. **Won %**: leads with ≥ 1 won deal. Denominator = leads in the batch now (undone or deleted leads drop out). |
| Scope | Whole life of the batch, not the date range. With the rep filter: only the batch's leads that person owns. |
| Who | Admins only. `import_batches_admin` RLS already hides batches from managers and reps, so the function refuses them (42501 `forbidden`) and the UI does not render the block. |
| Edge cases | `filename` is user-supplied text and is rendered as React text, never as HTML. A batch with 0 leads left shows "0 leads (all removed)". "Per source" and "per country" from the Master Plan wait: companies has no `source` column (Day 3a dropped it), and per country is a cheap later add. |

### 1.6 Best time to call

| | |
|---|---|
| Source | `public.activities` where `type='call'` in range, in scope |
| Grid | Weekday (ISO 1 = Monday … 7) × hour (0–23) of `created_at at time zone 'Europe/Paris'`, i.e. the rep's clock. Per cell: calls and reached. Only cells with calls are returned. |
| Metric shown | Connect rate (default) or call volume (a switch). Cells with fewer than 5 calls show "Not enough calls" (a hatched, empty cell) instead of a misleading 0 % or 100 %. |
| Supported? | Yes. Every call has an outcome (the CHECK requires one), so a connect rate exists for every call. |
| Edge cases | Calls logged after the fact count at the time they were logged (`created_at` is server time). The lead's own local hour (`companies.call_zone`, Day 4c) is more useful for international leads; it is the v1.1 toggle (Q3). Hours shown: 07:00–20:00 Paris by default, widened to any hour that has calls, with a footnote "N calls outside these hours". |

### 1.7 Sales

| | |
|---|---|
| Source | `private.orders (id, created_by, status, fulfilment, created_at)` and `private.order_lines (order_id, product_id, product_name, quantity, line_total)`, joined to `public.products (name)` (Day 6d) |
| Metrics | Revenue per bucket = `sum(line_total)` of orders with `status='confirmed'` and `created_at` in range. Totals: revenue, sales (orders), average sale, and the split by fulfilment (from stock or direct from source). Top 10 products by revenue, with pieces sold. |
| Grouping | A product line groups by `product_id`, named by the current `products.name`. A line without a product (direct from source) groups by `lower(product_name)`. |
| Edge cases | Cancelled sales are left out (`status='cancelled'`). An undone sale is a returned and cancelled sale, so it is left out too. Margin is deferred (cost data is `private.order_line_costs`, managers and admins only; R2 stock analytics). RLS: a rep sees sales they recorded or on leads they own. "Mine" is `created_by = me`, which is the same as `list_sales(p_user)`. |

### 1.8 KPI row (This period)

These come from the blocks above, so no extra query is needed:
- Calls (sub-line: reached n)
- Connect rate (sub-line: "n of m calls")
- Won (value; sub-line: n deals)
- Win rate (sub-line: n won · m lost)
- Median cycle (days; sub-line: from n won deals)
- Revenue (sub-line: n sales)

### 1.9 Deferred, and why

| Item (Master Plan 11) | Deferred to | Why |
|---|---|---|
| Zoom call metrics (talk ratio, monologue, questions, next-step language) | R3 | needs the Zoom app, webhooks, transcripts and `call_metrics` tables, which do not exist yet |
| Targets (actual vs target) | R3 | no `targets` table; needs Haider to set targets per person and period |
| Leaderboard | R3 (maybe never) | with 3 people the team table already compares them; ranking is a culture choice for Haider. v1 sorts the table by name and shows no rank. |
| Weighted forecast, pipeline velocity | R3 | needs a probability per stage (not defined); `expected_close` exists but is optional |
| Quality per source and per country | v1.1 / R3 | no source column on leads; per country is easy later |
| Lead-local heatmap | v1.1 | `call_zone` exists; a toggle once v1 is in use (Q3) |
| Change vs previous period on tiles | v1.1 | doubles the work for each tile; ship visuals first (Q7) |
| CSV export | later | exports need step-up MFA (CLAUDE.md) and a route of their own |
| Nightly aggregates | not needed | live queries fit the budgets at 30k leads / 300k entries (3.6); revisit if a measurement fails |
| Coaching dashboard | R3 | built on transcripts |

---

## 2 Filters

All filters sit in **one row above the content** and scope everything in "This period". "Right now" is visibly separate.

| Filter | Values | Default | Who |
|---|---|---|---|
| Range preset | `7d`, `30d`, `90d`, `mtd` (this month), `last_month`, `custom` | `30d` | everyone |
| Custom dates | `from`, `to` (ISO dates), using the existing `DateRangePicker` (`src/components/ui/date-picker.tsx:281`) | only with `custom` | everyone |
| Person | "Whole team" or one member (from `list_team()`, the existing `Combobox`) | team for admin/manager | admin, manager |
| Untouched days (Right now) | 7, 30, 90 | 30 | everyone |
| Heatmap metric | connect rate / calls | rate | everyone (local to the card, not in the URL) |

Preset meaning, with "today" = the Paris date on the **server** (`dateInZone(now, 'Europe/Paris')`, `src/lib/home.ts`):
- `7d` = today-6 .. today
- `30d` = today-29 .. today
- `90d` = today-89 .. today
- `mtd` = the 1st of the month .. today
- `last_month` = the whole previous month

One pure function, `resolveRange(params, todayParis) -> { from, to, bucket }`, used by the page and the API, does
this. The browser never does calendar arithmetic for the query.

**URL state**: `/analytics?range=30d`, `/analytics?range=custom&from=2026-09-01&to=2026-09-30&rep=<uuid>&idle=30`.
- The page parses leniently: bad values are dropped, the same as `filterParams` in `src/lib/leads.ts`.
- The API parses strictly: an unknown key or bad value gets 400.
- Changing a filter calls `window.history.replaceState`. Next.js keeps `useSearchParams` in sync with the native
  History API (Context7, Next.js docs "Native History API"). It does not spam Back, and a reload or a shared link
  restores the view.
- A rep's URL with `rep=<someone else>`: the page silently shows the rep's own figures, and the API answers 403. The
  database is the real check (3.3).

---

## 3 Data layer

### 3.1 Shape: seven INVOKER functions, one per block

There are seven functions instead of one, which is Home's proven pattern (D26). The server calls them in parallel
with `Promise.allSettled`, and each result becomes `Part<T> = {ok:true,data} | {ok:false}`. A failing block shows its
own error, and the rest of the page stands.

Every function follows the same rules:
- `language plpgsql stable security invoker set search_path = ''` and `set plan_cache_mode = force_custom_plan`.
- Static SQL only. Team and person are separate statements chosen by IF, each with a fixed index condition (Gate 1
  G6: no EXECUTE or format()).
- Two-factor sign-in is required (42501 `forbidden`).
- `revoke all … from public, anon; grant execute … to authenticated`.
- No body, `lost_note`, `cancel_reason`, note or cost column is ever read.

**No SECURITY DEFINER is needed.**
- RLS already lets each role read what its view needs: deals are owner-only for reps, and managers and admins see
  all; activities, leads and products are org-wide; import batches are admin-only.
- The one block where INVOKER hides rows a manager might want is list quality, and that block is admin-only by
  design.
- So Gate 1 G4's reviewed DEFINER list does not change.

### 3.2 Helpers (private schema, granted to authenticated like the Day 5c helpers)

```sql
-- Who the figures are for. null = the whole team (managers and admins only).
create function private.analytics_owner(p_user uuid) returns uuid
language plpgsql stable set search_path = '' as $$
declare caller constant uuid := (select auth.uid());
begin
  if caller is null or not (select private.has_aal2()) then
    raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
  end if;
  if (select private.is_manager_or_admin()) then
    if p_user is not null and not exists (select 1 from public.profiles p where p.id = p_user) then
      raise exception 'no such team member' using errcode = 'P0002', hint = 'rep';  -- other org = not visible
    end if;
    return p_user;
  end if;
  if p_user is not null and p_user <> caller then
    raise exception 'only managers and admins see a colleague''s figures' using errcode = '42501', hint = 'scope';
  end if;
  return caller;                      -- a rep always gets their own figures, never null
end $$;

-- The range as instants and the bucket size; refuses bad ranges (22023 'bounds').
create function private.analytics_window(p_from date, p_to date)
returns table (t_from timestamptz, t_to timestamptz, bucket text)
-- checks: both not null; p_from <= p_to; p_to - p_from <= 365; p_to <= (now() at time zone 'Europe/Paris')::date
-- t_from = p_from::timestamp at time zone 'Europe/Paris'; t_to = (p_to + 1)::timestamp at time zone 'Europe/Paris'
-- bucket = case when p_to - p_from < 31 then 'day' else 'week' end
```

How the role rule maps to RLS:
- For **deals, history and sales**, RLS is the security boundary. A rep could not read a colleague's deals even if the
  scope check were wrong.
- For **activities and leads**, RLS is org-wide (Haider, 10 Oct: "every user sees every lead"; the team reads every
  timeline). There, "a rep sees only their own figures" is a **product rule** enforced by `analytics_owner`, the same
  as Home's `home_summary` refusing the team scope to reps.
- This adds no exposure. A signed-in rep can already read those rows through PostgREST under RLS (see the
  rate-limit.ts header note). Attack tests check both kinds (5.2).

### 3.3 Function signatures and return shapes

All return `jsonb` (parsed with Zod `strictObject` on the server, so an unknown key, such as a cost column, fails that
part rather than reaching the browser). `p_user` is resolved by `analytics_owner`.

| Function | Signature | Returns |
|---|---|---|
| Activity | `public.analytics_activity(p_from date, p_to date, p_user uuid default null)` | `{scope:'team'\|'person', owner_id, bucket:'day'\|'week', buckets:[{start:'YYYY-MM-DD', partial:bool, calls, reached, emails, whatsapp, meetings}], totals:{calls, reached, emails, whatsapp, meetings, meetings_held}, by_person:[{user_id\|null, calls, reached, emails, whatsapp, meetings}]}` (by_person only in team scope) |
| Pipeline | `public.analytics_pipeline(p_from date, p_to date, p_user uuid default null)` | `{opened:{count, value, no_value}, won:{count, value}, lost:{count, mistake}, win_rate:{won, lost, rate\|null}, cycle:{n, median_days\|null, mean_days\|null}, funnel:{cohort, lead, qualified, negotiations, won, still_open, lost, mistake}, stage_days:[{key, n, median_days\|null}], lost_reasons:[{code, count}], by_person:[{user_id\|null, opened, won, won_value, lost, rate\|null}]}` |
| Speed | `public.analytics_speed(p_from date, p_to date, p_user uuid default null)` | `{leads, touched, median_minutes\|null, within_1h, within_24h, buckets:[{key:'lt1h'\|'lt24h'\|'lt3d'\|'gte3d'\|'none', count}]}` |
| Call times | `public.analytics_call_times(p_from date, p_to date, p_user uuid default null)` | `{min_calls:5, cells:[{dow:1..7, hour:0..23, calls, reached}]}` |
| Sales | `public.analytics_sales(p_from date, p_to date, p_user uuid default null)` | `{bucket, buckets:[{start, partial, revenue, sales}], totals:{revenue, sales, from_stock, direct}, top_products:[{product_id\|null, name, revenue, pieces}]}` (≤ 10) |
| Coverage | `public.analytics_coverage(p_user uuid default null, p_idle_days integer default 30)` | `{idle_days, untouched, never_contacted, no_next_step, overdue_tasks, as_of}`; `p_idle_days in (7,30,90)` else 22023 `bounds` |
| Batches | `public.analytics_batches(p_user uuid default null, p_limit integer default 20)` | `[{id, filename, created_at, leads, contacted, reached, with_deal, won}]`; admin only (42501 `forbidden`); `p_limit` 1–50 |

Names in `by_person` come from the existing `list_team()` call (`fetchTeam`, already used by Home). The functions
return ids only, and a null `user_id` is shown as "Former team members".

Team activity uses one index range per person (`activities_user_created_idx (user_id, created_at desc)`, via
`profiles cross join lateral`, exactly as `home_summary` K4 does), plus authorless entries:

```sql
-- team branch (person branch: where x.user_id = v_owner and x.created_at >= w.t_from and x.created_at < w.t_to)
select a.* from public.profiles pr
cross join lateral (select x.user_id, x.type, x.outcome, x.created_at from public.activities x
                     where x.user_id = pr.id and x.created_at >= w.t_from and x.created_at < w.t_to) a
union all
select x.user_id, x.type, x.outcome, x.created_at from public.activities x
 where x.user_id is null and x.org_id = (select private.current_org_id())
   and x.created_at >= w.t_from and x.created_at < w.t_to          -- activities_no_author_idx
```

### 3.4 Indexes

Policy: add an index only when the timing script shows a need. One index is needed for correctness with the plan
above:

| Index | Why | Status |
|---|---|---|
| `activities_no_author_idx on public.activities (org_id, created_at) where user_id is null` | team totals include former members' entries without a full scan; tiny (only orphaned entries) | **add in A1** |
| `activities_user_created_idx (user_id, created_at desc)` | activity, call times (person and team) | exists (Day 4a) |
| `activities_company_keyset_idx (company_id, created_at desc, id desc)` | first touch per lead (speed), batch contacted | exists |
| `companies_created_keyset_idx (org_id, created_at desc, id desc)`, `companies_import_batch_idx` | speed cohort, batches | exist |
| `deals_org_closed_idx` / `deals_owner_closed_idx (…, status, closed_at desc, id desc) where status <> 'open'` | won, lost, cycle | exist |
| `deal_stage_history_deal_idx (deal_id, id desc)` | funnel, days in stage | exists |
| `orders_org_idx`, `orders_creator_idx (created_by, created_at)` | sales | exist |
| `tasks_org_assignee_idx (org_id, assignee_id, due_at)` | overdue tasks | exists |
| Candidates **only if a budget fails**: `deals (org_id, created_at)` and `(owner_id, created_at)` for "opened"; a covering `activities (user_id, created_at) include (type, outcome, org_id)` for index-only activity scans | | not added |

### 3.5 Zod input schemas (server)

```ts
export const analyticsRanges = ["7d", "30d", "90d", "mtd", "last_month", "custom"] as const;
export const idleOptions = inactivityOptions; // [7, 30, 90] from src/lib/leads.ts, one list
const isoDate = z.iso.date();
// API: strict (unknown keys → 400). Page: the same fields with .catch(undefined) per field (lenient, like leads).
export const analyticsParams = z.strictObject({
  range: z.enum(analyticsRanges).default("30d"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  rep: z.uuid().optional(),
  idle: z.coerce.number().refine((n) => idleOptions.includes(n)).optional(),
}).superRefine((p, ctx) => { /* custom needs from+to, from <= to, span <= 366 days; others must not carry from/to */ });
```

- `resolveRange` turns these into `{p_from, p_to}`, and they reach SQL only as typed RPC arguments.
- No user text exists anywhere in the inputs (dates, a uuid and an integer only), so nothing can be interpolated into
  a PostgREST filter.
- Each response part has its own `strictObject` schema with bounds: counts are non-negative integers, money matches
  `/^\d{1,16}(\.\d{1,2})?$/`, arrays are capped (buckets ≤ 53 weeks or 31 days, cells ≤ 168, products ≤ 10, batches
  ≤ 50, reasons ≤ 8), and stage keys and reason codes are enums.

### 3.6 Server, route, cache

- `src/lib/analytics.ts`: constants, Zod params and parts, `resolveRange`, and the formatting helpers.
- `src/lib/analytics-server.ts` (`server-only`): `fetchAnalytics(supabase, params, role)` runs the seven RPCs with
  `allSettled`, plus `list_team` for managers and admins. A 42501 `scope` on the activity part, or any part, gives
  `"forbidden"`. Batches are not called for non-admins.
- `GET /api/analytics`:
  - Uses `apiSession()` and the strict params: 400 for bad input, 401 when signed out, 403 for a forbidden scope.
  - Sends `Cache-Control: private, no-store`.
  - Is added to the per-person limiter in `src/lib/rate-limit.ts` (30 a minute) and to its route list test.
  - Logs neither raw errors nor parameters.
- `src/app/(app)/analytics/page.tsx` (server):
  - Calls `requireSession()` and reads the role, the same as Home.
  - Parses `searchParams` (Next 16 `PageProps<"/analytics">`, async) and resolves the range.
  - Starts `fetchAnalytics` as a promise and renders the header and filter row at once.
  - Streams the body under `<Suspense fallback={<AnalyticsBodySkeleton/>}>`, the same as Home's D32.
- Client: TanStack Query key `['analytics', from, to, rep, idle]`.
  - Seeded from the server promise, `staleTime` 60 s, no refetch interval, no refetch on focus (analytics should not
    jitter).
  - `placeholderData: keepPreviousData`, so on a filter change the old frame stays at 60 % opacity until the new one
    lands. There is no skeleton then (dataviz rule "refetch keeps the frame").
  - Hovering a preset prefetches it, and the dock prefetches the default view on hover or focus (as Home does).

### 3.7 Performance budgets (measured later, never assumed)

Seed: `scripts/db-perf.sh` already builds 30,015 leads, 300,000 activities, 15,000 tasks, 10,000 deals with history,
and the Day 6d sales. A new `supabase/tests/perf_analytics.sql` runs after `perf_sales.sql`:
- Each function for 7d, 30d, 90d and 365d, as a rep and as an admin (team).
- auto_explain plans, then 5 warm runs averaged, the same pattern as `perf_day5.sql`.
- Runs 6+ check that the plan stays custom.

| Function (warm, local PG 16, RLS on) | 30d | 90d | 365d |
|---|---|---|---|
| analytics_activity (team / person) | ≤ 60 ms | ≤ 150 ms | ≤ 400 ms |
| analytics_pipeline | ≤ 40 ms | ≤ 60 ms | ≤ 120 ms |
| analytics_speed | ≤ 40 ms | ≤ 80 ms | ≤ 200 ms |
| analytics_call_times | ≤ 60 ms | ≤ 150 ms | ≤ 400 ms |
| analytics_sales | ≤ 30 ms | ≤ 80 ms | ≤ 200 ms |
| analytics_coverage (snapshot) | ≤ 60 ms | | |
| analytics_batches (20 batches over 30k leads) | ≤ 400 ms | | |

Page budgets (CLAUDE.md):
- The skeleton is immediate (loading.tsx).
- All blocks are in under 2 s on first load.
- A filter change with a warm cache is under 200 ms. Uncached, the old frame shows at once and the new numbers are
  under 1 s at 90d.
- Taps are acknowledged in under 100 ms.
- `tests/auth/analytics-perf.spec.ts` measures this the way `home-perf.spec.ts` does.
- Bundle: Recharts loads only on /analytics (`next/dynamic`, chart components `ssr:false`). Analytics route JS should
  add no more than about 180 KB gzip over the shell, measured from the build output in A3. Home, Leads and Pipeline
  JS must not change.

### 3.8 Migration plan

- One file: `supabase/migrations/20261024090000_analytics.sql`. It sorts after main's newest,
  `20261023090000_security_digest.sql`, and is renamed at merge if main moves (D35, `check-migration-order.sh`). It is
  read-only: no tables, no views, no materialized views, no triggers.
  1. `private.analytics_owner`, `private.analytics_window` (+ grants to authenticated, revoke from public and anon).
  2. The seven public functions (+ the Day 3a grant loop).
  3. `activities_no_author_idx`.
- Rollback: drop the functions and the index. No data changes.
- Before merge, on the DEV Supabase project (fake data, read-only MCP): run the Supabase security and performance
  advisors and report the results. `scripts/db-advisors.sh` runs in `db-test.sh` locally (0 ERROR expected).
  `gate1_attack.sql` picks up the new functions automatically: G4 (no DEFINER), G5 (not executable by PUBLIC), G6 (no
  dynamic SQL).

### 3.9 Attack-test plan: `supabase/tests/analytics_attack.sql`

Same harness as `home_attack.sql` (`pg_temp.act`, `expect_error`, `eq`, raw fixture writes with triggers off,
rollback per scenario). It runs after `home_attack.sql` in `scripts/db-test.sh`.

The fixture is its own org, "Analytics Org": admin Ada, manager Max, reps Rita and Remy. It has hand-placed
activities, deals with history (including an undo pair, a reopen and a "mistake" loss), manual and imported leads,
tasks, two batches (one rolled back) and sales (one cancelled), so every figure is an exact number. TopStock org rows
prove that nothing crosses orgs.

| # | Case | Expect |
|---|---|---|
| A1 | anon calls any analytics function | no privilege (rls_attack section 1 style), and G5 in gate1 |
| A2 | aal1 session | 42501 `forbidden` on all seven |
| B1 | rep, `p_user` null | own figures = hand count |
| B2 | rep, `p_user` = colleague | 42501 `scope` (all functions with p_user) |
| B3 | rep, `p_user` = self | same as B1 |
| B4 | manager, `p_user` null / = Rita | team figures / Rita's figures |
| B5 | manager or admin, `p_user` = a TopStock-org user or a random uuid | P0002 `rep`, no figures |
| B6 | after demoting Max to rep in the block (role change via `set_user_role` with fresh code) | team refused at once (role read per call) |
| C1 | Analytics Org admin | no TopStock-org row in any count (exact numbers) |
| C2 | rep pipeline and sales | equal to the rep's own deals and sales only; a colleague's won deal never appears, even in `by_person` (person scope has no by_person) |
| D1 | `analytics_batches` as manager and as rep | 42501 `forbidden`; as admin: the rolled-back batch is absent; the filename returns byte-for-byte (a name with `<script>` and bidi-safe text) |
| E1 | `p_from > p_to`, span 367 days, `p_to` = Paris tomorrow, null dates, `p_idle_days` 14, `p_limit` 0/51 | 22023 `bounds` |
| F1 | Paris day edges: a call at 31 Oct 2026 23:30 UTC | counts on 1 Nov (Paris), not 31 Oct; range `to=2026-10-31` excludes it |
| F2 | DST: 25 Oct 2026 (25 h day) and 29 Mar 2026 (23 h day) | one bucket each; hour cells in Paris time on both sides of the change |
| F3 | week buckets for a 90-day range | first and last flagged partial; buckets contiguous, zeros filled |
| G1 | connect rate | only the five reached outcomes count; `wrong_number` does not |
| G2 | funnel | undone move and its undo row excluded; Lead→Negotiations jump counts Qualified; mistake excluded from lost and win rate |
| G3 | speed | imported leads excluded; notes ignored; an activity dated before the lead's creation ignored |
| G4 | coverage parity | `untouched` = `count_leads(p_statuses => '{cold,warm,negotiation}', p_owners => …, p_inactive_days => 30)` exactly; overdue with `due_date` = Paris yesterday counts, = Paris today does not |
| G5 | sales | cancelled excluded; a product-less line grouped by name; revenue = sum of `line_total` |
| H1 | no text leaks | sentinel strings in activity body, lost_note, cancel_reason, order note and cost never appear in any payload (`::text like '%sentinel%'`, as share_attack does) |
| H2 | catalog | all seven `prosecdef = false`, `provolatile = 's'`, `search_path=''` |

Mutation checks for the A1 evidence bundle:
- Remove the rep branch of `analytics_owner`. Expect B2 to fail.
- Drop `x.user_id is null` from the union. Expect the former-member count case to fail.
- Use `current_date` instead of the Paris date. Expect F1 to fail in a Kiritimati or Pago_Pago session (the db.yml zone
  rule, log 16 Oct).

---

## 4 UI

### 4.1 Layout, desktop 1280–1728 (content max 1440, page padding 32, 12-column grid, gap 16 at ≤1439, 24 at ≥1440)

```
Analytics                                                       [ 7d | 30d | 90d | This month | Last month | Custom… ]  [ Whole team ▾ ]
1 Sep – 30 Sep 2026 · Paris time · updated 14:32
┌ THIS PERIOD ──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [Calls 412] [Connect rate 31 %] [Won 48 300 €] [Win rate 58 %] [Median cycle 12 d] [Revenue 61 920 €]  (2 cols each)│
│ ┌ Calls ───────────────────────────────── 8 cols ┐ ┌ Speed-to-lead ───────── 4 cols ┐                           │
│ │ stacked columns: reached / not reached         │ │ median 2 h 15 min               │                           │
│ │ ─ Emails ─ WhatsApp ─ Meetings (mini columns)  │ │ 5 horizontal bars by bucket     │                           │
│ └────────────────────────────────────────────────┘ └─────────────────────────────────┘                           │
│ ┌ Deal funnel ─────────────────── 7 cols ┐ ┌ Lost reasons ──────────────── 5 cols ┐                              │
│ │ horizontal bars Lead→Qualified→Neg.→Won │ │ horizontal bars, sorted, + "mistake" │                              │
│ │ days-in-stage row                       │ │ footnote                              │                              │
│ └─────────────────────────────────────────┘ └───────────────────────────────────────┘                              │
│ ┌ Team (admin/manager, team view) ── 12 cols: one row per person, numbers in DM Mono, right-aligned ┐             │
│ ┌ Best time to call ── 12 cols: weekday × hour grid, legend of 5 steps + "not enough calls" ┐                    │
│ ┌ Revenue ───────────────── 7 cols ┐ ┌ Top products ────────── 5 cols ┐                                           │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
RIGHT NOW · not affected by the dates
[Untouched 30+ days 28 412 ▾7/30/90] [Never contacted 26 900] [Warm, no next step 14] [Overdue tasks 6]   (3 cols each)
┌ List quality per import (admins) ── 12 cols table: file · imported · leads · contacted % · reached % · deal % · won % ┐
```

- KPI tiles: the Home tile classes (`KPI_CARD_CLASS`, `src/components/home/kpi-card.tsx`), 2 columns each from 1280.
  The number is 28 px at 1280–1439 and 32 px from 1440, because six tiles are narrower than Home's four. Money from
  €1M uses compact notation ("1,2 M €").
- Cards: `HomeCard` (radius 20, `bg-card`, padding 24), with titles in sentence case.
- 768–1024: tiles 3 per row, charts full width, Funnel and Lost reasons side by side at 1024.

### 4.2 Layout, phone 390 (padding 16, one column)

From top to bottom:
1. Title, then the range line.
2. Presets as a horizontal snap strip (`edge-fade` utility, as the tab strips are), with "Custom…" at the end.
3. The person picker, full width, below it.
4. Tiles 2 × 3, with the sub-line hidden under 360 px (Home rule).
5. Calls: chart height 200, x ticks every 7th day, mini columns below.
6. Speed, Funnel and Lost reasons.
7. Team: one compact card per person (no wide table, so no sideways scroll).
8. Best time to call, **transposed** (rows = hours, columns = Mon–Sun), giving cells of about 44 × 28 px.
9. Revenue, Top products, Right now tiles 2 × 2, then List quality as one card per import.

Analytics stays under More on the 5-item phone dock (Q13).

### 4.3 Chart per block

| Block | Form (dataviz heuristic) | Axes | Tooltip (values lead, labels muted) | Text alternative |
|---|---|---|---|---|
| Calls | 2-segment stacked **columns** (reached = ink, not reached = ink-35), ≤ 24 px bars, 4 px rounded top, 2 px surface gap; legend (2 series) + direct label on the max bucket only | x: bucket dates (day "14 Oct" / week "6 Oct"), y: count, compact ticks, hairline grid | "Tue 14 Oct · 38 calls · 12 reached (32 %)"; week: "Week of 6 Oct (partial)" | caption sentence + table (bucket, calls, reached, rate, emails, WhatsApp, meetings) |
| Emails / WhatsApp / Meetings | **small multiples**, 3 mini single-series columns (64 px), shared x domain, title + total each, no legend | x shared, no y axis (total in title) | per bar, same as above | included in the Calls table |
| Speed-to-lead | headline **stat** + 5 horizontal **bars** (single series ink; "Not yet" ink-35) | y: bucket labels, x: count | "1–24 h · 9 leads (30 %)" | table |
| Funnel | horizontal **bars** of cohort reach (not a trapezoid funnel), % of cohort at the bar tip | y: stages, x: 0–100 % | "Negotiations · 11 of 40 (28 %)" | table + "still open n, lost n" line |
| Days in stage | three inline figures under the funnel (median days, n) | none | n/a | is text |
| Lost reasons | horizontal **bars**, sorted desc, values at tips | y: reason labels, x: count | "Price · 4 (40 %)" | table |
| Team | **table** (more than 7 measures across people: the table is the form) | none | none | is a table |
| Best time to call | **heatmap**, custom CSS grid (Recharts has none), sequential ink ramp, 5 fixed bins of connect rate (0–10, 10–20, 20–30, 30–45, ≥ 45 %) or of calls (quantiles of the range), hatched muted cell under 5 calls | rows weekday, columns hour | "Tue 10:00 · 23 calls · 9 reached · 39 %" | table (weekday × hour, calls / reached) |
| Revenue | single-series **columns** | x: buckets, y: € compact | "Week of 6 Oct · 12 420 € · 3 sales" | table |
| Top products | horizontal **bars**, top 10 by revenue, € at tips, pieces muted | y: product names (truncated with full name in tooltip and table) | "Denim jacket · 8 940 € · 1 200 pieces" | table |

Common mechanics:
- Every chart sits in a `ChartFrame`: a `<figure>` with `<figcaption>`. The caption is the card title plus one
  generated summary sentence, e.g. "412 calls, 31 % reached; busiest day Tue 14 Oct (38)". The frame also has a
  "Show as table" `Disclosure` (existing `src/components/ui/disclosure.tsx`) that holds a real `<table>` with the same
  numbers.
- Recharts 3 has `accessibilityLayer` on by default: the chart takes Tab focus and the arrow keys move the tooltip
  (Context7, recharts Accessibility). The focus ring is the app's ink `--ring`. The chart's `title` and `desc` props are
  set from the caption.
- Heatmap: `role="grid"` with roving tabindex. Arrow keys, Home/End and PageUp/PageDown move between cells. Each cell
  has an `aria-label` with the full readout, and the same tooltip shows on focus and on hover.
- Hit targets are larger than the marks: the full band for columns, at least 24 px.
- Tooltips: `bg-card`, a 1 px border, radius 12, the floating-layer shadow. Text uses text tokens only. Untrusted names
  (products, file names) are React text.

### 4.4 Colour tokens (added to `src/app/globals.css`, light and dark; DESIGN.md palette only)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--chart-ink` | `#0E0E10` | `#F5F3EF` | main series, top heat bin |
| `--chart-ink-65` | `#626264` | `#A9A8A7` | second step |
| `--chart-ink-35` | `#ABABAB` | `#686769` | remainder segment ("not reached", "not yet") |
| `--chart-seq-1..5` | `#ABABAB #878788 #626264 #3E3E40 #0E0E10` | `#686769 #898888 #A9A8A7 #CAC8C6 #F5F3EF` | heatmap bins (more = darker in light, lighter in dark) |
| `--chart-empty` | `var(--muted)` + 45° hatch in `--border` | same | "not enough calls" |
| `--chart-grid` | `var(--border)` | `var(--border)` | hairline grid and axis lines |
| `--chart-axis` | `var(--muted-foreground)` | `var(--muted-foreground)` | tick and label text (6.2:1 light) |
| `--chart-accent` | `var(--brand)` `#F2203E` | same | the **active datum only**: the hovered or focused bar (or the reached segment of the active column) |
| `--chart-cursor` | `var(--muted)` | `var(--muted)` | hover band behind the active column |

- The values are exact mixes of TopStock Black / Chalk White with the card surface, not opacity, so 2 px surface gaps
  stay clean.
- Checked with the dataviz validator (`validate_palette.js --ordinal`):
  - Monotone lightness passes, and every adjacent step differs by ΔL ≥ 0.06 in both modes.
  - The light end passes on the card (2.30:1 light, 3.02:1 dark).
  - "Single hue" reports FAIL, but that is an artefact of neutral greys (chroma about 0.004, so the hue angle is
    noise). Ink plus Signal Red as a pair: CVD ΔE 32.9 (protan), normal 51.0, both ≥ 3:1 on the card.
- Signal Red is never used for text, never as a status, and never as a second series.
- Status colours appear only in the existing labelled dots, e.g. the "stalled" wording if linked. Recharts fills use
  `fill="var(--chart-ink)"` (CSS variables in SVG presentation attributes), so dark mode switches with `.dark` and
  needs no re-render.

### 4.5 Motion

- Recharts' own animations are off (`isAnimationActive={false}`), because they animate SVG geometry (y and height),
  not transform or opacity.
- Entrance, first visit to Analytics per tab only (the Home rule, D29):
  - Each chart's plot group rises with `scaleY` 0→1 from the baseline (horizontal bars use `scaleX`), with
    `springs.smooth` and a 30 ms stagger.
  - Tiles count up with the existing `CountUp`. Its first-visit flag is generalised to one flag per route.
- Filter change: tiles ease from the old value in 0.3 s (CountUp already does this), and charts cross-fade (opacity)
  from the 60 % frame.
- `prefers-reduced-motion` removes the entrance, the count-up and the cross-fade. Tooltips stay (Recharts tooltip
  `isAnimationActive: 'auto'` already respects it).
- Press feedback on presets and tiles: scale 0.97 within 100 ms.

### 4.6 Number and date formatting

- Counts: `format.number`.
- Percent: `format.number(x, {style:'percent', maximumFractionDigits:0})`.
- Money: existing `formatMoney(value, locale)` (EUR), and `Intl.NumberFormat(locale, {style:'currency',
  currency:'EUR', notation:'compact', maximumFractionDigits:1})` for tiles from €1M and for y ticks.
- Durations: ICU messages (`{h} h {m} min`, `{d} d`), not `Intl.DurationFormat` (Safari coverage).
- Bucket dates arrive as `YYYY-MM-DD` and are formatted as UTC calendar dates (`timeZone:'UTC'`), so a Paris date
  never shifts by a day in another browser zone.
- Weekday and hour labels come from Intl (`weekday:'short'`, `hour:'2-digit'`, 24-hour in both EN-GB and FR style).
- All copy lives in a new `Analytics` namespace in `messages/en.json` and `messages/fr.json`. The existing `Stages`
  and `LostReasons` are reused. French runs about 20 % longer, so no fixed label widths.
- Numbers that line up use DM Mono (tables, tiles, axis ticks).

### 4.7 Loading, empty and error states

- `analytics/loading.tsx` renders `AnalyticsSkeleton`: the header, a filter row of placeholders, 6 tile skeletons
  (`KpiRowSkeleton` pattern), and each card at its final height. Chart areas are 240 px desktop and 200 px phone,
  heatmap rows are 7 × 32 px, the team table has 3 rows. There are no spinners, and the body under Suspense uses the
  same component, so there is no layout jump.
- Lazy chart chunks render the same chart-area placeholder while loading.
- A card loads with its own skeleton only when no data exists for its key yet. Otherwise it keeps the previous frame.
- Empty states (calm, one line, with an action where there is one):

  | Block | Empty message |
  |---|---|
  | Calls | "No calls, emails or messages logged in this period." · Work queue |
  | Pipeline | "No deals opened or closed in this period." · Pipeline |
  | Speed | "No leads added by hand in this period. Imported lists are measured under List quality." |
  | Heatmap | "The map fills in once an hour slot has 5 calls." |
  | Sales | "No sales recorded in this period." |
  | List quality | "No imports yet." · Import leads (admin) |
  | Coverage at zero | "All caught up" |

- Error: `CardError` (existing `src/components/home/home-card.tsx`) with the message "Couldn't load {block}" and
  **Try again**, which refetches the query; parts that succeeded stay. The whole-page request failing shows each
  card's error, with the filters still usable.
- Errors pass through `src/lib/db-errors.ts`, so no raw database text reaches the screen.

### 4.8 Recharts version

- **recharts 3.10.1**, exact pin (npm `latest`, published 25 Jul 2026, so more than two weeks old). Context7 docs exist
  for 3.x. React 19 is in its peer range.
- Add **react-is 19.3.0**, exactly matching react 19.3.0 (a peer dependency).
- New transitive dependencies (react-redux, @reduxjs/toolkit, immer, reselect, victory-vendor, es-toolkit,
  decimal.js-light) are reviewed in the PR: npm audit, licences (MIT/ISC), and the lockfile diff.
- Use the `responsive` prop (3.3+) with a fixed height instead of `ResponsiveContainer`.
- CSP needs no change: inline styles are already allowed (`src/proxy.ts`), and scripts stay nonce-only. Recharts uses
  no eval.

---

## 5 Tests

### 5.1 Unit (`tests/unit/analytics.spec.ts`, Playwright unit config)

- `resolveRange`, at fixed instants for each preset:
  - DST days (29 Mar and 25 Oct 2026).
  - 31 Oct 23:30 UTC, which is already 1 Nov in Paris.
  - Month ends and 29 Feb 2028.
  - The bucket rule (31 days gives day buckets, 32 gives weeks).
  - Custom validation: reversed dates, 367 days, a future `to`, malformed input, and `from` without `custom`.
- Zod params: the page drops bad values, the API refuses unknown keys.
- Zod parts: `strictObject` rejects an extra key (e.g. `cost_per_piece`), negative counts, over-long arrays and bad
  money.
- Parity (the day5-parity pattern) against the migration text:
  - `REACHED_OUTCOMES` matches both the Home and Analytics SQL.
  - Stage keys, lost reason codes, idle options = `inactivityOptions`, `WIN_RATE_MIN_CLOSED`, minimum heat calls, and
    the funnel's position order.
- Formatting in EN and FR: compact EUR, percent, durations, and UTC-safe bucket dates (run with `TZ=Pacific/Kiritimati`
  and `TZ=America/Los_Angeles`).
- Caption sentence generator, heat bin mapping, heatmap transposition, and how the Team table merges names with
  `by_person` (including the null "Former team members" row).
- `hardcoded-strings.spec.ts` and `messages.spec.ts` cover the new namespace automatically. The route inventory and
  rate-limit lists get `/api/analytics`.

### 5.2 Database: `analytics_attack.sql` (3.9) and `perf_analytics.sql` (3.7)

Run in `db-test.sh` under the CI zones, with `gate1_attack.sql` checking the catalog rules. The perf script runs in
`db-perf.sh`.

### 5.3 End to end (`tests/auth/analytics.spec.ts`, signed-in fixtures like `home-fixture.ts`)

- Admin, seeded data: every block renders with the exact fixture numbers, and no console errors.
- Presets: each one changes the URL (`replaceState`) and the figures, and a reload restores the view.
- Custom range: open the picker, pick two dates, the URL updates.
- Person filter (admin): pick Rita, see her figures and the URL `rep=`, the Team table is hidden, back to Whole team.
- Rep user:
  - No person picker, no Team table, no List quality.
  - `?rep=<admin id>` renders the rep's own figures.
  - `GET /api/analytics?rep=<admin id>` answers 403.
  - `GET /api/analytics?foo=1` answers 400.
  - Signed out answers 401.
- Empty: an org or range with no data shows every empty state. Coverage zeros show "All caught up".
- Errors:
  - `page.route('/api/analytics*')` answering 500 shows Try again on every card, and a retry recovers.
  - A response with one `{ok:false}` part breaks only that card.
- Keyboard:
  - Tab into the Calls chart, and the arrow keys move the tooltip.
  - Heatmap arrows, Home and End.
  - "Show as table" holds the same numbers as the tooltip.
  - The focus ring is visible.
- Reduced motion: no count-up and no rise.
- Coverage links: the Untouched tile's count equals the Leads list count at the target URL.
- `tests/auth/analytics-perf.spec.ts`: route timings and the Analytics JS size (3.7), and Home JS unchanged.
- No horizontal scroll at 390, 768, 1024, 1280, 1440 and 1728 (the phone_fit pattern from Day 7c).

### 5.4 Screenshots (`tests/auth/analytics-screens.spec.ts` → `docs/evidence/analytics/screens/`)

- Widths 1280, 1440, 1728 and 390, plus 768 and 1024 (a new layout).
- Light and dark, EN and FR.
- States: full data, empty, one card in error, rep view, and a tooltip open on the Calls chart and on the heatmap.
- Then the CLAUDE.md UI chain: `/apple-design` audit, `web-design-guidelines` audit, fixes, `/security-review`, the
  advisor subagent until APPROVED.

---

## 6 Build order, then open questions

Each step is one PR: branch → CI green → Vercel preview → advisor APPROVED → Haider merges.

| Step | What | Done when |
|---|---|---|
| **A1** Database | migration `20261024090000_analytics.sql` (helpers, 7 functions, `activities_no_author_idx`), `analytics_attack.sql`, `perf_analytics.sql`, db-test and db-perf wiring | attack suite green under UTC, Kiritimati and Pago_Pago; budgets met (or an index added and re-measured); mutation checks caught; dev advisors 0 ERROR, results reported |
| **A2** Data layer | `src/lib/analytics.ts`, `analytics-server.ts`, `GET /api/analytics` (+ limiter), unit and parity tests; no UI | unit suite green; 400/401/403 behaviour proven |
| **A3** Shell | pin recharts 3.10.1 + react-is 19.3.0; chart tokens; `ChartFrame`, tooltip, bar wrappers; `loading.tsx` skeleton; page header, filter row (URL state), KPI tiles; messages EN+FR | screenshots of the shell matrix; bundle measured; Home JS unchanged |
| **A4** Charts 1 | Calls + small multiples, Speed-to-lead, Funnel + days in stage, Lost reasons, with all states | e2e for these blocks, keyboard and table views |
| **A5** Charts 2 | Team table, Best time to call heatmap, Revenue, Top products | e2e, heatmap keyboard, phone transposition |
| **A6** Right now + finish | Coverage tiles with links, List quality (admin), full e2e and perf specs, full screenshot matrix, audits, security review | evidence bundle, advisor APPROVED, REPORT |

Haider said to go with the recommendations, so the builder proceeds on these unless he says otherwise. Each one is
logged in `docs/log.md` when its step starts.

| # | Question | Recommendation |
|---|---|---|
| Q1 | What does a rep see? | Own numbers only, no person picker, no Team table, no List quality. Managers and admins see the team and can pick a person. This matches Home and deals RLS. All three users are admins today. |
| Q2 | Which time zone? | Fixed Europe/Paris for every figure (the business day; matches `list_sales`). Home's profile-zone figures agree while profiles are Paris. |
| Q3 | Best time to call: whose clock? | Paris (the rep's clock) in v1, with a "Lead's local time" toggle in v1.1 using `companies.call_zone`. |
| Q4 | Speed-to-lead: which leads, which clock? | Hand-added leads only, wall-clock time. Business-hours speed is a later refinement. |
| Q5 | Whose deal is it? | The current owner (what RLS and the board use). The creator stays in history. |
| Q6 | Whose sale is it? | Whoever recorded it (`created_by`, the same as Sales' person filter). |
| Q7 | Show change vs the previous period? | Not in v1; add to the six tiles in v1.1. |
| Q8 | Leaderboard? | No. The Team table is sorted by name with no rank. Revisit in R3 with targets. |
| Q9 | "Opened by mistake" losses? | Excluded from lost and win rate, shown as a footnote (the same as Home). |
| Q10 | Untouched default? | 30 days, options 7, 30 and 90 (the Leads filter's options, so the link matches). |
| Q11 | List quality for managers? | Admins only (import batches are admin-only today). Revisit when a manager joins. |
| Q12 | Heatmap scale? | Fixed connect-rate bins (0–10–20–30–45 %+) so maps compare across ranges, with a minimum of 5 calls per cell. |
| Q13 | Analytics on the phone dock? | Keep the 5-item dock. Analytics stays under More (Day 2 decision). |
| Q14 | Export? | Not in v1 (needs step-up MFA). "Show as table" covers reading. |
| Q15 | Employee monitoring (not legal advice) | Per-person figures are visible to managers and admins only. Haider tells the team what is measured (the CNIL expects staff to be informed and the use proportionate). Nothing new is collected. |

---

## Appendix A: facts checked in the repo (17 Oct 2026, origin/main 7cf424e)

Schema:
- **Leads are companies** (`20261010090000_leads_are_companies.sql`): `lead_status` (cold, warm, negotiation,
  customer, cool_off, do_not_contact, disqualified), `owner_id`, `country`, `last_activity_at`, `import_batch_id`,
  `created_at`. `timezone` and `next_action_at` were added in Day 4b (`20261012090000_lead_page.sql:355`). `call_zone`
  and `queue_rank` were added in Day 4c. There is no `source` column. Everyone in the org reads every lead.
- **Activities**: `type` is one of call, email, whatsapp, meeting or note. Outcomes per type come from
  `activities_outcome_fits_type` (`20261011120000_activity_hardening.sql:29`). Calls must carry one of no_answer,
  voicemail, wrong_number, not_interested, interested, meeting_booked, do_not_contact or connected. Email and WhatsApp
  carry null or sent, meetings null, held or no_show. `created_at` is server time and never moves. The
  `activities_select` policy is org-wide.
- **Deals** (`20261015090000_deals_pipeline.sql`): `status` open, won or lost, `value` (nullable, ≤ 1e8, EUR only),
  `closed_at`, `lost_reason` from 8 codes, `owner_id`, `created_by`. Reps see their own deals; managers and admins see
  all (`deals_select`).
- **`deal_stage_history`**: append-only, `kind` open, move, won, lost, reopen or undo, `from_stage`, `to_stage`,
  `undoes`, `value_after`, `lost_reason`. Its RLS follows deals.
- **Tasks** (Day 4a): `due_at` or `due_date` (all-day), `done_at`, `cancelled_at`, `kind`, `assignee_id`,
  `created_by`. A task is visible to its assignee, its creator, managers and admins.
- **`import_batches`**: `kind` leads or stock, `status` staged, dry_run, imported, rolled_back or failed, `filename`.
  Admins only (`import_batches_admin`).
- **Sales** (`20261019090000_sales_requests.sql`): `private.orders` (confirmed or cancelled, `created_by`,
  `fulfilment`) and `private.order_lines` (`quantity`, `unit_price`, `line_total`, `product_id`, `product_name`).
  Visible to the creator, the lead's owner, managers and admins. `list_sales` buckets by Paris dates.
- **Profiles**: `role` admin, manager or rep; `timezone` defaults to Europe/Paris. Role changes go only through
  `set_user_role` (admin plus a fresh code).

Code to reuse:
- **Home**: `home_summary` with `p_scope`, the Day 5c rules (team refused to reps with 42501 `scope`; static IF
  branches; per-person lateral scans), Zod parts in `src/lib/home.ts`, `fetchHome` with `allSettled`, `GET /api/home`,
  `HomeCard`, `CardError`, `KpiRow` and `KpiRowSkeleton`, `CountUp` (D29), and `PipelineSnapshot` (an ink bar with
  30/60/100 % tints and a scaleX entrance, no chart library).
- **Tests and checks**: `home_attack.sql` harness; `gate1_attack.sql` G1 to G7; `scripts/db-perf.sh` seeds (30,015
  leads, 300k activities, 15k tasks, 10k deals with history, Day 6 stock and sales); `check-migration-order.sh`; the
  CSP in `src/proxy.ts` (`style-src 'unsafe-inline'`).
- **Versions**: Recharts is not installed. npm `latest` is 3.10.1 (25 Jul 2026), and 3.11 is canary only. Next 16.4.0,
  React 19.3.0, next-intl 4.14.9, motion 14.0.0, TanStack Query 5.103.2 and zod 4.6.5 are installed.
