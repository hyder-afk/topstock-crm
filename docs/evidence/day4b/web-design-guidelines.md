# /web-design-guidelines: Day 4b lead page, 11 Oct 2026

Rules: vercel-labs/web-interface-guidelines `command.md` at commit 434b7f9 (the pinned rules URL, fetched for this
review). Files: `src/components/lead/*`, `src/components/activity/*`, `src/components/ui/tabs.tsx`,
`src/components/ui/textarea.tsx`, `src/app/(app)/leads/[id]/*` (page, loading, not-found), the leads preview, workspace
and table changes, `src/components/shell/shortcuts-dialog.tsx`, `messages/{en,fr}.json` (LeadPage, QuickActions,
CallPanel, Composer, Outcomes, Timeline, Errors, Leads.until, Shortcuts). Plan overrides (docs/preflight.md): no
spinners (skeletons, "Saving…" text and press states instead); sentence case, not Title Case.
Reviewed by the builder on the code and on the screenshots in `screens/`; every fix below was checked again on new
screenshots and by the e2e suites.

## Found and fixed

src/components/lead/details-tab.tsx - the time zone hint sat inside the select's label (read as part of its name) → a label with `htmlFor`, the hint tied with `aria-describedby`
src/components/lead/details-tab.tsx - hydration mismatch (React 418): country and zone names come from Intl, worded differently by the server's and the browser's data → the lead form and zone names are drawn in the browser only, with a placeholder of the form's shape first
src/components/activity/composer.tsx, outcome-pad.tsx, call-panel.tsx, details-tab.tsx - fields without `name` / `autocomplete` → names on every field, `autoComplete="off"` on note, subject and message
src/components/activity/composer.tsx - the kind selector's labels were cut with an ellipsis (French "Rendez-vous" in the rail) → labels may wrap; never cut
src/components/activity/call-panel.tsx - scroll inside the panel chained to the page; text got selected while dragging the handle → `overscroll-contain`; `select-none` on the handle
src/components/lead/lead-page.tsx - the phone composer sheet chained its scroll to the page → `overscroll-contain`
src/components/activity/timeline.tsx - entry titles were h4 directly under a card's h2 in Summary (a skipped level) → h3 there, h4 under the timeline's day headings (h3)
src/components/activity/timeline.tsx - the timeline filter lived only in React state → in the URL (`?filter=calls`), like the tab (`?tab=`), with `replaceState`
src/components/activity/call-panel.tsx - `aria-modal` on a region (not supported, ESLint jsx-a11y) → removed; the panel is a labelled region that does not trap focus
src/components/lead/local-time.tsx, timeline.tsx, outcome-pad.tsx, lead-cards.tsx, details-tab.tsx - times formatted as "02:43 PM" in English → `hourCycle: "h23"` everywhere (the design's "14:05")
src/components/lead/lead-cards.tsx - a Do not contact lead offered chips to plan a call → no chips there ("No next step.")
src/components/lead/lead-header.tsx - the place and the local time ran together on phones, with a "·" starting the second line → two lines on phones, one from tablet width
src/components/providers/query-provider.tsx - Zod 4's eval probe (`Function("")`) was reported as a CSP violation (`script-src`) in the browser → `z.config({ jitless: true })` (the same validation, no probe)
src/app/(app)/leads/[id]/not-found.tsx - a missing lead showed the app's generic not-found with "Go to Home" → the same words with "Back to leads"
src/components/activity/call-panel.tsx - closing the panel (✕, Esc, drag down) with an outcome picked but not saved dropped the call with no warning → every first close shows "Call not logged · Log it" (outcome and note kept); a second close or Don't log ends it
src/lib/drafts.ts, src/components/auth/forms.tsx - unsent note text stayed in a shared browser after signing out → the sign-in page clears every draft

## Checked, no change

- Icon-only buttons have `aria-label` (close the panel, entry options, edit a contact, previous and next lead, dismiss the log chip, task checks "Mark “…” done"); decorative icons are `aria-hidden`.
- Buttons for actions, links for navigation: Back, Open lead, J/K arrows and the import link are `<Link>`; Call, Email and WhatsApp are real `<a>` links (`tel:`, `mailto:`, `wa.me`) so long-press and copy work; no clickable div or span.
- Every control has a visible label or `aria-label`; the composer's limits are in `aria-describedby` (counter and the reason Save cannot run, `aria-live="polite"`).
- Toasts are one polite live region; logging errors are a toast that keeps the composer's text; the call panel's "Call not logged" is a status.
- Focus: the global `:focus-visible` ring; tabs use a roving tabindex with arrows, Home and End; End call moves focus to the pad; tab panels are focusable; dialogs return focus (Radix; the step-up dialog's own restore).
- Destructive actions: deleting an entry asks first and then needs a fresh code; outcomes, task checks and status changes have Undo; Do not contact names itself on the Save button.
- Animation: transform and opacity only, listed transitions (no `transition: all`), the panel's transform origin is the Call button, springs are interruptible, everything respects `prefers-reduced-motion`.
- Typography: "…" in placeholders and "Saving…"; curly quotes ("Mark “{title}” done"); counts, times, phone numbers and the timer in DM Mono with `tabular-nums` for the timer; headings `text-wrap: balance` (globals).
- Content: long names, notes, emails and addresses wrap (`break-words`, `break-all` for addresses); flex children have `min-w-0`; empty states for the timeline (all and filtered), next step, contacts, Deals and Stock; notes clamp at 6 lines with Show more (and the full text from `get_activity` past 2,000 characters).
- Performance: timeline pages of 30 with `content-visibility: auto` per row; no layout reads in render (the panel's origin is measured in an effect and on click); hover prefetch after 120 ms; the composer's draft is written 300 ms after typing stops.
- Touch: 44 px targets on phones, `touch-action: manipulation` and the tap highlight set globally, safe-area padding at the bottom of the phone call panel; the drag-to-close gesture has the ✕ button and Esc as alternatives.
- i18n: Intl for every date, time, relative time and number; zone and country names from Intl; phone numbers `translate="no"`; EN and FR keys checked for parity and French typography (`messages.spec.ts`).
- Hydration: times that depend on now or on the viewer's zone are drawn after mount (a placeholder of the same size first); `useSyncExternalStore` with server snapshots for the viewer's zone, the online state and the width.
- Dark mode: native selects, date and time inputs use the theme tokens; `color-scheme` set globally.

## Accepted, noted

- Leaving the page with text in the composer gives no warning: the draft is kept per lead and comes back (design 7.2).
- A missing lead is answered with the not-found screen but an HTTP 200: the page streams behind its loading skeleton (Next.js sends the status before the page knows), the same as other streamed routes.
- Native date and time pickers follow the browser's language and clock settings.
