import { expect, test } from "@playwright/test";
import { STOCK_STATUS_ALIASES, distinctStatuses, suggestLocation } from "@/lib/stock-import";

// STATUS values (design 7.3).
test("every STATUS alias in EN and FR, any case or accents", () => {
  for (const [alias, kind] of STOCK_STATUS_ALIASES) {
    expect(suggestLocation(alias)).toBe(kind);
    expect(suggestLocation(alias.toUpperCase())).toBe(kind);
  }
  expect(suggestLocation("Entrepôt")).toBe("warehouse");
  expect(suggestLocation("In warehouse ")).toBe("warehouse");
  expect(suggestLocation("EN TRANSIT")).toBe("transit");
  expect(suggestLocation("Expédié")).toBe("transit");
  expect(suggestLocation("Arrivé")).toBe("warehouse");
});

test("unknown values must be chosen; blanks use the default", () => {
  expect(suggestLocation("Port du Havre")).toBeNull();
  expect(suggestLocation("")).toBeNull();
  const { values, blanks } = distinctStatuses(["In Warehouse", "in warehouse", "", "Port du Havre", "  ", "EN TRANSIT"]);
  expect(blanks).toBe(2);
  expect(values.map((v) => [v.key, v.count, v.suggested])).toEqual([
    ["in warehouse", 2, "warehouse"],
    ["en transit", 1, "transit"],
    ["port du havre", 1, null],
  ]);
  expect(values[0].label).toBe("In Warehouse");
});
