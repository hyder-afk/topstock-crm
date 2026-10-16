# gate1_attack.sql planted breaks (Day 7d, scratch copy of the local database, every break rolled back)

| Break | Result | First failure |
|---|---|---|
| G1 RLS off on public.tasks | caught | FAIL: G1 row level security is off on public.tasks |
| G1 a view without security_invoker | caught | FAIL: G1 view public.v_leak does not run as the caller (security_invoker) |
| G1 a materialized view in private | caught | FAIL: G1 private.mv_leak is a materialized view or foreign table (no row level security) |
| G2 require_mfa dropped on private.stock_movements | caught | FAIL: G2 private.stock_movements has no restrictive two-factor policy (require_mfa, has_aal2) |
| G2 require_mfa made permissive-equivalent (always true) on public.deals | caught | FAIL: G2 public.deals has no restrictive two-factor policy (require_mfa, has_aal2) |
| G2 a new table with RLS but no two-factor policy | caught | FAIL: G2 public.t_new has no restrictive two-factor policy (require_mfa, has_aal2) |
| G3 a policy for PUBLIC | caught | FAIL: G3 policy leak on public.tasks names roles {public} |
| G3 share_reader on public.companies | caught | FAIL: G3 share_reader has a policy on public.companies (not on the reviewed list) |
| G4 a new SECURITY DEFINER function | caught | FAIL: G4 SECURITY DEFINER function private.planted() is not on the reviewed list |
| G4 a reviewed DEFINER function without search_path | caught | FAIL: G4 private.is_admin() must pin search_path to empty (has <NULL>) |
| G4 a trigger-only DEFINER function callable by authenticated | caught | FAIL: G4 authenticated EXECUTE on private.nightly_stock_jobs() is t, reviewed as false |
| G4 a DEFINER function made INVOKER | caught | FAIL: G4 reviewed function private.lead_has_files(uuid) is gone or no longer SECURITY DEFINER (update the list |
| G5 PUBLIC can execute a function | caught | FAIL: G5 PUBLIC can execute public.get_lead(uuid) |
| G6 dynamic SQL in a new function | caught | FAIL: G6 dynamic SQL outside the reviewed lead list functions: { |
| G7 TRUNCATE for authenticated | caught | FAIL: G7 authenticated has TRUNCATE on public.tasks |
| G2 has_aal2 always true, aal2 only in a comment | caught | FAIL: G2 private.has_aal2() is not the reviewed check (aal claim = aal2, INVOKER, STABLE, search_path empty) |
| G2 has_aal2 made SECURITY DEFINER | caught | FAIL: G2 private.has_aal2() is not the reviewed check (aal claim = aal2, INVOKER, STABLE, search_path empty) |

The last two rows were added after the advisor round: the earlier G2 check (`prosrc !~ 'aal2'`) would have passed a body that returns true and only mentions aal2 in a comment; G2 now compares the whole body (comments removed, whitespace collapsed) with the reviewed text and checks INVOKER, STABLE and the empty search_path.
