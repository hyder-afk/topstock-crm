"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useFormatter, useLocale, useMessages, useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Mail, MessageCircle } from "lucide-react";
import { createShareLink, extendShareLink, revokeShareLink } from "@/app/(app)/inventory/share/actions";
import { runWithStepUp, useStockErrorText, type StepUp } from "@/components/inventory/stock-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import type { ShareItem } from "@/lib/share/schema";
import { defaultLinkLanguage, type MadeLink, type ShareLinkList, type ShareLinkRow } from "@/lib/share/team";
import { linkMessage, mailtoHref, shareText, stockListText, whatsappTextHref, type ShareLang, type ShareText } from "@/lib/share/text";
import { cn } from "@/lib/utils";

// The lead's client link card (design 10.4 and 8.3), first on the Stock tab. No link yet: Share on WhatsApp (neutral)
// and Copy link, with the options (language, how long, a label, arriving stock, requests). Making a link asks for a
// fresh code once; the address is shown only in this page view (only its hash is kept), then the active links with
// their opens and requests, Revoke (no code), Replace and Extend (a code). Plus "Send stock list as text".

export type ShareLead = { id: string; name: string; country: string | null; phone: string | null; email: string | null };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}
export const shareLinksKey = (company: string) => ["share-links", company] as const;
export function useShareLinks(company: string | null) {
  return useQuery({
    queryKey: shareLinksKey(company ?? "all"),
    queryFn: () => getJson<ShareLinkList>(company ? `/api/inventory/share-links?company=${company}` : "/api/inventory/share-links?all=1"),
    staleTime: 15_000,
  });
}

const EXPIRY = [30, 90, 365] as const;

/** The client-facing words in a link's language (request config: ShareTextByLanguage), else the interface's. */
function useShareText(lang: ShareLang): ShareText {
  const messages = useMessages() as Record<string, unknown>;
  return useMemo(() => {
    const byLanguage = messages.ShareTextByLanguage as Partial<Record<ShareLang, Record<string, unknown>>> | undefined;
    return shareText(lang, byLanguage?.[lang] ?? (messages.ShareText as Record<string, unknown> | undefined) ?? {});
  }, [lang, messages]);
}

