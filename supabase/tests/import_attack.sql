-- Day 3b attack and behaviour tests for the lead import (design: docs/evidence/day3b/design.md section 4 and 6A).
-- Runs after rls_attack.sql on the same database (scripts/db-test.sh, CI job "rls"), reusing its users: admin a,
-- manager a1, rep b1, other-org admin c1. Any failure raises an exception and stops the run (ON_ERROR_STOP).
\set ON_ERROR_STOP 1
\set QUIET 1

-- Helpers (temporary functions do not survive into a new psql session, so they are defined again here) -------------
-- Sets the JWT claims the way Supabase does. totp_age_s: seconds since the two-factor code was entered (null = none).
create function pg_temp.as_user(sub text, aal text, totp_age_s integer default null) returns void
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', sub, 'role', 'authenticated', 'aal', aal,
    'amr', case when totp_age_s is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - totp_age_s)) end
  )::text, false)
$$;

-- Runs a statement that must fail with this SQLSTATE (and hint, when given).
create function pg_temp.expect_error(stmt text, want_state text, want_hint text default null) returns void
language plpgsql as $$
declare
  got_state text;
  got_hint text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics got_state = returned_sqlstate, got_hint = pg_exception_hint;
    if got_state <> want_state or (want_hint is not null and coalesce(got_hint, '') <> want_hint) then
      raise exception 'FAIL: "%" gave % (hint "%"), expected % (hint "%")', stmt, got_state, got_hint, want_state, want_hint;
    end if;
    return;
  end;
  raise exception 'FAIL: "%" succeeded, expected %', stmt, want_state;
end;
$$;

-- Runs a statement that must succeed, then undoes it: a probe that is allowed leaves nothing behind.
create function pg_temp.expect_ok(stmt text) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
    raise exception 'probe undone' using errcode = 'TS001';
  exception
    when sqlstate 'TS001' then
      return;
    when others then
      raise exception 'FAIL: "%" gave %, expected it to succeed', stmt, sqlstate;
  end;
end;
$$;

-- The rows of the happy-path file: one case per row (row 1 is the header). See the expected outcomes further down.
create function pg_temp.happy_rows() returns jsonb
language sql as $$
  select jsonb_build_array(
    jsonb_build_object('row_no', 2, 'name', 'Alpha SARL', 'owner_id', '00000000-0000-0000-0000-00000000000a',
                       'lead_status', 'warm', 'email', 'alpha@example.com', 'city', 'Paris', 'country', 'FR',
                       'last_activity', '2025-06-01T09:15:00', 'fixes', '[]'::jsonb),
    jsonb_build_object('row_no', 3, 'problems', jsonb_build_array('name_missing')),
    jsonb_build_object('row_no', 4, 'name', 'Alpha again', 'lead_status', 'cold', 'email', 'ALPHA@Example.com'),
    jsonb_build_object('row_no', 5, 'name', 'Beta', 'lead_status', 'cold', 'phone', '+33 6 39 98 00 01',
                       'last_activity', '2025-03-30T02:30:00'),
    jsonb_build_object('row_no', 6, 'name', 'Beta two', 'lead_status', 'cold', 'phone', '06 39 98 00 01'),
    jsonb_build_object('row_no', 7, 'name', 'Beta three', 'lead_status', 'cold', 'phone', '0033 6 39 98 00 01'),
    jsonb_build_object('row_no', 8, 'name', 'Café Gamma S.A.R.L.', 'lead_status', 'cold', 'city', 'Lyon', 'country', 'FR'),
    jsonb_build_object('row_no', 9, 'name', 'cafe gamma', 'lead_status', 'cold', 'city', 'LYON', 'country', 'FR'),
    jsonb_build_object('row_no', 10, 'name', 'Delta', 'lead_status', 'cold', 'city', 'Nantes', 'country', 'FR'),
    jsonb_build_object('row_no', 11, 'name', 'Delta', 'lead_status', 'cold', 'city', 'Nantes', 'country', 'FR',
                       'email', 'delta@example.com'),
    jsonb_build_object('row_no', 12, 'name', 'Exists by email', 'lead_status', 'cold', 'email', 'EXIST@example.com'),
    jsonb_build_object('row_no', 13, 'name', 'Exists by phone', 'lead_status', 'cold', 'phone', '01 99 00 11 22'),
    jsonb_build_object('row_no', 14, 'name', 'Maison Existante', 'lead_status', 'cold', 'city', 'Lyon', 'country', 'FR'),
    jsonb_build_object('row_no', 15, 'name', 'Zeta', 'lead_status', 'cold', 'email', 'zeta@example.com',
                       'owner_id', '00000000-0000-0000-0000-0000000000c1'),
    jsonb_build_object('row_no', 16, 'name', 'Future', 'lead_status', 'cold', 'last_activity', '2031-01-01T10:00:00'),
    jsonb_build_object('row_no', 17, 'name', '東京商事', 'lead_status', 'customer', 'city', 'Tokyo', 'country', 'JP'),
    jsonb_build_object('row_no', 18, 'name', '!!!', 'lead_status', 'cold', 'city', 'Paris', 'country', 'FR'),
    jsonb_build_object('row_no', 19, 'name', 'Zeta two', 'lead_status', 'cold', 'email', 'zeta@example.com'))
$$;

-- Fixtures (superuser) --------------------------------------------------------------------------------------------
-- A second admin in the main org, the Day 3a fixture batch closed, and three leads the file will match.
insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000000b', 'admin2@test.invalid', '{"first_name":"Henri"}');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-00000000000b';
update public.import_batches set status = 'discarded' where id = '90000000-0000-0000-0000-00000000000a';
insert into public.companies (id, org_id, name, email, phone, city, country, created_at)
select v.id::uuid, o.id, v.name, v.email, v.phone, v.city, v.country, now() - interval '30 days'
  from public.orgs o,
       (values ('31000000-0000-0000-0000-000000000001', 'Existing email', 'exist@example.com', null, null, null),
               ('31000000-0000-0000-0000-000000000002', 'Existing phone', null, '+33 1 99 00 11 22', null, null),
               ('31000000-0000-0000-0000-000000000003', 'Maison  Existante', null, null, 'Lyon', 'FR'))
         as v (id, name, email, phone, city, country)
 where o.name = 'TopStock Wholesale';

