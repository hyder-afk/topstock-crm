-- LOCAL ONLY (scripts/local-auth): the few PostgREST behaviours the app uses, for cloud VMs where the real
-- PostgREST cannot run. Never applied to a Supabase project; CI and Vercel use real PostgREST.
-- Everything runs as the caller's API role with the caller's JWT claims set (per request: the gateway sets the claims,
-- local_gateway.run below switches to the role), so row level security decides exactly as it does on Supabase.
-- Names arrive as text and are quoted with %I; values only ever travel as jsonb parameters.
create schema if not exists local_api;
grant usage on schema local_api to anon, authenticated, service_role;

-- POST /rest/v1/rpc/<fn> with a JSON object of named arguments.
create or replace function local_api.rpc(fn text, args jsonb) returns jsonb
language plpgsql as $$
declare
  p record;
  cols text;
  call_args text;
  q text;
  result jsonb;
begin
  select pr.proretset, pr.prorettype, pr.pronargs, pr.proargnames, pr.proargtypes::oid[] as argtypes
    into p
    from pg_proc pr
   where pr.pronamespace = 'public'::regnamespace and pr.proname = fn;
  if not found then
    raise exception 'Could not find the function public.%', fn using errcode = '42883';
  end if;
  select string_agg(format('%I %s', a.n, format_type(a.t, null)), ', ' order by a.i),
         string_agg(format('%I => r.%I', a.n, a.n), ', ' order by a.i)
    into cols, call_args
    from unnest(p.proargnames[1:p.pronargs], p.argtypes) with ordinality as a (n, t, i)
   where coalesce(args, '{}'::jsonb) ? a.n;
  if p.prorettype = 'void'::regtype then
    if cols is null then
      execute format('select public.%I()', fn);
    else
      execute format('select public.%I(%s) from jsonb_to_record($1) as r(%s)', fn, call_args, cols) using args;
    end if;
    return null;
  end if;
  if p.proretset then
    q := case when cols is null
              then format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I() x', fn)
              else format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from jsonb_to_record($1) as r(%s), public.%I(%s) x',
                          cols, fn, call_args) end;
  else
    q := case when cols is null
              then format('select to_jsonb(public.%I())', fn)
              else format('select to_jsonb(public.%I(%s)) from jsonb_to_record($1) as r(%s)', fn, call_args, cols) end;
  end if;
  execute q into result using args;
  return result;
end;
$$;

-- GET /rest/v1/<table>?select=a,b&col=eq.value (equality filters only).
create or replace function local_api.select_rows(tbl text, cols text[], filters jsonb) returns jsonb
language plpgsql as $$
declare
  fields text;
  conds text;
  result jsonb;
begin
  select string_agg(format('%L, t.%I', c, c), ', ') into fields from unnest(cols) as c;
  select string_agg(format('t.%I::text = %L', f.key, f.value), ' and ') into conds from jsonb_each_text(filters) as f;
  execute format('select coalesce(jsonb_agg(jsonb_build_object(%s)), ''[]''::jsonb) from public.%I t where %s',
                 fields, tbl, coalesce(conds, 'true'))
    into result;
  return result;
end;
$$;

-- PATCH /rest/v1/<table>?col=eq.value with a JSON object of new values.
create or replace function local_api.update_rows(tbl text, vals jsonb, filters jsonb) returns integer
language plpgsql as $$
declare
  sets text;
  conds text;
  n integer;
begin
  select string_agg(format('%I = r.%I', k, k), ', ') into sets from jsonb_object_keys(vals) as k;
  select string_agg(format('t.%I::text = %L', f.key, f.value), ' and ') into conds from jsonb_each_text(filters) as f;
  execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) r where %s',
                 tbl, sets, tbl, coalesce(conds, 'true'))
    using vals;
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on all functions in schema local_api to anon, authenticated, service_role;

