import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { expect, test } from "@playwright/test";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import { Combobox } from "@/components/ui/combobox";
import { DatePicker, DateRangePicker } from "@/components/ui/date-picker";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import { TimePicker } from "@/components/ui/time-picker";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";

// Server-render smoke test of the app's own pickers (Haider 15 Oct 2026: no native pickers or popups): each one
// renders without a native <select>, date/time input or type="search", submits through a hidden input with the old
// field's name and value shape, and keeps the trigger's id and aria-* for <Label htmlFor>. Interaction is tested in a
// browser at the call sites when they switch over.

function render(node: ReactNode, locale: "en" | "fr" = "en") {
  return renderToStaticMarkup(h(NextIntlClientProvider, { locale, messages: locale === "en" ? en : fr, timeZone: "Europe/Paris", children: node }));
}

// Radix Select renders an inert copy of itself for form autofill: aria-hidden, not focusable, no name, visually hidden,
// never opened. It is the only <select> allowed, and it must stay nameless (our hidden input carries the value).
const RADIX_BUBBLE = /<select aria-hidden="true" tabindex="-1" style="[^"]*">.*?<\/select>/g;

const noNative = (html: string) => {
  for (const bubble of html.match(RADIX_BUBBLE) ?? []) expect(bubble).not.toContain("name=");
  expect(html.replace(RADIX_BUBBLE, "")).not.toMatch(/<select[\s>]/);
  expect(html).not.toMatch(/type="(date|time|datetime-local|month|week|search)"/);
  expect(html).not.toMatch(/\btitle="/);
  expect(html).not.toMatch(/\brequired=""/);
};

test("Select keeps the native API: option children, name, value, id, aria-*", () => {
  const html = render(
    h(
      Select,
      { id: "status", name: "status", value: "qualified", onChange: () => {}, required: true, "aria-invalid": true, "aria-describedby": "hint" },
      h("option", { value: "lead" }, "Lead"),
      h("option", { value: "qualified" }, "Qualified"),
    ),
  );
  noNative(html);
  expect(html).toContain('<input type="hidden" name="status" value="qualified"/>');
  expect(html).toMatch(/<button[^>]*role="combobox"[^>]*id="status"|<button[^>]*id="status"[^>]*role="combobox"/);
  expect(html).toContain('aria-required="true"');
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('aria-describedby="hint"');
  expect(html).toContain("Qualified");
});

test("Select with an empty option and no value shows and submits it, like the native element", () => {
  const html = render(
    h(Select, { name: "country", defaultValue: "" }, h("option", { value: "" }, "Choose a country"), h("option", { value: "FR" }, "France")),
  );
  expect(html).toContain('<input type="hidden" name="country" value=""/>');
  expect(html).toContain("Choose a country");
});

test("Combobox renders a trigger with the chosen label and a hidden input", () => {
  const html = render(
    h(Combobox, {
      id: "zone",
      name: "timezone",
      defaultValue: "Europe/Paris",
      options: [
        { value: "Europe/Paris", label: "Paris" },
        { value: "Europe/London", label: "London" },
      ],
    }),
  );
  noNative(html);
  expect(html).toContain('<input type="hidden" name="timezone" value="Europe/Paris"/>');
  expect(html).toContain("Paris");
  expect(html).toContain('id="zone"');
});

test("DatePicker shows the day in words and submits YYYY-MM-DD; typed mode shows the locale's digits", () => {
  const html = render(h(DatePicker, { id: "due", name: "due", defaultValue: "2026-10-15" }), "fr");
  noNative(html);
  expect(html).toContain('<input type="hidden" name="due" value="2026-10-15"/>');
  expect(html).toContain("2026"); // "jeu. 15 oct. 2026"
  const typed = render(h(DatePicker, { name: "due", defaultValue: "2026-10-15", typed: true }), "fr");
  noNative(typed);
  expect(typed).toContain('value="15/10/2026"');
  const bad = render(h(DatePicker, { name: "due", defaultValue: "2026-02-30" }));
  expect(bad).toContain('<input type="hidden" name="due" value=""/>');
});

test("DateRangePicker submits both ends", () => {
  const html = render(h(DateRangePicker, { fromName: "from", toName: "to", defaultValue: { from: "2026-10-01", to: "2026-10-15" } }));
  noNative(html);
  expect(html).toContain('<input type="hidden" name="from" value="2026-10-01"/>');
  expect(html).toContain('<input type="hidden" name="to" value="2026-10-15"/>');
});

test("TimePicker is a combobox text box: 24-hour in French, 12-hour in English, HH:MM submitted", () => {
  const fr24 = render(h(TimePicker, { name: "at", defaultValue: "21:15" }), "fr");
  noNative(fr24);
  expect(fr24).toContain('role="combobox"');
  expect(fr24).toContain('value="21:15"');
  expect(fr24).toContain('<input type="hidden" name="at" value="21:15"/>');
  const en12 = render(h(TimePicker, { name: "at", defaultValue: "21:15" }), "en");
  expect(en12).toMatch(/value="9:15\s?PM"/i);
  expect(en12).toContain('<input type="hidden" name="at" value="21:15"/>');
});

test("DateTimePicker submits YYYY-MM-DDTHH:MM, or empty while a half is missing", () => {
  const html = render(h(DateTimePicker, { id: "when", name: "when", defaultValue: "2026-10-15T09:30" }), "fr");
  noNative(html);
  expect(html).toContain('<input type="hidden" name="when" value="2026-10-15T09:30"/>');
  expect(html).toContain('id="when"');
  const half = render(h(DateTimePicker, { name: "when", defaultValue: "2026-10-15" }));
  expect(half).toContain('<input type="hidden" name="when" value=""/>');
});

test("SearchInput is a text box with role searchbox, never type=search", () => {
  const html = render(h(SearchInput, { name: "q", defaultValue: "acme", label: "Search leads" }));
  noNative(html);
  expect(html).toContain('type="text"');
  expect(html).toContain('role="searchbox"');
  expect(html).toContain('aria-label="Search leads"');
  expect(html).toContain('aria-label="Clear search"'); // the app's own clear button while there is text
  const empty = render(h(SearchInput, { name: "q" }));
  expect(empty).not.toContain("Clear search");
});

test("Tooltip renders its trigger only until hover or focus (no title attribute)", () => {
  const html = render(h(TooltipProvider, { children: h(Tooltip, { content: "Call (C)", children: h("button", { type: "button", "aria-label": "Call" }, "C") }) }));
  noNative(html);
  expect(html).toContain('aria-label="Call"');
  expect(html).not.toContain("Call (C)");
});
