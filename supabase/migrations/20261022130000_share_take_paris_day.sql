-- Day 7f: the client share link's limits count in the Paris day (builder decision, 16 Oct 2026; docs/log.md).
--
-- private.share_take (20261020090000_client_share.sql) cut its hour and day buckets with date_trunc in the session's
-- time zone: UTC on Supabase, so the daily caps (20 requests a link, 200 an organisation) restarted at 01:00 or 02:00 in
-- Paris, and the DB tests (PGTZ=Europe/Paris) saw a different day from production. The day bucket is now the Paris day
-- whatever the session's zone; the hour bucket names its zone too (the same hours for Paris and UTC, and no longer
-- dependent on a half-hour session zone). The minute bucket does not depend on the zone and is unchanged.
-- tests/unit/sql-timezone.spec.ts no longer allowlists these two lines: this definition supersedes them.
--
-- Everything else is the merged body verbatim: invoker, VOLATILE, search_path '', the limits, the 2-day clean-up.
-- create or replace keeps the owner and privileges; they are restated below as merged (share_reader only).
-- On the day this applies, a day bucket made before it (keyed on UTC midnight) is not the one counted after it, so a link
-- may take up to one extra day's allowance once; the old rows are dropped by the 2-day clean-up.
--
-- Redefines (REBASE when the named migration changes before this one merges):
--   private.share_take (20261020090000_client_share.sql): the body verbatim but b_h and b_d.

-- The counters (invoker: runs as share_reader). Over a limit it refuses without writing; otherwise it adds one to each
-- span and drops this scope's buckets older than 2 days. Under concurrency the overshoot is at most the number of
-- parallel calls.
create or replace function private.share_take(p_scope uuid, p_kind text) returns boolean
language plpgsql volatile set search_path = '' as $$
declare
  v_org constant boolean := p_scope = private.share_org();
  b_m constant timestamptz := date_trunc('minute', now());
  b_h constant timestamptz := date_trunc('hour', now(), 'Europe/Paris');
  b_d constant timestamptz := date_trunc('day', now(), 'Europe/Paris');
  lim_m integer;
  lim_h integer;
  lim_d integer;
begin
  if p_scope is null then
    return false;
  elsif p_kind = 'view' and not v_org then
    lim_m := 30; lim_h := 600;
  elsif p_kind = 'request' and not v_org then
    lim_h := 5; lim_d := 20;
  elsif p_kind = 'request' and v_org then
    lim_d := 200;
  else
    return false;
  end if;
  if exists (select 1 from private.share_rate r
              where r.scope_id = p_scope and r.kind = p_kind
                and ((r.span = 'm' and r.bucket = b_m and r.n >= lim_m)
                     or (r.span = 'h' and r.bucket = b_h and r.n >= lim_h)
                     or (r.span = 'd' and r.bucket = b_d and r.n >= lim_d))) then
    return false;
  end if;
  insert into private.share_rate as r (scope_id, kind, span, bucket, n)
  select p_scope, p_kind, s.span, s.bucket, 1
    from (values ('m', b_m, lim_m), ('h', b_h, lim_h), ('d', b_d, lim_d)) s (span, bucket, lim)
   where s.lim is not null
  on conflict (scope_id, kind, span, bucket) do update set n = r.n + 1;
  delete from private.share_rate r where r.scope_id = p_scope and r.bucket < now() - interval '2 days';
  return true;
end;
$$;

revoke all on function private.share_take(uuid, text) from public, anon, authenticated;
grant execute on function private.share_take(uuid, text) to share_reader;
