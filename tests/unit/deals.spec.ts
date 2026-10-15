import { expect, test } from "@playwright/test";
import {
  dealIdInput,
  loseInput,
  moveInput,
  openDealInput,
  reopenInput,
  stageParams,
  undoInput,
  updateDealInput,
  winInput,
} from "@/lib/deals";
import { addMoney, formatMoney, fromCents, isMoney, moneyInputText, parseMoney, subMoney, toCents } from "@/lib/money";
import { logActivityInput } from "@/lib/activities";

// Day 5 design 8.4: every deal action input is a strict object (nothing unknown passes), money is a decimal string
// with at most two decimals up to 100,000,000, and parseMoney reads what people type in English and French.
const id = "00000000-0000-4000-8000-000000000001";
const req = "00000000-0000-4000-8000-000000000002";

test("every action input refuses an unknown key (strictObject: no mass assignment)", () => {
  const cases: [{ safeParse: (v: unknown) => { success: boolean } }, Record<string, unknown>][] = [
    [openDealInput, { leadId: id, title: null, value: null, expectedClose: null, fulfilment: null, contactId: null, ownerId: null, requestId: req }],
    [moveInput, { id, stage: "qualified", version: 0, requestId: req }],
    [winInput, { id, version: 1, value: "18400", fulfilment: "from_stock", requestId: req }],
    [loseInput, { id, version: 1, reason: "price", note: null, requestId: req }],
    [reopenInput, { id, stage: "negotiations", version: 2, requestId: req }],
    [undoInput, { id, historyId: 12, toStage: "lead", version: 1, requestId: req }],
    [updateDealInput, { id, version: 0, fields: ["title"], title: "Denim" }],
    [dealIdInput, { id }],
  ];
  for (const [schema, good] of cases) {
    expect(schema.safeParse(good).success, JSON.stringify(good)).toBe(true);
    expect(schema.safeParse({ ...good, status: "won" }).success).toBe(false);
    expect(schema.safeParse({ ...good, created_by: id }).success).toBe(false);
  }
});

test("moves name an open stage only; won and lost have their own inputs", () => {
  for (const stage of ["won", "lost", "closed", ""]) expect(moveInput.safeParse({ id, stage, version: 0, requestId: req }).success).toBe(false);
  expect(moveInput.safeParse({ id, stage: "lead", version: -1, requestId: req }).success).toBe(false);
  expect(moveInput.safeParse({ id, stage: "lead", version: 1.5, requestId: req }).success).toBe(false);
  expect(winInput.safeParse({ id, version: 1, value: "18400", fulfilment: "warehouse", requestId: req }).success).toBe(false);
});

test("Lose: Other needs a note; notes refuse control and bidi characters and more than 500 characters", () => {
  const base = { id, version: 1, requestId: req };
  expect(loseInput.safeParse({ ...base, reason: "other", note: null }).success).toBe(false);
  expect(loseInput.safeParse({ ...base, reason: "other", note: "Went quiet" }).success).toBe(true);
  expect(loseInput.safeParse({ ...base, reason: "price", note: "x".repeat(501) }).success).toBe(false);
  expect(loseInput.safeParse({ ...base, reason: "price", note: `a${String.fromCharCode(0x202e)}b` }).success).toBe(false);
  expect(loseInput.safeParse({ ...base, reason: "price", note: "line one\nline two" }).success).toBe(true);
  expect(loseInput.safeParse({ ...base, reason: "unknown", note: null }).success).toBe(false);
});

test("titles: 120 characters at most, no control or bidi characters", () => {
  const base = { leadId: id, value: null, expectedClose: null, fulfilment: null, contactId: null, ownerId: null, requestId: req };
  expect(openDealInput.safeParse({ ...base, title: "é".repeat(120) }).success).toBe(true);
  expect(openDealInput.safeParse({ ...base, title: "é".repeat(121) }).success).toBe(false);
  expect(openDealInput.safeParse({ ...base, title: `Denim${String.fromCharCode(0x2066)}` }).success).toBe(false);
  expect(openDealInput.safeParse({ ...base, title: "Denim\tjackets" }).success).toBe(false);
});

test("update names fields from the list, once each", () => {
  expect(updateDealInput.safeParse({ id, version: 0, fields: ["status"] }).success).toBe(false);
  expect(updateDealInput.safeParse({ id, version: 0, fields: [] }).success).toBe(false);
  expect(updateDealInput.safeParse({ id, version: 0, fields: ["value", "value"], value: "1" }).success).toBe(false);
  expect(updateDealInput.safeParse({ id, version: 0, fields: ["value", "owner_id"], value: "1", ownerId: id }).success).toBe(true);
});

