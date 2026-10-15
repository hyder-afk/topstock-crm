\pset format unaligned
\pset tuples_only on
\echo S6a numeric(14,2) NaN stored and passes value >= 0
create temp table s6 (value numeric(14,2) check (value >= 0));
insert into s6 values ('NaN');
select 'stored=' || value::text || ' passes_ge0=' || (value >= 0)::text || ' greater_than_1e12=' || (value > 1e12)::text from s6;
\echo S6b numeric(14,2) Infinity
do $$ begin insert into s6 values ('Infinity'); raise notice 'Infinity ACCEPTED'; exception when others then raise notice 'Infinity refused: % %', sqlstate, sqlerrm; end $$;
do $$ begin insert into s6 values ('-Infinity'); raise notice '-Infinity ACCEPTED'; exception when others then raise notice '-Infinity refused: % %', sqlstate, sqlerrm; end $$;
\echo S6c unconstrained numeric parameter (how PostgREST hands RPC JSON arguments over: json_to_record)
select 'json NaN -> ' || p_value::text || ', json Infinity -> ' || q::text || ', 12.345 -> ' || r::text
  from json_to_record('{"p_value":"NaN","q":"Infinity","r":12.345}') as x(p_value numeric, q numeric, r numeric);
create function pg_temp.f(p numeric) returns text language sql as $$ select p::text || ' bound_check(<=1e8)=' || coalesce((p <= 100000000)::text,'null') || ' ne_nan=' || (p <> 'NaN')::text $$;
select 'param NaN: ' || pg_temp.f('NaN');
select 'param Infinity: ' || pg_temp.f('Infinity');
\echo S6d the design CHECK refuses NaN; the 1e8 bound refuses Infinity before the column cast? (column cast first)
create temp table s6b (value numeric(14,2) check (value is null or (value >= 0 and value <> 'NaN' and value <= 100000000)));
do $$ begin insert into s6b values ('NaN'); raise notice 'NaN ACCEPTED by design CHECK'; exception when others then raise notice 'NaN refused by design CHECK: % %', sqlstate, sqlerrm; end $$;
do $$ begin insert into s6b values (100000000.01); raise notice 'over cap ACCEPTED'; exception when others then raise notice 'over cap refused: %', sqlstate; end $$;
do $$ begin insert into s6b values (12.345); raise notice '12.345 stored as %', (select value from s6b); end $$;
\echo S6e jsonb text of NaN and its JSON round trip
select 'to_jsonb(NaN::numeric)=' || to_jsonb('NaN'::numeric)::text;