-- 0. Duplicate keys (pure functions) -------------------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in select * from (values
      (private.lead_email_key(' Alpha@Example.COM '), 'alpha@example.com'),
      (private.lead_email_key('   '), null),
      (private.lead_phone_key('+33 (0)6 12 34 56 78'), '612345678'),
      (private.lead_phone_key('06.12.34.56.78'), '612345678'),
      (private.lead_phone_key('0033 6 12 34 56 78'), '612345678'),
      (private.lead_phone_key('1234567'), null),
      (private.lead_phone_key('+33 6 12 34 56 78 / +33 6 98 76 54 32'), null),
      -- Known limit (design open question 7): US/Canada numbers whose area codes end in the same two digits and that
      -- share the 7-digit local number give the same key, so the second one is skipped as a repeat (shown at Check).
      (private.lead_phone_key('+1 212-555-0149'), '125550149'),
      (private.lead_phone_key('+1 312-555-0149'), '125550149'),
      (private.lead_name_key('Café Gamma S.A.R.L.', 'Lyon', 'FR'), 'cafegamma|lyon|FR'),
      (private.lead_name_key('CAFE GAMMA', 'LYON', 'FR'), 'cafegamma|lyon|FR'),
      (private.lead_name_key('Łódź Trading Ltd', 'Łódź', 'PL'), 'lodztrading|lodz|PL'),
      (private.lead_name_key('Œuvre & Fils', 'Saint-Étienne', 'FR'), 'oeuvrefils|saintetienne|FR'),
      (private.lead_name_key('SARL', 'Paris', 'FR'), 'sarl|paris|FR'),
      (private.lead_name_key('Alpha', null, 'FR'), null),
      (private.lead_name_key('Alpha', ' - ', 'FR'), null),
      (private.lead_name_key('!!!', 'Paris', 'FR'), null),
      (private.lead_name_key('東京商事', 'Tokyo', 'JP'), '東京商事|tokyo|JP')
    ) as k (got, want) loop
    if t.got is distinct from t.want then
      raise exception 'FAIL: duplicate key gave "%", expected "%"', t.got, t.want;
    end if;
  end loop;
  if private.lead_db_problem('x', null, null, null, null, 'cold') is not null
     or private.lead_db_problem('', null, null, null, null, 'cold') <> 'db_name'
     or private.lead_db_problem('x', '06 ext 12', null, null, null, 'cold') <> 'db_phone'
     or private.lead_db_problem('x', null, 'no-at-sign', null, null, 'cold') <> 'db_email'
     or private.lead_db_problem('x', null, null, repeat('c', 121), null, 'cold') <> 'db_city'
     or private.lead_db_problem('x', null, null, null, 'France', 'cold') <> 'db_country'
     or private.lead_db_problem('x', null, null, null, null, 'hot') <> 'db_status' then
    raise exception 'FAIL: lead_db_problem';
  end if;
  -- Only contacts, activities, deals, tasks (Day 4a), holds (Day 6a), sales and stock requests (Day 6d) and client
  -- links (Day 6e) point at a lead: the "untouched" rule checks exactly these.
  if (select array_agg(conrelid::regclass::text order by conrelid::regclass::text) from pg_constraint
       where contype = 'f' and confrelid = 'public.companies'::regclass)
     is distinct from array['activities', 'contacts', 'deals', 'private.orders', 'private.share_links',
                             'private.stock_requests', 'private.stock_reservations', 'tasks'] then
    raise exception 'FAIL: a new table references leads; update private.lead_import_untouched';
  end if;
end $$;

-- 0b. The key rules table shared with the TypeScript copy (tests/unit/helpers/dedupe-ref.ts) ---------------------
-- tests/unit/key-rules.spec.ts holds the same rows and checks that the literal between the two markers below equals
-- them, then runs them through the TypeScript copy: both sides give the same keys. Columns: name, city, country, email,
-- phone, then the expected name, email and phone keys. The rows from "A+B $ C = D" on hold the characters that once
-- gave a different key in an ICU database (Supabase, CI) and a libc one (the local runner): symbols, emoji, Greek final
-- sigma, decomposed accents, "|"... The same rows must pass under both (scripts/db-test.sh runs libc).
do $$
declare
  t record;
begin
  for t in select * from (values
      -- key-table:start
      ('Café Gamma S.A.R.L.', 'Lyon', 'FR', ' Alpha@Example.COM ', '+33 (0)6 12 34 56 78', 'cafegamma|lyon|FR', 'alpha@example.com', '612345678'),
      ('CAFE GAMMA SARL', 'LYON', 'FR', 'alpha@example.com', '06.12.34.56.78', 'cafegamma|lyon|FR', 'alpha@example.com', '612345678'),
      ('Œuvre & Fils', 'Saint-Étienne', 'FR', '   ', '0033 6 12 34 56 78', 'oeuvrefils|saintetienne|FR', null, '612345678'),
      ('ŒUVRE ÆTHER æon', 'Århus', 'DK', 'ÉLODIE@EXEMPLE.FR', '1234567', 'oeuvreaetheraeon|arhus|DK', 'élodie@exemple.fr', null),
      ('Straße Müller GmbH', 'München', 'DE', null, '12345678', 'strassemuller|munchen|DE', null, '12345678'),
      ('GROẞHANDEL KG', 'Köln', 'DE', null, '123456789012345', 'großhandelkg|koln|DE', null, '789012345'),
      ('ſtore ŉ Co', 'Paris', 'FR', null, '1234567890123456', 'storenco|paris|FR', null, null),
      ('Łódź Trading Sp', 'Łódź', 'PL', null, '+33 6 12 34 56 78 / +33 6 98 76 54 32', 'lodztradingsp|lodz|PL', null, null),
      ('ÀÉÎÕÜ Ÿ Ñ Ç Ø Đ Ħ Ŧ ĸ Ŋ', 'Ðorđe', 'RS', null, U&'\FF10\FF16 \FF11\FF12 \FF13\FF14 \FF15\FF16 \FF17\FF18', 'aeiouyncodhtkn|dorde|RS', null, null),
      ('Ĳssel BV', 'Zwolle', 'NL', null, U&'\0660\0666\0661\0662\0663\0664\0665\0666\0667\0668', 'ĳssel|zwolle|NL', null, null),
      ('İstanbul Ltd. Şti.', 'İzmir', 'TR', null, null, 'istanbulsti|izmir|TR', null, null),
      ('SARL', 'Paris', 'FR', null, null, 'sarl|paris|FR', null, null),
      ('S.A.S.', 'Nantes', 'FR', null, null, 'sas|nantes|FR', null, null),
      ('SA SARL', 'Lille', 'FR', null, null, 'sasarl|lille|FR', null, null),
      ('Sasu Sasso SAS', 'Nice', 'FR', null, null, 'sasso|nice|FR', null, null),
      ('Acme_SARL', 'Brest', 'FR', null, null, 'acme|brest|FR', null, null),
      ('Sarlington Limited', 'Leeds', 'GB', null, null, 'sarlington|leeds|GB', null, null),
      ('3M France SAS', 'Cergy', 'FR', null, null, '3mfrance|cergy|FR', null, null),
      ('Bistrot l’Ami Jean', 'Paris', 'FR', null, null, 'bistrotlamijean|paris|FR', null, null),
      ('Chez l''Ami', 'Paris', 'FR', null, null, 'chezlami|paris|FR', null, null),
      (U&'Maison\00A0Verdane\202FLtd', U&'Lyon\00A0', 'FR', null, null, 'maisonverdane|lyon|FR', null, null),
      (U&'\FF34\FF2F\FF30 \FF33\FF34\FF2F\FF23\FF2B', U&'\FF30\FF41\FF52\FF49\FF53', 'FR', U&'Contact@\FF25\FF38\FF21\FF2D\FF30\FF2C\FF25.com', null, U&'\FF54\FF4F\FF50\FF53\FF54\FF4F\FF43\FF4B|\FF50\FF41\FF52\FF49\FF53|FR', U&'contact@\FF45\FF58\FF41\FF4D\FF50\FF4C\FF45.com', null),
      (U&'\FF21\FF22\FF23\FF01\FF06\FF08\FF11\FF12\FF13\FF09', U&'Lyon\3000Est', 'FR', null, null, U&'\FF41\FF42\FF43\FF11\FF12\FF13|lyonest|FR', null, null),
      ('東京商事', 'Tokyo', 'JP', null, null, '東京商事|tokyo|JP', null, null),
      ('Dupont, Fils & Cie', 'Saint-Denis', 'FR', null, null, 'dupontfilscie|saintdenis|FR', null, null),
      ('Le "Petit" Marché', 'Aix-en-Provence', 'FR', null, null, 'lepetitmarche|aixenprovence|FR', null, null),
      ('A+B $ C = D', 'Lyon', 'FR', null, null, 'abcd|lyon|FR', null, null),
      ('Hat^Tilde~Less<More>', 'Grave`Paris', 'FR', null, null, 'hattildelessmore|graveparis|FR', null, null),
      ('Prix € ™ Café² ½', 'Paris²', 'FR', null, null, 'prixcafe|paris|FR', null, null),
      (U&'Le Comptoir 🙂 ❤\FE0F', U&'Nice \+01F1EB\+01F1F7', 'FR', null, null, 'lecomptoir|nice|FR', null, null),
      ('ΣΟΦΟΣ', 'ΑΘΉΝΑ', 'GR', null, null, 'σοφοσ|αθήνα|GR', null, null),
      ('σοφος', 'Αθήνα', 'GR', null, null, 'σοφοσ|αθήνα|GR', null, null),
      (U&'Socie\0301te\0301 Ge\0301ne\0301rale', U&'Saint-E\0301tienne', 'FR', null, null, 'societegenerale|saintetienne|FR', null, null),
      (U&'Fromagerie Durand Sa\0300rl', 'Lausanne', 'CH', null, null, 'fromageriedurand|lausanne|CH', null, null),
      ('Fromagerie Durand Sàrl', 'Lausanne', 'CH', null, null, 'fromageriedurand|lausanne|CH', null, null),
      (U&'SARL\00A0Dupont', 'Paris', 'FR', null, null, 'dupont|paris|FR', null, null),
      (U&'Dupont \FF33\FF21\FF32\FF2C', 'Paris', 'FR', null, null, U&'dupont\FF53\FF41\FF52\FF4C|paris|FR', null, null),
      ('東京、商事', '東京', 'JP', null, null, '東京商事|東京|JP', null, null),
      ('A|B', 'C', 'FR', null, null, 'ab|c|FR', null, null),
      ('A', 'B|C', 'FR', null, null, 'a|bc|FR', null, null),
      ('Durand SARL SAS', 'Paris', 'FR', null, null, 'durand|paris|FR', null, null),
      ('Sasha Inc Bv', 'Paris', 'FR', null, null, 'sasha|paris|FR', null, null),
      ('SARL SAS', 'Paris', 'FR', null, null, 'sarlsas|paris|FR', null, null),
      ('佐々木商店', '東京', 'JP', null, null, '佐々木商店|東京|JP', null, null),
      ('ジョン・スミス', '大阪', 'JP', null, null, 'ジョンスミス|大阪|JP', null, null),
      ('ООО «Ромашка»', 'Москва', 'RU', null, null, 'оооромашка|москва|RU', null, null),
      ('النور، للتجارة', 'الدار البيضاء', 'MA', null, null, 'النورللتجارة|الدارالبيضاء|MA', null, null),
      (U&'L\02BCatelier Inter\00ADnational SA\00ADRL', U&'Lyon\200B', 'FR', null, null, 'latelierinternational|lyon|FR', null, null),
      ('IRMAK INC', 'ISTANBUL', 'TR', null, null, 'irmak|istanbul|TR', null, null),
      ('Alpha', '', 'FR', null, null, null, null, null),
      ('Alpha', ' - ', 'FR', null, null, null, null, null),
      ('Alpha', null, 'FR', null, null, null, null, null),
      ('!!!', 'Paris', 'FR', null, null, null, null, null),
      ('Delta', 'Nantes', null, null, null, 'delta|nantes|', null, null)
      -- key-table:end
    ) as k (name, city, country, email, phone, name_key, email_key, phone_key) loop
    if private.lead_name_key(t.name, t.city, t.country) is distinct from t.name_key
       or private.lead_email_key(t.email) is distinct from t.email_key
       or private.lead_phone_key(t.phone) is distinct from t.phone_key then
      raise exception 'FAIL: key table row (%, %, %, %, %) gave (%, %, %), expected (%, %, %)',
        t.name, t.city, t.country, t.email, t.phone,
        private.lead_name_key(t.name, t.city, t.country), private.lead_email_key(t.email), private.lead_phone_key(t.phone),
        t.name_key, t.email_key, t.phone_key;
    end if;
  end loop;
