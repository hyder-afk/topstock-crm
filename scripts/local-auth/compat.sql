-- LOCAL ONLY (scripts/local-auth): what the Supabase Postgres image provides on top of plain PostgreSQL and
-- Supabase Auth's own migrations, so the app's migrations apply unchanged. Never applied to a Supabase project.
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
do $$
begin
  if to_regprocedure('auth.jwt()') is null then
    create function auth.jwt() returns jsonb language sql stable as $f$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
    $f$;
  end if;
end;
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
