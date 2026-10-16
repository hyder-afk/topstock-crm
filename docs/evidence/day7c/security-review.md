# Day 7c (part 1): security review of the orphan sweeper, 15 Oct 2026

Scope: branch `day7c-local` against `day7a-local` 54739bb: migration `20261022090000_orphan_sweeper.sql`,
`scripts/ops/sweep-core.mjs` and `scripts/ops/sweep-lead-files.mjs`, the topstock-ops template
`docs/ops-templates/sweep-lead-files.yml`, the tests (`supabase/tests/sweeper_attack.sql`,
`tests/unit/sweep-plan.spec.ts`, `tests/auth/sweeper.spec.ts`). The PWA commit is covered in the README (no data, no
new endpoint beyond a static manifest; CSP unchanged).

Method: the `/security-review` threat rows (report only findings at 80 % confidence or more; the skill's exclusions),
done by the builder in this session; the `advisor` subagent round is still to run (README, "Not done here").

## Result: NO FINDINGS at 80 % confidence or more

| Area | Checked | Holds because |
|---|---|---|
| Who can call the database part | the three functions | SECURITY INVOKER, `search_path = ''`, static SQL; `revoke all ... from public, anon, authenticated`, `grant execute ... to service_role` only. Tested in the catalog and live (anon and an aal2 admin get 42501 on all three); mutation rows 6 to 8 caught. PostgREST exposes them in `public`, but only a service-role key passes |
| What the candidates can contain | `lead_file_orphans` | bucket `lead-files` only; names in the exact `org/lead/file.ext` shape with lowercase UUIDs and a known type; `created_at` older than `p_min_age` with a floor of 24 hours enforced in SQL (a caller cannot ask for less); no `files` row of any status (pending, ready and deleting keep their bytes). Tested; mutation rows 1 to 5 caught |
| Path injection into the delete | script | names come only from the database; the script re-checks the shape and that the org id is the name's first part, refuses repeats, and stops the whole run on any bad row; it never builds a path. The Storage API body is JSON (`{"prefixes": [...]}`) |
| Blast radius of a fault | script | dry run by default; caps (50 objects, 200 MiB) stop before any delete; sanity stop when the bucket has objects but zero files rows; two listings and only names in both; batches of 100; a failed batch stops further deletes. Unit tests with a fake fetch prove each (dry run never calls delete) |
| The key | workflow, script, docs | referenced only by name (`PROD_SWEEPER_KEY` in topstock-ops, `SWEEPER_KEY` in the step's env); a dedicated secret key that can be revoked alone; sent only in the `apikey` header (a `sb_secret_` key is not a JWT; a legacy JWT also as bearer, as Supabase documents); never printed (errors give the HTTP status and PostgREST code only, config errors never echo values). gitleaks over the three commits: no leaks |
| Code that runs with the key | workflow | `SWEEPER_SHA` must be a full SHA on topstock-crm `main` (`git merge-base --is-ancestor`), checked out with a read-only token and `persist-credentials: false`; `permissions: {}`; no `npm install` (no third-party code); a new commit on main never runs with the production key until Haider changes the variable |
| Workflow injection | workflow | every input and variable reaches the shell through `env:`, never `${{ }}` inside `run:`; numeric inputs validated by regex; actionlint 1.7.7 with ShellCheck 0.10.0: clean |
| Audit row | `record_file_sweep` | counts only (`found`, `removed`, `bytes`, `dry_run`), no org, actor, record id or names; bounds (removed never above found, a dry run removes nothing, no negatives or nulls); a signed-in person cannot forge one (the only authenticated insert policy is for their own sign-in rows); no person in the app reads it (org is null). Mutation rows 10 to 12 caught |
| Logs | script | counts and bytes per org id only; never a file name or lead id (unit test checks the log and summary text) |
| service_role grants | migration | exactly `select (storage_path)` on `public.files` and `insert (action, table_name, diff_json)` on `public.audit_log`; on Supabase service_role already holds more by default, so this widens nothing there |

## Notes below the bar (recorded, no change needed)

1. **A Supabase secret key is full service_role.** Supabase secret keys cannot be scoped to three functions; a
   leaked `sweeper` key reads and writes the whole production database. Mitigations: it lives only in topstock-ops
   (Claude never attached), is revocable on its own (runbook "If the key leaks"), and the code that uses it is pinned.
   Residual S1 in the README.
2. **Storage API delete semantics.** storage-api's bulk delete takes object names (`prefixes`) and removes those
   objects; the names here are full file paths with an extension, so even prefix matching would only reach an object
   named below a file path (`.../x.pdf/...`), which the CRM never creates and which the shape check never returns.
   The CI end-to-end test (`tests/auth/sweeper.spec.ts`) proves one exact removal on the real storage-api.
3. **Production restore.** While a restore loads file rows back, objects can briefly have no row; the sanity check
   catches only "zero rows". The runbook tells Haider to disable the workflow before any production restore.
4. **Org ids in the run summary.** They are UUIDs (no PII) and stay in topstock-ops' run page; the runbook asks Haider
   not to paste them into Claude anyway.