end $$;

-- 1. anon: no function, no batch, no working rows ------------------------------------------------------------------
set role anon;
do $$ begin perform set_config('request.jwt.claims', '{"role":"anon"}', false); end $$;
do $$
declare
  stmt text;
begin
  foreach stmt in array array[
    $q$select public.create_lead_import('x.csv', null, 1, 2)$q$,
    $q$select public.stage_lead_import_rows(gen_random_uuid(), '[]')$q$,
    $q$select public.validate_lead_import(gen_random_uuid())$q$,
    $q$select * from public.list_lead_import_issues(gen_random_uuid())$q$,
    $q$select public.commit_lead_import(gen_random_uuid())$q$,
    $q$select public.preview_lead_import_rollback(gen_random_uuid())$q$,
    $q$select public.rollback_lead_import(gen_random_uuid())$q$,
    $q$select public.discard_lead_import(gen_random_uuid())$q$,
    $q$select * from public.list_lead_imports()$q$,
    $q$select count(*) from public.import_batches$q$,
    $q$select count(*) from private.lead_import_staging$q$] loop
    perform pg_temp.expect_error(stmt, '42501');
  end loop;
end $$;
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;  -- superuser: no caller

-- 2. Admin without two-factor (aal1), and with a code older than 10 minutes ---------------------------------------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal1'); end $$;
do $$
declare
  stmt text;
begin
  foreach stmt in array array[
    $q$select public.create_lead_import('x.csv', null, 1, 2)$q$,
    $q$select public.stage_lead_import_rows(gen_random_uuid(), '[{"row_no": 2, "problems": ["name_missing"]}]')$q$,
    $q$select public.validate_lead_import(gen_random_uuid())$q$,
    $q$select public.commit_lead_import(gen_random_uuid())$q$,
    $q$select public.rollback_lead_import(gen_random_uuid())$q$,
    $q$select public.discard_lead_import(gen_random_uuid())$q$,
    $q$select * from public.list_lead_imports()$q$,
    $q$select public.preview_lead_import_rollback(gen_random_uuid())$q$] loop
    perform pg_temp.expect_error(stmt, '42501', 'admin');
  end loop;
  if (select count(*) from public.import_batches) <> 0 or (select count(*) from private.lead_import_staging) <> 0 then
    raise exception 'FAIL: aal1 session reads imports';
  end if;
end $$;

-- A finished import from yesterday, to show history stays readable without a fresh code.
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;  -- superuser: no caller
insert into public.import_batches (id, org_id, filename, uploaded_by, row_count, last_row_no, status, imported)
select '91000000-0000-0000-0000-000000000001', o.id, 'old.csv', '00000000-0000-0000-0000-00000000000a', 5, 6,
       'imported', 5
  from public.orgs o where o.name = 'TopStock Wholesale';
set role authenticated;

do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 660); end $$;
do $$
declare
  stmt text;
begin
  foreach stmt in array array[
    $q$select public.create_lead_import('x.csv', null, 1, 2)$q$,
    $q$select public.stage_lead_import_rows('91000000-0000-0000-0000-000000000001', '[{"row_no": 2, "problems": ["name_missing"]}]')$q$,
    $q$select public.validate_lead_import('91000000-0000-0000-0000-000000000001')$q$,
    $q$select * from public.list_lead_import_issues('91000000-0000-0000-0000-000000000001')$q$,
    $q$select public.commit_lead_import('91000000-0000-0000-0000-000000000001')$q$,
    $q$select public.rollback_lead_import('91000000-0000-0000-0000-000000000001')$q$,
    $q$select public.discard_lead_import('91000000-0000-0000-0000-000000000001')$q$] loop
    perform pg_temp.expect_error(stmt, '42501', 'step_up');
  end loop;
  -- Going around the functions with a stale code changes nothing either.
  perform pg_temp.expect_error($q$insert into public.import_batches (filename, row_count, last_row_no) values ('x.csv', 1, 2)$q$, '42501');
  update public.import_batches set status = 'rolling_back' where id = '91000000-0000-0000-0000-000000000001';
  if (select status from public.import_batches where id = '91000000-0000-0000-0000-000000000001') <> 'imported' then
    raise exception 'FAIL: stale code changed an import status';
  end if;
  perform pg_temp.expect_error($q$insert into private.lead_import_staging (batch_id, row_no, org_id, name)
    select '91000000-0000-0000-0000-000000000001', 2, org_id, 'x' from public.import_batches limit 1$q$, '42501');
  if (select count(*) from private.lead_import_staging) <> 0 then
    raise exception 'FAIL: stale code reads working rows';
  end if;
  -- History and the undo preview need no fresh code.
  if (select count(*) from public.list_lead_imports()) <> 2 then  -- the Day 3a fixture and old.csv
    raise exception 'FAIL: history should be readable without a fresh code';
  end if;
  if (public.preview_lead_import_rollback('91000000-0000-0000-0000-000000000001') ->> 'tagged')::integer <> 0 then
    raise exception 'FAIL: undo preview';
  end if;
