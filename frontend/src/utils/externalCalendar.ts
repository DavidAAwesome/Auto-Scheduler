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

/** All-day dates from a start date up to (not including) the exclusive end date, as Google and Outlook store them. */
export function allDayDates(startDate: string, endDateExclusive: string) {
  const dates: string[] = [];
  for (let date = startDate; date < endDateExclusive && dates.length < 31; date = addDays(date, 1)) dates.push(date);
  return dates.length ? dates : [startDate];
}

type Extra = { location?: string | null; calendarName?: string | null; link?: string | null; busy: boolean };
function build(id: string, title: string | undefined, kind: EventKind, segments: { date: string; start: number; end: number }[], allDay: boolean, extra: Extra): ImportedEvent[] {
  return segments.map(segment => ({
    externalId: id,
    title: (title ?? '').trim() || '(No title)',
    kind,
    ...segment,
    location: extra.location?.trim() || null,
    calendarName: extra.calendarName ?? null,
    link: extra.link?.startsWith('https://') ? extra.link : null,
    // All-day items never block time; timed ones block unless the calendar marks them "Free".
    busy: !allDay && extra.busy,
    allDay,
  }));
}
function imported(id: string, title: string | undefined, kind: EventKind, start: Date, end: Date, zone: string, extra: Extra) {
  return build(id, title, kind, localSegments(start, end, zone), false, extra);
}
function importedAllDay(id: string, title: string | undefined, kind: EventKind, startDate: string, endDateExclusive: string, extra: Extra) {
  return build(id, title, kind, allDayDates(startDate, endDateExclusive).map(date => ({ date, start: 0, end: 1440 })), true, extra);
}

/** Keeps only the day-pieces inside the synced range (multi-day events can start before it or end after it). */
export function insideRange(events: ImportedEvent[], rangeStart: string, rangeEnd: string) {
  return events.filter(e => e.date >= rangeStart && e.date <= rangeEnd);
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

/** Everything except cancelled events and declined invitations. Events marked "Free" (transparent) and
 * all-day events come in as show-only: visible on the calendar, but they don't block time. */
export function fromGoogle(event: GoogleEvent, calendarName: string, zone: string): ImportedEvent[] {
  if (event.status === 'cancelled') return [];
  if (event.attendees?.some(a => a.self && a.responseStatus === 'declined')) return [];
  const kind: EventKind = (event.attendees?.length ?? 0) > 1 ? 'Meeting' : 'Other';
  const extra = { location: event.location, calendarName, link: event.htmlLink, busy: event.transparency !== 'transparent' };
  if (event.start?.date && event.end?.date) return importedAllDay(event.id, event.summary, kind, event.start.date, event.end.date, extra);
  if (!event.start?.dateTime || !event.end?.dateTime) return [];
  return imported(event.id, event.summary, kind, new Date(event.start.dateTime), new Date(event.end.dateTime), zone, extra);
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

/** Same rules as Google: "Free" (showAs free) and all-day events are show-only; cancelled and declined are skipped. */
export function fromOutlook(event: OutlookEvent, zone: string): ImportedEvent[] {
  if (event.isCancelled || event.responseStatus?.response === 'declined' || !event.start || !event.end) return [];
  const kind: EventKind = (event.attendees?.length ?? 0) > 0 ? 'Meeting' : 'Other';
  const extra = { location: event.location?.displayName, calendarName: 'Outlook', link: event.webLink, busy: event.showAs !== 'free' };
  // All-day events are date-only in Outlook too; the date part is the calendar date regardless of time zone.
  if (event.isAllDay) return importedAllDay(event.id, event.subject, kind, event.start.dateTime.slice(0, 10), event.end.dateTime.slice(0, 10), extra);
  return imported(event.id, event.subject, kind, graphTime(event.start.dateTime), graphTime(event.end.dateTime), zone, extra);
}

/** The dates a sync covers, in the user's zone. */
export function syncRange(today: string) {
  return { rangeStart: addDays(today, -SYNC_DAYS_BACK), rangeEnd: addDays(today, SYNC_DAYS_AHEAD) };
}
