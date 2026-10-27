import type { Availability, Task, WorkSession, WorkSessionInput } from '../types/models.ts';
import { resolveDay } from './availability.ts';

/** Minutes of saved (not cancelled, not completed) work sessions for a task. Breaks never count. */
export function plannedMinutes(taskId: string, sessions: WorkSession[]) {
  return sessions.filter(s => s.taskId === taskId && s.type === 'work' && s.status === 'saved').reduce((sum, s) => sum + s.end - s.start, 0);
}

/** A session must end by the task's due time (a task due 11:59 PM can be worked on until midnight). */
export function endsAfterDue(session: Pick<WorkSessionInput, 'date' | 'end'>, task: Pick<Task, 'deadline' | 'dueTime'>) {
  return session.date > task.deadline || (session.date === task.deadline && session.end > task.dueTime + 1);
}

export function overlapping(input: WorkSessionInput, sessions: WorkSession[], ignoreId?: string) {
  return sessions.find(s => s.id !== ignoreId && s.status !== 'cancelled' && s.date === input.date && s.start < input.end && s.end > input.start);
}

/** True when the session falls (partly) outside the user's available hours for that weekday. Allowed, but worth a warning. */
export function outsideAvailability(input: Pick<WorkSessionInput, 'date' | 'start' | 'end'>, availability: Availability | null) {
  if (!availability) return false;
  const day = resolveDay(availability, input.date); // honours week overrides and multiple periods
  return !day.enabled || !day.periods.some(period => input.start >= period.start && input.end <= period.end);
}

export function sessionsByDate(sessions: WorkSession[]) {
  const map = new Map<string, WorkSession[]>();
  for (const session of [...sessions].sort((a, b) => a.start - b.start)) map.set(session.date, [...(map.get(session.date) ?? []), session]);
  return map;
}

/** Wall-clock `minutes` after midnight on `date` in IANA `zone`, as a UTC ISO instant (minutes may be 1440 = next midnight). */
export function zonedInstant(date: string, minutes: number, zone: string) {
  const [year, month, day] = date.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  const format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map(p => [p.type, Number(p.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant;
  };
  // Two passes settle the offset, including on daylight-saving change days.
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first)).toISOString();
}