end $$;

-- aal2 with no authenticator code at all in the token: same as stale.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2'); end $$;
do $$ begin
  perform pg_temp.expect_error($q$select public.create_lead_import('x.csv', null, 1, 2)$q$, '42501', 'step_up');
end $$;

-- 3. Reps and managers (even with a fresh code) --------------------------------------------------------------------
do $$
declare
  who text;
  stmt text;
begin
  foreach who in array array['00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1'] loop
    perform pg_temp.as_user(who, 'aal2', 30);
    foreach stmt in array array[
      $q$select public.create_lead_import('x.csv', null, 1, 2)$q$,
      $q$select public.validate_lead_import('91000000-0000-0000-0000-000000000001')$q$,
      $q$select public.commit_lead_import('91000000-0000-0000-0000-000000000001')$q$,
      $q$select public.rollback_lead_import('91000000-0000-0000-0000-000000000001')$q$,
      $q$select public.preview_lead_import_rollback('91000000-0000-0000-0000-000000000001')$q$,
      $q$select * from public.list_lead_imports()$q$,
      $q$insert into public.import_batches (filename, row_count, last_row_no) values ('x.csv', 1, 2)$q$] loop
      perform pg_temp.expect_error(stmt, '42501');
    end loop;
    if (select count(*) from public.import_batches) <> 0 or (select count(*) from private.lead_import_staging) <> 0 then
      raise exception 'FAIL: % reads imports', who;
    end if;
  end loop;
end $$;

-- 4. Happy path: start, add rows, check, import, with exact expected outcomes ---------------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  batch uuid;
  r jsonb;
  t record;
  n integer;
begin
  batch := public.create_lead_import('happy.csv', repeat('a', 64), 18, 19);
  if (select uploaded_by from public.import_batches where id = batch) <> '00000000-0000-0000-0000-00000000000a'
     or (select status from public.import_batches where id = batch) <> 'staged' then
    raise exception 'FAIL: new import row';
  end if;
  -- Checking before every row has arrived is refused.
  perform public.stage_lead_import_rows(batch, (select jsonb_agg(e) from jsonb_array_elements(pg_temp.happy_rows()) e
                                                where (e ->> 'row_no')::integer <= 10));
  perform pg_temp.expect_error(format('select public.validate_lead_import(%L)', batch), '22023', 'incomplete');
  n := public.stage_lead_import_rows(batch, pg_temp.happy_rows());
  if n <> 9 then raise exception 'FAIL: re-sending rows should add only the new ones (got %)', n; end if;
  if public.stage_lead_import_rows(batch, pg_temp.happy_rows()) <> 0 then
    raise exception 'FAIL: sending the same rows twice added rows';
  end if;

  r := public.validate_lead_import(batch);
  if (r ->> 'status') <> 'dry_run' then raise exception 'FAIL: check status %', r; end if;
  for t in select * from (values
      (2, 'ready', null, null, null), (3, 'rejected', null, null, null),
      (4, 'duplicate_file', 'email', 2, null), (5, 'ready', null, null, null),
      (6, 'duplicate_file', 'phone', 5, null), (7, 'duplicate_file', 'phone', 5, null),
      (8, 'ready', null, null, null), (9, 'duplicate_file', 'name', 8, null),
      (10, 'duplicate_file', 'name', 11, null), (11, 'ready', null, null, null),
      (12, 'duplicate_existing', 'email', null, null), (13, 'duplicate_existing', 'phone', null, null),
      (14, 'duplicate_existing', 'name', null, null), (15, 'rejected', null, null, 'owner_unknown'),
      (16, 'rejected', null, null, 'date_out_of_range'), (17, 'ready', null, null, null),
      (18, 'ready', null, null, null), (19, 'ready', null, null, null)
    ) as e (row_no, outcome, match_key, match_row_no, reason) loop
    if not exists (select 1 from private.lead_import_staging s
                    where s.batch_id = batch and s.row_no = t.row_no and s.outcome = t.outcome
                      and s.match_key is not distinct from t.match_key
                      and s.match_row_no is not distinct from t.match_row_no
                      and s.reason is not distinct from t.reason) then
      raise exception 'FAIL: row % expected % % % %, got %', t.row_no, t.outcome, t.match_key, t.match_row_no, t.reason,
        (select row(s.outcome, s.match_key, s.match_row_no, s.reason) from private.lead_import_staging s
          where s.batch_id = batch and s.row_no = t.row_no);
    end if;
  end loop;
  if (select match_company_id from private.lead_import_staging where batch_id = batch and row_no = 12)
     <> '31000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: existing match by email should point at the existing lead';
  end if;
  if (select row(duplicates, rejected) from public.import_batches where id = batch) <> row(8, 3)
     or (r -> 'issue_counts' ->> 'ready')::integer <> 7 or (r -> 'issue_counts' ->> 'by_name')::integer <> 3 then
    raise exception 'FAIL: check counts %', r;
  end if;
  -- The problems list: every row that is not plainly ready, with the matching lead's name, and no staged values.
  if (select count(*) from public.list_lead_import_issues(batch)) <> 11
     or (select match_company_name from public.list_lead_import_issues(batch) where row_no = 12) <> 'Existing email' then
    raise exception 'FAIL: problems list';
  end if;
  if (select count(*) from public.list_lead_import_issues(batch, 12, 2)) <> 2 then
    raise exception 'FAIL: problems list paging';
  end if;
  perform pg_temp.expect_error(format('select public.stage_lead_import_rows(%L, %L)', batch,
                                      '[{"row_no": 2, "problems": ["name_missing"]}]'), '22023', 'not_staged');

  -- Import three rows, then a teammate adds a lead with row 11's email: row 11 must be skipped as already in the CRM.
  r := public.commit_lead_import(batch, 3);
  if (r ->> 'status') <> 'committing' or (r ->> 'imported_now')::integer <> 3 or (r ->> 'remaining')::integer <> 4 then
    raise exception 'FAIL: first import chunk %', r;
  end if;
  perform set_config('test.batch', batch::text, false);
end $$;

reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;  -- superuser: no caller
insert into public.companies (org_id, name, email)
select o.id, 'Added meanwhile', 'delta@example.com' from public.orgs o where o.name = 'TopStock Wholesale';
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;

do $$
declare
  batch uuid := current_setting('test.batch')::uuid;
  r jsonb;
  b public.import_batches%rowtype;
