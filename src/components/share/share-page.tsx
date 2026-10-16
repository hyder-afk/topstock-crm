"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Logo } from "@/components/logo";
import { ShareList } from "@/components/share/share-list";
import { ItemSheet, ReviewSheet, type BasketLine, type SendState } from "@/components/share/share-request";
import { Button } from "@/components/ui/button";
import { requestElapsed, snapshotFromWire } from "@/lib/share/wire";
import { tokenFromHash } from "@/lib/share/token";
import type { ShareItem, ShareSnapshot } from "@/lib/share/schema";

// The client stock page (/s/fr, /s/en; design 8.3, 8.6 and 10.5). The token is read once from the URL fragment and kept
// in memory only (never stored, never in a request URL): the page POSTs it to /api/share/view, then polls every 5
// minutes while visible (and on focus, at most once a minute) with the version it holds, and POSTs a request to
// /api/share/request. Every link that does not work shows the same sentence.

type View =
  | { kind: "loading" }
  | { kind: "ok"; snap: ShareSnapshot }
  | { kind: "inactive" }
  | { kind: "slow_down"; snap: ShareSnapshot | null }
  | { kind: "error"; snap: ShareSnapshot | null }
  | { kind: "offline"; snap: ShareSnapshot | null };

let capturedToken: string | null | undefined;
function readToken() {
  if (capturedToken === undefined) capturedToken = tokenFromHash(window.location.hash);
  return capturedToken;
}
const noSubscribe = () => () => {};

const POLL_MS = 5 * 60_000;
const FOCUS_MIN_MS = 60_000;

