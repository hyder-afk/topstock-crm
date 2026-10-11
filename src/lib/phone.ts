// Dialling strings for tel: and wa.me links (Day 4 design 5.2 and 7.1). Phone numbers are stored and shown as written;
// only the link gets an international form, so Haider dialling a French "06…" from Karachi reaches France, not a
// Pakistani number. Own table for the team's markets (EU, UK, US, Canada, North Africa, the Gulf, Pakistan…): no
// libphonenumber (design section 9; E.164 rewriting stays deferred since Day 3b).
//
// Trunk rules per country:
// - "drop": a leading 0 is the trunk prefix and goes ("06 12 34 56 78" in France → +33 6 12 34 56 78);
// - "keep": the 0 is part of the number (Italy, San Marino, Vatican: "02 1234 5678" → +39 02 1234 5678);
// - "none": no trunk prefix, a national number has no leading 0 (Spain "612 345 678" → +34 612 345 678);
// - "nanp": the US and Canada, 10 digits (or 11 starting with 1).
type Trunk = "drop" | "keep" | "none" | "nanp";

const plans: Record<string, [code: string, trunk: Trunk]> = {
  // European Union, the UK and neighbours
  FR: ["33", "drop"], BE: ["32", "drop"], NL: ["31", "drop"], LU: ["352", "none"], DE: ["49", "drop"], AT: ["43", "drop"],
  CH: ["41", "drop"], LI: ["423", "none"], IT: ["39", "keep"], SM: ["378", "keep"], VA: ["39", "keep"], MC: ["377", "none"],
  ES: ["34", "none"], AD: ["376", "none"], PT: ["351", "none"], GB: ["44", "drop"], IE: ["353", "drop"], DK: ["45", "none"],
  SE: ["46", "drop"], NO: ["47", "none"], FI: ["358", "drop"], IS: ["354", "none"], PL: ["48", "none"], CZ: ["420", "none"],
  SK: ["421", "drop"], HU: ["36", "drop"], RO: ["40", "drop"], BG: ["359", "drop"], GR: ["30", "none"], CY: ["357", "none"],
  MT: ["356", "none"], HR: ["385", "drop"], SI: ["386", "drop"], EE: ["372", "none"], LV: ["371", "none"], LT: ["370", "drop"],
  RS: ["381", "drop"], BA: ["387", "drop"], ME: ["382", "drop"], MK: ["389", "drop"], AL: ["355", "drop"], TR: ["90", "drop"],
  UA: ["380", "drop"], MD: ["373", "drop"],
  // French overseas departments and territories
  RE: ["262", "drop"], YT: ["262", "drop"], GP: ["590", "drop"], MQ: ["596", "drop"], GF: ["594", "drop"],
  NC: ["687", "none"], PF: ["689", "none"],
  // North America
  US: ["1", "nanp"], CA: ["1", "nanp"],
  // North and West Africa
  MA: ["212", "drop"], DZ: ["213", "drop"], TN: ["216", "none"], LY: ["218", "drop"], EG: ["20", "drop"], MR: ["222", "none"],
  SN: ["221", "none"], CI: ["225", "none"],
  // The Gulf and the Middle East
  AE: ["971", "drop"], SA: ["966", "drop"], QA: ["974", "none"], KW: ["965", "none"], BH: ["973", "none"], OM: ["968", "none"],
  JO: ["962", "drop"], LB: ["961", "drop"], IL: ["972", "drop"],
  // South and East Asia
  PK: ["92", "drop"], IN: ["91", "drop"], BD: ["880", "drop"], CN: ["86", "drop"], HK: ["852", "none"],
};

/** Countries whose numbers dialString can turn into international form. */
export const DIAL_COUNTRIES = Object.keys(plans);

// E.164 allows at most 15 digits; anything under 8 in all is a short code or a typo, never dialled internationally.
function international(digits: string): string | null {
  return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0") ? `+${digits}` : null;
}

/**
 * The number in international form ("+33612345678"), or null when it cannot be worked out safely (no country, a
 * market not in the table, or a national number in an unexpected shape). Display always stays as written.
 */
export function dialString(phone: string | null | undefined, country: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  // Extensions and anything after them are not part of the number.
  const main = trimmed.split(/\s*(?:ext\.?|x|#|poste)\s*\d*$/i)[0];
  // "+33 (0)6 …": the bracketed trunk 0 is not dialled from abroad.
  const digits = main.replace(/\(0\)/g, "").replace(/\D/g, "");
  if (main.startsWith("+")) return international(digits);
  if (digits.startsWith("00")) return international(digits.slice(2));
  const plan = country ? plans[country] : undefined;
  if (!plan) return null;
  const [code, trunk] = plan;
  if (trunk === "nanp") {
    if (digits.startsWith("011")) return international(digits.slice(3));
    if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
  }
  if (digits.length < 6) return null;
  if (trunk === "drop") return digits.startsWith("0") && !digits.startsWith("00") ? international(code + digits.slice(1)) : null;
  if (trunk === "keep") return international(code + digits);
  return digits.startsWith("0") ? null : international(code + digits);
}

/** The tel: link: the international form when known, otherwise the digits as written (and a leading plus). */
export function callHref(phone: string, country: string | null | undefined): string {
  const dial = dialString(phone, country);
  if (dial) return `tel:${dial}`;
  const trimmed = phone.trim();
  return `tel:${trimmed.startsWith("+") ? "+" : ""}${trimmed.replace(/[^0-9]/g, "")}`;
}

/** The WhatsApp chat link (digits only, no plus), or null when the number has no known country code. */
export function whatsappHref(phone: string | null | undefined, country: string | null | undefined): string | null {
  const dial = dialString(phone, country);
  return dial ? `https://wa.me/${dial.slice(1)}` : null;
}
