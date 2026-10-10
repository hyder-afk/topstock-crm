import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FOLD_FROM, FOLD_TO, LEGAL_FORM_WORDS, emailKey, nameKey, phoneKey } from "./helpers/dedupe-ref";

// The duplicate keys on both sides of the shared contract (design 2.1 and 3.8). The same table is a literal here and in
// supabase/tests/import_attack.sql (block 0b), which runs it through private.lead_name_key, lead_email_key and
// lead_phone_key; this spec runs it through the TypeScript copy and checks that the SQL literal is the same table, so
// the two sides are proved equal row by row. Same approach as parity.spec.ts: the SQL files are read as text.
const attackSql = readFileSync(join(__dirname, "../../supabase/tests/import_attack.sql"), "utf8");
const migration = readFileSync(join(__dirname, "../../supabase/migrations/20261010150000_lead_import.sql"), "utf8");

type KeyRow = [
  name: string,
  city: string | null,
  country: string | null,
  email: string | null,
  phone: string | null,
  nameKey: string | null,
  emailKey: string | null,
  phoneKey: string | null,
];

// Accents, ligatures (Œ Æ ß ẞ Ĳ), long s and ŉ, letters without a decomposition (Ł Ø Đ Ħ Ŧ ĸ Ŋ), Turkish İ and Ş,
// legal forms (alone, together, dotted, inside words, next to "_"), apostrophes, quotes, NBSP, full-width letters,
// digits and punctuation, the ideographic space, CJK, empty or missing cities, and phone and email edge cases.
const KEY_TABLE: readonly KeyRow[] = [
  ["Café Gamma S.A.R.L.", "Lyon", "FR", " Alpha@Example.COM ", "+33 (0)6 12 34 56 78", "cafegamma|lyon|FR", "alpha@example.com", "612345678"],
  ["CAFE GAMMA SARL", "LYON", "FR", "alpha@example.com", "06.12.34.56.78", "cafegamma|lyon|FR", "alpha@example.com", "612345678"],
  ["Œuvre & Fils", "Saint-Étienne", "FR", "   ", "0033 6 12 34 56 78", "oeuvrefils|saintetienne|FR", null, "612345678"],
  ["ŒUVRE ÆTHER æon", "Århus", "DK", "ÉLODIE@EXEMPLE.FR", "1234567", "oeuvreaetheraeon|arhus|DK", "élodie@exemple.fr", null],
  ["Straße Müller GmbH", "München", "DE", null, "12345678", "strassemuller|munchen|DE", null, "12345678"],
  ["GROẞHANDEL KG", "Köln", "DE", null, "123456789012345", "großhandelkg|koln|DE", null, "789012345"],
  ["ſtore ŉ Co", "Paris", "FR", null, "1234567890123456", "storenco|paris|FR", null, null],
  ["Łódź Trading Sp", "Łódź", "PL", null, "+33 6 12 34 56 78 / +33 6 98 76 54 32", "lodztradingsp|lodz|PL", null, null],
  ["ÀÉÎÕÜ Ÿ Ñ Ç Ø Đ Ħ Ŧ ĸ Ŋ", "Ðorđe", "RS", null, "\uFF10\uFF16 \uFF11\uFF12 \uFF13\uFF14 \uFF15\uFF16 \uFF17\uFF18", "aeiouyncodhtkn|dorde|RS", null, null],
  ["Ĳssel BV", "Zwolle", "NL", null, "\u0660\u0666\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668", "ĳssel|zwolle|NL", null, null],
  ["İstanbul Ltd. Şti.", "İzmir", "TR", null, null, "istanbulsti|izmir|TR", null, null],
  ["SARL", "Paris", "FR", null, null, "sarl|paris|FR", null, null],
  ["S.A.S.", "Nantes", "FR", null, null, "sas|nantes|FR", null, null],
  ["SA SARL", "Lille", "FR", null, null, "sasarl|lille|FR", null, null],
  ["Sasu Sasso SAS", "Nice", "FR", null, null, "sasso|nice|FR", null, null],
  ["Acme_SARL", "Brest", "FR", null, null, "acme|brest|FR", null, null],
  ["Sarlington Limited", "Leeds", "GB", null, null, "sarlington|leeds|GB", null, null],
  ["3M France SAS", "Cergy", "FR", null, null, "3mfrance|cergy|FR", null, null],
  ["Bistrot l’Ami Jean", "Paris", "FR", null, null, "bistrotlamijean|paris|FR", null, null],
  ["Chez l'Ami", "Paris", "FR", null, null, "chezlami|paris|FR", null, null],
  ["Maison\u00A0Verdane\u202FLtd", "Lyon\u00A0", "FR", null, null, "maisonverdane|lyon|FR", null, null],
  ["\uFF34\uFF2F\uFF30 \uFF33\uFF34\uFF2F\uFF23\uFF2B", "\uFF30\uFF41\uFF52\uFF49\uFF53", "FR", "Contact@\uFF25\uFF38\uFF21\uFF2D\uFF30\uFF2C\uFF25.com", null, "\uFF54\uFF4F\uFF50\uFF53\uFF54\uFF4F\uFF43\uFF4B|\uFF50\uFF41\uFF52\uFF49\uFF53|FR", "contact@\uFF45\uFF58\uFF41\uFF4D\uFF50\uFF4C\uFF45.com", null],
  ["\uFF21\uFF22\uFF23\uFF01\uFF06\uFF08\uFF11\uFF12\uFF13\uFF09", "Lyon\u3000Est", "FR", null, null, "\uFF41\uFF42\uFF43\uFF11\uFF12\uFF13|lyonest|FR", null, null],
  ["東京商事", "Tokyo", "JP", null, null, "東京商事|tokyo|JP", null, null],
  ["Dupont, Fils & Cie", "Saint-Denis", "FR", null, null, "dupontfilscie|saintdenis|FR", null, null],
  ["Le \"Petit\" Marché", "Aix-en-Provence", "FR", null, null, "lepetitmarche|aixenprovence|FR", null, null],
  ["Alpha", "", "FR", null, null, null, null, null],
  ["Alpha", " - ", "FR", null, null, null, null, null],
  ["Alpha", null, "FR", null, null, null, null, null],
  ["!!!", "Paris", "FR", null, null, null, null, null],
  ["Delta", "Nantes", null, null, null, "delta|nantes|", null, null],
];

