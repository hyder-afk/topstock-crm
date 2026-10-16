import { createElement as h, Fragment } from "react";
import { expect, test } from "@playwright/test";
import {
  addDays,
  addMonths,
  addYears,
  clampIso,
  daysInMonth,
  endOfWeek,
  formatIsoDate,
  formatTypedDate,
  isInRange,
  isIsoDate,
  isOutOfRange,
  joinDateTime,
  monthLabel,
  monthMatrix,
  moveFocus,
  numericDateOrder,
  orderRange,
  parseIsoDate,
  parseTypedDate,
  splitDateTime,
  startOfWeek,
  todayIso,
  weekday,
  weekdayNames,
} from "@/lib/pickers/calendar";
import { pickerChangeEvent } from "@/lib/pickers/event";
import { flattenEntries, foldText, parseOptionChildren, resolveSelectValue, searchScore, textOf } from "@/lib/pickers/options";
import { formatTime, fromMinutes, isTime, isTimeOutOfRange, localeHourCycle, nearestTimeIndex, parseTypedTime, timeList, toMinutes } from "@/lib/pickers/time";

// The pure rules behind the app's own pickers (Haider 15 Oct 2026: no native pickers or popups). The components'
// behaviour in a browser is tested at the call sites when they switch over.

test.describe("calendar days", () => {
  test("only real days are ISO days", () => {
    expect(isIsoDate("2026-10-15")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true); // leap year
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-10-00")).toBe(false);
    expect(isIsoDate("15/10/2026")).toBe(false);
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(parseIsoDate("2026-10-15")).toEqual({ y: 2026, m: 10, d: 15 });
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
  });

  test("day and month arithmetic crosses months, years and daylight-saving changes", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30"); // Paris clocks change on 29 March 2026
    expect(addDays("2026-10-25", -1)).toBe("2026-10-24"); // and on 25 October 2026
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(addMonths("2026-01-15", -13)).toBe("2024-12-15");
    expect(addYears("2028-02-29", 1)).toBe("2029-02-28");
  });

  test("weeks start on Monday by default, Sunday when asked", () => {
    expect(weekday("2026-10-15")).toBe(4); // Thursday
    expect(startOfWeek("2026-10-15")).toBe("2026-10-12");
    expect(endOfWeek("2026-10-15")).toBe("2026-10-18");
    expect(startOfWeek("2026-10-12")).toBe("2026-10-12");
    expect(startOfWeek("2026-10-18")).toBe("2026-10-12"); // a Sunday ends the Monday week
    expect(startOfWeek("2026-10-15", 0)).toBe("2026-10-11");
    expect(endOfWeek("2026-10-15", 0)).toBe("2026-10-17");
  });

  test("the month grid is 6 weeks of 7 days starting on the week's first day", () => {
    const october = monthMatrix(2026, 10);
    expect(october).toHaveLength(6);
    for (const week of october) expect(week).toHaveLength(7);
    expect(october[0][0]).toEqual({ iso: "2026-09-28", day: 28, inMonth: false });
    expect(october[0][3]).toEqual({ iso: "2026-10-01", day: 1, inMonth: true });
    expect(october.flat().filter((d) => d.inMonth)).toHaveLength(31);
    expect(october.flat().filter((d) => d.inMonth).at(-1)!.iso).toBe("2026-10-31");
    for (const week of october) expect(weekday(week[0].iso)).toBe(1);
    // Days run on without gaps.
    const days = october.flat().map((d) => d.iso);
    for (let i = 1; i < days.length; i++) expect(days[i]).toBe(addDays(days[i - 1], 1));
    // A month that starts on the week's first day still shows 6 rows (the panel never changes height).
    const june = monthMatrix(2026, 6);
    expect(june[0][0].iso).toBe("2026-06-01");
    expect(june).toHaveLength(6);
    // Sunday first.
    const sunday = monthMatrix(2026, 10, 0);
    expect(sunday[0][0].iso).toBe("2026-09-27");
    expect(weekday(sunday[0][0].iso)).toBe(0);
    // February of a leap year.
    expect(monthMatrix(2028, 2).flat().filter((d) => d.inMonth)).toHaveLength(29);
  });

  test("min and max bound the days and the keyboard", () => {
    expect(isOutOfRange("2026-10-15", "2026-10-16")).toBe(true);
    expect(isOutOfRange("2026-10-16", "2026-10-16")).toBe(false);
    expect(isOutOfRange("2026-10-20", undefined, "2026-10-19")).toBe(true);
    expect(isOutOfRange("2026-10-19", undefined, "2026-10-19")).toBe(false);
    expect(isOutOfRange("2026-10-19")).toBe(false);
    expect(clampIso("2026-10-01", "2026-10-10", "2026-10-20")).toBe("2026-10-10");
    expect(clampIso("2026-10-30", "2026-10-10", "2026-10-20")).toBe("2026-10-20");
    expect(clampIso("2026-10-15", "2026-10-10", "2026-10-20")).toBe("2026-10-15");
  });

  test("keys move focus as in the WAI-ARIA date picker dialog", () => {
    const at = "2026-10-15"; // Thursday
    expect(moveFocus(at, "ArrowLeft")).toBe("2026-10-14");
    expect(moveFocus(at, "ArrowRight")).toBe("2026-10-16");
    expect(moveFocus(at, "ArrowUp")).toBe("2026-10-08");
    expect(moveFocus(at, "ArrowDown")).toBe("2026-10-22");
    expect(moveFocus(at, "PageUp")).toBe("2026-09-15");
    expect(moveFocus(at, "PageDown")).toBe("2026-11-15");
    expect(moveFocus(at, "PageUp", { shiftKey: true })).toBe("2025-10-15");
    expect(moveFocus(at, "PageDown", { shiftKey: true })).toBe("2027-10-15");
    expect(moveFocus(at, "Home")).toBe("2026-10-12");
    expect(moveFocus(at, "End")).toBe("2026-10-18");
    expect(moveFocus(at, "Home", { weekStartsOn: 0 })).toBe("2026-10-11");
    expect(moveFocus("2026-01-31", "PageDown")).toBe("2026-02-28");
    expect(moveFocus(at, "Enter")).toBeNull();
    expect(moveFocus(at, "a")).toBeNull();
    // Never past min or max.
    expect(moveFocus("2026-10-10", "ArrowUp", { min: "2026-10-05" })).toBe("2026-10-05");
    expect(moveFocus("2026-10-28", "PageDown", { max: "2026-11-01" })).toBe("2026-11-01");
  });

  test("ranges are ordered and include both ends", () => {
    expect(orderRange("2026-10-20", "2026-10-10")).toEqual({ from: "2026-10-10", to: "2026-10-20" });
    expect(orderRange("2026-10-10", "2026-10-20")).toEqual({ from: "2026-10-10", to: "2026-10-20" });
    expect(orderRange("2026-10-10", "2026-10-10")).toEqual({ from: "2026-10-10", to: "2026-10-10" });
    expect(isInRange("2026-10-10", "2026-10-10", "2026-10-20")).toBe(true);
    expect(isInRange("2026-10-20", "2026-10-10", "2026-10-20")).toBe(true);
    expect(isInRange("2026-10-21", "2026-10-10", "2026-10-20")).toBe(false);
    expect(isInRange("2026-10-15", "2026-10-10", null)).toBe(false);
  });

  test("names come from Intl in the interface language", () => {
    expect(weekdayNames("en", 1, "long")).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
    expect(weekdayNames("fr", 1, "long")).toEqual(["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]);
    expect(weekdayNames("en", 0, "short")[0]).toBe("Sun");
    expect(monthLabel("en", 2026, 10)).toBe("October 2026");
    expect(monthLabel("fr", 2026, 10)).toBe("octobre 2026");
    expect(formatIsoDate("2026-10-15", "fr", { weekday: "long", day: "numeric", month: "long", year: "numeric" })).toBe("jeudi 15 octobre 2026");
    expect(formatIsoDate("2026-10-15", "en", { day: "numeric", month: "long", year: "numeric" })).toBe("October 15, 2026");
    expect(formatIsoDate("not a day", "en")).toBe("");
  });

  test("typed days follow the locale's digit order, with no guessing", () => {
    expect(numericDateOrder("fr")).toBe("dmy");
    expect(numericDateOrder("en")).toBe("mdy");
    expect(numericDateOrder("en-GB")).toBe("dmy");
    expect(formatTypedDate("2026-10-05", "fr")).toBe("05/10/2026");
    expect(formatTypedDate("2026-10-05", "en")).toBe("10/05/2026");
    expect(parseTypedDate("05/10/2026", "fr")).toBe("2026-10-05");
    expect(parseTypedDate("05/10/2026", "en")).toBe("2026-05-10");
    expect(parseTypedDate("5.10.26", "fr")).toBe("2026-10-05");
    expect(parseTypedDate("5-10-2026", "fr")).toBe("2026-10-05");
    expect(parseTypedDate(" 15 10 2026 ", "fr")).toBe("2026-10-15");
    expect(parseTypedDate("2026-10-15", "fr")).toBe("2026-10-15");
    expect(parseTypedDate("2026-10-15", "en")).toBe("2026-10-15");
    expect(parseTypedDate("31/02/2026", "fr")).toBeNull();
    expect(parseTypedDate("2026-02-31", "fr")).toBeNull();
    expect(parseTypedDate("15/10", "fr")).toBeNull();
    expect(parseTypedDate("15/10/202", "fr")).toBeNull();
    expect(parseTypedDate("aa/10/2026", "fr")).toBeNull();
    expect(parseTypedDate("", "fr")).toBeNull();
    // Round trip in both languages.
    for (const locale of ["fr", "en"]) {
      for (const iso of ["2026-01-01", "2026-12-31", "2028-02-29"]) expect(parseTypedDate(formatTypedDate(iso, locale), locale)).toBe(iso);
    }
  });

  test("today is read in a time zone", () => {
    const late = new Date("2026-10-15T22:30:00Z"); // already the 16th in Paris, still the 15th in New York
    expect(todayIso("Europe/Paris", late)).toBe("2026-10-16");
    expect(todayIso("America/New_York", late)).toBe("2026-10-15");
    expect(todayIso("UTC", late)).toBe("2026-10-15");
  });

  test("date and time travel as one datetime-local value", () => {
    expect(splitDateTime("2026-10-15T09:30")).toEqual({ date: "2026-10-15", time: "09:30" });
    expect(splitDateTime("2026-10-15T24:00")).toEqual({ date: "", time: "" });
    expect(splitDateTime("2026-02-30T09:30")).toEqual({ date: "", time: "" });
    expect(splitDateTime("2026-10-15")).toEqual({ date: "", time: "" });
    expect(splitDateTime("")).toEqual({ date: "", time: "" });
    expect(joinDateTime("2026-10-15", "09:30")).toBe("2026-10-15T09:30");
    expect(joinDateTime("2026-10-15", "")).toBe("");
    expect(joinDateTime("", "09:30")).toBe("");
  });
});

test.describe("times", () => {
  test("the list has 96 quarter hours, bounded by min and max", () => {
    const list = timeList();
    expect(list).toHaveLength(96);
    expect(list[0]).toBe("00:00");
    expect(list[1]).toBe("00:15");
    expect(list.at(-1)).toBe("23:45");
    expect(timeList(30)).toHaveLength(48);
    expect(timeList(60, "08:00", "18:00")).toEqual(["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"]);
    expect(timeList(15, "08:10", "08:50")).toEqual(["08:15", "08:30", "08:45"]);
    expect(timeList(0)).toHaveLength(1440); // a silly step is clamped, never an endless loop
  });

  test("HH:MM checks and minute arithmetic", () => {
    expect(isTime("09:15")).toBe(true);
    expect(isTime("23:59")).toBe(true);
    expect(isTime("24:00")).toBe(false);
    expect(isTime("9:15")).toBe(false);
    expect(isTime("")).toBe(false);
    expect(toMinutes("09:15")).toBe(555);
    expect(fromMinutes(555)).toBe("09:15");
    expect(fromMinutes(1440)).toBe("00:00");
    expect(fromMinutes(-15)).toBe("23:45");
  });

  test("typed times in every common shape", () => {
    const cases: [string, string | null][] = [
      ["9", "09:00"],
      ["915", "09:15"],
      ["0915", "09:15"],
      ["9:15", "09:15"],
      ["09:15", "09:15"],
      ["9.15", "09:15"],
      ["9h15", "09:15"],
      ["9 h 15", "09:15"],
      ["9h", "09:00"],
      ["21:15", "21:15"],
      ["2115", "21:15"],
      ["0", "00:00"],
      ["23:59", "23:59"],
      ["9:15pm", "21:15"],
      ["9:15 PM", "21:15"],
      ["9 pm", "21:00"],
      ["9p", "21:00"],
      ["12 am", "00:00"],
      ["12:30 pm", "12:30"],
      ["12:30 a.m.", "00:30"],
      ["24:00", null],
      ["9:60", null],
      ["13 pm", null],
      ["0 am", null],
      ["abc", null],
      ["9:1", null],
      ["", null],
    ];
    for (const [text, expected] of cases) expect(parseTypedTime(text), text).toBe(expected);
  });

  test("French reads 24-hour, US English 12-hour", () => {
    expect(localeHourCycle("fr")).toBe("h23");
    expect(localeHourCycle("en")).toBe("h12");
    expect(localeHourCycle("en-GB")).toBe("h23");
    expect(formatTime("09:15", "fr")).toBe("09:15");
    expect(formatTime("21:15", "fr")).toBe("21:15");
    expect(formatTime("21:15", "en").replace(/\s/g, " ")).toBe("9:15 PM");
    expect(formatTime("00:00", "en").replace(/\s/g, " ")).toBe("12:00 AM");
    expect(formatTime("21:15", "en", "h23")).toBe("21:15");
    expect(formatTime("nope", "en")).toBe("");
    // Every list entry round-trips through its 12-hour label.
    for (const time of timeList()) expect(parseTypedTime(formatTime(time, "en", "h12"))).toBe(time);
  });

  test("the highlighted entry is the value or the next one", () => {
    const list = timeList();
    expect(nearestTimeIndex(list, "09:15")).toBe(37);
    expect(nearestTimeIndex(list, "09:10")).toBe(37);
    expect(nearestTimeIndex(list, "23:50")).toBe(0); // wraps
    expect(nearestTimeIndex(list, "")).toBe(0);
    expect(nearestTimeIndex([], "09:00")).toBe(-1);
    expect(isTimeOutOfRange("07:00", "08:00", "18:00")).toBe(true);
    expect(isTimeOutOfRange("18:15", "08:00", "18:00")).toBe(true);
    expect(isTimeOutOfRange("12:00", "08:00", "18:00")).toBe(false);
    expect(isTimeOutOfRange("12:00")).toBe(false);
  });
});

test.describe("option children", () => {
  test("options, groups, fragments, arrays and conditionals are read in order", () => {
    const show = false;
    const entries = parseOptionChildren([
      h("option", { key: "blank", value: "" }, "Choose…"),
      show ? h("option", { key: "hidden", value: "x" }, "Hidden") : null,
      h(Fragment, { key: "f" }, h("option", { value: "lead" }, "Lead"), [h("option", { key: "q", value: "qualified" }, "Qualified")]),
      h("optgroup", { key: "g", label: "Closed" }, h("option", { value: "won" }, "Won"), h("option", { value: "lost", disabled: true }, "Lost")),
      h("option", { key: "n", value: 7 }, "Seven"),
      h("option", { key: "t" }, "  No  value "),
      "stray text",
      h("span", { key: "s" }, "stray element"),
    ]);
    expect(entries.map((e) => (e.kind === "group" ? `group:${e.label}` : e.value))).toEqual(["", "lead", "qualified", "group:Closed", "7", "No value"]);
    const group = entries[3];
    expect(group.kind === "group" && group.options.map((o) => [o.value, o.disabled])).toEqual([
      ["won", false],
      ["lost", true],
    ]);
    const flat = flattenEntries(entries);
    expect(flat.map((o) => o.value)).toEqual(["", "lead", "qualified", "won", "lost", "7", "No value"]);
    expect(flat[0]).toEqual({ value: "", label: "Choose…", textValue: "Choose…", disabled: false });
    expect(flat.every((o) => !("kind" in o))).toBe(true);
  });

  test("a disabled optgroup disables its options; labels and text are read through elements", () => {
    const [group] = parseOptionChildren(h("optgroup", { label: "Old", disabled: true }, h("option", { value: "a" }, "A")));
    expect(group.kind === "group" && group.options[0].disabled).toBe(true);
    const [labelled] = flattenEntries(parseOptionChildren(h("option", { value: "fr", label: "France" }, "FR")));
    expect(labelled.textValue).toBe("France");
    expect(textOf(["Paris ", 75, h("b", null, " (FR)"), null, false])).toBe("Paris 75 (FR)");
  });

  test("the shown value is the native select's", () => {
    const options = flattenEntries(
      parseOptionChildren([
        h("option", { key: "a", value: "a", disabled: true }, "A"),
        h("option", { key: "b", value: "b" }, "B"),
        h("option", { key: "c", value: "" }, "None"),
      ]),
    );
    expect(resolveSelectValue(options, "b")).toBe("b");
    expect(resolveSelectValue(options, "a")).toBe("a"); // a matching disabled option still shows
    expect(resolveSelectValue(options, "")).toBe("");
    expect(resolveSelectValue(options, "zzz")).toBe("b"); // no match: the first enabled option, as natively
    expect(resolveSelectValue(options, undefined)).toBe("b");
    const noBlank = options.filter((o) => o.value !== "");
    expect(resolveSelectValue(noBlank, "", true)).toBe(""); // a placeholder shows instead
    expect(resolveSelectValue(noBlank, undefined, true)).toBe("");
    expect(resolveSelectValue(noBlank, "zzz", true)).toBe("b");
    expect(resolveSelectValue([], "x")).toBe("");
  });

  test("the change event carries what call sites read", () => {
    const event = pickerChangeEvent("status", "won");
    expect(event.target).toEqual({ name: "status", value: "won" });
    expect(event.currentTarget.value).toBe("won");
    expect(pickerChangeEvent(undefined, "").target).toEqual({ name: "", value: "" });
  });
});

test.describe("combobox search", () => {
  test("accents and case are ignored", () => {
    expect(foldText("  Équateur ")).toBe("equateur");
    expect(foldText("Créteil")).toBe("creteil");
    expect(searchScore("equa", ["Équateur"])).toBe(1);
    expect(searchScore("ÉQUA", ["Equateur"])).toBe(1);
  });

  test("word starts rank above matches inside a word; every typed word must match", () => {
    expect(searchScore("", ["France"])).toBe(1);
    expect(searchScore("fra", ["France"])).toBe(1);
    expect(searchScore("ance", ["France"])).toBe(0.5);
    expect(searchScore("xyz", ["France"])).toBe(0);
    expect(searchScore("new yo", ["America/New_York", "New York"])).toBe(1);
    expect(searchScore("new paris", ["America/New_York"])).toBe(0);
    expect(searchScore("fr", ["Germany", "DE"])).toBe(0);
    expect(searchScore("de", ["Germany", "DE"])).toBe(1); // keywords count (a country code)
    expect(searchScore("côte", ["Côte d’Ivoire", "CI"])).toBe(1);
  });
});
