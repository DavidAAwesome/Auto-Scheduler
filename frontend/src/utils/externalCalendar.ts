import type { EventKind, ImportedEvent } from '../types/models.ts';
import { addDays } from './dates.ts';

/** Days back and ahead that a sync imports. */
export const SYNC_DAYS_BACK = 7;
export const SYNC_DAYS_AHEAD = 56;

/** Local date (YYYY-MM-DD) and minutes after midnight of a UTC instant in an IANA zone. */
export function localParts(instant: Date, zone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(instant).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Splits an external event into one block per local day (events can cross midnight), on a 5-minute grid. */
export function localSegments(start: Date, end: Date, zone: string) {
  if (!(end > start)) return [];
  const from = localParts(start, zone);
  const to = localParts(end, zone);
  const segments: { date: string; start: number; end: number }[] = [];
  for (let date = from.date; date <= to.date; date = addDays(date, 1)) {
    const segStart = Math.floor((date === from.date ? from.minutes : 0) / 5) * 5;
    const segEnd = Math.min(1440, Math.ceil((date === to.date ? to.minutes : 1440) / 5) * 5);
    if (segEnd > segStart) segments.push({ date, start: segStart, end: segEnd });
    if (segments.length > 31) break; // guard against absurd multi-week events
  }
  return segments;
}

function imported(id: string, title: string | undefined, kind: EventKind, start: Date, end: Date, zone: string,
  extra: { location?: string | null; calendarName?: string | null; link?: string | null }): ImportedEvent[] {
  return localSegments(start, end, zone).map(segment => ({
    externalId: id,
    title: (title ?? '').trim() || '(No title)',
    kind,
    ...segment,
    location: extra.location?.trim() || null,
    calendarName: extra.calendarName ?? null,
    link: extra.link?.startsWith('https://') ? extra.link : null,
  }));
}

/** Google Calendar API v3 event (only the fields AutoPlan reads). */
export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
}

/** Timed, busy, not-declined events only: all-day and "free" events shouldn't block your time. */
export function fromGoogle(event: GoogleEvent, calendarName: string, zone: string): ImportedEvent[] {
  if (event.status === 'cancelled' || event.transparency === 'transparent') return [];
  if (!event.start?.dateTime || !event.end?.dateTime) return []; // all-day
  if (event.attendees?.some(a => a.self && a.responseStatus === 'declined')) return [];
  const kind: EventKind = (event.attendees?.length ?? 0) > 1 ? 'Meeting' : 'Other';
  return imported(event.id, event.summary, kind, new Date(event.start.dateTime), new Date(event.end.dateTime), zone,
    { location: event.location, calendarName, link: event.htmlLink });
}

/** Microsoft Graph calendarView event, requested with Prefer: outlook.timezone="UTC". */
export interface OutlookEvent {
  id: string;
  subject?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  webLink?: string;
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  location?: { displayName?: string };
  attendees?: unknown[];
  responseStatus?: { response?: string };
}

/** Graph returns UTC wall times without a "Z" when asked for UTC. */
const graphTime = (value: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);

export function fromOutlook(event: OutlookEvent, zone: string): ImportedEvent[] {
  if (event.isAllDay || event.isCancelled || event.showAs === 'free') return [];
  if (event.responseStatus?.response === 'declined' || !event.start || !event.end) return [];
  const kind: EventKind = (event.attendees?.length ?? 0) > 0 ? 'Meeting' : 'Other';
  return imported(event.id, event.subject, kind, graphTime(event.start.dateTime), graphTime(event.end.dateTime), zone,
    { location: event.location?.displayName, calendarName: 'Outlook', link: event.webLink });
}

/** The dates a sync covers, in the user's zone. */
export function syncRange(today: string) {
  return { rangeStart: addDays(today, -SYNC_DAYS_BACK), rangeEnd: addDays(today, SYNC_DAYS_AHEAD) };
}
