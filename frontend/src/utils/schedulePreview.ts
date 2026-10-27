import type { CalendarEvent, ProposedEvent, SchedulePreview, ScheduleSession, Task, TaskAllocation } from '../types/models.ts';
import { addDays } from './dates.ts';
import { clock12, longDate } from './calendar.ts';
import { occurrencesOn } from './events.ts';

export const timeRange = (start: number, end: number) => `${clock12(start)}–${clock12(end % 1440)}`;
const minutesLabel = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes} min`);

/** How a session is drawn: saved, a proposal that Apply would add, or a saved session Apply would remove. */
export type CalendarItemKind = 'saved' | 'proposed' | 'removed';
export interface CalendarItem { session: ScheduleSession; kind: CalendarItemKind; reason?: string }

/**
 * The single list of sessions that the calendar, Today's Tasks and chat show.
 * Without a preview it is the saved schedule. With one, the preview's complete future schedule replaces the saved
 * sessions it covers, and saved sessions it would delete are kept as "removed" ghosts so nothing changes silently.
 */
export function calendarSessions(sessions: ScheduleSession[], preview: SchedulePreview | null): CalendarItem[] {
  const live = sessions.filter(s => s.status !== 'cancelled');
  if (!preview) return live.map(session => ({ session, kind: 'saved' }));
  const covered = new Set(preview.sessions.filter(s => s.change !== 'new').map(s => s.id));
  const removed = new Map(preview.removed.filter(r => !r.newEndAt).map(r => [r.session.id, r.reason]));
  const items: CalendarItem[] = [];
  for (const session of live) {
    if (covered.has(session.id)) continue;
    if (removed.has(session.id)) items.push({ session, kind: 'removed', reason: removed.get(session.id) });
    else items.push({ session, kind: 'saved' });
  }
  for (const session of preview.sessions) items.push({ session, kind: session.change === 'new' ? 'proposed' : 'saved', reason: session.reason ?? undefined });
  return items.sort((a, b) => a.session.startAt.localeCompare(b.session.startAt) || a.session.endAt.localeCompare(b.session.endAt));
}

export type AgendaItem =
  | { kind: 'event'; start: number; end: number; event: CalendarEvent }
  | { kind: 'proposedEvent'; start: number; end: number; proposed: ProposedEvent }
  | { kind: 'session'; start: number; end: number; item: CalendarItem };

/** Draft fixed events that a plan preview would add, for one date. */
export function proposedEventsOn(preview: SchedulePreview | null, date: string): ProposedEvent[] {
  return (preview?.proposedEvents ?? []).filter(e => e.date === date);
}

/** Today's plan: events and sessions happening today, with deadlines kept separate from work times. */
export function todayAgenda(state: { sessions: ScheduleSession[]; events: CalendarEvent[]; tasks: Task[]; schedulePreview: SchedulePreview | null }, today: string) {
  const items: AgendaItem[] = [
    ...occurrencesOn(state.events, today).map(({ event }) => ({ kind: 'event' as const, start: event.start, end: event.end, event })),
    ...proposedEventsOn(state.schedulePreview, today).map(proposed => ({ kind: 'proposedEvent' as const, start: proposed.start, end: proposed.end, proposed })),
    ...calendarSessions(state.sessions, state.schedulePreview)
      .filter(item => item.session.date === today && item.kind !== 'removed')
      .map(item => ({ kind: 'session' as const, start: item.session.start, end: item.session.end, item })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const open = state.tasks.filter(task => !task.done);
  return {
    items,
    dueToday: open.filter(task => task.deadline === today),
    overdue: open.filter(task => task.deadline < today),
  };
}

function sessionLine(item: CalendarItem) {
  const s = item.session;
  const label = s.type === 'break' ? (s.locked ? 'Protected break' : 'Break') : s.title;
  const tag = item.kind === 'proposed' ? ' · proposed' : s.status === 'completed' ? ' · done' : '';
  return `• ${timeRange(s.start, s.end)} ${label}${s.type === 'work' ? ` (${minutesLabel(s.end - s.start)})` : ''}${tag}`;
}

/** Deterministic answer for "Today's tasks", drawn from the same data as the calendar. */
export function todayText(agenda: ReturnType<typeof todayAgenda>, today: string, zone: string, tasks: Task[] = []) {
  const lines = [`Today, ${longDate(today)} (${zone}):`];
  const proposed = agenda.items.some(i => i.kind === 'proposedEvent' || (i.kind === 'session' && i.item.kind === 'proposed'));
  if (!agenda.items.length) lines.push('Nothing is scheduled today: no saved or proposed work sessions, breaks, or events.');
  for (const entry of agenda.items) {
    if (entry.kind === 'event') lines.push(`• ${timeRange(entry.start, entry.end)} ${entry.event.title} (event)`);
    else if (entry.kind === 'proposedEvent') lines.push(`• ${timeRange(entry.start, entry.end)} ${entry.proposed.title} (event · proposed)`);
    else lines.push(sessionLine(entry.item));
  }
  if (proposed) lines.push('Sessions marked “proposed” are a preview and are not saved until you Apply.');
  if (agenda.overdue.length) lines.push(`Overdue: ${agenda.overdue.map(t => t.title).join(', ')}.`);
  if (agenda.dueToday.length) lines.push(`Deadlines today: ${agenda.dueToday.map(t => `${t.title} (due ${clock12(t.dueTime)})`).join(', ')}.`);
  else {
    const upcoming = tasks.filter(t => !t.done && t.deadline > today).sort((a, b) => a.deadline.localeCompare(b.deadline));
    lines.push(upcoming.length ? `No deadlines today. Next due: ${upcoming[0].title} on ${longDate(upcoming[0].deadline)}.` : 'No deadlines today.');
  }
  return lines.join('\n');
}

/** One line for a task the preview could not fully place: minutes left and the specific reasons. */
export function unscheduledLine(task: TaskAllocation) {
  const reasons = task.reasons.map(r => r.message).join(' ');
  return `${task.title}: ${task.unallocatedMinutes} min not placed. ${reasons || 'No valid slot was found.'}`;
}

const MODE_LABEL: Record<SchedulePreview['mode'], string> = { generate: 'Proposed schedule', repair: 'Proposed repair', break: 'Proposed break', plan: 'Proposed plan with your new items' };

/** Human summary of a preview: the same sessions the calendar draws, what moves and why, and what did not fit. */
export function previewText(preview: SchedulePreview) {
  const added = preview.sessions.filter(s => s.change === 'new');
  const lines = [`${MODE_LABEL[preview.mode]}, ${longDate(preview.startDate)} – ${longDate(preview.endDate)} (${preview.timeZone}). Not saved yet.`];
  const byDay = new Map<string, ScheduleSession[]>();
  for (const s of added) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
  for (const [date, sessions] of byDay) {
    lines.push(longDate(date));
    for (const s of sessions) lines.push(sessionLine({ session: s, kind: 'saved' }));
  }
  const newEvents = preview.proposedEvents ?? [];
  if (newEvents.length) {
    lines.push('New fixed events (not moved by AutoPlan):');
    for (const e of newEvents) lines.push(`• ${longDate(e.date)} ${timeRange(e.start, e.end)} ${e.title}${e.repeats ? ' (weekly)' : ''}`);
  }
  if (!added.length) lines.push('No new sessions.');
  const busyDays = preview.days.filter(d => d.workMinutes > 0);
  if (busyDays.length > 1) lines.push(`Work by day: ${busyDays.map(d => `${longDate(d.date)} ${minutesLabel(d.workMinutes)}`).join('; ')}.`);
  const moved = preview.removed.filter(r => r.session.type === 'work');
  for (const r of moved) lines.push(`${r.newEndAt ? 'Shortens' : 'Moves'} ${r.session.title} (${timeRange(r.session.start, r.session.end)}, ${longDate(r.session.date)}): ${r.reason}`);
  for (const c of preview.conflicts) lines.push(`Conflict: ${c.message}`);
  const unscheduled = preview.tasks.filter(t => t.unallocatedMinutes > 0);
  if (unscheduled.length) {
    lines.push('Not fully scheduled:');
    lines.push(...unscheduled.map(t => `• ${unscheduledLine(t)}`));
    lines.push(preview.note);
  } else if (preview.tasks.length) {
    lines.push('All remaining work fits.');
  }
  return lines.join('\n');
}

/** "Why didn't X fit?" from the pending preview, or the saved schedule's coverage when there is none. */
export function explainText(preview: SchedulePreview | null, tasks: Task[], sessions: ScheduleSession[], now = new Date()) {
  if (preview) {
    const short = preview.tasks.filter(t => t.unallocatedMinutes > 0);
    if (!short.length) return 'Everything in the current proposal fits. Nothing is unscheduled.';
    return [...short.map(unscheduledLine), preview.note].join('\n');
  }
  const open = tasks.filter(t => !t.done);
  const lines = open.map(task => {
    const planned = sessions.filter(s => s.taskId === task.id && s.type === 'work' && s.status === 'saved' && new Date(s.endAt) > now)
      .reduce((sum, s) => sum + s.end - s.start, 0);
    const missing = task.remainingMinutes - planned;
    return missing > 0 ? `${task.title}: ${missing} of ${task.remainingMinutes} remaining min have no saved session yet.` : null;
  }).filter(Boolean);
  return lines.length ? `${lines.join('\n')}\nGenerate a schedule to see where it fits or why it can’t.` : 'All remaining work has saved sessions.';
}

export interface BusyItem {
  kind: 'event' | 'session';
  title: string;
  start: number;
  end: number;
  detail: string;
}

const EVENT_SOURCE: Record<CalendarEvent['source'], string> = { manual: '', google: ' · from Google Calendar', outlook: ' · from Outlook' };

/** Existing calendar events and saved sessions for each day in the range, kept apart: events are fixed, sessions are planned. */
export function busyItemsByDate(events: CalendarEvent[], sessions: ScheduleSession[], _tasks: Task[], startDate: string, days: number) {
  const byDate = new Map<string, BusyItem[]>();
  for (let offset = 0; offset < days; offset++) {
    const date = addDays(startDate, offset);
    const items: BusyItem[] = [
      ...occurrencesOn(events, date).map(({ event }) => ({
        kind: 'event' as const,
        title: event.title,
        start: event.start,
        end: event.end,
        detail: `fixed event (${event.kind.toLowerCase()})${event.location ? ` at ${event.location}` : ''}${EVENT_SOURCE[event.source]}`,
      })),
      ...sessions.filter(s => s.date === date && s.status !== 'cancelled').map(s => ({
        kind: 'session' as const,
        title: s.type === 'break' ? 'Break' : s.title,
        start: s.start,
        end: s.end,
        detail: s.type === 'break' ? 'saved break' : s.source === 'auto' ? 'planned work, saved by the scheduler' : 'planned work, placed by you',
      })),
    ];
    if (items.length) byDate.set(date, items.sort((a, b) => a.start - b.start));
  }
  return byDate;
}

/** Plain-language busy time for a date range, drawn only from the user's stored events and saved sessions. */
export function busyTimeText(events: CalendarEvent[], sessions: ScheduleSession[], tasks: Task[], startDate: string, days: number, hasCalendarConnection: boolean) {
  const endDate = addDays(startDate, days - 1);
  const byDate = busyItemsByDate(events, sessions, tasks, startDate, days);
  const span = `${longDate(startDate)} – ${longDate(endDate)}`;
  if (!byDate.size) {
    const note = hasCalendarConnection ? '' : ' No external calendar is connected, so only events added in AutoPlan appear.';
    return `Nothing is busy from ${span}: no events and no saved sessions.${note}`;
  }
  const lines = [`Busy time, ${span}:`];
  for (const [date, items] of byDate) {
    lines.push(longDate(date));
    for (const item of items) lines.push(`• ${timeRange(item.start, item.end)} ${item.title}, ${item.detail}`);
  }
  return lines.join('\n');
}
