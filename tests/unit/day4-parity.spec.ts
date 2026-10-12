import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  ACTIVITY_TYPES,
  BODY_MAX,
  BODY_SHOWN,
  CALL_OUTCOMES,
  OUTCOMES_FOR_TYPE,
  TIMELINE_PAGE_SIZE,
  UNDO_SECONDS,
  UNSAFE_TEXT,
} from "@/lib/activities";
import { STEP_UP_SECONDS } from "@/lib/import";
import { TASK_KINDS, TASK_TITLE_MAX } from "@/lib/tasks";
import { CALL_WINDOW } from "@/lib/timezones";

// The lead page's lists and limits against the Day 4a and 4b migrations (Day 4 design 8.4): a kind, outcome or limit
// the database does not share would make a save fail, or show a raw code.
const hardening = readFileSync(join(__dirname, "../../supabase/migrations/20261011120000_activity_hardening.sql"), "utf8");
const leadPage = readFileSync(join(__dirname, "../../supabase/migrations/20261012090000_lead_page.sql"), "utf8");
const quoted = (text: string) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const between = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  expect(start, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0);
  return text.slice(start + from.length, text.indexOf(to, start + from.length));
};

test("call outcomes match the activities check and log_activity, in pad order", () => {
  const check = between(hardening, "type = 'call' and outcome is not null and outcome in (", ")");
  expect(quoted(check)).toEqual([...CALL_OUTCOMES]);
  const logged = between(leadPage, "(p_type = 'call' and p_outcome in (", ")");
  expect(quoted(logged)).toEqual([...CALL_OUTCOMES]);
});

test("the other kinds' outcomes match the check", () => {
  expect(hardening).toContain("(type in ('email', 'whatsapp') and (outcome is null or outcome = 'sent'))");
  expect(hardening).toContain("(type = 'meeting' and (outcome is null or outcome in ('held', 'no_show')))");
  expect(hardening).toContain("(type = 'note' and outcome is null)");
  expect(OUTCOMES_FOR_TYPE).toEqual({
    call: CALL_OUTCOMES,
    email: [null, "sent"],
    whatsapp: [null, "sent"],
    meeting: [null, "held", "no_show"],
    note: [null],
  });
});

test("kinds of entry match the timeline filter list", () => {
  expect(quoted(between(leadPage, "not p_types <@ array[", "]"))).toEqual([...ACTIVITY_TYPES]);
});

test("task kinds match the tasks check", () => {
  expect(quoted(between(hardening, "check (kind in (", ")"))).toEqual([...TASK_KINDS]);
  expect(hardening).toContain("char_length(new.title) not between 1 and 300");
  expect(TASK_TITLE_MAX).toBe(300);
});

test("text: 10,000 characters, the same unsafe characters, 2,000 shown", () => {
  expect(hardening).toContain("if char_length(new.body) > 10000 then");
  expect(BODY_MAX).toBe(10_000);
  expect(hardening).toContain(`body !~ '${UNSAFE_TEXT.source.replace(/\\u([0-9A-F]{4})/g, "\\u$1")}'`);
  expect(leadPage).toContain("left(a.body, 2000), char_length(a.body) > 2000");
  expect(BODY_SHOWN).toBe(2_000);
});

test("undo window, step-up window, page size and the 09:00 working day", () => {
  expect(UNDO_SECONDS).toBe(120);
  expect(leadPage).toContain("created_at > now() - interval '120 seconds'");
  expect(leadPage).toContain("a.created_at + interval '120 seconds'");
  expect(STEP_UP_SECONDS).toBe(600);
  expect(leadPage).toContain("if not (select private.has_recent_aal2(600)) then");
  expect(leadPage).toContain("p_limit not between 1 and 100");
  expect(TIMELINE_PAGE_SIZE + 1).toBeLessThanOrEqual(100);
  expect(leadPage).toContain("return (d + time '09:00') at time zone z;");
  expect(CALL_WINDOW.start).toBe(9 * 60);
  expect(CALL_WINDOW.end).toBe(18 * 60);
  expect(CALL_WINDOW.lunch).toEqual([12 * 60, 14 * 60]);
});
