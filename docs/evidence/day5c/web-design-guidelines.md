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

## Verifier round 1 and the 4c rebase (15 Oct)

- Focus is kept when the focused Needs attention row leaves (after the deal sheet closes, or while it is open);
  `attention_opens_deal_sheet and refetch_after_move` checks both orders with `toBeFocused`.
- Start calling: `aria-keyshortcuts="G Q"`, key caps `aria-hidden`.

## Advisor item 3 (15 Oct): the Low stock card and its skeleton

Rules: vercel-labs/web-interface-guidelines at 434b7f9 (`command.md`, fetched again with WebFetch for this audit: not
blocked). Files: `src/components/home/low-stock-card.tsx`, `src/components/home/home-skeleton.tsx`.

### Findings and fixes (d29be68)

- `low-stock-card.tsx` (product rows) - Content handling: the figures line was `truncate`, so a long line could hide a
  number → it wraps (`break-words`); the name keeps its one-line ellipsis in a `min-w-0` row.
- `low-stock-card.tsx` (loading) and `home-skeleton.tsx` (last card) - loading state shaped unlike the content (3
  one-line rows, no action) → `LowStockSkeleton` and `LowStockActionSkeleton` at the content's sizes, `aria-hidden`,
  pulse behind `motion-safe:`.
- `messages/en.json` `Home.lowStock.inTransit` - Title Case inside a line ("In Transit"); the guideline's Title Case
  is for headings and buttons, and the app's lines are sentence case → "in transit".

### Checked, no change needed

- Accessibility: the card is a region named by its heading; the follow-up list is labelled ("Also in inventory"); the
  placeholder icon and the dots are `aria-hidden`; every status keeps its words; the skeleton is `aria-hidden` and the
  card says `aria-busy` while loading.
- Focus and hover: the links (Open inventory, follow-ups) use the global `:focus-visible` ring and a hover tone stronger
  than rest; 44 px targets on phones.
- Navigation: real links with each Inventory tab or filter in the URL.
- Typography: DM Mono (tabular) for the figures; French narrow no-break spaces before colons (unit test).
- Locale: numbers through `useFormatter` (Intl) in the page's locale.
- Layout: no sideways scroll at any width (`home-screens`, 72 Low stock shots); flex children `min-w-0`.
- Performance: at most 5 product rows (no virtualisation needed).

Unresolved: none.
