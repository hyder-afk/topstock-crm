import { expect, test } from "@playwright/test";
import {
  CALL_WINDOW,
  addDays,
  callZone,
  isOpen,
  localDate,
  localParts,
  nextOpening,
  spanEnds,
  weekdayOf,
  zoneChoices,
  zoneOffset,
  zonedInstant,
} from "@/lib/timezones";

// Calling hours on the lead's side (Day 4 design 5.1; Haider 11 Oct: Monday to Friday 09:00 to 18:00 lead time, a lunch
// switch off by default that skips 12:00 to 14:00 for European zones). Fixed instants around the 2026 clock changes:
// EU 29 Mar and 25 Oct, US 8 Mar and 1 Nov (the week Paris and New York are 5 hours apart). The cases between the
// markers are written to be shared with 4c's queue_attack.sql (private.call_zone_open).
// call-window:start
const cases: [key: string, at: string, skipLunch: boolean, open: boolean][] = [
  ["Europe/Paris", "2026-10-12T06:59:00Z", false, false], // Monday 08:59 Paris
  ["Europe/Paris", "2026-10-12T07:00:00Z", false, true], // Monday 09:00
  ["Europe/Paris", "2026-10-12T15:59:00Z", false, true], // 17:59
  ["Europe/Paris", "2026-10-12T16:00:00Z", false, false], // 18:00 closes
  ["Europe/Paris", "2026-10-12T10:30:00Z", false, true], // 12:30, lunch switch off
  ["Europe/Paris", "2026-10-12T10:30:00Z", true, false], // 12:30, lunch switch on
  ["Europe/Paris", "2026-10-12T09:59:00Z", true, true], // 11:59 with the switch
  ["Europe/Paris", "2026-10-12T12:00:00Z", true, true], // 14:00 with the switch
  ["Europe/Paris", "2026-10-10T10:00:00Z", false, false], // Saturday
  ["Europe/Paris", "2026-10-11T10:00:00Z", false, false], // Sunday
  ["Europe/Paris", "2026-10-26T07:30:00Z", false, false], // Monday after the change: 07:30 UTC is 08:30 CET
  ["Europe/Paris", "2026-10-26T08:00:00Z", false, true], // 09:00 CET
  ["Europe/Paris", "2026-10-23T06:59:00Z", false, false], // Friday before the change, 08:59 CEST
  ["Europe/Paris", "2026-03-30T06:59:00Z", false, false], // Monday after spring change, 08:59 CEST
  ["Europe/Paris", "2026-03-30T07:00:00Z", false, true],
  ["Europe/London", "2026-10-12T07:59:00Z", false, false], // 08:59 BST
  ["Europe/London", "2026-10-12T08:00:00Z", false, true], // 09:00 BST
  ["Europe/London", "2026-10-26T08:59:00Z", false, false], // 08:59 GMT
  ["Europe/London", "2026-10-26T09:00:00Z", false, true],
  ["America/New_York", "2026-10-26T13:00:00Z", false, true], // 09:00 EDT (Paris already on CET: 14:00)
  ["America/New_York", "2026-10-26T12:59:00Z", false, false],
  ["America/New_York", "2026-11-02T13:59:00Z", false, false], // 08:59 EST
  ["America/New_York", "2026-11-02T14:00:00Z", false, true],
  ["America/New_York", "2026-03-09T13:00:00Z", false, true], // after the US spring change, 09:00 EDT
  ["America/New_York", "2026-10-12T16:30:00Z", true, true], // lunch switch: not a European zone
  ["Asia/Karachi", "2026-10-12T04:00:00Z", false, true], // 09:00 PKT
  ["Asia/Karachi", "2026-10-12T13:00:00Z", false, false], // 18:00
  ["Asia/Kolkata", "2026-10-12T03:30:00Z", false, true], // 09:00 IST (+05:30)
  ["Asia/Kolkata", "2026-10-12T03:29:00Z", false, false],
  ["Asia/Kathmandu", "2026-10-12T03:15:00Z", false, true], // 09:00 (+05:45)
  ["Asia/Kathmandu", "2026-10-12T03:14:00Z", false, false],
  ["Asia/Dubai", "2026-10-16T06:00:00Z", false, true], // Friday 10:00 (Monday to Friday everywhere)
  ["Asia/Dubai", "2026-10-17T06:00:00Z", false, false], // Saturday
  ["Africa/Casablanca", "2026-10-12T08:00:00Z", false, true], // 09:00 (+01)
  ["US", "2026-10-12T15:59:00Z", false, false], // New York 11:59, Los Angeles 08:59
  ["US", "2026-10-12T16:00:00Z", false, true], // New York 12:00, Los Angeles 09:00
  ["US", "2026-10-12T21:59:00Z", false, true], // New York 17:59
  ["US", "2026-10-12T22:00:00Z", false, false], // New York 18:00
  ["US", "2026-10-12T16:30:00Z", true, true], // spans ignore the lunch switch
  ["US", "2026-11-02T17:00:00Z", false, true], // after 1 Nov: NY 12:00 EST, LA 09:00 PST
  ["US", "2026-11-02T16:59:00Z", false, false],
  ["CA", "2026-10-12T16:00:00Z", false, true], // Halifax 13:00, Vancouver 09:00
  ["CA", "2026-10-12T15:59:00Z", false, false],
  ["AU", "2026-10-12T00:00:00Z", false, false], // Sydney 11:00, Perth 08:00
  ["AU", "2026-10-12T01:00:00Z", false, true], // Perth 09:00, Sydney 12:00
  ["AU", "2026-10-12T05:00:00Z", false, true], // Sydney 16:00, Perth 13:00
  ["AU", "2026-10-12T07:00:00Z", false, false], // Sydney 18:00
  ["MX", "2026-10-12T16:00:00Z", false, true], // Mexico City 10:00, Tijuana 09:00
  ["BR", "2026-10-12T13:00:00Z", false, true], // São Paulo 10:00, Manaus 09:00
  ["BR", "2026-10-12T12:59:00Z", false, false],
  ["ID", "2026-10-12T02:00:00Z", false, true], // Jakarta 09:00, Jayapura 11:00
  ["ID", "2026-10-12T01:59:00Z", false, false],
  ["ID", "2026-10-12T09:00:00Z", false, false], // Jayapura 18:00
  ["Europe/Madrid", "2026-10-12T10:30:00Z", true, false], // lunch: European
  ["Atlantic/Canary", "2026-10-12T11:30:00Z", true, true], // Canaries 12:30: not Europe/*, the switch does not apply
  ["Europe/Moscow", "2026-10-12T06:00:00Z", false, true], // 09:00 MSK
  ["Pacific/Auckland", "2026-10-11T20:00:00Z", false, true], // Monday 09:00 NZDT
  ["Pacific/Auckland", "2026-10-11T19:59:00Z", false, false],
  ["America/Los_Angeles", "2026-10-12T16:00:00Z", false, true],
  ["America/Los_Angeles", "2026-10-12T15:59:00Z", false, false],
];
// call-window:end

