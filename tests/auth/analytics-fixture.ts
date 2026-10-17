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

export const XSS_NAME = "<img src=x onerror=alert(1)>";
export const expected = {
  team: { calls: 19, reached: 9, won: 54200, revenue: 1644, sales: 2, calls7d: 11 },
  rep: { calls: 5, reached: 4, won: 8000, revenue: 150 },
};

export function seedAnalytics(org: string, admin: string, rep: string) {
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
    set session_replication_role = origin;
  `);
}
