# Day 4b screenshots: the lead page

Taken by `tests/auth/screens.spec.ts` (tests "lead page: summary, timeline, call panel, details, until when, do not
contact, calling hours" and "lead page: route skeleton at 1024 and 1280") against the local auth stack, on made-up
leads: Maison Verdane in Lyon, two contacts (one number marked wrong), one entry of each kind (call, email, WhatsApp,
interested call, held meeting, note), an open follow-up task and a next call date; Comptoir Silence, a Do not contact
lead; Mercerie du Samedi, a Lyon lead with no entries for the calling-hours shots. Each shot waits for the real screen
(not the skeleton, except the skeleton shots) and fails on any console error or sideways scroll.

**Current set: taken on 11 Oct 2026 on f2c900b** (the app as merged after the review round, production build; only the
screens spec changed, to add the review-round states below). Run: `screens.spec.ts -g "leads: list with a lead
open|lead page|command menu"`, Chromium, 4 tests passed, 173 shots, no console error, no sideways scroll.

| State | Matrix | Shots |
|---|---|---|
| `lead` (Summary) | 390, 768, 1024, 1280, 1440, 1728 × light and dark × English and French | 24 |
| `lead-timeline` | English light at all six widths; French dark 390, 1280, 1440, 1728; English dark and French light 390 and 1440 | 14 |
| `lead-call` (call panel after End call, Interested picked: the follow-up chips; French heading "Appel vers …"; pad keys 56 px on phones) | same | 14 |
| `lead-details` (lead form, time zone, next call) | same | 14 |
| `lead-until` ("Until when?" after choosing Cool off; viewport shots) | same | 14 |
| `lead-dnc` (Do not contact banner, no Call/WhatsApp/Email; "Add a note" below 1024) | English light and French dark at 390, 768 and 1440 | 6 |
| `lead-dnc-note` (review round: "Add a note" opens the composer sheet with Note, Call and Meeting only; viewport shots) | English light and French dark at 390 and 768 | 4 |
| `lead-call-queued` (review round: a second Call while the first call's outcome step is open; the panel names the waiting call, focus on Save; viewport shots) | English light and French dark at 390 and 1440 | 4 |
| `lead-hours` (review round: clock fixed to Sat 10 Oct 2026 12:00 UTC, so calling hours open on Monday: "ouvre lun. à 09:00 (dans 2 jours)", "opens Mon 09:00 (in 2 days)") | French light and dark at 390 and 1440, English light 1440 | 5 |
| `lead-skeleton` (review round: the route skeleton, `loading.tsx`, opened from the leads preview with O while the page's data request is held; viewport shots) | English light and French dark at 1024 (actions under the header) and 1280 (beside it) | 4 |

103 lead page shots. This folder keeps 49: the Summary at every width in English light and at phone, laptop and wide
widths in the other three combinations (`lead-*-1024` is the 1024 layout: actions under the header); the timeline,
the call panel, Details and "Until when?" at 1440 and 390; Do not contact at 390, 768 and 1440; every review-round
shot (`lead-dnc-note-*`, `lead-call-queued-*`, `lead-hours-*`, `lead-skeleton-*`); the leads preview with its
**Open lead** button; the shortcuts list with its "On a lead" section. The full set is the CI artifact "auth-screens"
of the PR's auth-journey job.

Notes for reading them:
- Full-page shots: the dock and the call panel are fixed to the screen, so in a full-page image they appear once, at the
  first screen's position (in `lead-call-*-390` the phone call sheet shows near the top; on a phone it sits at the
  bottom, as `lead-call-queued-*-390` shows). Dialog and sheet states (`lead-until`, `lead-dnc-note`) and the call
  panel's queued state are viewport shots: Chromium's full-page capture of a page taller than the screen paints an
  open dialog half transparent (checked: the same dialog in a viewport capture is opaque, computed opacity 1).
- The test browser runs in UTC, so a lead in Lyon shows both clocks ("23:03 there · 21:03 for you"); a viewer in the
  lead's zone sees "23:03 local time". These were taken on a Sunday evening, so the lead is outside calling hours
  and every French shot reads "ouvre lun. à 09:00"; `lead-hours-*` shows the same line with a fixed clock.
- Timeline rows use `content-visibility: auto` up to 120 loaded entries (design D13); the shot paints them all (a style
  added for the shot only). Past 120 the timeline is virtualised; no shot has that many entries (the e2e test
  `timeline_virtualised_past_120` covers it).
- The follow-up task title is in English in the French shots: it is the fixture's own text (titles made by the app are
  written in the caller's language). Contact titles ("Owner", "Head buyer") are fixture text too.
- History: first taken on 434522c, then on 08ba920 (virtualised timeline, tabs in Activity boundaries, call panel close
  fix), now on f2c900b (review round); each time the kept set was replaced in place.
