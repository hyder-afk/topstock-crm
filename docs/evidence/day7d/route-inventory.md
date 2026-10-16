# Day 7d: route inventory unit test (`tests/unit/route-inventory.spec.ts`)

Gate 1 items 5, 9, 10 and 16. The rules are four functions of a file's repository path and text: `routeProblems`,
`actionProblems`, `pageProblems` and `screenProblems`. They read the code with the TypeScript compiler API
(`ts.createSourceFile` with parent nodes set, the top-level statements, `ts.canHaveModifiers`/`ts.getModifiers` for
`export` and `default`, `node.getText(sourceFile)`; TypeScript 5.9.3, checked in Context7 `/microsoft/typescript`,
"Using the Compiler API"). `reach()` adds the text of every same-file function an exported function calls, directly or
through another one. The four tests over `src/app` and the six planted-break tests run the **same functions**: the
planted ones on in-memory files.

A Zod parse is `/\.safeParse\(|(?<!JSON)\.parse\(|\bparse(?!Int\b|Float\b)[A-Z]\w*\(/`: `.safeParse(`, `.parse(` but not
`JSON.parse(`, or a `parseXxx(` helper (as `parseFilters`) but not `parseInt` or `parseFloat` (advisor round, 16 Oct).
Today's code passes it unchanged.

## Planted breaks in the test (in-memory fixtures, the real rule functions)

Each fixture must give exactly the named problem; each correct twin must give none, so a rule that flagged everything
would fail too.

| Fixture | Expected problem | Result |
|---|---|---|
| GET route with a Zod parse and no `apiSession()` | `no apiSession()` | caught; the twin with `apiSession()` passes |
| POST route with `apiSession()` that reads its body with `JSON.parse`, `parseInt` and `parseFloat` only | `reads the request without a Zod parse` | caught; the twin with `schema.safeParse(body)` passes. **With the old regex (`\.parse\(` and `parse[A-Z]`) this test fails** (run on 16 Oct: 1 failed, 9 passed), which is the hole the advisor found |
| GET route whose `safeParse` sits in a same-file helper | none | passes (the helper is found through `reach()`) |
| server action whose session check is in a same-file helper, no Zod | `takes input without a Zod parse` | caught; the twin with `inputSchema.safeParse(input)` passes |
| server action with Zod and no `requireSession()` | `no requireSession()/requireAdmin()` | caught |
| `src/app/(app)/debug/page.tsx` added to the real list of screens; the same page without a session check | `not on the reviewed list`; `no requireSession()/requireAdmin()` | both caught; the twin with `requireSession()` passes the page rule |

## Planted breaks in the real source (first round, 5 changes, each reverted with `git checkout`)

| Break in `src/` | Test that failed |
|---|---|
| `/api/tasks` route without `apiSession()` | route rule: `src/app/api/tasks/route.ts GET: no apiSession()` |
| `updateProfile` without its `safeParse` | action rule: `takes input without a Zod parse` |
| `changeRole` without `requireSession()` | action rule: `no requireSession()/requireAdmin()` |
| a new `src/app/(app)/debug/page.tsx` | screen list and page rule |
| `/inventory/settings` page without `requireAdmin()` | page rule |

Run: `npx playwright test -c playwright.unit.config.ts tests/unit/route-inventory.spec.ts`: 10 passed.
