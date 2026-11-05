import type { CalendarEvent, EventKind, EventOccurrence } from '../types/models.ts';
import type { IconName } from '../components/Icon.tsx';
import { weekdayIndex } from './calendar.ts';
import { addDays } from './dates.ts';

export const EVENT_KINDS: EventKind[] = ['Class', 'Meeting', 'Appointment', 'Social', 'Other'];
export const eventIcon: Record<EventKind, IconName> = {
  Class: 'study',
  Meeting: 'users',
  Appointment: 'clock',
  Social: 'coffee',
  Other: 'calendar',
};

/** Mirrors the backend's `occurs_on`: one-time events happen on their date; weekly ones on matching weekdays until `until`. */
export function occursOn(event: CalendarEvent, date: string) {
  if (event.skipDates.includes(date)) return false;
  if (!event.repeat) return event.date === date;
  return event.date <= date && date <= event.repeat.until && event.repeat.weekdays.includes(weekdayIndex(date));
}

/** Busy, timed events block work. Events marked "Free" and all-day items are shown but leave the time open. */
export const blocksTime = (event: Pick<CalendarEvent, 'busy' | 'allDay'>) => event.busy !== false && !event.allDay;

/** Shown in the all-day row: all-day items, and Free events that fill the whole day (e.g. the middle of a multi-day trip). */
export const showsAllDay = (e: Pick<CalendarEvent, 'allDay' | 'busy' | 'start' | 'end'>) => !!e.allDay || (e.busy === false && e.start === 0 && e.end === 1440);

/** Timed events on `date` (busy and free), by start time. All-day items are listed separately by `allDayOn`. */
export function occurrencesOn(events: CalendarEvent[], date: string): EventOccurrence[] {
  return events.filter(e => !showsAllDay(e) && occursOn(e, date)).sort((a, b) => a.start - b.start).map(event => ({ event, date }));
}

/** Only the events on `date` that make time busy. */
export function busyOccurrencesOn(events: CalendarEvent[], date: string): EventOccurrence[] {
  return occurrencesOn(events, date).filter(o => blocksTime(o.event));
}

/** All-day items on `date` (e.g. imported birthdays, holidays, trips). */
export function allDayOn(events: CalendarEvent[], date: string) {
  return events.filter(e => showsAllDay(e) && occursOn(e, date)).sort((a, b) => a.title.localeCompare(b.title));
}

/** The busy event occurring on `date` that overlaps [start, end), if any. Work can't be planned over busy events. */
export function eventClash(events: CalendarEvent[], date: string, start: number, end: number) {
  return events.find(e => blocksTime(e) && e.start < end && e.end > start && occursOn(e, date));
}

/** How many times a repeating event happens in total (shown when creating a class schedule). */
/** Why these times cannot be saved, or null. Shown in the form, so the disabled button is never a mystery. */
export function eventTimeProblem(start: number, end: number) {
  return Number.isFinite(start) && Number.isFinite(end) && end <= start ? "The event must end after it starts." : null;
}

/** Work sessions (not breaks) an event at these times would overlap. */
export function overlappingWork<T extends { type: string; start: number; end: number; date: string }>(sessions: T[], event: CalendarEvent, start: number, end: number) {
  return end > start ? sessions.filter(s => s.type === "work" && s.start < end && s.end > start && occursOn(event, s.date)) : [];
}

export function occurrenceCount(event: Pick<CalendarEvent, 'date' | 'repeat' | 'skipDates'>) {
  if (!event.repeat) return 1;
  let count = 0;
  for (let t = Date.parse(`${event.date}T12:00:00Z`); t <= Date.parse(`${event.repeat.until}T12:00:00Z`); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (event.repeat.weekdays.includes(weekdayIndex(day)) && !event.skipDates.includes(day)) count++;
  }
  return count;
}

/** The first date on or after `from` when the event happens (null if it never does again). */
export function nextOccurrence(event: CalendarEvent, from: string): string | null {
  if (!event.repeat) return event.date >= from && occursOn(event, event.date) ? event.date : null;
  const start = event.date > from ? event.date : from;
  for (let t = Date.parse(`${start}T12:00:00Z`), end = Date.parse(`${event.repeat.until}T12:00:00Z`); t <= end; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (occursOn(event, day)) return day;
  }
  return null;
}

/** The final date a repeating series actually happens (its end date may not be a class day). */
function lastOccurrence(event: CalendarEvent): string | null {
  if (!event.repeat) return null;
  for (let t = Date.parse(`${event.repeat.until}T12:00:00Z`), first = Date.parse(`${event.date}T12:00:00Z`); t >= first; t -= 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (occursOn(event, day)) return day;
  }
  return null;
}

/** `through`: for an imported event that spans several days, the last day and its end time. */
export interface ListedEvent { event: CalendarEvent; date: string; through?: { date: string; end: number } }

/** Imported multi-day events arrive as one piece per day; list them once, as a span. A piece continues the previous
 * one when it is the same imported event (title, source, location, busy/all-day) on the next day, picking up at
 * midnight where the previous piece ran to midnight. */
function mergeSpans(items: ListedEvent[]): ListedEvent[] {
  const out: ListedEvent[] = [];
  const open = new Map<string, ListedEvent>();
  const ordered = [...items].sort((a, b) => a.date.localeCompare(b.date) || a.event.start - b.event.start);
  for (const item of ordered) {
    const e = item.event;
    if (e.source === 'manual' || e.repeat) { out.push(item); continue; }
    const key = [e.source, e.title, e.location ?? '', e.busy !== false, !!e.allDay].join('|');
    const last = open.get(key);
    const lastDate = last?.through?.date ?? last?.date;
    const lastEnd = last?.through?.end ?? last?.event.end;
    if (last && lastDate && addDays(lastDate, 1) === item.date && lastEnd === 1440 && e.start === 0) {
      last.through = { date: item.date, end: e.end };
    } else {
      const copy = { ...item };
      open.set(key, copy);
      out.push(copy);
    }
  }
  return out;
}
/** Events for the sidebar list. Repeating series appear once (at their next class), not once per week.
 * upcoming: one-time events from today on, by date and time. repeating: series still running, by next date.
 * past: one-time events and finished series, most recent first. */
export function groupEvents(events: CalendarEvent[], today: string) {
  const upcoming: ListedEvent[] = [], repeating: ListedEvent[] = [], past: ListedEvent[] = [];
  for (const event of events) {
    const next = nextOccurrence(event, today);
    if (event.repeat) (next ? repeating : past).push({ event, date: next ?? lastOccurrence(event) ?? event.repeat.until });
    else (next ? upcoming : past).push({ event, date: event.date });
  }
  const soonest = (a: ListedEvent, b: ListedEvent) => a.date.localeCompare(b.date) || a.event.start - b.event.start || a.event.title.localeCompare(b.event.title);
  repeating.sort(soonest);
  return { upcoming: mergeSpans(upcoming).sort(soonest), repeating, past: mergeSpans(past).sort((a, b) => soonest(b, a)) };
}

export interface Placed { lane: number; lanes: number }
/** Side-by-side layout for overlapping blocks in one day column (classic calendar "lanes"). */
export function layoutLanes<T extends { start: number; end: number }>(items: T[]): Map<T, Placed> {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const result = new Map<T, Placed>();
  let cluster: T[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const flush = () => { for (const item of cluster) result.get(item)!.lanes = laneEnds.length; cluster = []; laneEnds = []; };
  for (const item of sorted) {
    if (item.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex(end => end <= item.start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(item.end); } else laneEnds[lane] = item.end;
    result.set(item, { lane, lanes: 0 });
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return result;
}
