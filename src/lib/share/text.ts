import { whatsappHref } from "@/lib/phone";
import type { ShareItem } from "@/lib/share/schema";

// "Send stock list as text" and the link message (design 10.4): a WhatsApp-friendly list built from the same whitelist
// the client page shows (share_preview), up to 30 in-stock items, cut to 3,500 characters, French typography in French.
// Pure; unit-tested (whatsapp-text.spec.ts).

export type ShareLang = "en" | "fr";
const MAX_ITEMS = 30;
const MAX_CHARS = 3500;

/** EUR per piece: 2 to 4 decimals ("2,50 €", "€2.50"). */
export function piecePrice(value: string | number, lang: ShareLang): string {
  return new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-GB", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number(value));
}

export function pieces(n: number, lang: ShareLang): string {
  return new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-GB").format(n);
}

/** The opening words and the closing line around a link (the message template). */
export function linkMessage(link: string, firstName: string | null, lang: ShareLang): string {
  const who = firstName ? `${firstName}, TopStock Wholesale` : "TopStock Wholesale";
  return lang === "fr"
    ? `Bonjour, voici notre stock en direct avec les prix à la pièce : ${link}. Touchez un article pour le demander. ${who}`
    : `Hello, here is our live stock with prices per piece: ${link}. Tap an item to ask for it. ${who}`;
}

/** The stock list as one text: "• Name: 2,50 €/pc · 4 200 pcs" lines, then the link when one was just made. */
export function stockListText(items: ShareItem[], lang: ShareLang, opts: { link?: string | null; firstName?: string | null } = {}): string {
  const fr = lang === "fr";
  const head = fr ? "Notre stock disponible (prix HT à la pièce) :" : "Our stock available now (prices per piece, excl. VAT):";
  const inStock = items.filter((i) => i.warehouse > 0).slice(0, MAX_ITEMS);
  const lines = inStock.map((i) => {
    const price = i.priceMax === null ? (fr ? "prix sur demande" : "price on request") : `${piecePrice(i.priceMax, lang)}/pc`;
    return `• ${i.name}${fr ? " :" : ":"} ${price} · ${pieces(i.warehouse, lang)} pcs`;
  });
  const tail: string[] = [];
  if (items.filter((i) => i.warehouse > 0).length > MAX_ITEMS) tail.push(fr ? "… et d’autres articles." : "… and more items.");
  if (opts.link) tail.push(linkMessage(opts.link, opts.firstName ?? null, lang));
  else if (opts.firstName) tail.push(`${opts.firstName}, TopStock Wholesale`);
  const tailText = tail.length ? `\n\n${tail.join("\n")}` : "";
  let body = [head, ...lines].join("\n");
  const room = MAX_CHARS - tailText.length;
  if (body.length > room) {
    const cut = body.slice(0, Math.max(0, room - 2));
    body = `${cut.slice(0, cut.lastIndexOf("\n") > 0 ? cut.lastIndexOf("\n") : cut.length)}\n…`;
  }
  return `${body}${tailText}`;
}

/** wa.me with the text: the lead's own chat when its number is known, else WhatsApp's "choose a chat". */
export function whatsappTextHref(text: string, phone: string | null, country: string | null): string {
  const chat = whatsappHref(phone, country) ?? "https://wa.me/";
  return `${chat}?text=${encodeURIComponent(text)}`;
}

export function mailtoHref(subject: string, body: string, to?: string | null): string {
  const addr = to && /^[^\s@<>",;]+@[^\s@<>",;]+$/.test(to) ? encodeURIComponent(to) : "";
  return `mailto:${addr}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
