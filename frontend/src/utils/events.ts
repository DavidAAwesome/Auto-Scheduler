import type { CalendarEvent, EventKind, EventOccurrence } from '../types/models.ts';
import type { IconName } from '../components/Icon.tsx';
import { weekdayIndex } from './calendar.ts';

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

export function occurrencesOn(events: CalendarEvent[], date: string): EventOccurrence[] {
  return events.filter(e => occursOn(e, date)).sort((a, b) => a.start - b.start).map(event => ({ event, date }));
}

/** The event occurring on `date` that overlaps [start, end), if any. Work sessions can't be planned over events. */
export function eventClash(events: CalendarEvent[], date: string, start: number, end: number) {
  return events.find(e => e.start < end && e.end > start && occursOn(e, date));
}

/** How many times a repeating event happens in total (shown when creating a class schedule). */
export function occurrenceCount(event: Pick<CalendarEvent, 'date' | 'repeat' | 'skipDates'>) {
  if (!event.repeat) return 1;
  let count = 0;
  for (let t = Date.parse(`${event.date}T12:00:00Z`); t <= Date.parse(`${event.repeat.until}T12:00:00Z`); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (event.repeat.weekdays.includes(weekdayIndex(day)) && !event.skipDates.includes(day)) count++;
  }
  return count;
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
