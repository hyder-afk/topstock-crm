-- Minimal stand-in for the Supabase auth layer, used ONLY by the local test runner on plain PostgreSQL.
-- CI runs the same tests against the real Supabase Postgres (supabase db start), which provides these.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema auth;
create schema extensions;
grant usage on schema auth, extensions to anon, authenticated, service_role;
-- Columns, defaults and nullability as on the real image (dev's information_schema, 16 Oct 2026): created_at and
-- raw_user_meta_data have NO default (Supabase Auth fills them itself), so a test that needs a creation time sets it.
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  recovery_sent_at timestamptz,   -- read by the security digest (Supabase Auth sets it when a reset email goes out)
  deleted_at timestamptz          -- Supabase Auth's soft delete
);
-- The security digest (20261023090000_security_digest.sql) counts rows in three more Supabase Auth tables. These copy
-- the columns it reads and the NOT NULL columns of the real ones, with the real defaults: none (checked on the dev
-- project, 16 Oct 2026).
create type auth.aal_level as enum ('aal1', 'aal2', 'aal3');
create type auth.factor_type as enum ('totp', 'webauthn', 'phone');
create type auth.factor_status as enum ('unverified', 'verified');
create table auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz,
  updated_at timestamptz,
  factor_id uuid,
  aal auth.aal_level,
  not_after timestamptz
);
create table auth.mfa_factors (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  friendly_name text,
  factor_type auth.factor_type not null,
  status auth.factor_status not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create table auth.mfa_challenges (
  id uuid primary key,
  factor_id uuid not null references auth.mfa_factors (id) on delete cascade,
  created_at timestamptz not null,
  verified_at timestamptz,
  ip_address inet not null
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