export function ShareLinkCard({ lead, canEdit, ownerFirstName, me, stepUp }: { lead: ShareLead; canEdit: boolean; ownerFirstName: string | null; me: string | null; stepUp: StepUp }) {
  const t = useTranslations("ShareLinks");
  const format = useFormatter();
  const uiLocale = useLocale();
  const errorText = useStockErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const id = useId();
  const query = useShareLinks(lead.id);
  const [language, setLanguage] = useState<"en" | "fr">(() => defaultLinkLanguage(lead.country, uiLocale));
  const [days, setDays] = useState<(typeof EXPIRY)[number]>(90);
  const [label, setLabel] = useState("");
  const [showInTransit, setShowInTransit] = useState(true);
  const [allowRequests, setAllowRequests] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [made, setMade] = useState<MadeLink | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [textOpen, setTextOpen] = useState(false);
  const linkInput = useRef<HTMLInputElement>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["share-links"] });
  // A made link's message is in that link's language, also when the picker changed since.
  const wordsFor = { en: useShareText("en"), fr: useShareText("fr") };
  const message = (link: MadeLink) => linkMessage(link.url, me, wordsFor[link.language]);

  const make = async (then: "whatsapp" | "copy" | "none", replace = false) => {
    if (busy) return;
    setBusy(then === "none" ? "replace" : then);
    setFailure(null);
    // Opened in the click itself (a window opened after the await would be blocked); filled once the link exists.
    const win = then === "whatsapp" ? window.open("about:blank", "_blank") : null;
    const res = await runWithStepUp(stepUp, () =>
      createShareLink({ companyId: lead.id, language, label: label.trim() || null, days, showInTransit, allowRequests, replace }),
    );
    setBusy(null);
    if (!res) {
      win?.close();
      return;
    }
    if (!res.ok) {
      win?.close();
      setFailure(errorText(res));
      return;
    }
    setMade(res.data);
    refresh();
    if (win) {
      win.opener = null;
      win.location.href = whatsappTextHref(message(res.data), lead.phone, lead.country);
    }
    if (then === "copy") await copy(res.data.url);
    else toast.show(t("made"));
    requestAnimationFrame(() => linkInput.current?.select());
  };
  const copy = async (text: string, done = t("copied")) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show(done);
    } catch {
      linkInput.current?.select();
      toast.show(t("copyFailed"));
    }
  };
  const revoke = async (row: ShareLinkRow) => {
    if (busy) return;
    setBusy(row.id);
    const res = await revokeShareLink(row.id).catch(() => null);
    setBusy(null);
    refresh();
    toast.show(res?.ok ? t("revoked") : errorText(res ?? { ok: false, error: "unavailable" }));
  };
  const extend = async (row: ShareLinkRow) => {
    if (busy) return;
    setBusy(row.id);
    const res = await runWithStepUp(stepUp, () => extendShareLink({ id: row.id, days: 90 }));
    setBusy(null);
    if (!res) return;
    refresh();
    toast.show(res.ok ? t("extended", { date: format.dateTime(new Date(res.data.expires_at), { day: "numeric", month: "short", year: "numeric" }) }) : errorText(res));
  };

  const links = query.data?.links ?? [];
  const dateText = (iso: string) => format.dateTime(new Date(iso), { day: "numeric", month: "short" });

  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-3 rounded-lg bg-card p-4 sm:p-5">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-lg font-bold">
          {t("title")}
        </h2>
        <p className="max-w-[65ch] text-sm text-muted-foreground">{canEdit ? t("intro") : t("readOnly", { owner: ownerFirstName ?? "—" })}</p>
      </div>
      {query.data && !query.data.sharing_enabled ? (
        <p className="flex items-start gap-2 rounded-md bg-muted p-3 text-sm" role="note">
          <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-amber" />
          {t("sharingOff")}
        </p>
      ) : null}

      {canEdit ? (
        <>
          <Disclosure className="rounded-md border border-border" summaryClassName="px-3" summary={t("options")}>
            <div className="grid gap-3 border-t border-border p-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1 text-sm font-bold">
                <Label htmlFor={`${id}-language`}>{t("language")}</Label>
                <Select
                  id={`${id}-language`}
                  name="language"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value === "fr" ? "fr" : "en")}
                  className="font-normal"
                >
                  <option value="fr">Français</option>
                  <option value="en">English</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1 text-sm font-bold">
                <Label htmlFor={`${id}-expiry`}>{t("expiry")}</Label>
                <Select
                  id={`${id}-expiry`}
                  name="expiry"
                  value={String(days)}
                  onChange={(e) => setDays(Number(e.target.value) as (typeof EXPIRY)[number])}
                  className="font-normal"
                >
                  {EXPIRY.map((d) => (
                    <option key={d} value={d}>
                      {t("days", { count: d })}
                    </option>
                  ))}
                </Select>
              </div>
              <label className="flex flex-col gap-1 text-sm font-bold sm:col-span-2">
                {t("label")}
                <input
                  name="label"
                  value={label}
                  maxLength={80}
                  autoComplete="off"
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t("labelPlaceholder")}
                  className="min-h-11 rounded-md border border-border bg-background px-3 font-normal"
                />
              </label>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input type="checkbox" name="show_in_transit" checked={showInTransit} onChange={(e) => setShowInTransit(e.target.checked)} className="size-5" />
                {t("showArriving")}
              </label>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input type="checkbox" name="allow_requests" checked={allowRequests} onChange={(e) => setAllowRequests(e.target.checked)} className="size-5" />
                {t("allowRequests")}
              </label>
            </div>
          </Disclosure>

          {made ? (
            <div className="flex flex-col gap-2 rounded-md bg-muted p-3">
              <label htmlFor={`${id}-url`} className="text-sm font-bold">
                {t("linkLabel")}
              </label>
              <input
                id={`${id}-url`}
                ref={linkInput}
                readOnly
                value={made.url}
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
                className="min-h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">{t("made")}</p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={whatsappTextHref(message(made), lead.phone, lead.country)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-4 font-bold text-primary-foreground"
                >
                  <MessageCircle aria-hidden="true" strokeWidth={1.75} className="size-4" />
                  {t("shareWhatsapp")}
                </a>
                <Button variant="quiet" onClick={() => void copy(made.url)}>
                  <Copy aria-hidden="true" strokeWidth={1.75} className="size-4" />
                  {t("copyAgain")}
                </Button>
                <a
                  href={mailtoHref(wordsFor[made.language].t("emailSubject"), message(made), lead.email)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-md bg-muted px-4 font-bold text-foreground"
                >
                  <Mail aria-hidden="true" strokeWidth={1.75} className="size-4" />
                  {t("email")}
                </a>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="neutral" onClick={() => void make("whatsapp")} aria-disabled={!!busy || undefined}>
                <MessageCircle aria-hidden="true" strokeWidth={1.75} className="size-4" />
                {busy === "whatsapp" ? t("creating") : t("shareWhatsapp")}
              </Button>
              <Button variant="quiet" onClick={() => void make("copy")} aria-disabled={!!busy || undefined}>
                <Copy aria-hidden="true" strokeWidth={1.75} className="size-4" />
                {busy === "copy" ? t("creating") : t("copyLink")}
              </Button>
            </div>
          )}
          {failure ? (
            <p role="alert" className="text-sm">
              {failure}
            </p>
          ) : null}
        </>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-bold">{t("active")}</h3>
        {query.isPending ? (
          <div className="h-14 rounded-md bg-muted motion-safe:animate-pulse" aria-hidden="true" />
        ) : query.isError ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {t("loadError")}
            <Button variant="link" onClick={() => void query.refetch()}>
              {t("retry")}
            </Button>
          </div>
        ) : links.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("none")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {links.map((l) => (
              <li key={l.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col gap-0.5 text-sm">
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    {l.label ? (
                      <span className="font-bold" dir="auto">
                        {l.label}
                      </span>
                    ) : null}
                    <span>{l.created_by_first_name ? t("row", { name: l.created_by_first_name, date: dateText(l.created_at) }) : t("rowNoName", { date: dateText(l.created_at) })}</span>
                    <span className="font-mono text-xs text-muted-foreground">{t("hint", { hint: l.token_hint })}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {[
                      l.last_opened_at ? t("opened", { when: format.relativeTime(new Date(l.last_opened_at)) }) : t("neverOpened"),
                      t("opens", { count: l.open_count }),
                      t("requests", { count: l.request_count }),
                      t("validUntil", { date: format.dateTime(new Date(l.expires_at), { day: "numeric", month: "short", year: "numeric" }) }),
                      l.language.toUpperCase(),
                    ].join(" · ")}
                  </span>
                </div>
                {canEdit ? (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" onClick={() => void revoke(l)} aria-label={t("revokeLabel", { date: dateText(l.created_at) })}>
                      {t("revoke")}
                    </Button>
                    <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" onClick={() => void make("none", true)} aria-label={t("replaceLabel", { date: dateText(l.created_at) })}>
                      {t("replace")}
                    </Button>
                    <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" onClick={() => void extend(l)}>
                      {t("extend")}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Button variant="link" className={cn("self-start")} onClick={() => setTextOpen(true)}>
        {t("sendText")}
      </Button>
      <StockTextDialog open={textOpen} onOpenChange={setTextOpen} lead={lead} language={made?.language ?? language} link={made?.url ?? null} me={me} />
    </section>
  );
}

function StockTextDialog({
  open,
  onOpenChange,
  lead,
  language,
  link,
  me,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lead: ShareLead;
  language: "en" | "fr";
  link: string | null;
  me: string | null;
}) {
  const t = useTranslations("ShareLinks");
  const toast = useToast();
  const id = useId();
  const preview = useQuery({
    queryKey: ["share-preview"],
    queryFn: () => getJson<{ items: ShareItem[] }>("/api/inventory/share-preview"),
    enabled: open,
    staleTime: 30_000,
  });
  const items = preview.data?.items ?? [];
  const words = useShareText(language);
  const text = preview.data ? stockListText(items, words, { link, firstName: me }) : "";
  const hasStock = items.some((i) => i.warehouse > 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={`${id}-desc`} className={cn(phoneSheet, "max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain sm:w-[min(560px,calc(100%-32px))]")}>
        <div className="flex flex-col gap-4 p-5 sm:p-6">
          <DialogTitle className="text-xl font-bold">{t("textTitle")}</DialogTitle>
          <DialogDescription id={`${id}-desc`} className="text-sm text-muted-foreground">
            {t("textBody")}
          </DialogDescription>
          {preview.isPending ? (
            <div className="h-48 rounded-md bg-muted motion-safe:animate-pulse" aria-hidden="true" />
          ) : preview.isError ? (
            <p role="alert">{t("loadError")}</p>
          ) : !hasStock ? (
            <p className="text-sm text-muted-foreground">{t("textEmpty")}</p>
          ) : (
            <>
              <label htmlFor={`${id}-text`} className="sr-only">
                {t("textTitle")}
              </label>
              <textarea id={`${id}-text`} readOnly value={text} rows={10} className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm" />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="quiet"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(text);
                      toast.show(t("textCopied"));
                    } catch {
                      (document.getElementById(`${id}-text`) as HTMLTextAreaElement | null)?.select();
                      toast.show(t("copyFailed"));
                    }
                  }}
                >
                  <Copy aria-hidden="true" strokeWidth={1.75} className="size-4" />
                  {t("copyText")}
                </Button>
                <a
                  href={whatsappTextHref(text, lead.phone, lead.country)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-4 font-bold text-primary-foreground"
                >
                  <MessageCircle aria-hidden="true" strokeWidth={1.75} className="size-4" />
                  {t("openWhatsapp")}
                </a>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