begin
  r := public.commit_lead_import(batch, 3);
  if (r ->> 'imported_now')::integer <> 2 or (r ->> 'late_duplicates')::integer <> 1 then
    raise exception 'FAIL: late duplicate not skipped %', r;
  end if;
  r := public.commit_lead_import(batch, 3);
  if (r ->> 'status') <> 'imported' then raise exception 'FAIL: import did not finish %', r; end if;
  select * into b from public.import_batches where id = batch;
  if b.imported <> 6 or b.duplicates <> 9 or b.rejected <> 3 or b.imported + b.duplicates + b.rejected <> b.row_count
     or b.imported_at is null then
    raise exception 'FAIL: final counts %', row_to_json(b);
  end if;
  -- A replayed call after the end does nothing.
  if (public.commit_lead_import(batch) ->> 'imported_now')::integer <> 0 then
    raise exception 'FAIL: replayed import call added leads';
  end if;
  perform pg_temp.expect_error(format('select public.validate_lead_import(%L)', batch), '22023', 'not_ready');
  -- The leads: tagged, in the org, owner kept, date converted from Paris time (spring-forward gap moves to 03:30).
  if (select count(*) from public.companies where import_batch_id = batch) <> 6 then
    raise exception 'FAIL: imported lead count';
  end if;
  if (select owner_id from public.companies where import_batch_id = batch and name = 'Alpha SARL')
     <> '00000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL: owner not kept';
  end if;
  if (select last_activity_at from public.companies where import_batch_id = batch and name = 'Beta')
     <> '2025-03-30 01:30:00+00' then
    raise exception 'FAIL: last activity not converted from Paris time';
  end if;
  if (select last_activity_at from public.companies where import_batch_id = batch and name = 'Alpha SARL')
     <> '2025-06-01 07:15:00+00' then
    raise exception 'FAIL: summer time conversion';
  end if;
end $$;

-- Superuser view: the working rows are gone; the audit log holds small rows only.
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;  -- superuser: no caller
do $$
declare
  batch uuid := current_setting('test.batch')::uuid;
begin
  if (select count(*) from private.lead_import_staging where batch_id = batch) <> 0 then
    raise exception 'FAIL: working rows kept after the import';
  end if;
  if (select count(*) from public.audit_log a join public.companies c on c.id::text = a.record_id
       where c.import_batch_id = batch and a.action = 'insert' and a.diff_json = jsonb_build_object('import_batch_id', batch))
     <> 6 then
    raise exception 'FAIL: imported leads should each have one small audit row';
  end if;
  if exists (select 1 from public.audit_log a join public.companies c on c.id::text = a.record_id
              where c.import_batch_id = batch
                and (a.diff_json::text ~ '(name|email|phone|_key|search_text)' )) then
    raise exception 'FAIL: lead data copied into the audit log';
  end if;
  if (select count(*) from public.audit_log where table_name = 'import_batches' and record_id = batch::text) < 4 then
    raise exception 'FAIL: import status changes not audited';
  end if;
end $$;
set role authenticated;

-- Everyone in the org sees the imported leads, and the leads list filters by import.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2'); end $$;
do $$
declare
  batch uuid := current_setting('test.batch')::uuid;
begin
  if (select count(*) from public.list_leads(p_import_batch => batch)) <> 6
     or public.count_leads(p_import_batch => batch) <> 6 then
    raise exception 'FAIL: from-this-import filter';
  end if;
  if (select count(*) from public.list_leads(p_import_batch => batch, p_search => 'beta')) <> 1 then
    raise exception 'FAIL: import filter with search';
  end if;
end $$;

-- 5. Undo keeps every lead someone worked on ------------------------------------------------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  batch uuid := current_setting('test.batch')::uuid;
  r jsonb;
  untagged integer := (select count(*) from public.companies where import_batch_id is null);
begin
  -- One edit, one activity, one contact, one deal.
  perform public.bulk_update_leads(array(select id from public.companies where import_batch_id = batch and name = 'Alpha SARL'),
                                   p_status => 'customer');
  insert into public.activities (company_id, type, outcome)  -- the author is the caller (Day 4a)
  values ((select id from public.companies where import_batch_id = batch and name = 'Beta'), 'call', 'no_answer');
  perform public.add_contact((select id from public.companies where import_batch_id = batch and name = 'Café Gamma S.A.R.L.'), 'Ana');
  insert into public.deals (company_id, stage_id, owner_id)
  select (select id from public.companies where import_batch_id = batch and name = '東京商事'), s.id,
         '00000000-0000-0000-0000-00000000000a'
    from public.pipeline_stages s order by s.position limit 1;
  perform set_config('test.untagged', untagged::text, false);
end $$;

-- An activity that did not move the last-activity date (added with that trigger off) still keeps its lead.
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;  -- superuser: no caller
alter table public.activities disable trigger touch_company_activity;
insert into public.activities (org_id, company_id, type, user_id)
select c.org_id, c.id, 'note', '00000000-0000-0000-0000-00000000000a'
  from public.companies c where c.import_batch_id = current_setting('test.batch')::uuid and c.name = '!!!';
alter table public.activities enable trigger touch_company_activity;
set role authenticated;

do $$
declare
  batch uuid := current_setting('test.batch')::uuid;
  r jsonb;
  untagged integer := current_setting('test.untagged')::integer;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  r := public.preview_lead_import_rollback(batch);
  if r <> '{"tagged": 6, "removable": 1, "kept": 5}'::jsonb then raise exception 'FAIL: undo preview %', r; end if;
  -- Another admin may undo; one lead per call to exercise the loop.
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000b', 'aal2', 30);
  r := public.rollback_lead_import(batch, 1);
  if (r ->> 'status') <> 'rolling_back' or (r ->> 'removed_now')::integer <> 1 then
    raise exception 'FAIL: first undo chunk %', r;
  end if;
  r := public.rollback_lead_import(batch, 1);
  r := public.rollback_lead_import(batch, 1);
  if (r ->> 'status') <> 'rolled_back' or (r ->> 'kept')::integer <> 5 then raise exception 'FAIL: undo end %', r; end if;
  if (select count(*) from public.companies where import_batch_id = batch) <> 5
     or (select count(*) from public.companies where import_batch_id is null) <> untagged then
    raise exception 'FAIL: undo removed the wrong leads';
  end if;
  if (public.rollback_lead_import(batch) ->> 'removed_now')::integer <> 0 then
    raise exception 'FAIL: second undo removed leads';
  end if;
  if (select row(status, kept, rolled_back_by) from public.import_batches where id = batch)
     <> row('rolled_back'::text, 5, '00000000-0000-0000-0000-00000000000b'::uuid) then
    raise exception 'FAIL: undo history row';
  end if;
end $$;

reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;  -- superuser: no caller
do $$ begin
  if (select count(*) from public.audit_log
       where action = 'delete' and table_name = 'companies'
         and diff_json = jsonb_build_object('import_batch_id', current_setting('test.batch')::uuid, 'undo', true)) <> 1 then
    raise exception 'FAIL: undone leads should each have one small audit row';
  end if;
end $$;
set role authenticated;

-- 6. Going around the functions (direct API calls by an admin with a fresh code) -----------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  batch uuid;
  other uuid;
  stmt text;
