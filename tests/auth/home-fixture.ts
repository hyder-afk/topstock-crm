import { expect } from "@playwright/test";
import { sql } from "./helpers";

// The Home dashboard's made-up fixture (Day 5c), shared by home.spec.ts and home-screens.spec.ts: an org of its own
// (the reused local stack holds other specs' rows in the default org), so every figure is exact. Local stack only.
const uuid = /^[0-9a-f-]{36}$/;
export const userId = (email: string) => sql(`select id from auth.users where email = '${email}'`);

// An org of its own with the five stages copied from the default org; returns its id.
export function makeOrg(name: string) {
  const id = sql(`insert into public.orgs (name) values ('${name}') returning id`);
  expect(id).toMatch(uuid);
  sql(`insert into public.pipeline_stages (org_id, name, position, is_won, is_lost, key, stall_days)
       select '${id}', s.name, s.position, s.is_won, s.is_lost, s.key, s.stall_days
         from public.pipeline_stages s join public.orgs o on o.id = s.org_id and o.name = 'TopStock Wholesale'`);
  return id;
}
export function moveTo(email: string, orgId: string, role: "admin" | "rep", firstName: string) {
  sql(`update public.profiles set org_id = '${orgId}', role = '${role}', first_name = '${firstName}', timezone = 'Europe/Paris'
       where id = '${userId(email)}'`);
}

// The fixture, written straight into the local database with the tables' own triggers off (no guard, no history row,
// no "last activity" touch), so every clock is exactly as written. All values are fixed test literals.
export function seedHome(org: string, admin: string, rep: string, tag: string) {
  const sfx = tag ? ` ${tag}` : ""; // a run id in test titles; none in screenshots
  sql(`
    set session_replication_role = replica;
    with l as (
      insert into public.companies (org_id, name, owner_id, lead_status, country, city, created_at)
      select '${org}', n.name, n.owner::uuid, 'warm', 'FR', 'Lyon', now() - interval '30 days'
        from (values ('Maison Verdane${sfx}', '${admin}'), ('Atelier Nordlys${sfx}', '${admin}'),
                     ('Comptoir Brécy${sfx}', '${admin}'), ('Halles Altamar${sfx}', '${rep}'),
                     ('Épicerie Corvel${sfx}', '${rep}'), ('Société Lunéa${sfx}', '${admin}')) as n (name, owner)
      returning id, name, owner_id)
    select 1 from l;
    insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, status, stage_entered_at,
                              closed_at, expected_close, fulfilment, lost_reason, version)
    select '${org}', c.id, s.id, c.owner_id, c.owner_id, d.title, d.value, d.status, now() - d.entered, d.closed,
           d.close_on, d.fulfilment, d.reason, 1
      from (values
        ('Maison Verdane${sfx}', 'lead', 'Denim jackets', 12000::numeric, 'open', interval '1 hour', null::timestamptz, null::date, null, null),
        ('Atelier Nordlys${sfx}', 'qualified', 'Stalled order', 8000, 'open', interval '20 days', null, null, null, null),
        ('Comptoir Brécy${sfx}', 'negotiations', 'Spring range', 30000, 'open', interval '2 days', null, (now() at time zone 'Europe/Paris')::date + 3, null, null),
        ('Halles Altamar${sfx}', 'lead', 'Past due', 5000, 'open', interval '1 day', null, (now() at time zone 'Europe/Paris')::date - 2, null, null),
        ('Épicerie Corvel${sfx}', 'qualified', 'No value yet', null, 'open', interval '1 day', null, null, null, null),
        ('Société Lunéa${sfx}', 'won', 'Won pallets', 4200, 'won', interval '3 days',
         greatest((select w.month_start from private.home_window(now(), 'Europe/Paris') w) + interval '1 second', now() - interval '1 hour'), null, 'from_stock', null),
        ('Épicerie Corvel${sfx}', 'lost', 'Lost on price', null, 'lost', interval '5 days', now() - interval '3 days', null, null, 'price'))
        as d (lead, stage, title, value, status, entered, closed, close_on, fulfilment, reason)
      join public.companies c on c.name = d.lead and c.org_id = '${org}'
      join public.pipeline_stages s on s.org_id = '${org}' and s.key = d.stage;
    insert into public.deal_stage_history (org_id, deal_id, actor_id, kind, from_stage, to_stage, value_after, version_after, created_at)
    select '${org}', d.id, d.owner_id, 'won', 'negotiations', 'won', d.value, 1, now() - interval '1 hour'
      from public.deals d where d.org_id = '${org}' and d.status = 'won';
    insert into public.activities (org_id, company_id, user_id, type, outcome, body, created_at)
    select '${org}', c.id, a.who::uuid, a.type, a.outcome, a.body,
           -- today in Paris even just after midnight (the day's first seconds), else the minutes ago written below
           greatest((select w.day_start from private.home_window(now(), 'Europe/Paris') w) + interval '1 second', now() - a.ago)
      from (values ('Maison Verdane${sfx}', '${admin}', 'call', 'connected', null, interval '10 minutes'),
                   ('Atelier Nordlys${sfx}', '${admin}', 'call', 'no_answer', null, interval '12 minutes'),
                   ('Comptoir Brécy${sfx}', '${admin}', 'call', 'interested', null, interval '14 minutes'),
                   ('Halles Altamar${sfx}', '${rep}', 'call', 'no_answer', null, interval '5 minutes'),
                   ('Maison Verdane${sfx}', '${admin}', 'note', null, 'SECRET-NOTE-${tag} asked about prices', interval '20 minutes'))
           as a (lead, who, type, outcome, body, ago)
      join public.companies c on c.name = a.lead and c.org_id = '${org}';
    insert into public.tasks (org_id, company_id, assignee_id, created_by, title, kind, due_date, due_at)
    select '${org}', c.id, '${admin}', '${admin}', t.title, t.kind, t.due_date, t.due_at
      from (values ('Maison Verdane${sfx}', 'Call back about sizes', 'call', (now() at time zone 'Europe/Paris')::date - 2, null::timestamptz),
                   ('Comptoir Brécy${sfx}', 'Send the price list', 'todo', (now() at time zone 'Europe/Paris')::date, null),
                   ('Atelier Nordlys${sfx}', 'Showroom visit', 'meeting', null,
                    now() + ((select w.day_end from private.home_window(now(), 'Europe/Paris') w) - now()) / 2))
           as t (lead, title, kind, due_date, due_at)
      join public.companies c on c.name = t.lead and c.org_id = '${org}';
    set session_replication_role = origin;
  `);
  return {
    stalledDeal: sql(`select id from public.deals where org_id = '${org}' and title = 'Stalled order'`),
    overdueTask: sql(`select id from public.tasks where org_id = '${org}' and title = 'Call back about sizes'`),
  };
}

