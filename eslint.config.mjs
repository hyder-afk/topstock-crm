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
      // Day 6e: the client stock page, its routes and libraries, and every inventory server file.
      "src/app/(share)/**",
      "src/app/api/share/**",
      "src/lib/share/**",
      "src/components/share/**",
      "src/lib/http.ts",
      "src/lib/inventory-server.ts",
      "src/lib/sales-server.ts",
      "src/lib/stock-import-server.ts",
      "src/app/(app)/inventory/**",
      "src/app/api/inventory/**",
    ],
    rules: { "no-console": "error" },
  },
  // The client stock page never reaches Supabase or a server helper from the browser (design 8.6, threat P15): its
  // data comes only from /api/share/*.
  {
    files: ["src/app/(share)/**", "src/components/share/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@supabase/*"], message: "The client page talks to /api/share only." },
            { group: ["@/lib/supabase/*"], message: "The client page talks to /api/share only." },
            { group: ["*-server", "@/lib/share/server"], message: "No server helpers on the client page." },
          ],
        },
      ],
    },
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