test("the money wire format: accepted and refused (design 8.4)", () => {
  for (const ok of ["0", "12400.5", "12400.50", "100000000", "0.01"]) expect(isMoney(ok), ok).toBe(true);
  for (const bad of ["1e3", "-1", "12.345", "NaN", "Infinity", "100000000.01", "1000000000", "", " 1", "1,5", ".5"]) {
    expect(isMoney(bad), bad).toBe(false);
  }
  expect(winInput.safeParse({ id, version: 1, value: "12.345", fulfilment: "from_stock", requestId: req }).success).toBe(false);
});

test("parseMoney reads English and French, with every kind of thousands space", () => {
  const nbsp = String.fromCharCode(0xa0);
  const nnbsp = String.fromCharCode(0x202f);
  expect(parseMoney("12,400.50", "en")).toBe("12400.50");
  expect(parseMoney("12400.5", "en")).toBe("12400.50");
  expect(parseMoney("€12,400", "en")).toBe("12400");
  expect(parseMoney(`12${nbsp}400,50`, "fr")).toBe("12400.50");
  expect(parseMoney(`12${nnbsp}400,50 €`, "fr")).toBe("12400.50");
  expect(parseMoney("12 400,5", "fr")).toBe("12400.50");
  expect(parseMoney("12400.50", "fr")).toBe("12400.50");
  expect(parseMoney("007", "en")).toBe("7");
  expect(parseMoney("100 000 000", "fr")).toBe("100000000");
});

test("parseMoney refuses what it cannot read for sure", () => {
  for (const [input, locale] of [
    ["1,234.5", "fr"], // both separators in French
    ["1.234", "fr"], // a thousands point or three decimals?
    ["12,40", "en"], // misplaced English comma
    ["12.345", "en"],
    ["-5", "en"],
    ["1e3", "en"],
    ["100000000,01", "fr"],
    ["abc", "en"],
    ["", "fr"],
  ]) {
    expect(parseMoney(input, locale), `${input} (${locale})`).toBeNull();
  }
});

test("sums in cents never drift; display follows the locale", () => {
  expect(toCents("12400.5")).toBe(BigInt(1240050));
  expect(fromCents(BigInt(5))).toBe("0.05");
  expect(addMoney("0.10", "0.20")).toBe("0.30");
  expect(subMoney("48200.00", null)).toBe("48200.00");
  expect(subMoney("100.00", "100.01")).toBe("-0.01");
  expect(formatMoney("12400", "en")).toBe("€12,400");
  expect(formatMoney("12400", "fr").replace(/\s/g, " ")).toBe("12 400 €");
  expect(formatMoney("12400.5", "en", { cents: true })).toBe("€12,400.50");
  expect(parseMoney(moneyInputText("12400.5", "fr"), "fr")).toBe("12400.50");
  expect(parseMoney(moneyInputText("12400.5", "en"), "en")).toBe("12400.50");
});

test("the stage route's cursor needs both parts; unknown parameters are refused", () => {
  expect(stageParams.safeParse({ stage: "lead" }).success).toBe(true);
  expect(stageParams.safeParse({ stage: "lead", after_at: "2026-10-12T09:00:00Z" }).success).toBe(false);
  expect(stageParams.safeParse({ stage: "lead", after_at: "2026-10-12T09:00:00Z", after_id: id }).success).toBe(true);
  expect(stageParams.safeParse({ stage: "lead", order: "value" }).success).toBe(false);
  expect(stageParams.safeParse({ stage: "lead", scope: "everyone" }).success).toBe(false);
  expect(stageParams.safeParse({ stage: "lead", select: "*" }).success).toBe(false);
});

test("a logged call may open a deal only from Interested or Book meeting, and not with a linked deal", () => {
  const call = {
    leadId: id, type: "call", outcome: "interested", body: "", contactId: null, dialled: null,
    followUpDate: "2026-10-13", followUpAt: null, leadName: "Maison Verdane", requestId: req,
  };
  expect(logActivityInput.safeParse({ ...call, openDeal: { title: "Denim", value: "6800" } }).success).toBe(true);
  expect(logActivityInput.safeParse({ ...call, openDeal: { title: null, value: "6,800" } }).success).toBe(false);
  expect(logActivityInput.safeParse({ ...call, openDeal: { title: null, value: null }, dealId: id }).success).toBe(false);
  expect(logActivityInput.safeParse({ ...call, outcome: "no_answer", followUpDate: null, openDeal: { title: null, value: null } }).success).toBe(false);
  expect(logActivityInput.safeParse({ ...call, openDeal: { title: null, value: null, owner: id } }).success).toBe(false);
  expect(logActivityInput.safeParse({ ...call, dealId: id }).success).toBe(true);
});
