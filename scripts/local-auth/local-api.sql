-- LOCAL ONLY (scripts/local-auth): the few PostgREST behaviours the app uses, for cloud VMs where the real
-- PostgREST cannot run. Never applied to a Supabase project; CI and Vercel use real PostgREST.
-- Everything runs as the caller's API role with the caller's JWT claims set (the gateway does that per request),
-- so row level security decides exactly as it does on Supabase. Names arrive as text and are quoted with %I;
-- values only ever travel as jsonb parameters.
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