begin
  -- Server-kept batch columns cannot be named.
  foreach stmt in array array[
    $q$insert into public.import_batches (filename, row_count, last_row_no, uploaded_by) values ('x.csv', 1, 2, '00000000-0000-0000-0000-00000000000b')$q$,
    $q$insert into public.import_batches (filename, row_count, last_row_no, status) values ('x.csv', 1, 2, 'imported')$q$,
    $q$insert into public.import_batches (filename, row_count, last_row_no, imported) values ('x.csv', 1, 2, 1)$q$,
    $q$update public.import_batches set imported = 99$q$,
    $q$update public.import_batches set kept = 0$q$,
    $q$delete from public.import_batches$q$] loop
    perform pg_temp.expect_error(stmt, '42501');
  end loop;
  -- A direct insert is allowed (same rules as the function) but every status move is checked.
  insert into public.import_batches (filename, row_count, last_row_no) values ('direct.csv', 2, 3) returning id into batch;
  if (select uploaded_by from public.import_batches where id = batch) <> '00000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL: uploader not set by the server';
  end if;
  perform pg_temp.expect_error(format($q$update public.import_batches set status = 'committing' where id = %L$q$, batch), '22023', 'bad_transition');
  perform pg_temp.expect_error(format($q$update public.import_batches set status = 'imported' where id = %L$q$, batch), '22023', 'bad_transition');
  perform pg_temp.expect_error(format($q$update public.import_batches set status = 'dry_run' where id = %L$q$, batch), '22023', 'incomplete');
  perform pg_temp.expect_error(format($q$update public.import_batches set status = 'rolled_back' where id = %L$q$, batch), '22023', 'bad_transition');
  -- Leads cannot be tagged into an import that is not being imported, nor backdated without one.
  foreach stmt in array array[
    format($q$insert into public.companies (name, import_batch_id) values ('tagged', %L)$q$, batch),
    format($q$insert into public.companies (name, import_batch_id) values ('tagged', %L)$q$, current_setting('test.batch')),
    $q$insert into public.companies (name, last_activity_at) values ('backdated', now() - interval '1 day')$q$] loop
    perform pg_temp.expect_error(stmt, '42501');
  end loop;
  -- Working rows: not with a stale code (even into my own open import), no outcome on insert, no problem changes,
  -- no other org.
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 660);
  perform pg_temp.expect_error(format($q$insert into private.lead_import_staging (batch_id, row_no, org_id, name) select %L, 2, org_id, 'x' from public.import_batches where id = %L$q$, batch, batch), '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform public.stage_lead_import_rows(batch, '[{"row_no": 2, "name": "Direct", "lead_status": "cold"}]');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 660);
  if (select count(*) from private.lead_import_staging) <> 0 then
    raise exception 'FAIL: a stale code reads working rows';
  end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  if (select count(*) from private.lead_import_staging where batch_id = batch) <> 1 then
    raise exception 'FAIL: a fresh code should read the working rows';
  end if;
  foreach stmt in array array[
    format($q$insert into private.lead_import_staging (batch_id, row_no, org_id, name, outcome) select %L, 3, org_id, 'x', 'ready' from public.import_batches where id = %L$q$, batch, batch),
    format($q$update private.lead_import_staging set problems = '{}' where batch_id = %L$q$, batch),
    format($q$insert into private.lead_import_staging (batch_id, row_no, org_id, name) values (%L, 3, '00000000-0000-0000-0000-0000000000cc', 'x')$q$, batch),
    format($q$insert into private.lead_import_staging (batch_id, row_no, org_id, name) select %L, 4, org_id, 'x' from public.import_batches where id = %L$q$, batch, batch)] loop
    perform pg_temp.expect_error(stmt, '42501');
  end loop;
  -- Input limits: more than 1,000 rows, more than 1 MiB, a row number past the end, bad values (constant error).
  perform pg_temp.expect_error(format('select public.stage_lead_import_rows(%L, %L)', batch,
    (select jsonb_agg(jsonb_build_object('row_no', 2, 'problems', jsonb_build_array('name_missing'))) from generate_series(1, 1001))), '22023');
  perform pg_temp.expect_error(format('select public.stage_lead_import_rows(%L, %L)', batch,
    (select jsonb_agg(jsonb_build_object('row_no', 2, 'name', repeat('n', 500), 'email', repeat('e', 500), 'city', repeat('c', 300)))
       from generate_series(1, 900))), '22023');
  perform pg_temp.expect_error(format('select public.stage_lead_import_rows(%L, %L)', batch,
    '[{"row_no": 4, "problems": ["name_missing"]}]'), '22023');
  perform pg_temp.expect_error(format('select public.stage_lead_import_rows(%L, %L)', batch,
    '[{"row_no": 3, "problems": ["not_a_code"]}]'), '22023');
  perform pg_temp.expect_error(format('select public.stage_lead_import_rows(%L, %L)', batch,
    '[{"row_no": 3, "name": "x", "lead_status": "cold", "last_activity": "2025-02-30T00:00:00"}]'), '22023');
  perform pg_temp.expect_error(format('select public.stage_lead_import_rows(%L, %L)', batch, '{"row_no": 3}'), '22023');
  perform pg_temp.expect_error($q$select public.create_lead_import('big.csv', null, 50001, 50002)$q$, '22023');
  perform pg_temp.expect_error($q$select public.create_lead_import('x.csv', null, 3, 3)$q$, '22023');
  perform pg_temp.expect_error($q$select public.create_lead_import('x.csv', null, 1, 2, 'Mars/Olympus')$q$, '22023');
  perform pg_temp.expect_error($q$select public.create_lead_import('a/b.csv', null, 1, 2)$q$, '23514');
  -- At most 3 open imports per organisation.
  other := public.create_lead_import('second.csv', null, 1, 2);
  perform public.create_lead_import('third.csv', null, 1, 2);
  perform pg_temp.expect_error($q$select public.create_lead_import('fourth.csv', null, 1, 2)$q$, '22023', 'too_many_open');
  -- Another admin cannot add rows to, check or import my import, but may discard it.
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000b', 'aal2', 30);
  perform pg_temp.expect_error(format('select public.stage_lead_import_rows(%L, %L)', other,
    '[{"row_no": 2, "problems": ["name_missing"]}]'), '42501');
  perform pg_temp.expect_error(format('select public.validate_lead_import(%L)', other), '42501');
  perform pg_temp.expect_error(format('select public.commit_lead_import(%L)', other), '42501');
  perform public.discard_lead_import(other);
  perform pg_temp.expect_error(format('select public.discard_lead_import(%L)', other), '22023', 'not_ready');
  -- Another organisation's admin sees nothing of ours.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1', 'aal2', 30);
  if (select count(*) from public.list_lead_imports()) <> 0 or (select count(*) from private.lead_import_staging) <> 0 then
    raise exception 'FAIL: other org reads our imports';
  end if;
  foreach stmt in array array[
    format('select public.validate_lead_import(%L)', batch),
    format('select public.commit_lead_import(%L)', batch),
    format('select public.rollback_lead_import(%L)', current_setting('test.batch')),
    format('select public.discard_lead_import(%L)', batch),
    format('select public.preview_lead_import_rollback(%L)', current_setting('test.batch'))] loop
    perform pg_temp.expect_error(stmt, 'P0002');
  end loop;
  perform set_config('test.direct', batch::text, false);
end $$;

-- Bad values never reach an error message (it would end up in logs).
do $$
declare
  msg text;
  detail text;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  begin
    perform public.stage_lead_import_rows(current_setting('test.direct')::uuid,
      '[{"row_no": 3, "name": "x", "lead_status": "cold", "owner_id": "PLANTED-not-a-uuid"}]');
  exception when others then
    get stacked diagnostics msg = message_text, detail = pg_exception_detail;
  end;
  if msg is null or msg || coalesce(detail, '') like '%PLANTED%' then
    raise exception 'FAIL: a bad value was echoed in the error (%)', msg;
  end if;
end $$;

