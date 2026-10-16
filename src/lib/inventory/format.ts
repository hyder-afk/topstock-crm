// Money and quantity formatting (design 10.7): Intl with the page's locale. Prices per piece show 2 to 4 decimals (a sheet
// may carry 0.1250 €), totals 2. French pieces use the narrow no-break space Intl gives for thousands.

export function pricePerPiece(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

export function moneyTotal(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export function pieces(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/** "1,50 € – 2,50 €", a single price when both ends match, or null when neither is set. */
export function priceRange(locale: string, min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null;
  if (min === null || max === null || min === max) return pricePerPiece(locale, (max ?? min) as number);
  return `${pricePerPiece(locale, min)} – ${pricePerPiece(locale, max)}`;
}
