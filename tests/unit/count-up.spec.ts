import { expect, test } from "@playwright/test";
import { formatMoney } from "@/lib/money";

// Count-up (Day 5 design 7.11): every frame's text fits in the width the final value reserves (DM Mono: each character
// is as wide, so fewer or as many characters never shift the layout), in English and French, from €0 to €99,999,999;
// counts too. Frames are the values between 0 and the target, rounded, as the component writes them.
const frames = (target: number, n = 60) => Array.from({ length: n + 1 }, (_, i) => Math.round((target * i) / n));

for (const locale of ["en", "fr"]) {
  test(`money frames never outgrow the final value (${locale})`, () => {
    for (const target of [0, 7, 950, 48_200, 182_400, 1_000_000, 12_345_678, 99_999_999]) {
      const final = formatMoney(String(target), locale);
      for (const v of frames(target)) {
        expect(Array.from(formatMoney(String(v), locale)).length, `${v} of ${target}`).toBeLessThanOrEqual(Array.from(final).length);
      }
    }
  });
  test(`count frames never outgrow the final value (${locale})`, () => {
    const nf = new Intl.NumberFormat(locale);
    for (const target of [0, 9, 23, 450, 1030, 30_000]) {
      const final = nf.format(target);
      for (const v of frames(target)) expect(nf.format(v).length).toBeLessThanOrEqual(final.length);
    }
  });
}

test("French money keeps Intl's narrow no-break spaces (one character each)", () => {
  expect(formatMoney("182400", "fr")).toBe("182 400 €");
  expect(formatMoney("182400", "en")).toBe("€182,400");
});
