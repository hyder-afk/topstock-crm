-- Day 7d: Gate 1 read-only checks on the DEV project (swhkafqlmfhvgpsgdqjp) only. Never on production.
-- Run through the Supabase MCP (read_only=true) or the SQL editor of the dev project. Every statement is a SELECT;
-- answers are counts and sizes only (no names, no addresses, no row contents).

-- 1. Security item 15 (Day 7 plan section 2): stored lead facts match their rules. Each must be 0.
select 'has_contact_phone_consistent' as check, count(*) as wrong
  from public.companies c
 where c.has_contact_phone is distinct from exists (
         select 1 from public.contacts k where k.company_id = c.id and k.phone ~ '[0-9]' and k.phone_wrong_at is null)
union all
select 'call_zone_matches_map', count(*)
  from public.companies where call_zone is distinct from private.lead_call_zone(timezone, country)
union all
select 'call_zone_is_a_known_key', count(*)
  from public.companies where not (call_zone = any (private.call_zone_keys()))
union all
select 'queue_rank_matches_rule', count(*)
  from public.companies c
 where c.queue_rank is distinct from (
         case
           when not ((coalesce(c.phone ~ '[0-9]', false) and c.phone_wrong_at is null) or c.has_contact_phone) then null
           when c.lead_status = 'negotiation' then 0
           when c.lead_status = 'warm' then 1
           when c.lead_status = 'cold' then case when c.next_action_at is null then 3 else 2 end
           when c.lead_status = 'cool_off' and c.next_action_at is not null then 2
         end);

-- 2. Gate 1 item 29/30: dev holds fake data only, and which accounts exist (counts per address domain, no addresses).
select 'auth_users' as what, split_part(email, '@', 2) as domain, count(*) as n from auth.users group by 2
union all
select 'lead_emails', coalesce(split_part(email, '@', 2), '(none)'), count(*) from public.companies group by 2
union all
select 'contact_emails', coalesce(split_part(email, '@', 2), '(none)'), count(*) from public.contacts group by 2
order by 1, 3 desc;

-- 3. Row counts of the tables a real import would fill (all expected near 0 or test-sized on dev).
select 'companies' as t, count(*) from public.companies
union all select 'contacts', count(*) from public.contacts
union all select 'activities', count(*) from public.activities
union all select 'tasks', count(*) from public.tasks
union all select 'deals', count(*) from public.deals
union all select 'files', count(*) from public.files
union all select 'products', count(*) from public.products
union all select 'stock_movements', count(*) from private.stock_movements
union all select 'orders', count(*) from private.orders
union all select 'audit_log', count(*) from public.audit_log;

-- 4. Security item 16 (Day 4 design line 544, Day 6 design lines 757 to 758): the Gate 1 size query, plus the whole
-- database against the Free plan's 500 MB.
select n.nspname || '.' || c.relname as relation, pg_size_pretty(pg_total_relation_size(c.oid)) as size,
       pg_total_relation_size(c.oid) as bytes
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where (n.nspname, c.relname) in (('public', 'audit_log'), ('public', 'activities'), ('public', 'tasks'),
                                  ('public', 'companies'), ('private', 'stock_movements'), ('private', 'orders'),
                                  ('private', 'order_lines'))
union all
select 'database ' || current_database(), pg_size_pretty(pg_database_size(current_database())),
       pg_database_size(current_database())
 order by bytes desc;

-- 5. Which migrations the dev project has (deploy-dev-db applies main's; Day 7a to 7f are not on main yet).
select version, name from supabase_migrations.schema_migrations order by version;

-- 6. Extensions that matter for Gate 1 (pg_cron for the nightly stock job; question 3).
select extname, extversion from pg_extension where extname in ('pg_cron', 'pgcrypto', 'pg_net', 'plpgsql_check') order by 1;
