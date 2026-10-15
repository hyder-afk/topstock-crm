# Usage: python3 eq-sql.py <out.sql> <base commit> <rewrite commit>; then psql -f out.sql on a scratch PostgreSQL 16
# Throwaway: every changed SQL regex class (HEAD vs working tree), compared in Postgres 16 over every code point
# 1..0x10FFFF except the surrogates (chr() refuses them and they cannot occur in UTF-8 text).
import subprocess,re,sys
files=["supabase/migrations/20261017090000_inventory_reads.sql","supabase/migrations/20261018090000_stock_import.sql",
"supabase/migrations/20261019090000_sales_requests.sql","supabase/migrations/20261020090000_client_share.sql"]
pairs=[]
for f in files:
    d=subprocess.run(['git','diff','-U0',sys.argv[2],sys.argv[3],'--',f],capture_output=True,text=True).stdout.split('\n')
    o=[l[1:] for l in d if l.startswith('-') and not l.startswith('---')]
    n=[l[1:] for l in d if l.startswith('+') and not l.startswith('+++')]
    assert len(o)==len(n)
    for a,b in zip(o,n):
        ca=re.findall(r"'\[[^']*\]'",a); cb=re.findall(r"'\[[^']*\]'",b); assert len(ca)==len(cb)==1,(a,b)
        # rest of the line identical apart from the class
        assert a.replace(ca[0],'@')==b.replace(cb[0],'@'),(a,b)
        pairs.append((f,ca[0],cb[0]))
uniq=sorted(set((a,b) for _,a,b in pairs))
print(f"-- {len(pairs)} changed lines, {len(uniq)} distinct classes")
sql=["create temp table cps as select g as cp, chr(g) as ch from generate_series(1,1114111) g where g not between 55296 and 57343;"]
for i,(a,b) in enumerate(uniq):
    sql.append(f"select {i} as pair, count(*) filter (where (ch ~ {a}) <> (ch ~ {b})) as differing, count(*) filter (where ch ~ {b}) as matching, "
               f"string_agg(to_hex(cp), ',' order by cp) filter (where ch ~ {b} and cp > 159) as matched_above_9f from cps;")
    # also embedded in text, with a newline and a tab neighbour
    sql.append(f"select {i} as pair_embedded, count(*) filter (where ('ab'||ch||'cd' ~ {a}) <> ('ab'||ch||'cd' ~ {b})) from cps;")
open(sys.argv[1],'w').write('\n'.join(sql)+'\n')
for i,(a,b) in enumerate(uniq): print(i, b)
