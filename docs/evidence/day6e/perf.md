# Day 6e performance: I9 to I11 and the client page's weight

`supabase/tests/perf_share.sql` after `perf_stock.sql` (5,000 products: 3,000 with warehouse stock, 1,000 in transit
only), on a throwaway PostgreSQL 16 (a reduced copy of `scripts/db-perf.sh` on port 54381: shim, migrations of the 6e
head, 1,000 fake companies, `perf_stock.sql`, `perf_share.sql`). `db-perf.sh` now runs `perf_share.sql` after
`perf_sales.sql`. 60 links with known tokens, so each timed call uses a link of its own (a link takes 30 views a minute
and 5 requests an hour); every call runs as the `anon` role, as PostgREST calls it. Method as Day 4: runs 1 to 5 not
shown, 6 to 10 with plans (auto_explain), p95 (slowest but one) and average of runs 11 to 25. Shared runner.

## Results (ms, p95 / average)

| Case (budget) | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| I9 `share_view` valid link, 2,000 items (40) | **40.79** / 31.61 | 33.06 / 29.86 | **42.61** / 32.68 |
| I9 `share_view` unknown, well-formed token (3) | 0.15 / 0.07 | 0.07 / 0.06 | 0.09 / 0.07 |
| I9 `share_view` malformed token (1) | 0.01 / 0.01 | 0.00 / 0.00 | 0.01 / 0.00 |
| I11 `share_request` 5 lines + the task (20) | 9.53 / 8.99 | 9.53 / 8.89 | 8.74 / 8.03 |

| I10: a full answer, 2,000 items (budget) | Size |
|---|---|
| raw, as the database writes it (jsonb text, with spaces) (150 KB) | 125,333 bytes |
| gzip (35 KB) | 11,573 bytes |

The route sends the same arrays through `JSON.stringify` (no spaces), so the HTTP body is smaller still.

## What changed during the build (ca18b65)

- **First version: I10 212 KB raw / 59 KB gzip, I11 37 ms average (51 ms p95).** Each item started with the product's
  UUID (36 random characters: they do not compress) and the price kept its four decimals; the route also turned the
  arrays into named fields. Now the item is `[number, name, category, price, pieces per carton, warehouse, transit,
  eta week]` (the product number, P-0042, names it in a request, and no internal id leaves the database), prices are
  `trim_scale`d, and the arrays travel to the browser, which maps them itself (`src/lib/share/wire.ts`).
- `share_request` built the whole 2,000-item list to check the requested products; it now reads only the named
  products with the same rule: I11 37 ms to 8–9 ms.

## The client page's JavaScript (`bundle-scan.txt`)

From `next build` and the page's own HTML: the scripts `/s/fr` shares with `/login` (framework, root layout) are
610 KB raw / 189 KB gzip; the page's own chunks are **77 KB raw / 23.7 KB gzip** (budget: baseline + 40 KB gzip). They
were 54 KB gzip while the page parsed the answer with Zod; a hand-written check equal to the server's schema
(unit-tested against it) replaced it.

## Not measured here

- Lighthouse (mobile, Slow 4G): not installed, and no new dependency may be added in this session; the CI or Haider's
  preview check at Day 8 is the place for it.
- `/api/share/view` server time on Vercel (design: p95 ≤ 300 ms): needs the preview deployment.
- 500 share items render longest task (browser): not measured; the list renders 2,000 rows without virtualisation
  (design 10.5 asks for a plain list); see open risks.
