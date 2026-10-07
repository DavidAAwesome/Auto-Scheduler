/** Prefer GMT in the UI — same civil clock as UTC for most users. */
export const PREFERRED_ZONES: { value: string; label: string }[] = [
  { value: "Etc/GMT", label: "GMT" },
  { value: "America/New_York", label: "America/New_York" },
  { value: "America/Chicago", label: "America/Chicago" },
  { value: "America/Denver", label: "America/Denver" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "Europe/Paris", label: "Europe/Paris" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo" },
];

export function timeZoneLabel(zone: string) {
  if (zone === "UTC" || zone === "Etc/UTC" || zone === "Etc/GMT" || zone === "GMT") {
    return "GMT";
  }
  return zone;
}

export function normalizeTimeZone(zone: string) {
  const trimmed = zone.trim();
  if (!trimmed || trimmed === "UTC" || trimmed === "Etc/UTC" || trimmed === "GMT") {
    return "Etc/GMT";
  }
  return trimmed;
}

export function timeZoneChoices() {
  const seen = new Set<string>(["Etc/GMT"]);
  const choices = [...PREFERRED_ZONES];
  for (const zone of Intl.supportedValuesOf("timeZone")) {
    if (zone === "UTC" || zone === "Etc/UTC" || seen.has(zone)) continue;
    seen.add(zone);
    choices.push({ value: zone, label: zone });
  }
  return choices;
}
