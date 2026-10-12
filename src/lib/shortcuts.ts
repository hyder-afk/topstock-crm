import type { SectionId } from "@/lib/nav";

// "G then a letter" opens a section (Master Plan 4: "G then L go to leads"). The plan's Cmd+1..7 cannot work in a
// browser: Chrome and Safari keep Cmd/Ctrl+digit for switching tabs, so pages never receive it.
export const goKeys: Record<SectionId, string> = {
  home: "h",
  leads: "l",
  pipeline: "p",
  inventory: "i",
  tasks: "t",
  analytics: "a",
  more: "m",
};

// "G then Q" starts the work queue (Day 4c; Q is free: design 2.1).
export const queueGoKey = "q";

// True when the key press belongs to whatever the person is typing in, so single-letter shortcuts must stay quiet.
export function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
