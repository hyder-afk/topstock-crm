# Day 7d: secrets scan and dependency audits (16 Oct 2026)

Run in the worktree on `day7d-local` (base `day7f-local` 287430b). Outputs below are counts and verdicts only.

## gitleaks, full history

Binary: gitleaks 8.28.0 (read-only use of the copy built for Day 7c). gitleaks scans `git log -p --all`, so every
branch and tag in this clone is included.

| Command | Result |
|---|---|
| `gitleaks git --redact --report-format json .` | 678 commits scanned, ~10.9 MB, **no leaks found** (exit 0) |
| `gitleaks git --redact --log-opts=--all .` | 678 commits scanned, **no leaks found** |
| `.gitleaksignore` | 3 entries, each a reviewed false positive in an old commit (a Go pseudo-version, a time-zone name after a field called `*_key`, a fixed test UUID); the current files no longer hold them |

Re-run on the final head after the Day 7c merge: see README, "Merge with Day 7c".

## npm audit

| Command | Result |
|---|---|
| `npm audit --omit=dev` (runtime dependencies, what ships) | **found 0 vulnerabilities** (exit 0) |
| `npm audit` (everything, report only) | 5 high, one chain: `braces` 3.0.3 (GHSA-vfj7-8cjw-p6xm, stack exhaustion on deeply nested patterns) via `micromatch` 4.0.8, `fast-glob` 3.3.1, `@next/eslint-plugin-next` 16.4.0, `eslint-config-next` 16.4.0. Lint-time only, never in the build output or the server; the only offered fix downgrades `eslint-config-next` to 14.2.35 (breaking). CI keeps it report-only (`npm audit --audit-level=critical \|\| true`). Accepted until Next ships a fixed plugin |
| `npm audit signatures` | **not run here**: npm fetches Sigstore's trust root from `tuf-repo-cdn.sigstore.dev`, which this session's network proxy refuses (403 at CONNECT, recorded in the proxy status). Not worked around. Added as a step in `ci.yml`'s quality job: **prepared, runs in CI later** (GitHub Actions is blocked by billing) |

## Production bundle scan (`scripts/check-build.mjs`)

See `check-build.md`.
