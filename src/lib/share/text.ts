import { createTranslator } from "next-intl";
import { whatsappHref } from "@/lib/phone";
import type { ShareItem } from "@/lib/share/schema";

// "Send stock list as text" and the link message (design 10.4): a WhatsApp-friendly list built from the same whitelist
// the client page shows (share_preview), up to 30 in-stock items, cut to 3,500 characters. The words come from the
// ShareText messages of the link's language (French typography there); prices and counts use Intl. Pure; unit-tested.

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

export type ShareTextKey = "message" | "signature" | "company" | "emailSubject" | "listHead" | "line" | "perPiece" | "priceOnRequest" | "more";
/** The client-facing words in the link's language (messages/{en,fr}.json › ShareText), not the teammate's. */
export type ShareText = { lang: ShareLang; t: (key: ShareTextKey, values?: Record<string, string>) => string };

export function shareText(lang: ShareLang, messages: Record<string, unknown>): ShareText {
  const translate = createTranslator({ locale: lang, messages: { ShareText: messages }, namespace: "ShareText" });
  return { lang, t: (key, values) => (translate as unknown as (k: string, v?: Record<string, string>) => string)(key, values) };
}

const signature = (firstName: string | null, text: ShareText) => (firstName ? text.t("signature", { firstName }) : text.t("company"));

/** The opening words, the link on a line of its own (no punctuation a chat app could glue to it), the closing line. */
export function linkMessage(link: string, firstName: string | null, text: ShareText): string {
  return text.t("message", { link, who: signature(firstName, text) });
}

/** The stock list as one text: "• Name: 2,50 €/pc · 4 200 pcs" lines, then the link when one was just made. */
export function stockListText(items: ShareItem[], text: ShareText, opts: { link?: string | null; firstName?: string | null } = {}): string {
  const { lang, t } = text;
  const inStock = items.filter((i) => i.warehouse > 0).slice(0, MAX_ITEMS);
  const lines = inStock.map((i) => {
    const price = i.priceMax === null ? t("priceOnRequest") : t("perPiece", { price: piecePrice(i.priceMax, lang) });
    return t("line", { name: i.name, price, pieces: pieces(i.warehouse, lang) });
  });
  const tail: string[] = [];
  if (items.filter((i) => i.warehouse > 0).length > MAX_ITEMS) tail.push(t("more"));
  if (opts.link) tail.push(linkMessage(opts.link, opts.firstName ?? null, text));
  else if (opts.firstName) tail.push(signature(opts.firstName, text));
  const tailText = tail.length ? `\n\n${tail.join("\n")}` : "";
  let body = [t("listHead"), ...lines].join("\n");
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
