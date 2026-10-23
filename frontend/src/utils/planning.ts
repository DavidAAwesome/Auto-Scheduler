import type { Availability, Task, WorkSession, WorkSessionInput } from '../types/models.ts';
import { weekdayIndex } from './calendar.ts';

/** Minutes of work already placed in sessions for a task. */
export function plannedMinutes(taskId: string, sessions: WorkSession[]) {
  return sessions.filter(s => s.taskId === taskId).reduce((sum, s) => sum + s.end - s.start, 0);
}

/** A session must end by the task's due time (a task due 11:59 PM can be worked on until midnight). */
export function endsAfterDue(session: Pick<WorkSessionInput, 'date' | 'end'>, task: Pick<Task, 'deadline' | 'dueTime'>) {
  return session.date > task.deadline || (session.date === task.deadline && session.end > task.dueTime + 1);
}

export function overlapping(input: WorkSessionInput, sessions: WorkSession[], ignoreId?: string) {
  return sessions.find(s => s.id !== ignoreId && s.date === input.date && s.start < input.end && s.end > input.start);
}

/** True when the session falls (partly) outside the user's available hours for that weekday. Allowed, but worth a warning. */
export function outsideAvailability(input: Pick<WorkSessionInput, 'date' | 'start' | 'end'>, availability: Availability | null) {
  const day = availability?.days[weekdayIndex(input.date)];
  return !!day && (!day.enabled || input.start < day.start || input.end > day.end);
}

export function sessionsByDate(sessions: WorkSession[]) {
  const map = new Map<string, WorkSession[]>();
  for (const session of [...sessions].sort((a, b) => a.start - b.start)) map.set(session.date, [...(map.get(session.date) ?? []), session]);
  return map;
}