-- 7. One import or undo at a time; a demoted uploader cannot finish; idle imports expire ---------------------------
do $$
declare
  first_batch uuid;
  second_batch uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform public.discard_lead_import(current_setting('test.direct')::uuid);
  perform public.discard_lead_import((select id from public.import_batches where filename = 'third.csv'));
  first_batch := public.create_lead_import('one.csv', null, 2, 3);
  perform public.stage_lead_import_rows(first_batch,
    '[{"row_no": 2, "name": "One A", "lead_status": "cold"}, {"row_no": 3, "name": "One B", "lead_status": "cold"}]');
  perform public.validate_lead_import(first_batch);
  perform public.commit_lead_import(first_batch, 1);  -- paused half way
  second_batch := public.create_lead_import('two.csv', null, 1, 2);
  perform public.stage_lead_import_rows(second_batch, '[{"row_no": 2, "name": "Two A", "lead_status": "cold"}]');
  perform public.validate_lead_import(second_batch);
  perform pg_temp.expect_error(format('select public.commit_lead_import(%L)', second_batch), '22023', 'busy');
  -- With a stale code, nobody can add leads to an import, even their own paused one.
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 660);
  perform pg_temp.expect_error(format($q$insert into public.companies (name, import_batch_id) values ('late', %L)$q$, first_batch), '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  -- Undo of the paused import works and frees the slot.
  if (public.rollback_lead_import(first_batch) ->> 'status') <> 'rolled_back' then
    raise exception 'FAIL: undo of a paused import';
  end if;
  if (public.commit_lead_import(second_batch) ->> 'status') <> 'imported' then
    raise exception 'FAIL: second import after the first was undone';
  end if;
  perform set_config('test.second', second_batch::text, false);
end $$;

-- Rep b1 is made admin, pauses an import, then is made rep again: he can no longer tag leads into it.
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;  -- superuser: no caller
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$
declare
  batch uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  batch := public.create_lead_import('demoted.csv', null, 2, 3);
  perform public.stage_lead_import_rows(batch,
    '[{"row_no": 2, "name": "Dem A", "lead_status": "cold"}, {"row_no": 3, "name": "Dem B", "lead_status": "cold"}]');
  perform public.validate_lead_import(batch);
  perform public.commit_lead_import(batch, 1);
  perform set_config('test.demoted', batch::text, false);
end $$;
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;  -- superuser: no caller
update public.profiles set role = 'rep' where id = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$ begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  perform pg_temp.expect_error(format('select public.commit_lead_import(%L)', current_setting('test.demoted')), '42501');
  perform pg_temp.expect_error(format($q$insert into public.companies (name, import_batch_id) values ('sneak', %L)$q$,
                                      current_setting('test.demoted')), '42501');
  -- An admin cleans up the paused import.
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  if (public.rollback_lead_import(current_setting('test.demoted')::uuid) ->> 'status') <> 'rolled_back' then
    raise exception 'FAIL: undo of the demoted import';
  end if;
end $$;

-- An import left open for more than a day is discarded (and its rows deleted) when the next import starts.
do $$ begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform set_config('test.idle', public.create_lead_import('idle.csv', null, 1, 2)::text, false);
  perform public.stage_lead_import_rows(current_setting('test.idle')::uuid,
    '[{"row_no": 2, "name": "Idle", "lead_status": "cold"}]');
end $$;
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;  -- superuser: no caller
alter table public.import_batches disable trigger set_updated_at;  -- it would reset the back-dated time
update public.import_batches set updated_at = now() - interval '25 hours' where id = current_setting('test.idle')::uuid;
alter table public.import_batches enable trigger set_updated_at;
set role authenticated;
do $$ begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform public.discard_lead_import(public.create_lead_import('fresh.csv', null, 1, 2));
  if (select status from public.import_batches where id = current_setting('test.idle')::uuid) <> 'discarded' then
    raise exception 'FAIL: idle import not discarded';
  end if;
end $$;

-- 8. Review fixes, one import each -----------------------------------------------------------------------------------
-- The check: short phones, fix counts, and dates around 1 Jan 1990 (local time, like the browser).
do $$
declare
  batch uuid;
  r jsonb;
  t record;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  batch := public.create_lead_import('rules.csv', null, 7, 8);
  perform public.stage_lead_import_rows(batch, jsonb_build_array(
    -- Two shops of a chain in one city with different phones are two leads, even when the numbers are too short (6 or
    -- 7 digits) to be phone keys: company + city decides only for a row with no email and no phone of its own (row 8,
    -- which repeats the first shop that has a phone).
    jsonb_build_object('row_no', 2, 'name', 'Joe''s Pizza', 'lead_status', 'cold', 'phone', '555-0123',
                       'city', 'Springfield', 'country', 'US'),
    jsonb_build_object('row_no', 3, 'name', 'Joe''s Pizza', 'lead_status', 'cold', 'phone', '555-0199',
                       'city', 'Springfield', 'country', 'US'),
    -- Two rows with a fix, the second a repeat of the first: only the first is "added with a change".
    jsonb_build_object('row_no', 4, 'name', 'Fix One', 'lead_status', 'cold', 'email', 'fix@example.com',
                       'fixes', jsonb_build_array('owner_unassigned')),
    jsonb_build_object('row_no', 5, 'name', 'Fix Two', 'lead_status', 'cold', 'email', 'FIX@example.com',
                       'fixes', jsonb_build_array('owner_unassigned')),
    -- Midnight on 1 Jan 1990 in Paris is in range; a second earlier is not.
    jsonb_build_object('row_no', 6, 'name', 'New Year 1990', 'lead_status', 'cold', 'last_activity', '1990-01-01T00:00:00'),
    jsonb_build_object('row_no', 7, 'name', 'Before 1990', 'lead_status', 'cold', 'last_activity', '1989-12-31T23:59:59'),
    jsonb_build_object('row_no', 8, 'name', 'Joe''s Pizza', 'lead_status', 'cold', 'city', 'Springfield', 'country', 'US')));
  r := public.validate_lead_import(batch);
  for t in select * from (values
      (2, 'ready', null, null, null), (3, 'ready', null, null, null), (8, 'duplicate_file', 'name', 2, null),
      (4, 'ready', null, null, null), (5, 'duplicate_file', 'email', 4, null),
      (6, 'ready', null, null, null), (7, 'rejected', null, null, 'date_out_of_range')
    ) as e (row_no, outcome, match_key, match_row_no, reason) loop
    if not exists (select 1 from private.lead_import_staging s
                    where s.batch_id = batch and s.row_no = t.row_no and s.outcome = t.outcome
                      and s.match_key is not distinct from t.match_key
                      and s.match_row_no is not distinct from t.match_row_no
                      and s.reason is not distinct from t.reason) then
      raise exception 'FAIL: row % expected % % % %, got %', t.row_no, t.outcome, t.match_key, t.match_row_no, t.reason,
        (select row(s.outcome, s.match_key, s.match_row_no, s.reason) from private.lead_import_staging s
          where s.batch_id = batch and s.row_no = t.row_no);
    end if;
  end loop;
  if (r -> 'issue_counts' ->> 'owner_unassigned')::integer <> 1 or (r -> 'issue_counts' ->> 'with_fixes')::integer <> 1 then
    raise exception 'FAIL: fix counts should count only rows that are added %', r -> 'issue_counts';
  end if;
  perform public.discard_lead_import(batch);
end $$;

-- The tagging rule while an import is held in "committing": a direct insert by the uploader with a date in the future
-- or before 31 Dec 1989 (UTC) is refused, and another admin cannot tag leads into it.
do $$
declare
  batch uuid;
  bad_date text;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  batch := public.create_lead_import('held.csv', null, 2, 3);
  perform public.stage_lead_import_rows(batch, '[{"row_no": 2, "name": "Held A", "lead_status": "cold"},
    {"row_no": 3, "name": "Held B", "lead_status": "cold"}]');
  perform public.validate_lead_import(batch);
  perform public.commit_lead_import(batch, 1);
  foreach bad_date in array array['now() + interval ''1 day''', '''1989-12-30 23:59:59+00''', '''1989-06-01 12:00:00+00'''] loop
    perform pg_temp.expect_error(format($q$insert into public.companies (name, import_batch_id, last_activity_at)
                                           values ('Probe', %L, %s)$q$, batch, bad_date), '42501');
  end loop;
  -- The earliest instant that is 1 Jan 1990 somewhere (00:00 at UTC+14) is accepted (the probe is undone).
  perform pg_temp.expect_ok(format($q$insert into public.companies (name, import_batch_id, last_activity_at)
                                      values ('Probe', %L, '1989-12-31 10:00:00+00')$q$, batch));
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000b', 'aal2', 30);
  perform pg_temp.expect_error(format($q$insert into public.companies (name, import_batch_id) values ('Sneak', %L)$q$, batch),
                               '42501');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  if (public.rollback_lead_import(batch) ->> 'status') <> 'rolled_back' then
    raise exception 'FAIL: undo of held.csv';
  end if;
end $$;

-- 1 Jan 1990 at midnight passes the check and imports: in Paris (31 Dec 1989, 23:00 UTC) and at UTC+14 (10:00 UTC),
-- the earliest instant any time zone reaches that day.
do $$
declare
  zone text;
  batch uuid;
  r jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  foreach zone in array array['Europe/Paris', 'Etc/GMT-14'] loop
    batch := public.create_lead_import('new-year-1990.csv', null, 2, 3, zone);
    perform public.stage_lead_import_rows(batch, '[{"row_no": 2, "name": "New Year 1990", "lead_status": "cold",
      "last_activity": "1990-01-01T00:00:00"}, {"row_no": 3, "name": "Year 2020", "lead_status": "cold",
      "last_activity": "2020-01-01T00:00:00"}]');
    r := public.validate_lead_import(batch);
    if (r ->> 'ready')::integer <> 2 then raise exception 'FAIL: 1 Jan 1990 in % should pass the check %', zone, r; end if;
    r := public.commit_lead_import(batch);
    if (r ->> 'status') <> 'imported' or (r ->> 'imported_now')::integer <> 2 then
      raise exception 'FAIL: 1 Jan 1990 in % should import %', zone, r;
    end if;
    if (select last_activity_at from public.companies where import_batch_id = batch and name = 'New Year 1990')
       <> (case zone when 'Europe/Paris' then timestamptz '1989-12-31 23:00:00+00' else timestamptz '1989-12-31 10:00:00+00' end) then
      raise exception 'FAIL: 1 Jan 1990 in % stored as %', zone,
        (select last_activity_at from public.companies where import_batch_id = batch and name = 'New Year 1990');
    end if;
    perform public.rollback_lead_import(batch);
  end loop;
