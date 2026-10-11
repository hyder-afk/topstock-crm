"use client";

import { useSyncExternalStore } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { browserZone, isOpen, localDate, nextOpening, spanEnds } from "@/lib/timezones";
import { cn } from "@/lib/utils";

const noop = () => () => {};

// The browser's clock, refreshed every 30 s (not announced: it is not a live region, design 7.9). Null on the server and
// during hydration, so the server and the first browser render agree. One shared clock per interval, read as an external
// store: a part drawn for the first time in the browser (a tab prepared in a hidden Activity boundary) has the time at
// once, and showing it again draws nothing new unless the clock moved on.
type Clock = { subscribe: (listener: () => void) => () => void; snapshot: () => Date };
const clocks = new Map<number, Clock>();
const serverNow = () => null;

function clockFor(intervalMs: number): Clock {
  const found = clocks.get(intervalMs);
  if (found) return found;
  let now = new Date();
  let timer: number | null = null;
  const listeners = new Set<() => void>();
  const clock: Clock = {
    subscribe: (listener) => {
      listeners.add(listener);
      if (timer === null) {
        timer = window.setInterval(() => {
          now = new Date();
          listeners.forEach((l) => l());
        }, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
      };
    },
    snapshot: () => {
      // Nobody listened for a while (no timer ran): the time is brought up to date before it is read.
      if (timer === null && Date.now() - now.getTime() >= intervalMs) now = new Date();
      return now;
    },
  };
  clocks.set(intervalMs, clock);
  return clock;
}

export function useClientNow(intervalMs = 30_000): Date | null {
  const clock = clockFor(intervalMs);
  return useSyncExternalStore(clock.subscribe, clock.snapshot, serverNow);
}

/**
 * The lead's local time and whether it is a good time to call (Day 4 design 7.1):
 * "14:05 local time · good time to call", "Outside calling hours · opens 09:00 (in 50 min)", for a span "10:05–13:05,
 * United States · time zone not set · Set", and when the viewer's zone differs "14:05 there · 17:05 for you".
 */
export function LocalTime({
  callZoneKey,
  country,
  canSetZone,
  onSetZone,
  onAddCountry,
}: {
  callZoneKey: string;
  country: string | null;
  canSetZone: boolean;
  onSetZone: () => void;
  onAddCountry: (() => void) | null;
}) {
  const t = useTranslations("LeadPage");
  const format = useFormatter();
  const now = useClientNow();
  const viewerZone = useSyncExternalStore(noop, browserZone, () => null);

  if (!now) return <span aria-hidden="true" className="inline-block h-5 w-56 rounded-sm bg-muted motion-safe:animate-pulse" />;

  if (!country) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
        {t("zoneUnknown")}
        {onAddCountry ? (
          <button type="button" onClick={onAddCountry} className="min-h-11 font-bold text-foreground underline-offset-4 hover:underline sm:min-h-0">
            {t("addCountry")}
          </button>
        ) : null}
      </span>
    );
  }

  const time = (zone: string, at: Date = now) => format.dateTime(at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone });
  const open = isOpen(callZoneKey, now);
  const ends = spanEnds(callZoneKey);
  // Times in DM Mono (design 7: times line up), the words around them in Outfit.
  const mono = (chunks: React.ReactNode) => <span className="font-mono text-[0.8125rem]">{chunks}</span>;
  let clock: React.ReactNode;
  if (ends) {
    clock = t.rich("localTimeRange", { from: time(ends[1]), to: time(ends[0]), t: mono });
  } else if (viewerZone && viewerZone !== callZoneKey && time(viewerZone) !== time(callZoneKey)) {
    clock = t.rich("bothZones", { theirs: time(callZoneKey), mine: time(viewerZone), t: mono });
  } else {
    // The city and country are already on the line just before: "Lyon · France · 14:05 local time".
    clock = t.rich("localTime", { time: time(callZoneKey), t: mono });
  }

  let hours: string;
  if (open) {
    hours = t("goodTime");
  } else {
    const opens = nextOpening(callZoneKey, now);
    const zone = ends ? ends[0] : callZoneKey;
    if (!opens) {
      hours = t("outsideHours");
    } else {
      const sameDay = localDate(zone, opens) === localDate(zone, now);
      const relative = format.relativeTime(opens, now);
      // Another day: the weekday and the time apart, so French reads "ouvre lun. à 09:00" (not "ouvre à lun. 09:00").
      hours = sameDay
        ? t("opensAt", { time: time(zone, opens), relative })
        : t("opensAtDay", { day: format.dateTime(opens, { weekday: "short", timeZone: zone }), time: time(zone, opens), relative });
    }
  }

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", open ? "bg-status-green" : "bg-muted-foreground")} />
        <span>{clock}</span>
      </span>
      <span className="text-muted-foreground">
        <span aria-hidden="true" className="max-sm:hidden">· </span>
        {hours}
      </span>
      {ends ? (
        <span className="text-muted-foreground">
          <span aria-hidden="true">· </span>
          {t("zoneNotSet")}
          {canSetZone ? (
            <>
              {" · "}
              <button type="button" onClick={onSetZone} className="min-h-11 font-bold text-foreground underline-offset-4 hover:underline sm:min-h-0">
                {t("setTimezone")}
              </button>
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
