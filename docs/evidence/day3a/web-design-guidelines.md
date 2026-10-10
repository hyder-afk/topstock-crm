# /web-design-guidelines: Day 3a leads screen, 10 Oct 2026

Rules: vercel-labs/web-interface-guidelines `command.md` at commit 434b7f9 (SHA-256 d246b026…, matches the pin).
Files: src/components/leads/*, src/components/ui/{popover,dropdown-menu,select,toast}.tsx, src/app/(app)/leads/*.
Plan overrides (docs/preflight.md): no spinners (skeletons and press states instead); sentence case, not Title Case.

## Found and fixed

src/components/leads/lead-form.tsx - inputs and selects had no `name` → added (name, status, owner, phone, email, city, country)
src/components/leads/contact-form.tsx - inputs had no `name` → added (first_name, last_name, title, phone, email)
src/components/leads/leads-toolbar.tsx - search, city, country search and view name inputs had no `name` → added
src/components/leads/lead-form.tsx, contact-form.tsx - first invalid field not focused on submit → focused
messages/{en,fr}.json Leads.searchPlaceholder, filter.countrySearch - placeholders did not end with "…" → added
src/components/leads/leads-toolbar.tsx - deleting a saved view was immediate → toast with Undo (saves it again)
src/components/leads/leads-table.tsx - sticky column header could cover a row reached with the arrow keys → `scrollMargin` and `scrollPaddingStart` = header height
src/components/leads/lead-preview.tsx, leads-workspace.tsx - headings without `text-balance` → added on the lead name and state headings

## Checked, no change

- Icon-only buttons (close, edit contact, delete view, remove filter, dismiss) have `aria-label`; decorative icons `aria-hidden`.
- Toast region `role="status"` with `aria-live="polite"`; form errors use the existing alert/status message.
- Checkboxes and radios are wrapped by their label (one hit target); native `<select>` has explicit background and text colour.
- Large list virtualised (TanStack Virtual); country picker shows only selected plus 8 matches; the 249-country `<select>` is native.
- URL reflects filters, sort and the open lead; links are real `<a>` (Cmd/Ctrl-click and middle-click open a lead in a new tab).
- Dates and numbers through next-intl (`Intl`), one reference time per request (no hydration mismatch); counts and phone numbers in DM Mono.
- `touch-action: manipulation`, tap highlight, `color-scheme`, `theme-color` set globally (Day 1); `overscroll-behavior: contain` on the table, preview and filter panel.

## Accepted, noted

- Table rows also open the lead on a pointer click anywhere in the row (`div` with `onClick`): the company link inside each row is the keyboard and screen-reader path, so nothing is pointer-only.
- No "unsaved changes" warning when leaving an open edit form: the forms are short and inline; revisit if people lose edits.
- The add-lead dialog opens centred rather than from its button (also in the Apple audit).
