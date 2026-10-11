# Day 4b screenshots: the lead page

Taken by `tests/auth/screens.spec.ts` (test "lead page: summary, timeline, call panel, details, until when, do not
contact") against the local auth stack, on a made-up lead: Maison Verdane in Lyon, two contacts (one number marked
wrong), one entry of each kind (call, email, WhatsApp, interested call, held meeting, note), an open follow-up task and
a next call date; plus Comptoir Silence, a Do not contact lead. Each shot waits for the real screen (not the skeleton)
and fails on any console error or sideways scroll.

| State | Matrix | Shots |
|---|---|---|
| `lead` (Summary) | 390, 768, 1024, 1280, 1440, 1728 × light and dark × English and French | 24 |
| `lead-timeline` | English light at all six widths; French dark 390, 1280, 1440, 1728; English dark and French light 390 and 1440 | 14 |
| `lead-call` (call panel after End call, Interested picked: the follow-up chips) | same | 14 |
| `lead-details` (lead form, time zone, next call) | same | 14 |
| `lead-until` ("Until when?" after choosing Cool off) | same | 14 |
| `lead-dnc` (Do not contact banner, no Call/WhatsApp/Email) | English light and French dark at 390 and 1440 | 4 |

84 lead page shots (436 in the whole screens run). This folder keeps a representative set: the Summary at every width in
English light, at phone, laptop and wide widths in the other three combinations; the timeline, the call panel,
Details, "Until when?" and the Do not contact lead at 1440 and 390; the leads preview with its new **Open lead**
button; the shortcuts list with the new "On a lead" section. The full set is the CI artifact "auth-screens" of the
PR's auth-journey job.

Notes for reading them:
- Full-page shots: the dock, the call panel and sheets are fixed to the screen, so in a full-page image they appear
  once, at the first screen's position (the phone call panel and "Until when?" sheet show at the top, where the first
  screen is; on a phone they sit at the bottom).
- The test browser runs in UTC, so a lead in Lyon shows both clocks ("15:31 there · 13:31 for you"); a viewer in the
  lead's zone sees "15:31 local time". The screenshots were taken on a Sunday, so the lead is outside calling hours.
- Timeline rows use `content-visibility: auto` up to 120 loaded entries (design D13); the shot paints them all (a style
  added for the shot only). Past 120 the timeline is virtualised; no shot has that many entries (the e2e test
  `timeline_virtualised_past_120` covers it).
- Taken again on 08ba920 (after the virtualised timeline, the tabs in Activity boundaries and the call panel close fix):
  the same 84 lead page shots, no console error, no sideways scroll; the kept set below replaced in place.
- The follow-up task title is in English in the French shots: it is the fixture's own text (titles made by the app are
  written in the caller's language).