-- The gateway's only entry point: one call per request, made by psql as postgres after it has set the caller's JWT
-- claims. It switches to the caller's API role first (set_config('role', ..., true), as the gateway used to do itself),
-- so the request, and every function and table it reaches, runs as anon, authenticated or service_role under row
-- level security; it never runs the request as postgres. The answer is one value on stdout, never psql's stderr text:
--   ok, a newline, the result as JSON   (just "ok" when the result is SQL null: a void function, a PATCH)
--   error, a newline, {"code", "message", "hint"} as JSON, read with GET STACKED DIAGNOSTICS
-- so a line break inside a message or detail (an imported value quoted by 22P02, 23505 or 23514) cannot pose as a
-- hint, and a hint keeps all its lines. The begin ... exception block is a savepoint: an error undoes everything the
-- request did, so the gateway's commit afterwards writes nothing; on success the commit keeps it.
-- Bodies and filters arrive as JSON text and are cast inside the block, so a value jsonb refuses is a caught error.
-- Granted to nobody: only postgres (the gateway's connection) can use the schema, never anon, authenticated or
-- service_role.
create schema if not exists local_gateway;
revoke all on schema local_gateway from public;

create or replace function local_gateway.run(p_role text, p_kind text, p_name text, p_body text, p_cols text,
                                             p_filters text) returns text
language plpgsql as $$
declare
  result jsonb;
  err_code text;
  err_message text;
  err_hint text;
begin
  begin
    perform set_config('role', p_role, true);
    case p_kind
      when 'rpc' then
        result := local_api.rpc(p_name, p_body::jsonb);
      when 'select' then
        result := local_api.select_rows(p_name, string_to_array(p_cols, ','), p_filters::jsonb);
      when 'update' then
        result := to_jsonb(local_api.update_rows(p_name, p_body::jsonb, p_filters::jsonb));
    end case;
  exception when others then
    get stacked diagnostics err_code = returned_sqlstate, err_message = message_text, err_hint = pg_exception_hint;
    return 'error' || chr(10)
      || jsonb_build_object('code', err_code, 'message', err_message, 'hint', nullif(err_hint, ''))::text;
  end;
  return 'ok' || coalesce(chr(10) || result::text, '');
end;
$$;
revoke all on function local_gateway.run(text, text, text, text, text, text) from public, anon, authenticated, service_role;

-- LOCAL ONLY probe row for scripts/local-auth/smoke-large-rpc.mjs (never in supabase/migrations): table GET/PATCH
-- round trips, and proof that a failed call writes nothing. Row level security is on with no policy, so only
-- service_role (bypassrls in the local stack) sees the row; it may read and change it, nothing more.
create table if not exists public.local_gateway_probe_rows (id integer primary key, note text not null default '');
alter table public.local_gateway_probe_rows enable row level security;
insert into public.local_gateway_probe_rows (id) values (1) on conflict (id) do nothing;
revoke all on table public.local_gateway_probe_rows from public, anon, authenticated;
grant select, update on table public.local_gateway_probe_rows to service_role;

-- LOCAL ONLY probe for the same smoke test. Keys of p_payload, in this order:
--   write: sets the probe row's note to this text (a later error shows whether the write survived);
--   cast: casts this text to integer (a 22P02 error whose message quotes the value, as an imported value would be);
--   raise: raises 22023 with a fixed detail and hint;
--   raise_with: sends a NOTICE with its own hint, then raises 22023 with this object's message, detail and hint;
-- otherwise it reports what reached the database: byte size and md5 of p_payload->>'blob', and the role and JWT role
-- the call ran as. Executable by service_role only, so an anon call must fail.
create or replace function public.local_gateway_probe(p_payload jsonb) returns jsonb
language plpgsql set search_path = '' as $$
begin
  if p_payload ? 'write' then
    update public.local_gateway_probe_rows set note = p_payload->>'write' where id = 1;
  end if;
  if p_payload ? 'cast' then
    perform (p_payload->>'cast')::integer;
  end if;
  if p_payload ? 'raise' then
    raise exception 'local probe refused' using errcode = '22023', detail = 'local probe detail', hint = 'local_probe_hint';
  end if;
  if p_payload ? 'raise_with' then
    raise notice 'local probe notice' using hint = 'local_probe_notice_hint';
    raise exception using errcode = '22023',
      message = coalesce(p_payload->'raise_with'->>'message', 'local probe refused'),
      detail = coalesce(p_payload->'raise_with'->>'detail', ''),
      hint = coalesce(p_payload->'raise_with'->>'hint', '');
  end if;
  return jsonb_build_object(
    'bytes', octet_length(p_payload->>'blob'),
    'md5', md5(p_payload->>'blob'),
    'role', current_user,
    'jwt_role', current_setting('request.jwt.claims', true)::jsonb->>'role');
end;
$$;
revoke all on function public.local_gateway_probe(jsonb) from public, anon, authenticated;
grant execute on function public.local_gateway_probe(jsonb) to service_role;
