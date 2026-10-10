# Day 3b screenshots

Taken by `tests/auth/screens.spec.ts` against the local auth stack on the final screens (the test fails on any console
error or sideways scroll). Every import step (choose, match, results, discard, done, undo, "Confirm it's you") is shot at
390, 768, 1024, 1280, 1440 and 1728, light and dark, English and French: 112 import shots, 338 in all. This folder keeps
a representative set (English light at 390, 1280, 1440 and 1728; French dark at 390 and 1440; 768 and 1024 for the two
largest steps; the leads screen and the command menu with the new Import entry points). The full set is the CI artifact
"auth-screens" of this PR's auth-journey job.

Full-page shots: the dock and sticky bars are fixed to the screen, so in a full-page image they appear once, at the
first screen's position.