// SQL string literals as the table writes them: 'text' with '' for a quote, U&'text' with \XXXX escapes, or null.
function sqlLiteral(token: string): string | null {
  if (token === "null") return null;
  const unicode = token.startsWith("U&");
  const body = token.slice(unicode ? 3 : 1, -1).replace(/''/g, "'");
  if (!unicode) return body;
  return body.replace(/\\(\\|[0-9A-Fa-f]{4}|\+[0-9A-Fa-f]{6})/g, (_, code: string) =>
    code === "\\" ? "\\" : String.fromCodePoint(parseInt(code.replace("+", ""), 16)),
  );
}

function sqlTable(): (string | null)[][] {
  const start = attackSql.indexOf("-- key-table:start");
  const end = attackSql.indexOf("-- key-table:end");
  expect(start, "key-table markers in import_attack.sql").toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return attackSql
    .slice(start, end)
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      expect(line, "one row per line").toMatch(/^\(.*\),?$/);
      return [...line.matchAll(/U&'(?:[^']|'')*'|'(?:[^']|'')*'|null/g)].map((m) => sqlLiteral(m[0]));
    });
}

test.describe("duplicate keys: TypeScript copy and SQL on one shared table", () => {
  test("the TypeScript copy gives every expected key", () => {
    for (const [name, city, country, email, phone, wantName, wantEmail, wantPhone] of KEY_TABLE) {
      const label = JSON.stringify([name, city, country, email, phone]);
      expect(nameKey(name, city, country), label).toBe(wantName);
      expect(emailKey(email), label).toBe(wantEmail);
      expect(phoneKey(phone), label).toBe(wantPhone);
    }
  });

  test("import_attack.sql runs exactly the same table", () => {
    expect(sqlTable()).toEqual(KEY_TABLE.map((row) => [...row]));
    expect(KEY_TABLE.length).toBeGreaterThanOrEqual(25);
  });

  test("the fold map and the legal forms are the migration's", () => {
    expect(migration).toContain(`fold_from constant text := '${FOLD_FROM}';`);
    expect(migration).toContain(`fold_to constant text := '${FOLD_TO}';`);
    expect([...FOLD_FROM]).toHaveLength([...FOLD_TO].length);
    expect(migration).toContain(`'\\m(${LEGAL_FORM_WORDS.join("|")})\\M'`);
    expect(migration).toContain("punct constant text := '[[:punct:][:space:][:cntrl:]\u00A0-\u00BF\u2000-\u206F]';");
    // The order of the replacements matters: ẞ is not replaced, then lower() makes it ß (not "ss").
    expect(migration).toContain("'Œ', 'oe'), 'œ', 'oe'), 'Æ', 'ae'), 'æ', 'ae'), 'ß', 'ss'));");
    expect(nameKey("ẞ", "x", null)).toBe("ß|x|");
    expect(nameKey("ß", "x", null)).toBe("ss|x|");
  });
});
