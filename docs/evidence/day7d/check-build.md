# Day 7d: production bundle scan (`scripts/check-build.mjs`)

Gate 1 items 1, 14 and 36. Run on the production build of this branch made for the local stack
(`next build`, `/tmp/day7d-builder/app/.next`, built with the throwaway local stack's anon key):

```
check-build: 75 files under .next/static, 71 text files scanned, 1 anon-key occurrence(s)
check-build: no source maps, no server keys, no connection strings
```

First run found `sb_secret_` in a supabase-js chunk: the library's own check of a key's kind
(`e.startsWith("sb_publishable_")||e.startsWith("sb_secret_")`), a bare prefix, not a key. The rule now needs the prefix
followed by 16 or more key characters (a real secret key is longer), and the bare prefix is one of the planted cases
that must pass.

Planted cases on a scratch folder shaped like `.next/static` (holding one anon JWT that must pass):

| Planted | Expected | Result |
|---|---|---|
| `b.js.map` | fail | exit 1, "source map" |
| a JWT with role `service_role` | fail | exit 1, "a JWT with role service_role" |
| `sb_secret_` followed by 24 key characters | fail | exit 1, "an sb_secret_ key" |
| `e.startsWith("sb_secret_")` (library code) | pass | exit 0 |
| `postgresql://u@h/db` | fail | exit 1, "a postgres connection string" |
| `//# sourceMappingURL=b.js.map` | fail | exit 1, "sourceMappingURL comment" |

CI: `ci.yml` quality job runs it after `npm run build` (placeholder public values there, so no JWT at all): prepared,
runs in CI later.
