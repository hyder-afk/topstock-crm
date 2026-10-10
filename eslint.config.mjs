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
