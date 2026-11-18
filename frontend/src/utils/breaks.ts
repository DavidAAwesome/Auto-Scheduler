import type { CalendarEvent, SchedulePreferences, ScheduleSession, Task } from '../types/models.ts';
import { busyOccurrencesOn } from './events.ts';

/** What deciding on a break depends on, besides the sessions themselves. */
export interface BreakContext { preferences: SchedulePreferences; events: CalendarEvent[]; tasks: Pick<Task, 'id' | 'done' | 'kind'>[] }

const DERIVED = 'derived-break-';
type Span = [number, number];

/** A break drawn from the sessions around it. It is not saved, so it has no card and cannot be deleted. */
export const isDerivedBreak = (session: ScheduleSession) => session.id.startsWith(DERIVED);

function subtract(free: Span, blocked: Span[]) {
  const out: Span[] = [];
  let cursor = free[0];
  for (const [start, end] of [...blocked].sort((a, b) => a[0] - b[0])) {
    if (end <= cursor || start >= free[1]) continue;
    if (start > cursor) out.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < free[1]) out.push([cursor, free[1]]);
  return out;
}

/**
 * Automatic breaks for the given sessions. They are worked out here rather than saved, so a break can never outlive
 * the work around it. Same rule as the engine's _materialise_breaks: work separated by less than a break's rest is one
 * run, and a break starts the gap between two same-day runs whose combined work is over the focus limit.
 * Work for done or deleted tasks does not count.
 */
export function derivedBreaks(sessions: ScheduleSession[], { preferences, events, tasks }: BreakContext): ScheduleSession[] {
  const { breakMinutes: rest, focusMinutes: focus, lunch } = preferences;
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const out: ScheduleSession[] = [];
  const live = sessions.filter(s => s.status !== 'cancelled');
  for (const date of new Set(live.map(s => s.date))) {
    const onDay = live.filter(s => s.date === date);
    const open = onDay.filter(s => s.type === 'work' && taskById.has(s.taskId ?? '') && !taskById.get(s.taskId ?? '')!.done);
    const work = open.filter(s => taskById.get(s.taskId ?? '')!.kind !== 'flexible_event').sort((a, b) => a.start - b.start);
    const busy: Span[] = [
      ...busyOccurrencesOn(events, date).map(({ event }): Span => [event.start, event.end]),
      ...open.filter(s => taskById.get(s.taskId ?? '')!.kind === 'flexible_event').map((s): Span => [s.start, s.end]),
    ];
    const rests: Span[] = [...onDay.filter(s => s.type === 'break').map((s): Span => [s.start, s.end]), ...(lunch ? [[lunch.start, lunch.end] as Span] : [])];
    const runs: { start: number; end: number; total: number; last: ScheduleSession }[] = [];
    for (const session of work) {
      const run = runs[runs.length - 1];
      const length = session.end - session.start;
      if (run && !subtract([run.end, session.start], busy).some(([s, e]) => e - s >= rest)) {
        run.end = Math.max(run.end, session.end);
        run.total += length;
        run.last = session;
      } else {
        runs.push({ start: session.start, end: session.end, total: length, last: session });
      }
    }
    for (const [index, before] of runs.slice(0, -1).entries()) {
      const after = runs[index + 1];
      if (before.total + after.total <= focus) continue;
      if (rests.some(([s, e]) => s >= before.end && e <= after.start && e - s >= rest)) continue;
      const stretch = subtract([before.end, after.start], [...busy, ...rests]).find(([s, e]) => e - s >= rest);
      if (!stretch) continue;
      const at = (minute: number) => new Date(Date.parse(before.last.endAt) + (minute - before.last.end) * 60_000).toISOString();
      out.push({
        ...before.last, id: `${DERIVED}${date}-${stretch[0]}`, taskId: null, title: 'Break', type: 'break', status: 'saved',
        locked: false, source: 'auto', startAt: at(stretch[0]), endAt: at(stretch[0] + rest), start: stretch[0], end: stretch[0] + rest, change: null,
      });
    }
  }
  return out;
}
