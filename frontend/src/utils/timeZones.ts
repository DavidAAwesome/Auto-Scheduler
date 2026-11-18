import type { Availability } from "../types/models.ts";
import { dateInZone } from "./calendar.ts";

/**
 * The account timezone (saved with availability) is the only timezone the app uses. Values are IANA ids such as
 * America/New_York; labels are for people ("New York — Eastern Time"). The browser's zone is only the first default.
 */
const GMT = "Etc/GMT";
const COMMON = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "America/Mexico_City", "America/Sao_Paulo",
  GMT, "Europe/London", "Europe/Paris", "Europe/Berlin", "Africa/Lagos", "Asia/Dubai", "Asia/Kolkata",
  "Asia/Ho_Chi_Minh", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney",
];

export function normalizeTimeZone(zone: string | null | undefined) {
  const trimmed = (zone ?? "").trim();
  if (!trimmed || trimmed === "UTC" || trimmed === "Etc/UTC" || trimmed === "GMT") return GMT;
  return trimmed;
}

export function isValidTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The device's zone, used only before an account has saved one. */
export function browserTimeZone() {
  let zone = "";
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; } catch { /* fall through to GMT */ }
  return zone && isValidTimeZone(zone) ? normalizeTimeZone(zone) : GMT;
}

/** The zone every date and time in the app is shown and entered in. */
export function accountTimeZone(availability: Pick<Availability, "timeZone"> | null | undefined) {
  return availability?.timeZone ? normalizeTimeZone(availability.timeZone) : browserTimeZone();
}

export function accountToday(availability: Pick<Availability, "timeZone"> | null | undefined, now = new Date()) {
  return dateInZone(accountTimeZone(availability), now);
}

function genericName(zone: string) {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" })
      .formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value;
    return part ?? "";
  } catch {
    return "";
  }
}

/** "New York — Eastern Time". */
export function timeZoneLabel(zone: string) {
  const id = normalizeTimeZone(zone);
  if (id === GMT) return "GMT — Greenwich Mean Time";
  const city = id.split("/").pop()!.replace(/_/g, " ");
  const name = genericName(id);
  return name && name !== city ? `${city} — ${name}` : city;
}

export interface TimeZoneChoice { value: string; label: string }

let cached: { common: TimeZoneChoice[]; all: TimeZoneChoice[] } | null = null;
/** Common zones first, then every zone the browser knows, each id once. */
export function timeZoneChoices() {
  if (cached) return cached;
  const supported = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const seen = new Set<string>();
  const choice = (value: string) => ({ value, label: timeZoneLabel(value) });
  const common = COMMON.filter(zone => isValidTimeZone(zone) && !seen.has(zone) && seen.add(zone)).map(choice);
  const all = supported
    .map(normalizeTimeZone)
    .filter(zone => !seen.has(zone) && seen.add(zone))
    .map(choice)
    .sort((a, b) => a.label.localeCompare(b.label));
  cached = { common, all };
  return cached;
}
