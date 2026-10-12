-- LOCAL ONLY stand-in for the Supabase Storage schema (Day 4d), for the test runners on plain PostgreSQL:
-- scripts/db-test.sh and scripts/db-perf.sh (through shim.sql) and scripts/local-auth/start.sh. CI and Supabase have
-- the real schema, written by storage-api's own migrations. Only what the app's migration and tests touch: the two
-- tables with row level security on (no policy here: deny by default, as on Supabase), the same grants as Supabase
-- (the API roles may try anything; the policies decide), the unique (bucket_id, name) index and storage.foldername
-- (copied from storage-api's definition). Uploads themselves need the real storage-api, so they run only in CI.
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index bname on storage.buckets (name);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text collate "C",
  owner uuid,
  owner_id text,
  metadata jsonb,
  version text,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now()
);
create unique index bucketid_objname on storage.objects (bucket_id, name);
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
create function storage.foldername(name text) returns text[]
language plpgsql as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
