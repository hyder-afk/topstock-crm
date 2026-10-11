import { expect, test } from "@playwright/test";
import { mailHref, mailtoHref } from "@/lib/leads";
import { DIAL_COUNTRIES, callHref, dialString, whatsappHref } from "@/lib/phone";

// dialString (Day 4 design 5.2, 7.1 and threat 33): tel: and wa.me links get the international form so a call from
// Karachi to a French "06…" reaches France; anything uncertain stays null (Call then uses the digits as written and
// WhatsApp shows a hint). Display is never rewritten.
test.describe("dial_*", () => {
  const cases: [string, string | null, string | null][] = [
    // [as written, country, expected]
    ["06 12 34 56 78", "FR", "+33612345678"],
    ["07700 900123", "GB", "+447700900123"],
    ["02 1234 5678", "IT", "+390212345678"],
    ["347 123 4567", "IT", "+393471234567"],
    ["(212) 555-0149", "US", "+12125550149"],
    ["1 (212) 555-0149", "US", "+12125550149"],
    ["416-555-0199", "CA", "+14165550199"],
    ["011 33 6 12 34 56 78", "US", "+33612345678"],
    ["+33 6 12 34 56 78", null, "+33612345678"],
    ["+33 (0)6 12 34 56 78", "FR", "+33612345678"],
    ["0033 6 12 34 56 78", "BE", "+33612345678"],
    ["00 44 7700 900123", null, "+447700900123"],
    ["612 345 678", "ES", "+34612345678"],
    ["0612 345 678", "ES", null],
    ["06 61 23 45 67", "MA", "+212661234567"],
    ["0300 1234567", "PK", "+923001234567"],
    ["050 123 4567", "AE", "+971501234567"],
    ["0470 12 34 56", "BE", "+32470123456"],
    ["0151 23456789", "DE", "+4915123456789"],
    ["12345", "FR", null],
    ["06 12", "FR", null],
    ["612345678", "FR", null],
    ["06 12 34 56 78", null, null],
    ["06 12 34 56 78", "ZZ", null],
    ["+1 234", null, null],
    ["+33 6 12 34 56 78 90 12 34", null, null],
    ["", "FR", null],
    ["06 12 34 56 78 ext. 12", "FR", "+33612345678"],
  ];
  for (const [phone, country, expected] of cases) {
    test(`${phone} (${country ?? "no country"}) → ${expected ?? "null"}`, () => {
      expect(dialString(phone, country)).toBe(expected);
    });
  }

  test("the table covers the team's markets", () => {
    expect(DIAL_COUNTRIES.length).toBeGreaterThanOrEqual(60);
    for (const c of ["FR", "BE", "GB", "DE", "ES", "IT", "US", "CA", "MA", "DZ", "TN", "AE", "SA", "QA", "PK"]) expect(DIAL_COUNTRIES).toContain(c);
  });

  test("tel: links: the international form, else the digits as written (never letters or spaces)", () => {
    expect(callHref("06 12 34 56 78", "FR")).toBe("tel:+33612345678");
    expect(callHref("06 12 34 56 78", null)).toBe("tel:0612345678");
    expect(callHref(" +1 (212) 555-0149 ", "US")).toBe("tel:+12125550149");
    expect(callHref("06 12;javascript:alert(1)", null)).toBe("tel:06121");
  });
});

test.describe("whatsapp_*", () => {
  test("wa.me takes the international digits without the plus", () => {
    expect(whatsappHref("06 12 34 56 78", "FR")).toBe("https://wa.me/33612345678");
    expect(whatsappHref("+44 7700 900123", null)).toBe("https://wa.me/447700900123");
  });
  test("no country code: no link (the button reads 'Add the country code')", () => {
    expect(whatsappHref("06 12 34 56 78", null)).toBeNull();
    expect(whatsappHref(null, "FR")).toBeNull();
  });
});

test.describe("mailto", () => {
  test("subject and body with ? & CRLF and emoji are encoded; nothing starts another field", () => {
    const href = mailtoHref("ines@example.com", "Prix & stock? 😀", "Bonjour,\r\nVoici le tarif & la liste?\n#1");
    expect(href).toBe(
      "mailto:ines@example.com?subject=" +
        encodeURIComponent("Prix & stock? 😀") +
        "&body=" +
        encodeURIComponent("Bonjour,\r\nVoici le tarif & la liste?\r\n#1"),
    );
    const query = href.slice(href.indexOf("?") + 1);
    expect(query.split("&").map((p) => p.split("=")[0])).toEqual(["subject", "body"]);
  });

  test("mailto_crlf_blocked: a line break in the subject cannot add a header", () => {
    const href = mailtoHref("a@example.com", "Hi\r\nBcc: spy@example.com", "");
    expect(href).toBe(`mailto:a@example.com?subject=${encodeURIComponent("Hi Bcc: spy@example.com")}`);
    expect(decodeURIComponent(href)).not.toMatch(/[\r\n]/);
  });

  test("the address cannot add recipients or fields; the body is cut at 1,500 characters", () => {
    expect(mailtoHref("sales?cc=x&co@example.test", "", "")).toBe(mailHref("sales?cc=x&co@example.test"));
    expect(mailHref("sales?cc=x&co@example.test")).toBe("mailto:sales%3Fcc%3Dx%26co@example.test");
    const long = mailtoHref("a@example.com", "", "é".repeat(2000));
    expect(decodeURIComponent(long.split("body=")[1])).toHaveLength(1500);
  });
});
