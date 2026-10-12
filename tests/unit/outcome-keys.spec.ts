import { expect, test } from "@playwright/test";
import { outcomeForKey } from "@/lib/activities";

// Outcome keys (Day 4 design 7.7): digits by key position (event.code), so Henri's and Kais's AZERTY keyboards work:
// their top row types & é " ' ( - è à without Shift, and event.key would never be "1". Typing in the note is checked
// in the browser (tests/auth/lead-page.spec.ts), where the app skips key presses inside fields before reading them.
test("AZERTY: code Digit1 with key & is No answer", () => {
  expect(outcomeForKey({ code: "Digit1", key: "&" } as never)).toBe("no_answer");
  expect(outcomeForKey({ code: "Digit2" })).toBe("voicemail");
  expect(outcomeForKey({ code: "Digit3" })).toBe("wrong_number");
  expect(outcomeForKey({ code: "Digit4" })).toBe("not_interested");
  expect(outcomeForKey({ code: "Digit5" })).toBe("interested");
  expect(outcomeForKey({ code: "Digit6" })).toBe("meeting_booked");
  expect(outcomeForKey({ code: "Digit7" })).toBe("do_not_contact");
});

test("the numeric keypad and 0 for Spoke", () => {
  expect(outcomeForKey({ code: "Numpad7" })).toBe("do_not_contact");
  expect(outcomeForKey({ code: "Numpad1" })).toBe("no_answer");
  expect(outcomeForKey({ code: "Digit0" })).toBe("connected");
  expect(outcomeForKey({ code: "Numpad0" })).toBe("connected");
});

test("8, 9, letters, modifiers and IME composition are not outcomes", () => {
  expect(outcomeForKey({ code: "Digit8" })).toBeNull();
  expect(outcomeForKey({ code: "Digit9" })).toBeNull();
  expect(outcomeForKey({ code: "KeyA" })).toBeNull();
  expect(outcomeForKey({ code: "Digit1", metaKey: true })).toBeNull();
  expect(outcomeForKey({ code: "Digit1", ctrlKey: true })).toBeNull();
  expect(outcomeForKey({ code: "Digit1", altKey: true })).toBeNull();
  expect(outcomeForKey({ code: "Digit1", isComposing: true })).toBeNull();
});
