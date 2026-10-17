import { sql } from "./helpers";

// The Analytics made-up fixture (P2), shared by analytics.spec.ts and analytics-screens.spec.ts: an org of its own (the
// reused local stack holds other specs' rows in the default org), an admin and a rep, and hand-placed entries, deals
// with stage history and sales, all relative to Paris today so the default 30-day view always holds them. Written
// straight into the local database with the tables' own triggers off, so every clock is exactly as written. Fake data
// only; every value is a fixed test literal. Expected figures (team, 30 days):
//   calls 19 (reached 9) · emails 3 · WhatsApp 2 · meetings 2 (1 held)    7 days: calls 11
//   deals opened 8 · won 4 (54,200 €) · lost 2 + 1 opened by mistake · win rate 4/6 · median cycle 9 days
//   funnel lead 8 · qualified 6 · negotiations 5 · won 4 · still open 1
//   speed: 4 leads added by hand, 3 touched (under 1 h, 1–3 days, 3 days or more) and 1 not yet; median 26 h
//   sales 2 (1,644 €), top product "<img src=x onerror=alert(1)>" (894 €)
// The rep (Rita) alone: calls 5 (reached 4), WhatsApp 2, won 1 (8,000 €), lost 1 + 1 mistake, 1 sale (150 €).
// Right now (P3), not affected by the dates: last entries as the app keeps them, a next action on Comptoir Brécy, three
// open tasks (two overdue: the admin's on Maison Verdane, the rep's on Import Aurore; the rep's on Import Brisa due
// today), and an import made 60 days ago of five leads with entries and deals after it (Aurore: a reached call and a won
// deal; Brisa: an email and an open deal; Cobalt never contacted; Dune last touched in the sheet 100 days ago; Écume a
// customer), an import 10 days ago whose leads are all gone, and a rolled-back one (never listed). All before the 30-day
// window, so "This period" above is unchanged.
//   team, 30 days untouched: 5 (2 never contacted) · no next step 2 · overdue 2      90 days: 3 (2 never contacted)
//   the rep alone: untouched 2 (1 never contacted) · no next step 1 · overdue 1      the admin alone: overdue 1
//   list quality: the empty import first (0 leads), then 5 leads, contacted 2 (40 %), reached 1 (20 %), deal 2 (40 %),
//   won 1 (20 %); the rep alone: 2 leads, contacted 1 (50 %), reached 0, deal 1 (50 %), won 0

export const XSS_NAME = "<img src=x onerror=alert(1)>";
/** The import's file name: the uploader's text, shown only as React text. */
export const XSS_FILE = "<img src=x onerror=alert(1)> liste été.csv";
export const EMPTY_FILE = "relance-vide.csv";
export const expected = {
  team: { calls: 19, reached: 9, won: 54200, revenue: 1644, sales: 2, calls7d: 11 },
  rep: { calls: 5, reached: 4, won: 8000, revenue: 150 },
  coverage: {
    team: { untouched: 5, never: 2, noNextStep: 2, overdue: 2, untouched90: 3 },
    rep: { untouched: 2, never: 1, noNextStep: 1, overdue: 1 },
    adminOwnOverdue: 1,
  },
  batch: {
    team: { leads: 5, contacted: "40% (2)", reached: "20% (1)", deal: "40% (2)", won: "20% (1)" },
    rep: { leads: 2, contacted: "50% (1)", reached: "0% (0)", deal: "50% (1)", won: "0% (0)" },
  },
};

const LEADS = ["Maison Verdane", "Atelier Nordlys", "Comptoir Brécy", "Halles Altamar", "Import Aurore", "Import Brisa", "Import Cobalt", "Import Dune", "Import Écume"];

/**
 * Seeds the fixture into `org`. `tag` suffixes every lead name (an org that already holds Home's leads of the same
 * names, as the phone spec's does); `file` names the import (a plain one where a long name would be cut elsewhere).
 */