for (const [key, at, lunch, open] of cases) {
  test(`${key} at ${at}${lunch ? " (lunch switch)" : ""}: ${open ? "open" : "closed"}`, () => {
    expect(isOpen(key, new Date(at), lunch)).toBe(open);
  });
}

test("the window constants", () => {
  expect(CALL_WINDOW).toEqual({ weekdays: [1, 2, 3, 4, 5], start: 540, end: 1080, lunch: [720, 840] });
});

test("calling zone: picked zone, country zone, span key, Europe/Paris", () => {
  expect(callZone("America/Chicago", "US")).toBe("America/Chicago");
  expect(callZone(null, "FR")).toBe("Europe/Paris");
  expect(callZone(null, "GB")).toBe("Europe/London");
  expect(callZone(null, "US")).toBe("US");
  expect(callZone(null, null)).toBe("Europe/Paris");
  expect(callZone(null, "AQ")).toBe("Europe/Paris");
  expect(spanEnds("US")).toEqual(["America/New_York", "America/Los_Angeles"]);
  expect(spanEnds("Europe/Paris")).toBeNull();
  expect(zoneChoices("US")).toContain("America/Chicago");
  expect(zoneChoices("FR")).toBeNull();
});

test("next opening: from Friday evening in Paris to Monday 09:00; open now is null", () => {
  expect(nextOpening("Europe/Paris", new Date("2026-10-09T17:30:00Z"))?.toISOString()).toBe("2026-10-12T07:00:00.000Z");
  expect(nextOpening("Europe/Paris", new Date("2026-10-12T08:00:00Z"))).toBeNull();
  // 07:00 in New York on a weekday: the US span opens at noon New York time.
  expect(nextOpening("US", new Date("2026-10-13T11:00:00Z"))?.toISOString()).toBe("2026-10-13T16:00:00.000Z");
  // Kathmandu opens on a quarter hour in UTC.
  expect(nextOpening("Asia/Kathmandu", new Date("2026-10-12T00:00:00Z"))?.toISOString()).toBe("2026-10-12T03:15:00.000Z");
  // Lunch switch: back at 14:00.
  expect(nextOpening("Europe/Paris", new Date("2026-10-12T10:05:00Z"), true)?.toISOString()).toBe("2026-10-12T12:00:00.000Z");
});

test("wall-clock helpers across clock changes", () => {
  expect(localParts("Europe/Paris", new Date("2026-10-25T00:30:00Z"))).toMatchObject({ date: "2026-10-25", weekday: 7, minutes: 150 });
  expect(zoneOffset("Europe/Paris", new Date("2026-07-01T12:00:00Z"))).toBe(120);
  expect(zoneOffset("Europe/Paris", new Date("2026-12-01T12:00:00Z"))).toBe(60);
  expect(zoneOffset("Asia/Kathmandu", new Date("2026-12-01T12:00:00Z"))).toBe(345);
  expect(zonedInstant("2026-10-26", "09:00", "Europe/Paris").toISOString()).toBe("2026-10-26T08:00:00.000Z");
  expect(zonedInstant("2026-10-23", "09:00", "Europe/Paris").toISOString()).toBe("2026-10-23T07:00:00.000Z");
  // 02:30 on 29 Mar does not exist in Paris: it moves forward an hour.
  expect(zonedInstant("2026-03-29", "02:30", "Europe/Paris").toISOString()).toBe("2026-03-29T01:30:00.000Z");
  expect(localDate("Asia/Karachi", new Date("2026-10-12T19:30:00Z"))).toBe("2026-10-13");
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(weekdayOf("2026-10-11")).toBe(7);
});

test("a time that happens twice is read as standard time, as PostgreSQL does", () => {
  // 02:30 on 25 Oct happens twice in Paris (CEST, then CET): PostgreSQL reads the CET one.
  expect(zonedInstant("2026-10-25", "02:30", "Europe/Paris").toISOString()).toBe("2026-10-25T01:30:00.000Z");
  expect(zonedInstant("2026-10-25", "09:00", "Europe/Paris").toISOString()).toBe("2026-10-25T08:00:00.000Z");
  expect(zonedInstant("2026-03-29", "09:00", "Europe/Paris").toISOString()).toBe("2026-03-29T07:00:00.000Z");
  expect(zonedInstant("2026-10-12", "09:00", "Asia/Kathmandu").toISOString()).toBe("2026-10-12T03:15:00.000Z");
});
