import type { CalendarEvent, SchedulePreviewPayload, ScheduleTaskResult, Task, WorkSession } from '../types/models.ts';
import { addDays } from './dates.ts';
import { clock12, longDate } from './calendar.ts';
import { occurrencesOn } from './events.ts';

const REASON_TEXT: Record<string, string> = {
  insufficient_availability: 'not enough free time before the deadline',
  no_contiguous_slot: 'no single free block is long enough and splitting is off',
  remainder_below_min_session: 'the leftover is shorter than the minimum session length',
  deadline_passed: 'the deadline has already passed',
  dependency_cycle: 'the task is part of a dependency cycle',
  dependency_unmet: 'a dependency could not be scheduled first',
  invalid_data: 'the task duration or session limits are invalid',
  locked_capacity_exceeded: 'fixed sessions already use the remaining time',
  outside_planning_window: 'the deadline is beyond the planning window',
};

export const timeRange = (start: number, end: number) => `${clock12(start)}–${clock12(end % 1440)}`;

/** One line for a task the preview could not fully place: minutes left and the reason. */
export function unscheduledLine(task: ScheduleTaskResult) {
  return `${task.title}: ${task.unscheduledMinutes} min unscheduled, because ${REASON_TEXT[task.reason] ?? task.reason}.`;
}

/** Groups items by their local date, earliest date first and earliest start first within a day. */
export function groupByDate<T extends { date: string; start: number }>(items: T[]) {
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
  const groups = new Map<string, T[]>();
  for (const item of sorted) groups.set(item.date, [...(groups.get(item.date) ?? []), item]);
  return [...groups.entries()];
}

/** Human summary of a schedule preview: the same sessions the calendar draws, grouped by day, plus what did not fit. */
export function previewText(schedule: SchedulePreviewPayload) {
  const lines: string[] = [];
  const count = schedule.sessions.length;
  lines.push(`Proposed schedule, ${longDate(schedule.startDate)} – ${longDate(schedule.endDate)} (${schedule.timeZone}). ${count} session${count === 1 ? "" : "s"}. Not saved yet.`);
  for (const [date, sessions] of groupByDate(schedule.sessions)) {
    lines.push(`${longDate(date)}`);
    for (const session of sessions) lines.push(`• ${timeRange(session.start, session.end)} · ${session.title}`);
  }
  if (!count) lines.push("No sessions could be placed.");
  const unscheduled = schedule.tasks.filter(task => task.unscheduledMinutes > 0);
  if (unscheduled.length) {
    lines.push("Not fully scheduled:");
    lines.push(...unscheduled.map(task => `• ${unscheduledLine(task)}`));
  } else {
    lines.push("Everything fits.");
  }
  return lines.join("\n");
}

export interface BusyItem {
  kind: "event" | "session";
  title: string;
  start: number;
  end: number;
  detail: string;
}

const EVENT_SOURCE: Record<CalendarEvent["source"], string> = { manual: "", google: " · from Google Calendar", outlook: " · from Outlook" };

/** Existing calendar events and saved work sessions for each day in the range, kept apart: events are fixed, sessions are planned work. */
export function busyItemsByDate(events: CalendarEvent[], sessions: WorkSession[], tasks: Task[], startDate: string, days: number) {
  const titles = new Map(tasks.map(task => [task.id, task.title]));
  const byDate = new Map<string, BusyItem[]>();
  for (let offset = 0; offset < days; offset++) {
    const date = addDays(startDate, offset);
    const items: BusyItem[] = [
      ...occurrencesOn(events, date).map(({ event }) => ({
        kind: "event" as const,
        title: event.title,
        start: event.start,
        end: event.end,
        detail: `fixed event (${event.kind.toLowerCase()})${event.location ? ` at ${event.location}` : ""}${EVENT_SOURCE[event.source]}`,
      })),
      ...sessions.filter(session => session.date === date).map(session => ({
        kind: "session" as const,
        title: titles.get(session.taskId) ?? "Task",
        start: session.start,
        end: session.end,
        detail: session.source === "auto" ? "planned work, saved by the scheduler" : "planned work, placed by you",
      })),
    ];
    if (items.length) byDate.set(date, items.sort((a, b) => a.start - b.start));
  }
  return byDate;
}

/** Plain-language busy time for a date range, drawn only from the user's stored events and sessions. */
export function busyTimeText(events: CalendarEvent[], sessions: WorkSession[], tasks: Task[], startDate: string, days: number, hasCalendarConnection: boolean) {
  const endDate = addDays(startDate, days - 1);
  const byDate = busyItemsByDate(events, sessions, tasks, startDate, days);
  const span = `${longDate(startDate)} – ${longDate(endDate)}`;
  if (!byDate.size) {
    const note = hasCalendarConnection ? "" : " No external calendar is connected, so only events added in AutoPlan appear.";
    return `Nothing is busy from ${span}: no events and no saved work sessions.${note}`;
  }
  const lines = [`Busy time, ${span}:`];
  for (const [date, items] of byDate) {
    lines.push(longDate(date));
    for (const item of items) lines.push(`• ${timeRange(item.start, item.end)} ${item.title}, ${item.detail}`);
  }
  return lines.join("\n");
}
