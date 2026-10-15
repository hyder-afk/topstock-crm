import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Code that handles lead data never logs (design section 4, threat 13): server logs (Vercel function logs) must not
  // hold lead rows, import data or authenticator codes. Covers the import rules and screens, the import actions and
  // issues route, the leads actions and API routes, their server helpers, and the "Confirm it's you" action.
  {
    files: [
      "src/lib/import/**",
      "src/components/import/**",
      "src/app/(app)/leads/import/**",
      "src/app/(app)/leads/actions.ts",
      "src/app/api/imports/**",
      "src/app/api/leads/**",
      "src/lib/import-server.ts",
      "src/lib/leads-server.ts",
      "src/app/(app)/step-up-actions.ts",
      // Day 4b: the lead page's actions and routes, and the libraries that carry timeline text and lead numbers.
      "src/app/(app)/leads/**",
      "src/app/api/activities/**",
      "src/components/lead/**",
      "src/components/activity/**",
      "src/lib/activities.ts",
      "src/lib/tasks.ts",
      "src/lib/phone.ts",
      "src/lib/db-errors.ts",
      // Day 4d: files (names, paths and signed links never reach a log).
      "src/lib/files/**",
      "src/components/files/**",
      "src/app/api/files/**",
      "src/app/(app)/files/**",
    ],
    rules: { "no-console": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees (local copies of the repository, never committed).
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
