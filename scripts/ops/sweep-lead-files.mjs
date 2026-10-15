#!/usr/bin/env node
// Orphan sweeper for the lead-files bucket (Day 7c; docs/evidence/day7/plan.md section 3 on day7-local; runbook
// docs/ops-templates/sweep-lead-files.md). Runs ONLY from the private repository topstock-ops, as the scheduled
// workflow docs/ops-templates/sweep-lead-files.yml, with its own Supabase secret key (Haider, 15 Oct 2026: "orphan
// sweeper runs from topstock-ops with its own key; dry-run week first"). Never from Vercel, the app or a Claude session.
//
// What it does: lists objects in lead-files that have no files row at all and are older than the grace period
// (public.lead_file_orphans, service-role only), and in apply mode removes them through the Storage API, which removes
// the bytes and the storage row together (SQL cannot: storage.protect_delete). One audit_log row per run, counts only
// (public.record_file_sweep).
//
// Safety, in order:
//   1. Dry run unless SWEEP_MODE=apply (the workflow sets apply only when the repository variable SWEEP_APPLY is "yes"
//      on a scheduled run, or a manual run typed SWEEP).
//   2. Sanity: stops if the bucket holds objects but the database reports zero files rows.
//   3. Caps: stops without deleting when one run finds more than SWEEP_MAX_OBJECTS objects (default 50) or
//      SWEEP_MAX_MIB MiB (default 200). A bug that hid every files row would otherwise empty the bucket.
//   4. Every name must be in the exact shape org/lead/file.ext (lowercase UUIDs, a known type), and its org id must be
//      the first part of the name; any other row stops the run. It never builds a path itself.
//   5. Double check: lists again just before deleting and deletes only names found both times, 100 a request.
//   6. Logs counts and bytes per org id only, never names (paths are UUIDs and a type ending, but still not printed).
//
// Environment (names only; values come from topstock-ops secrets and variables):
//   SUPABASE_URL          https://<project-ref>.supabase.co (http://127.0.0.1:<port> only with SWEEP_ALLOW_LOCAL=1, for
//                         the CI test against the local stack's demo key)
//   SWEEPER_KEY           the dedicated secret key named "sweeper" (topstock-ops secret PROD_SWEEPER_KEY); sent only in
//                         the apikey header (a legacy service_role JWT is also sent as a bearer token, as Supabase asks)
//   SWEEP_MODE            dry (default) or apply
//   SWEEP_MAX_OBJECTS     1 to 1000, default 50
//   SWEEP_MAX_MIB         1 to 1024, default 200
//   SWEEP_MIN_AGE_HOURS   24 to 8760, default 24 (the database refuses less than 24)
//   GITHUB_STEP_SUMMARY   set by GitHub Actions: the run's summary (counts only) is appended to it
// Exit codes: 0 done (dry run or apply), 1 stopped by a safety rule or an error (GitHub then emails Haider), 2 bad
// configuration. Node 22 built-in fetch only; no npm packages.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ConfigError, readConfig, runSweep } from "./sweep-core.mjs";

async function main() {
  let config;
  try {
    config = readConfig(process.env);
  } catch (e) {
    console.log(`::error::${e instanceof ConfigError ? e.message : "bad configuration"}`);
    return 2;
  }
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  const report = await runSweep({
    config,
    summary: (md) => {
      if (summaryFile) appendFileSync(summaryFile, md);
      else console.log(md);
    },
  });
  return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