end $$;

-- The running total: counted, so it is right while paused and after a resume, in each call and in the history.
do $$
declare
  batch uuid;
  r jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  batch := public.create_lead_import('total.csv', null, 3, 4);
  perform public.stage_lead_import_rows(batch, '[{"row_no": 2, "name": "Total A", "lead_status": "cold"},
    {"row_no": 3, "name": "Total B", "lead_status": "cold"}, {"row_no": 4, "name": "Total C", "lead_status": "cold"}]');
  perform public.validate_lead_import(batch);
  r := public.commit_lead_import(batch, 2);
  if (r ->> 'status') <> 'committing' or (r ->> 'imported_total')::integer is distinct from 2 then
    raise exception 'FAIL: running total after the first chunk %', r;
  end if;
  if (select imported from public.list_lead_imports(p_id => batch)) <> 2 then
    raise exception 'FAIL: history should show the leads a paused import added';
  end if;
  r := public.commit_lead_import(batch, 2);  -- resumed
  if (r ->> 'status') <> 'imported' or (r ->> 'imported_now')::integer <> 1 or (r ->> 'imported_total')::integer <> 3 then
    raise exception 'FAIL: running total after a resume %', r;
  end if;
  -- (Each call is its own statement: a history read in the same statement would not see the call's changes.)
  r := public.commit_lead_import(batch);  -- a replay after the end
  if (r ->> 'imported_total')::integer <> 3 or (select imported from public.list_lead_imports(p_id => batch)) <> 3 then
    raise exception 'FAIL: total after the import %', r;
  end if;
  -- While an undo runs (or is paused), the history counts the leads still there.
  r := public.rollback_lead_import(batch, 1);
  if (r ->> 'status') <> 'rolling_back' or (select imported from public.list_lead_imports(p_id => batch)) <> 2 then
    raise exception 'FAIL: history during an undo %', r;
  end if;
  r := public.rollback_lead_import(batch);
  if (r ->> 'status') <> 'rolled_back' or (select imported from public.list_lead_imports(p_id => batch)) <> 3 then
    raise exception 'FAIL: history after the undo %', r;
  end if;
end $$;

-- A status changed directly (a PATCH, not a function) deletes the working rows too: discard, and undo of a paused import.
do $$
declare
  batch uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  batch := public.create_lead_import('patch-discard.csv', null, 2, 3);
  perform public.stage_lead_import_rows(batch, '[{"row_no": 2, "name": "Patch A", "lead_status": "cold",
    "email": "patch-a@example.com"}, {"row_no": 3, "name": "Patch B", "lead_status": "cold"}]');
  update public.import_batches set status = 'discarded' where id = batch;
  if (select status from public.import_batches where id = batch) <> 'discarded'
     or (select count(*) from private.lead_import_staging where batch_id = batch) <> 0 then
    raise exception 'FAIL: a direct discard left working rows';
  end if;
  -- With a repeated row and a rejected row: the counts are taken before the working rows go.
  batch := public.create_lead_import('patch-undo.csv', null, 4, 5);
  perform public.stage_lead_import_rows(batch, '[{"row_no": 2, "name": "Patch C", "lead_status": "cold",
    "email": "patch-c@example.com"}, {"row_no": 3, "name": "Patch D", "lead_status": "cold"},
    {"row_no": 4, "name": "Patch C again", "lead_status": "cold", "email": "PATCH-C@example.com"},
    {"row_no": 5, "problems": ["name_missing"]}]');
  perform public.validate_lead_import(batch);
  perform public.commit_lead_import(batch, 1);
  update public.import_batches set status = 'rolling_back' where id = batch;
  if (select count(*) from private.lead_import_staging where batch_id = batch) <> 0 then
    raise exception 'FAIL: a direct undo of a paused import left working rows';
  end if;
  if (select (duplicates, rejected) from public.import_batches where id = batch) <> (1, 1) then
    raise exception 'FAIL: the counts of a paused import were taken after its working rows were deleted: %',
      (select row(duplicates, rejected, issue_counts) from public.import_batches where id = batch);
  end if;
  if (public.rollback_lead_import(batch) ->> 'status') <> 'rolled_back' then
    raise exception 'FAIL: undo after a direct status change';
  end if;
end $$;

-- The file name: no control, zero-width, bidi or tag character (the browser's INVISIBLE_CHARS), no slash.
do $$
declare
  bad text;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  foreach bad in array array[U&'leads\202Evsc.csv', U&'lea\200Bds.csv', U&'\2066leads\2069.csv', U&'\FEFFleads.csv',
                             U&'leads\0085.csv', U&'leads\061C.csv', U&'leads\+0E0041.csv', U&'leads\2060.csv',
                             U&'leads\180E.csv', U&'leads\FFF9.csv', U&'leads\200E.csv', E'leads\t.csv', 'a\b.csv'] loop
    perform pg_temp.expect_error(format('select public.create_lead_import(%L, null, 1, 2)', bad), '23514');
    perform pg_temp.expect_error(format('insert into public.import_batches (filename, row_count, last_row_no) values (%L, 1, 2)',
                                        bad), '23514');
  end loop;
  -- Accents, spaces and brackets are fine.
  perform public.discard_lead_import(public.create_lead_import('Prospects été 2026 (v2).csv', null, 1, 2));
end $$;

-- Superuser view: no closed import keeps working rows.
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;  -- superuser: no caller
do $$ begin
  if exists (select 1 from private.lead_import_staging s join public.import_batches b on b.id = s.batch_id
              where b.status <> all (array['staged', 'dry_run', 'committing'])) then
    raise exception 'FAIL: working rows kept for a closed import';
  end if;
end $$;

\echo 'import_attack: all checks passed'
