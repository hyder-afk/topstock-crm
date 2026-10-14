# Day 5c web interface guidelines audit

Rules: vercel-labs/web-interface-guidelines at 434b7f9 (`command.md`, fetched for this audit). Files:
`src/components/home/*.tsx`, `src/app/(app)/page.tsx`, `src/app/(app)/loading.tsx`.

## Findings and fixes

- `src/components/home/home-card.tsx` (h2) - `outline-none` on a programmatic focus target with no replacement → removed; the heading keeps the focus ring (6bd5a7d).
- `src/components/home/home-view.tsx` - the deal sheet over Home was not in the URL (no deep link) → `?deal=<id>`, replaced on open and close, read by the page; e2e checks both (6bd5a7d).
- `src/components/home/recent-activity.tsx`, `kpi-card.tsx` - long text was cut mid-value on phones → two-line clamp on phones, one line with an ellipsis from tablet width (6bd5a7d).
- `src/components/home/home-scope.tsx` - a tap during hydration caused a hydration error → state update in a transition (6bd5a7d).

## Checked, no change needed

- Accessibility: icon-only controls have names (checks: "Mark “…” done"); the KPI row is a labelled group; cards are regions named by their headings; heading order h1 then h2; async updates announced (the calm line is `aria-live="polite"`, card errors are `role="status"`); decorative icons `aria-hidden`; the count-up's moving copy is `aria-hidden` and screen readers get the final value once.
- Focus: focus is never dropped to the body (a ticked row hands focus to the next check, the deal sheet to its opener; e2e).
- Animation: transform/opacity (and `scale`) only, no `transition: all`, reduced motion honoured (CSS and the count-up/bar read the media query).
- Typography: `…` ellipses, typographic quotes and apostrophes, French narrow no-break spaces (messages.spec), tabular figures.
- Content: empty, loading and error states for every card; `min-w-0` and truncation on flex children.
- Navigation: KPI cards and rows are real links; the attention rows are buttons (they open a sheet).
- Destructive actions: ticking a task has Undo.
- Locale: dates, numbers and money through Intl in the page's locale; dates on the server and in the browser share one zone and one reference time (no hydration mismatch); the tagline is `translate="no"`.
- Hydration safety: no `suppressHydrationWarning`; relative times start from the server's answer time on both sides.
- Performance: no long lists (at most 20 rows a card); the deal sheet loads on demand (Home's extra JS 9.1 KB gzip).

Unresolved: none.