export function seedAnalytics(org: string, admin: string, rep: string, o: { tag?: string; file?: string } = {}) {
  const sfx = o.tag ? ` ${o.tag}` : "";
  const file = o.file ?? XSS_FILE;
  // A Paris wall-clock time N days before Paris today, as an instant.
  const at = (days: number, time: string) => `(((now() at time zone 'Europe/Paris')::date - ${days}) + time '${time}') at time zone 'Europe/Paris'`;
  sql(`
    set session_replication_role = replica;
    insert into public.companies (org_id, name, owner_id, lead_status, country, city, created_at)
    values ('${org}', 'Maison Verdane', '${admin}', 'warm', 'FR', 'Lyon', ${at(20, "09:00")}),
           ('${org}', 'Atelier Nordlys', '${rep}', 'warm', 'FR', 'Lille', ${at(6, "09:00")}),
           ('${org}', 'Comptoir Brécy', '${admin}', 'warm', 'FR', 'Nantes', ${at(4, "09:00")}),
           ('${org}', 'Halles Altamar', '${rep}', 'cold', 'FR', 'Nice', ${at(1, "09:00")});

    -- Entries: (lead, author, type, outcome, when). A note never counts.
    insert into public.activities (org_id, company_id, user_id, type, outcome, body, created_at)
    select '${org}', c.id, a.who::uuid, a.type, a.outcome, null, a.at
      from (values
        -- Comptoir Brécy: an email 20 minutes after it was added (its first touch), then 6 calls at 10:00, 3 reached.
        ('Comptoir Brécy', '${admin}', 'email', 'sent', ${at(4, "09:20")}),
        ('Comptoir Brécy', '${admin}', 'call', 'connected', ${at(2, "10:02")}),
        ('Comptoir Brécy', '${admin}', 'call', 'no_answer', ${at(2, "10:06")}),
        ('Comptoir Brécy', '${admin}', 'call', 'interested', ${at(2, "10:11")}),
        ('Comptoir Brécy', '${admin}', 'call', 'voicemail', ${at(2, "10:16")}),
        ('Comptoir Brécy', '${admin}', 'call', 'meeting_booked', ${at(2, "10:21")}),
        ('Comptoir Brécy', '${admin}', 'call', 'wrong_number', ${at(2, "10:26")}),
        -- Maison Verdane: 2 emails, then 8 calls at 15:00 (2 reached), 2 meetings (1 held).
        ('Maison Verdane', '${admin}', 'email', null, ${at(7, "11:00")}),
        ('Maison Verdane', '${admin}', 'email', 'sent', ${at(7, "11:05")}),
        ('Maison Verdane', '${admin}', 'meeting', 'held', ${at(9, "14:00")}),
        ('Maison Verdane', '${admin}', 'meeting', 'no_show', ${at(9, "16:00")}),
        ('Maison Verdane', '${admin}', 'call', 'connected', ${at(12, "15:01")}),
        ('Maison Verdane', '${admin}', 'call', 'not_interested', ${at(12, "15:05")}),
        ('Maison Verdane', '${admin}', 'call', 'no_answer', ${at(12, "15:09")}),
        ('Maison Verdane', '${admin}', 'call', 'no_answer', ${at(12, "15:13")}),
        ('Maison Verdane', '${admin}', 'call', 'voicemail', ${at(12, "15:17")}),
        ('Maison Verdane', '${admin}', 'call', 'no_answer', ${at(12, "15:21")}),
        ('Maison Verdane', '${admin}', 'call', 'voicemail', ${at(12, "15:25")}),
        ('Maison Verdane', '${admin}', 'call', 'no_answer', ${at(12, "15:29")}),
        ('Maison Verdane', '${admin}', 'note', null, ${at(12, "15:40")}),
        -- Atelier Nordlys (the rep's): 5 calls at 11:00, 26 hours after it was added (4 reached), then 2 WhatsApp.
        ('Atelier Nordlys', '${rep}', 'call', 'connected', ${at(5, "11:00")}),
        ('Atelier Nordlys', '${rep}', 'call', 'interested', ${at(5, "11:10")}),
        ('Atelier Nordlys', '${rep}', 'call', 'connected', ${at(5, "11:20")}),
        ('Atelier Nordlys', '${rep}', 'call', 'no_answer', ${at(5, "11:30")}),
        ('Atelier Nordlys', '${rep}', 'call', 'do_not_contact', ${at(5, "11:40")}),
        ('Atelier Nordlys', '${rep}', 'whatsapp', 'sent', ${at(1, "12:00")}),
        ('Atelier Nordlys', '${rep}', 'whatsapp', null, ${at(1, "12:05")}))
        as a (lead, who, type, outcome, at)
      join public.companies c on c.name = a.lead and c.org_id = '${org}';

    -- Deals: (key, lead, final stage, value, opened, closed, lost reason).
    create temporary table fx_deals (k text, lead text, stage text, value numeric, opened timestamptz, closed timestamptz, reason text) on commit drop;
    insert into fx_deals values
      ('D1', 'Maison Verdane', 'won', 12000, ${at(15, "10:00")}, ${at(5, "10:00")}, null),
      ('D2', 'Comptoir Brécy', 'negotiations', 9000, ${at(10, "10:00")}, null, null),
      ('D3', 'Atelier Nordlys', 'lost', null, ${at(5, "12:00")}, ${at(2, "12:00")}, 'price'),
      ('D4', 'Halles Altamar', 'lost', null, ${at(1, "10:00")}, ${at(1, "10:30")}, 'mistake'),
      ('D5', 'Maison Verdane', 'won', 4200, ${at(8, "10:00")}, ${at(3, "10:00")}, null),
      ('D6', 'Atelier Nordlys', 'won', 8000, ${at(25, "10:00")}, ${at(12, "10:00")}, null),
      ('D7', 'Comptoir Brécy', 'won', 30000, ${at(22, "10:00")}, ${at(14, "10:00")}, null),
      ('D8', 'Maison Verdane', 'lost', null, ${at(18, "10:00")}, ${at(9, "10:00")}, 'timing');
    insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, status, stage_entered_at,
                              closed_at, fulfilment, lost_reason, version, created_at)
    select '${org}', c.id, s.id, c.owner_id, c.owner_id, 'Analytics ' || d.k, d.value,
           case d.stage when 'won' then 'won' when 'lost' then 'lost' else 'open' end, coalesce(d.closed, d.opened),
           d.closed, case when d.stage = 'won' then 'from_stock' end, d.reason, 1, d.opened
      from fx_deals d
      join public.companies c on c.name = d.lead and c.org_id = '${org}'
      join public.pipeline_stages s on s.org_id = '${org}' and s.key = d.stage;
    -- Stage history: (deal, kind, from, to, when), in order.
    insert into public.deal_stage_history (org_id, deal_id, kind, from_stage, to_stage, version_after, created_at)
    select '${org}', dl.id, h.kind, h.from_stage, h.to_stage, h.n, h.at
      from (values
        ('D1', 1, 'open', null, 'lead', ${at(15, "10:00")}), ('D1', 2, 'move', 'lead', 'qualified', ${at(12, "10:00")}),
        ('D1', 3, 'move', 'qualified', 'negotiations', ${at(8, "10:00")}), ('D1', 4, 'won', 'negotiations', 'won', ${at(5, "10:00")}),
        ('D2', 1, 'open', null, 'lead', ${at(10, "10:00")}), ('D2', 2, 'move', 'lead', 'negotiations', ${at(6, "10:00")}),
        ('D3', 1, 'open', null, 'lead', ${at(5, "12:00")}), ('D3', 2, 'lost', 'lead', 'lost', ${at(2, "12:00")}),
        ('D4', 1, 'open', null, 'lead', ${at(1, "10:00")}), ('D4', 2, 'lost', 'lead', 'lost', ${at(1, "10:30")}),
        ('D5', 1, 'open', null, 'lead', ${at(8, "10:00")}), ('D5', 2, 'won', 'lead', 'won', ${at(3, "10:00")}),
        ('D6', 1, 'open', null, 'lead', ${at(25, "10:00")}), ('D6', 2, 'move', 'lead', 'qualified', ${at(20, "10:00")}),
        ('D6', 3, 'won', 'qualified', 'won', ${at(12, "10:00")}),
        ('D7', 1, 'open', null, 'lead', ${at(22, "10:00")}), ('D7', 2, 'move', 'lead', 'qualified', ${at(19, "10:00")}),
        ('D7', 3, 'move', 'qualified', 'negotiations', ${at(16, "10:00")}), ('D7', 4, 'won', 'negotiations', 'won', ${at(14, "10:00")}),
        ('D8', 1, 'open', null, 'lead', ${at(18, "10:00")}), ('D8', 2, 'move', 'lead', 'qualified', ${at(13, "10:00")}),
        ('D8', 3, 'lost', 'qualified', 'lost', ${at(9, "10:00")}))
        as h (k, n, kind, from_stage, to_stage, at)
      join public.deals dl on dl.org_id = '${org}' and dl.title = 'Analytics ' || h.k;

    -- Sales: two confirmed and one cancelled (left out).
    with o as (
      insert into private.orders (org_id, company_id, fulfilment, status, created_by, created_at)
      select '${org}', c.id, 'from_stock', 'confirmed', '${admin}', ${at(6, "16:00")}
        from public.companies c where c.org_id = '${org}' and c.name = 'Comptoir Brécy'
      returning id)
    insert into private.order_lines (order_id, org_id, position, product_id, product_name, quantity, unit_price)
    select o.id, '${org}', l.pos, null, l.name, l.qty, l.price
      from o, (values (1, '${XSS_NAME}', 10, 89.40), (2, 'Denim jacket', 20, 30)) as l (pos, name, qty, price);
    with o as (
      insert into private.orders (org_id, company_id, fulfilment, status, created_by, created_at)
      select '${org}', c.id, 'direct_from_source', 'confirmed', '${rep}', ${at(2, "16:00")}
        from public.companies c where c.org_id = '${org}' and c.name = 'Atelier Nordlys'
      returning id)
    insert into private.order_lines (order_id, org_id, position, product_id, product_name, quantity, unit_price)
    select o.id, '${org}', 1, null, 'Denim jacket', 5, 30 from o;
    with o as (
      insert into private.orders (org_id, company_id, fulfilment, status, created_by, created_at, cancelled_at, cancelled_by)
      select '${org}', c.id, 'from_stock', 'cancelled', '${admin}', ${at(3, "16:00")}, ${at(3, "17:00")}, '${admin}'
        from public.companies c where c.org_id = '${org}' and c.name = 'Maison Verdane'
      returning id)
    insert into private.order_lines (order_id, org_id, position, product_id, product_name, quantity, unit_price)
    select o.id, '${org}', 1, null, 'Denim jacket', 100, 30 from o;

    -- Right now (P3). The imports: one of five leads 60 days ago, one whose leads are all gone, one rolled back.
    insert into public.import_batches (org_id, kind, filename, status, uploaded_by, row_count, imported, created_at)
    values ('${org}', 'leads', '${file.replaceAll("'", "''")}', 'imported', '${admin}', 5, 5, now() - interval '60 days'),
           ('${org}', 'leads', '${EMPTY_FILE}', 'imported', '${admin}', 2, 2, now() - interval '10 days'),
           ('${org}', 'leads', 'annule.csv', 'rolled_back', '${admin}', 3, 3, now() - interval '5 days');
    insert into public.companies (org_id, name, owner_id, lead_status, country, city, import_batch_id, last_activity_at, created_at)
    select '${org}', n.name, n.owner::uuid, n.status, 'FR', 'Lyon', b.id, n.last, b.created_at + interval '1 minute'
      from (values ('Import Aurore', '${admin}', 'cold', ${at(50, "10:00")}),
                   ('Import Brisa', '${rep}', 'warm', ${at(55, "10:00")}),
                   ('Import Cobalt', '${admin}', 'cold', null::timestamptz),
                   ('Import Dune', '${admin}', 'negotiation', now() - interval '100 days'),
                   ('Import Écume', '${rep}', 'customer', null))
           as n (name, owner, status, last)
      join public.import_batches b on b.org_id = '${org}' and b.status = 'imported' and b.row_count = 5;
    insert into public.activities (org_id, company_id, user_id, type, outcome, body, created_at)
    select '${org}', c.id, a.who::uuid, a.type, a.outcome, null, a.at
      from (values ('Import Aurore', '${admin}', 'call', 'connected', ${at(50, "10:00")}),
                   ('Import Brisa', '${rep}', 'email', 'sent', ${at(55, "10:00")})) as a (lead, who, type, outcome, at)
      join public.companies c on c.name = a.lead and c.org_id = '${org}';
    insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, status, stage_entered_at,
                              closed_at, fulfilment, version, created_at)
    select '${org}', c.id, s.id, c.owner_id, c.owner_id, 'Analytics ' || d.k, d.value, d.status, coalesce(d.closed, d.opened),
           d.closed, d.fulfilment, 1, d.opened
      from (values ('I1', 'Import Aurore', 'won', 2500::numeric, 'won', ${at(45, "10:00")}, ${at(40, "10:00")}, 'from_stock'),
                   ('I2', 'Import Brisa', 'lead', null, 'open', ${at(50, "11:00")}, null::timestamptz, null))
           as d (k, lead, stage, value, status, opened, closed, fulfilment)
      join public.companies c on c.name = d.lead and c.org_id = '${org}'
      join public.pipeline_stages s on s.org_id = '${org}' and s.key = d.stage;
    insert into public.deal_stage_history (org_id, deal_id, kind, from_stage, to_stage, version_after, created_at)
    select '${org}', dl.id, h.kind, h.from_stage, h.to_stage, h.n, h.at
      from (values ('I1', 1, 'open', null, 'lead', ${at(45, "10:00")}), ('I1', 2, 'won', 'lead', 'won', ${at(40, "10:00")}),
                   ('I2', 1, 'open', null, 'lead', ${at(50, "11:00")})) as h (k, n, kind, from_stage, to_stage, at)
      join public.deals dl on dl.org_id = '${org}' and dl.title = 'Analytics ' || h.k;
    -- The last entry per hand-added lead, as the app keeps it (written by triggers, which are off here).
    update public.companies c set last_activity_at = x.last
      from (select company_id, max(created_at) as last from public.activities
             where org_id = '${org}' and type <> 'note' group by company_id) x
     where c.id = x.company_id and c.import_batch_id is null;
    update public.companies set next_action_at = now() + interval '1 day' where org_id = '${org}' and name = 'Comptoir Brécy';
    insert into public.tasks (org_id, company_id, assignee_id, created_by, title, kind, due_date, due_at)
    select '${org}', c.id, t.who::uuid, t.who::uuid, t.title, 'call', t.due_date, t.due_at
      from (values ('Maison Verdane', '${admin}', 'Call back about sizes', (now() at time zone 'Europe/Paris')::date - 2, null::timestamptz),
                   ('Import Aurore', '${rep}', 'Chase the reorder', null, now() - interval '3 hours'),
                   ('Import Brisa', '${rep}', 'Send the catalogue', (now() at time zone 'Europe/Paris')::date, null))
           as t (lead, who, title, due_date, due_at)
      join public.companies c on c.name = t.lead and c.org_id = '${org}';
    set session_replication_role = origin;
  `.replace(new RegExp(`'(${LEADS.join("|")})'`, "g"), (_, name: string) => `'${name}${sfx}'`));
}
