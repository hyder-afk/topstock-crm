-- Minimal stand-in for the Supabase auth layer, used ONLY by the local test runner on plain PostgreSQL.
-- CI runs the same tests against the real Supabase Postgres (supabase db start), which provides these.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema auth;
create schema extensions;
grant usage on schema auth, extensions to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
-- As on Supabase (users_email_partial_key): one account per email, so two suites' fixtures cannot share an address.
create unique index users_email_partial_key on auth.users (email);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;
grant execute on all functions in schema auth to anon, authenticated, service_role;
-- Supabase grants these by default on public; the migration revokes what it does not want.
grant usage on schema public to anon, authenticated, service_role;
-- Day 4d: the Supabase Storage stand-in (bucket and objects tables, storage.foldername).
\ir storage_shim.sql
