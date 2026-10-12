// Money as decimal strings end to end (Day 5 design D10): never a float on the way to the database. A deal's value is
// euros with at most 2 decimals, from 0 to 100,000,000 (deals_value_bounds and private.deal_value_ok). Sums are made in
// cents with BigInt so a column total never drifts.

/** The largest value a deal may hold (deals_value_bounds), as the database writes it. */
export const DEAL_VALUE_MAX = "100000000";
/** The wire format every deal action takes: digits, an optional point and one or two decimals. */
export const MONEY_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;

/** True when `s` is a value the database takes (the pattern and the 100,000,000 cap). */
export function isMoney(s: string): boolean {
  return MONEY_PATTERN.test(s) && toCents(s) <= toCents(DEAL_VALUE_MAX);
}

// BigInt literals need ES2020 (tsconfig targets ES2017): the two constants instead.
const HUNDRED = BigInt(100);
const ZERO = BigInt(0);

// Spaces people (and Intl) put between thousands: the ordinary space, no-break space U+00A0, narrow no-break space
// U+202F (what Intl's fr-FR writes), thin space U+2009. Written as escapes: no invisible character in the source.
const GROUP_SPACES = /[    ]/g;

/**
 * What a person typed in a value field, as the wire format, or null when it is not a value (or is ambiguous). English
 * takes "12,400.50", "12400.5" and "12400"; French takes "12 400,50" (any of the spaces above), "12400,5" and "12400.50"
 * (a point with 1 or 2 decimals). A euro sign is ignored. Refused: both separators in French ("1,234.5"), a point before
 * three digits in French ("1.234": a thousands point or a decimal?), misplaced English commas ("12,40"), more than two
 * decimals, signs, exponents, and anything above 100,000,000.
 */
export function parseMoney(input: string, locale: string): string | null {
  const s = input.replace(/€/g, "").replace(GROUP_SPACES, "").trim();
  if (!s) return null;
  const fr = locale.toLowerCase().startsWith("fr");
  let intPart: string;
  let frac = "";
  if (fr) {
    if (s.includes(",") && s.includes(".")) return null;
    const m = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(s);
    if (!m) return null;
    intPart = m[1];
    frac = m[2] ?? "";
  } else {
    const grouped = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(s);
    const plain = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
    const m = grouped ?? plain;
    if (!m) return null;
    intPart = m[1].replace(/,/g, "");
    frac = m[2] ?? "";
  }
  intPart = intPart.replace(/^0+(?=\d)/, "");
  if (intPart.length > 9) return null;
  const out = frac ? `${intPart}.${frac.padEnd(2, "0")}` : intPart;
  return isMoney(out) ? out : null;
}

/** "12400.5" → 1240050 (cents). Assumes the wire format (or a database numeric text, which may have more digits). */
export function toCents(s: string): bigint {
  const neg = s.startsWith("-");
  const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
  const cents = BigInt(i || "0") * HUNDRED + BigInt((f + "00").slice(0, 2));
  return neg ? -cents : cents;
}

/** 1240050 (cents) → "12400.50" (always two decimals, as the database's numeric(16,2) text). */
export function fromCents(c: bigint): string {
  const neg = c < ZERO;
  const a = neg ? -c : c;
  const s = `${a / HUNDRED}.${String(a % HUNDRED).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

/** a + b on decimal strings (null counts as 0). */
export function addMoney(a: string | null, b: string | null): string {
  return fromCents(toCents(a ?? "0") + toCents(b ?? "0"));
}

/** a - b on decimal strings (null counts as 0). */
export function subMoney(a: string | null, b: string | null): string {
  return fromCents(toCents(a ?? "0") - toCents(b ?? "0"));
}

/**
 * A value for display: euros through Intl ("12 400 €" in French, "€12,400" in English). Cards and totals drop the cents
 * (design 7.2); `cents: true` keeps them when there are any (the deal sheet, the Win dialog).
 */
export function formatMoney(value: string, locale: string, opts: { cents?: boolean } = {}): string {
  const n = Number(value);
  const hasCents = toCents(value) % HUNDRED !== ZERO;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: opts.cents && hasCents ? 2 : 0,
    maximumFractionDigits: opts.cents && hasCents ? 2 : 0,
  }).format(n);
}

/** A stored value as a person edits it in their language ("12400,5" → "12 400,50" in French; "12,400.50" in English). */
export function moneyInputText(value: string | null, locale: string): string {
  if (value === null) return "";
  const hasCents = toCents(value) % HUNDRED !== ZERO;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
    useGrouping: true,
  }).format(Number(value));
}
