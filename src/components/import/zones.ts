// The time zones offered on the matching screen, with readable names in the screen's language ("France (GMT+2)",
// "temps universel coordonné"). Working the names out loads the browser's time zone data, which is slow the first
// time: the reading step prepares them (prepareZoneLabels), so the matching screen only has to draw.
export const TIME_ZONES = [
  "Europe/Paris",
  "Europe/London",
  "Europe/Brussels",
  "Europe/Berlin",
  "Europe/Madrid",
  "Africa/Casablanca",
  "America/New_York",
  "UTC",
];

// The country each listed zone belongs to (its name comes from Intl in the screen's language).
const zoneCountry: Record<string, string> = {
  "Europe/Paris": "FR",
  "Europe/London": "GB",
  "Europe/Brussels": "BE",
  "Europe/Berlin": "DE",
  "Europe/Madrid": "ES",
  "Africa/Casablanca": "MA",
  "America/New_York": "US",
};

const labels = new Map<string, string>();
const regionNames = new Map<string, Intl.DisplayNames | null>();

function zoneName(zone: string, locale: string, style: "long" | "longGeneric" | "shortOffset"): string | null {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

function countries(locale: string): Intl.DisplayNames | null {
  if (!regionNames.has(locale)) {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: "region" });
    } catch {
      // Older engines: the zone's own name is used instead.
    }
    regionNames.set(locale, names);
  }
  return regionNames.get(locale) ?? null;
}

/** "France (GMT+2)", worked out once per zone and language. */
export function zoneLabel(zone: string, locale: string): string {
  const key = `${locale}|${zone}`;
  let label = labels.get(key);
  if (label === undefined) {
    if (zone === "UTC") {
      label = zoneName(zone, locale, "long") ?? zone;
    } else {
      const code = zoneCountry[zone];
      const place = (code ? countries(locale)?.of(code) : null) ?? zoneName(zone, locale, "longGeneric") ?? zone.replace(/_/g, " ");
      const offset = zoneName(zone, locale, "shortOffset");
      label = offset ? `${place} (${offset})` : place;
    }
    labels.set(key, label);
  }
  return label;
}

/** Works out every listed zone's name now (while a file is being read). */
export function prepareZoneLabels(locale: string): void {
  for (const zone of TIME_ZONES) zoneLabel(zone, locale);
}