export function SharePage() {
  const t = useTranslations("Share");
  const tb = useTranslations("Share.basket");
  const locale = useLocale() as "en" | "fr";
  // The fragment, read once on the client (the server never sees it; a later "#main" from the skip link must not lose
  // it); undefined while hydrating, so the first client render matches the server's.
  const token = useSyncExternalStore(noSubscribe, readToken, () => undefined);
  const [loaded, setView] = useState<View>({ kind: "loading" });
  const view: View = token === null ? { kind: "inactive" } : loaded;
  const snapRef = useRef<ShareSnapshot | null>(null);
  const lastLoad = useRef(0);
  const loadedAt = useRef(0);
  const [picking, setPicking] = useState<ShareItem | null>(null);
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const [sentBy, setSentBy] = useState<{ signature: string | null } | null>(null);
  const idemKey = useRef<string | null>(null);
  const lastPicked = useRef<number | null>(null);

  useEffect(() => {
    loadedAt.current = performance.now();
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    lastLoad.current = Date.now();
    const known = snapRef.current?.version;
    let res: Response;
    try {
      res = await fetch("/api/share/view", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(known ? { token, knownVersion: known } : { token }),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      setView({ kind: navigator.onLine ? "error" : "offline", snap: snapRef.current });
      return;
    }
    const body = (await res.json().catch(() => null)) as { unchanged?: boolean; items?: unknown } | null;
    const fresh = res.ok && body && "items" in body ? snapshotFromWire(body) : null;
    if (res.status === 404) {
      snapRef.current = null;
      setView({ kind: "inactive" });
    } else if (res.status === 429) setView({ kind: "slow_down", snap: snapRef.current });
    else if (res.ok && body?.unchanged === true && snapRef.current) setView({ kind: "ok", snap: snapRef.current });
    else if (fresh) {
      snapRef.current = fresh;
      setView({ kind: "ok", snap: fresh });
    } else setView({ kind: "error", snap: snapRef.current });
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onFocus = () => {
      if (Date.now() - lastLoad.current >= FOCUS_MIN_MS) void load();
    };
    const onOnline = () => void load();
    const onOffline = () => setView((v) => ({ kind: "offline", snap: v.kind === "ok" ? v.snap : snapRef.current }));
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [token, load]);

  const snap = view.kind === "ok" ? view.snap : view.kind === "loading" || view.kind === "inactive" ? null : view.snap;
  const picked = useMemo(() => new Set(basket.map((l) => l.item.number)), [basket]);

  const submit = async (website: string) => {
    if (!token || send.kind === "sending") return;
    idemKey.current ??= crypto.randomUUID();
    setSend({ kind: "sending" });
    let res: Response | null = null;
    try {
      res = await fetch("/api/share/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        body: JSON.stringify({
          token,
          lines: basket.map((l) => ({ productNumber: l.item.number, description: null, quantity: l.quantity, unit: l.unit })),
          note,
          name,
          idempotencyKey: idemKey.current,
          website,
          t: requestElapsed(performance.now(), loadedAt.current),
        }),
      });
    } catch {
      res = null;
    }
    const body = res ? ((await res.json().catch(() => null)) as { status?: string; signature?: string | null } | null) : null;
    if (res?.ok && body?.status === "received") {
      setSentBy({ signature: body.signature ?? snap?.signature ?? null });
      setBasket([]);
      setNote("");
      setName("");
      idemKey.current = null;
      setSend({ kind: "idle" });
      setReviewOpen(false);
      requestAnimationFrame(() => document.getElementById("share-thanks")?.focus());
      return;
    }
    const s = body?.status;
    if (s === "inactive") {
      setSend({ kind: "idle" });
      setReviewOpen(false);
      setView({ kind: "inactive" });
      return;
    }
    setSend({
      kind: "error",
      text:
        s === "closed" ? tb("closed") : s === "too_many_open" ? tb("tooManyOpen") : s === "slow_down" ? tb("slowDown") : s === "invalid" ? tb("invalid") : tb("failed"),
    });
  };

  const updated = snap ? new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(snap.generatedAt)) : null;

  return (
    <div className="mx-auto flex w-full max-w-[720px] min-w-0 flex-col gap-6 px-4 pt-6 pb-32 sm:px-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <Logo className="h-auto w-[184px] max-w-[60vw] text-foreground" />
          <nav aria-label={t("language")} className="grid shrink-0 grid-cols-2 rounded-md bg-muted p-1">
            {(["en", "fr"] as const).map((l) => (
              <a
                key={l}
                href={`/s/${l}`}
                lang={l}
                aria-current={l === locale ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  if (l === locale) return;
                  window.location.assign(token ? `/s/${l}#${token}` : `/s/${l}`);
                }}
                className={`grid min-h-11 min-w-11 place-items-center rounded-[10px] px-2 font-mono text-sm ${l === locale ? "bg-card shadow-sm" : ""}`}
              >
                {l.toUpperCase()}
              </a>
            ))}
          </nav>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h1 className="text-2xl font-bold text-balance">{t("title")}</h1>
          {updated ? <p className="font-mono text-sm text-muted-foreground tabular-nums">{t("updated", { time: updated })}</p> : null}
        </div>
        {snap?.signature ? <p className="text-sm text-muted-foreground">{t("contact", { name: snap.signature })}</p> : null}
      </header>

      <main id="main" tabIndex={-1} className="flex min-w-0 flex-col gap-6 focus:outline-none">
        {view.kind === "loading" ? <ShareSkeleton label={t("loading")} /> : null}
        {view.kind === "inactive" ? <Notice text={t("inactive")} /> : null}
        {view.kind === "slow_down" ? <Notice text={t("slowDown")} role="status" /> : null}
        {view.kind === "offline" ? <Notice text={t("offline")} role="status" /> : null}
        {view.kind === "error" ? (
          <div className="flex flex-col items-start gap-3 rounded-lg bg-card p-4" role="alert">
            <p>{t("error")}</p>
            <Button variant="quiet" onClick={() => void load()}>
              {t("retry")}
            </Button>
          </div>
        ) : null}
        {sentBy ? (
          <div id="share-thanks" tabIndex={-1} className="flex flex-col items-start gap-3 rounded-lg bg-card p-4 focus:outline-none" role="status">
            <p className="font-bold">{sentBy.signature ? tb("thanks", { name: sentBy.signature }) : tb("thanksNoName")}</p>
            <Button variant="quiet" onClick={() => setSentBy(null)}>
              {tb("another")}
            </Button>
          </div>
        ) : null}
        {snap && view.kind !== "inactive" ? (
          snap.items.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-lg bg-card p-4">
              <p>{t("emptyTitle")}</p>
              {snap.allowRequests ? (
                <Button variant="quiet" onClick={() => setReviewOpen(true)}>
                  {tb("other")}
                </Button>
              ) : null}
            </div>
          ) : (
            <ShareList
              items={snap.items}
              showInTransit={snap.showInTransit}
              picked={picked}
              onPick={
                snap.allowRequests
                  ? (item) => {
                      lastPicked.current = item.number;
                      setPicking(item);
                    }
                  : undefined
              }
            />
          )
        ) : null}
        {snap && !snap.allowRequests ? <p className="text-sm text-muted-foreground">{tb("closed")}</p> : null}
      </main>

      {snap ? (
        <footer className="flex flex-col gap-2 text-[13px] text-muted-foreground">
          <p>{t("footerPrices")}</p>
          <p>{t("footerPrivacy")}</p>
        </footer>
      ) : null}

      {snap?.allowRequests && (basket.length > 0 || note.trim()) ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 pt-3 pr-[max(16px,env(safe-area-inset-right,0px))] pb-[max(12px,env(safe-area-inset-bottom))] pl-[max(16px,env(safe-area-inset-left,0px))] backdrop-blur sm:pr-[max(24px,env(safe-area-inset-right,0px))] sm:pl-[max(24px,env(safe-area-inset-left,0px))]">
          <div className="mx-auto flex max-w-[672px] items-center justify-between gap-3">
            <p className="text-sm font-bold" aria-live="polite">
              {tb("bar", { count: basket.length })}
            </p>
            <Button variant="neutral" onClick={() => setReviewOpen(true)}>
              {tb("review")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="sr-only" aria-live="polite">
          {basket.length ? tb("bar", { count: basket.length }) : ""}
        </p>
      )}

      <ItemSheet
        returnFocusTo={() => (lastPicked.current !== null ? document.querySelector<HTMLElement>(`[data-item-number="${lastPicked.current}"]`) : null)}
        item={picking}
        initial={picking ? (basket.find((l) => l.item.number === picking.number) ?? null) : null}
        onClose={() => setPicking(null)}
        onSave={(line) => {
          setBasket((b) => (b.some((l) => l.item.number === line.item.number) ? b.map((l) => (l.item.number === line.item.number ? line : l)) : [...b, line]));
          idemKey.current = null;
          setPicking(null);
        }}
      />
      <ReviewSheet
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        lines={basket}
        note={note}
        onNote={(v) => {
          setNote(v);
          idemKey.current = null;
        }}
        name={name}
        onName={setName}
        onEdit={(l) => {
          setReviewOpen(false);
          lastPicked.current = l.item.number;
          setPicking(l.item);
        }}
        onRemove={(id) => {
          setBasket((b) => b.filter((l) => l.item.number !== id));
          idemKey.current = null;
        }}
        onSend={(website) => void submit(website)}
        state={send}
      />
    </div>
  );
}

function Notice({ text, role }: { text: string; role?: "status" }) {
  return (
    <p className="rounded-lg bg-card p-4" role={role}>
      {text}
    </p>
  );
}

export function ShareSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-5" aria-busy="true">
      <span className="sr-only" role="status">
        {label}
      </span>
      <div className="h-11 rounded-md bg-muted motion-safe:animate-pulse" />
      <div className="flex flex-col gap-2">
        <div className="h-6 w-56 rounded-sm bg-muted motion-safe:animate-pulse" />
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg bg-card">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex min-h-16 items-start gap-3 px-4 py-3">
              <div className="flex flex-1 flex-col gap-2">
                <div className="h-4 w-3/5 rounded-sm bg-muted motion-safe:animate-pulse" />
                <div className="h-3 w-2/5 rounded-sm bg-muted motion-safe:animate-pulse" />
              </div>
              <div className="h-4 w-16 rounded-sm bg-muted motion-safe:animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
