#!/bin/bash
# Planted breaks for supabase/tests/gate1_attack.sql (Day 7d): each must make the file fail. Run it against a scratch
# database that holds every migration and nothing else (never a shared or remote one); every break runs inside a
# transaction that is rolled back. Usage: bash docs/evidence/day7d/gate1-breaks.sh "host=... port=... dbname=..."
CONN="${1:?a libpq connection string for a scratch database}"
F="$(cd "$(dirname "$0")/../../.." && pwd)/supabase/tests/gate1_attack.sql"
while IFS='|' read -r name sql; do
  out=$( { echo "begin;"; echo "$sql"; cat "$F"; echo "rollback;"; } | psql "$CONN" -X -q 2>&1 )
  first=$(echo "$out" | grep -m1 -o "FAIL: G[0-9][^\"]*" | cut -c1-110)
  if [ -n "$first" ]; then echo "| $name | caught | $first |"; else echo "| $name | NOT CAUGHT | |"; fi
done <<'LIST'
G1 RLS off on public.tasks|alter table public.tasks disable row level security;
G1 a view without security_invoker|create view public.v_leak as select id from public.companies;
G1 a materialized view in private|create materialized view private.mv_leak as select id from public.companies;
G2 require_mfa dropped on private.stock_movements|drop policy require_mfa on private.stock_movements;
G2 require_mfa made permissive-equivalent (always true) on public.deals|drop policy require_mfa on public.deals; create policy require_mfa on public.deals as restrictive for all to authenticated using (true) with check (true);
G2 a new table with RLS but no two-factor policy|create table public.t_new (id int primary key); alter table public.t_new enable row level security;
G3 a policy for PUBLIC|create policy leak on public.tasks for select using (true);
G3 share_reader on public.companies|create policy share_leak on public.companies for select to share_reader using (true);
G4 a new SECURITY DEFINER function|create function private.planted() returns int language sql security definer set search_path = '' as 'select 1';
G4 a reviewed DEFINER function without search_path|alter function private.is_admin() reset search_path;
G4 a trigger-only DEFINER function callable by authenticated|grant execute on function private.nightly_stock_jobs() to authenticated;
G4 a DEFINER function made INVOKER|alter function private.lead_has_files(uuid) security invoker;
G5 PUBLIC can execute a function|grant execute on function public.get_lead(uuid) to public;
G6 dynamic SQL in a new function|create function public.planted_exec(t text) returns void language plpgsql as $$ begin execute 'select 1'; end $$; revoke execute on function public.planted_exec(text) from public;
G7 TRUNCATE for authenticated|grant truncate on public.tasks to authenticated;
LIST
