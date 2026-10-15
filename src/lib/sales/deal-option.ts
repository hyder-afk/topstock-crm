import type { Fulfilment, LeadDealOption } from "@/lib/sales/types";

// The hold and sale sheets' deal picker (Day 6d), on Day 5's deal schema: an open deal's fulfilment is chosen at Win, so
// while it is open (null) it may take a hold and either kind of sale; a deal already set to the other kind is left out.
// The option reads like Day 5's deal chips: the title (or "Deal"), the translated stage, then the value only when the
// deal has one (an unestimated deal is never shown as €0).

/** Deals a hold may name: not set to Supplier Stock (the stock engine refuses those: hint deal_direct). */
export function dealsForHold(deals: LeadDealOption[]): LeadDealOption[] {
  return deals.filter((d) => d.fulfilment !== "direct_from_source");
}

/** Deals a sale of this kind may name; the chosen one stays listed whatever its kind. */
export function dealsForSale(deals: LeadDealOption[], fulfilment: Fulfilment, chosenId: string | null): LeadDealOption[] {
  return deals.filter((d) => d.fulfilment === null || d.fulfilment === fulfilment || d.id === chosenId);
}

type Words = {
  untitled: string;
  stage: (key: NonNullable<LeadDealOption["stage"]>) => string;
  money: (value: number, currency: string) => string;
};

/** "Denim jackets · Negotiations · €4,200.00"; "Deal · Lead" for a deal with no title and no value yet. */
export function dealOptionLabel(d: LeadDealOption, words: Words): string {
  const parts = [d.title ?? words.untitled];
  if (d.stage) parts.push(words.stage(d.stage));
  if (d.value !== null && d.value !== undefined) parts.push(words.money(Number(d.value), d.currency));
  return parts.join(" · ");
}
