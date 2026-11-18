import type { CalendarEvent, ScheduleSession, Task } from '../types/models.ts';
import { DEFAULT_DUE_TIME } from '../types/models.ts';
import { dateInZone } from './calendar.ts';
import { addDays } from './dates.ts';
import { occurrencesOn } from './events.ts';
import { zonedInstant } from './planning.ts';

/** Lead times offered in Settings, in minutes before the start. 0 = when it starts. */
export const REMINDER_LEADS = [0, 5, 10, 15, 30, 60] as const;
export { DEFAULT_REMINDER_MINUTES } from "../types/models.ts";
/** A task with no due time (11:59 PM) is reminded at 9 AM on the day it is due. */
export const DUE_DAY_REMINDER_MINUTE = 9 * 60;
/** A task with a due time is reminded at least this long before it is due, so there is time to finish. */
export const MIN_DUE_LEAD_MINUTES = 60;
/** A reminder still shows this long after its item starts (the app checks every 30 seconds, or was in the background). */
export const LATE_GRACE_MS = 5 * 60_000;

export type ReminderKind = 'session' | 'event' | 'due';
export interface Reminder {
  /** Unique per item and start time, so a moved session or event is reminded again. */
  key: string;
  kind: ReminderKind;
  title: string;
  body: string;
  /** When the reminder becomes due (ms since epoch). */
  fireAt: number;
  /** When the item starts, or the task is due (ms since epoch). */
  startsAt: number;
}

export interface ReminderInput {
  tasks: Pick<Task, 'id' | 'title' | 'deadline' | 'dueTime' | 'done'>[];
  sessions: ScheduleSession[];
  events: CalendarEvent[];
  zone: string;
  leadMinutes: number;
  now: number;
}

const MINUTE = 60_000;

/** "15 min before", or "when it starts" for 0. */
export function leadLabel(minutes: number) {
  if (!minutes) return 'when it starts';
  return minutes % 60 === 0 ? `${minutes / 60} h before` : `${minutes} min before`;
}

export function clockInZone(instant: number, zone: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(instant));
}

/** "now", "in 15 min", "in 1 h 30 min". */
export function startsIn(startsAt: number, now: number) {
  const minutes = Math.round((startsAt - now) / MINUTE);
  if (minutes <= 0) return 'now';
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (!hours) return `in ${rest} min`;
  return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
}

/**
 * Every reminder for today and tomorrow (in the account time zone):
 * - saved work sessions of unfinished tasks, `leadMinutes` before they start;
 * - fixed events (not all-day ones), `leadMinutes` before they start;
 * - unfinished tasks due today or tomorrow: at 9 AM on the due day when no due time was set,
 *   otherwise max(leadMinutes, 60) minutes before the due time.
 */
export function buildReminders({ tasks, sessions, events, zone, leadMinutes, now }: ReminderInput): Reminder[] {
  const lead = Math.max(0, leadMinutes) * MINUTE;
  const today = dateInZone(zone, new Date(now));
  const dates = [today, addDays(today, 1)];
  const open = new Map(tasks.filter(t => !t.done).map(t => [t.id, t]));
  const reminders: Reminder[] = [];

  for (const session of sessions) {
    if (session.type !== 'work' || session.status !== 'saved' || !session.taskId || !open.has(session.taskId)) continue;
    const startsAt = Date.parse(session.startAt);
    reminders.push({
      key: `session:${session.id}:${startsAt}`, kind: 'session', startsAt, fireAt: startsAt - lead,
      title: `Work on ${open.get(session.taskId)!.title}`,
      body: `Work session at ${clockInZone(startsAt, zone)} until ${clockInZone(Date.parse(session.endAt), zone)}`,
    });
  }

  for (const date of dates) {
    for (const { event } of occurrencesOn(events, date)) {
      if (event.allDay) continue;
      const startsAt = Date.parse(zonedInstant(date, event.start, zone));
      reminders.push({
        key: `event:${event.id}:${startsAt}`, kind: 'event', startsAt, fireAt: startsAt - lead,
        title: event.title,
        body: `${event.kind} at ${clockInZone(startsAt, zone)}${event.location ? ` · ${event.location}` : ''}`,
      });
    }
  }

  for (const task of open.values()) {
    if (!dates.includes(task.deadline)) continue;
    const startsAt = Date.parse(zonedInstant(task.deadline, task.dueTime, zone));
    const noTime = task.dueTime === DEFAULT_DUE_TIME;
    const fireAt = noTime
      ? Date.parse(zonedInstant(task.deadline, DUE_DAY_REMINDER_MINUTE, zone))
      : startsAt - Math.max(lead, MIN_DUE_LEAD_MINUTES * MINUTE);
    reminders.push({
      key: `due:${task.id}:${startsAt}`, kind: 'due', startsAt, fireAt,
      title: `${task.title} is due ${task.deadline === today ? 'today' : 'tomorrow'}`,
      body: noTime ? 'Due by the end of the day' : `Due at ${clockInZone(startsAt, zone)}`,
    });
  }
  return reminders.sort((a, b) => a.fireAt - b.fireAt || a.startsAt - b.startsAt);
}

/**
 * Reminders to show at `now`: due (fireAt <= now), not shown before, and not stale.
 * Session and event reminders stay valid until LATE_GRACE_MS after the start; a due-date reminder until the task is due.
 */
export function dueReminders(reminders: Reminder[], now: number, shown: ReadonlySet<string>): Reminder[] {
  return reminders.filter(r => {
    if (shown.has(r.key) || r.fireAt > now) return false;
    const expires = r.kind === 'due' ? r.startsAt : r.startsAt + LATE_GRACE_MS;
    return now < expires;
  });
}

/** The next time a reminder becomes due, or null. Lets the app wake up exactly then instead of polling often. */
export function nextFireAt(reminders: Reminder[], now: number, shown: ReadonlySet<string>): number | null {
  const next = reminders.find(r => r.fireAt > now && !shown.has(r.key));
  return next ? next.fireAt : null;
}

/** Shown keys with the time each item starts; entries for items that started over two days ago are dropped. */
export function pruneShown(shown: Record<string, number>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(shown).filter(([, startsAt]) => startsAt > now - 2 * 24 * 60 * MINUTE));
}
