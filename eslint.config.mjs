import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Import code handles lead data: it never logs (design section 4, threat 13).
  {
    files: ["src/lib/import/**", "src/components/import/**"],
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
