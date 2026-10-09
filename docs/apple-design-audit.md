# Apple design audit checklist (TopStock CRM)

Fallback for `/apple-design`; mandatory after every UI step. Record each finding and fix in the step's REPORT and in docs/log.md.

Check each item against the screen you changed and write the finding and the fix:

1. **Instant response**: every tap or click shows a press state within 100 ms (scale 0.97 or a tint), even if the action takes longer.
2. **Tracks the finger 1:1**: anything draggable moves with the pointer with no lag and no jump when the drag starts (grab offset measured at the threshold, 10 px hysteresis).
3. **Keeps momentum**: on release, the velocity decides where it lands (projection with deceleration about 0.99); snapping uses a spring, not a fixed-duration tween.
4. **Interruptible**: a new tap or drag mid-animation starts from the current on-screen value with the current velocity; nothing jumps back to a start position.
5. **Rubber-bands at the edges** instead of stopping dead.
6. **Animate from the current value**: tabs, indicators, cards changing position (FLIP), sheets opening from the button that opened them.
7. **Calm**: no constant motion; entrances on first visit only; no hover lift on non-clickable things; skeletons rather than spinners.
8. **Reduced motion**: `prefers-reduced-motion` removes stretch and entrance animations but keeps direct manipulation working.
9. **Materials and depth**: translucency only on floating layers (dock, popovers), borders and tone for depth elsewhere, shadow only on floating layers.
10. **Typography**: brand fonts Outfit + DM Mono, self-hosted (DESIGN.md; replaced the system stack on 7 Oct 2026), DM Mono for money and counts that line up, French labels up to 20 percent longer never clipped.
11. **Status is never colour-only**: every status carries a label or symbol; light-mode status text tokens green `#15702F`, amber `#7C5300`, red `#B61C29`.
12. **Spatial consistency**: things come from and return to where they live; the dock stays bottom-centre on every screen size.
