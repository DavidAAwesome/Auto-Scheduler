import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReminders, dueReminders, leadLabel, nextFireAt, pruneShown, startsIn, LATE_GRACE_MS, type ReminderInput } from '../src/utils/reminders.ts';
import { normalizeAvailability } from '../src/utils/availability.ts';
import { DEFAULT_DUE_TIME, type Availability, type CalendarEvent, type ScheduleSession } from '../src/types/models.ts';

// New York is UTC-5 on 2026-11-11, so 9:00 AM local = 14:00Z.
const ZONE = 'America/New_York';
const TODAY = '2026-11-11';
const TOMORROW = '2026-11-12';
const at = (iso: string) => Date.parse(iso);
const MIN = 60_000;

function session(id: string, startAt: string, endAt: string, extra: Partial<ScheduleSession> = {}): ScheduleSession {
  return { id, taskId: 't1', title: 'Essay', type: 'work', status: 'saved', locked: false, source: 'auto', scheduleVersion: 1,
    startAt, endAt, date: TODAY, start: 0, end: 0, ...extra };
}
function event(extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: 'e1', title: 'Calculus', kind: 'Class', date: TODAY, start: 13 * 60, end: 14 * 60, location: 'Room 4', repeat: null, skipDates: [], source: 'manual', ...extra };
}
const task = (extra: Partial<ReminderInput['tasks'][number]> = {}) => ({ id: 't1', title: 'Essay', deadline: '2026-11-20', dueTime: DEFAULT_DUE_TIME, done: false, ...extra });
const input = (extra: Partial<ReminderInput> = {}): ReminderInput => ({
  tasks: [task()], sessions: [], events: [], zone: ZONE, leadMinutes: 15, now: at('2026-11-11T13:00:00Z'), ...extra,
});

test('a saved work session is reminded the lead time before it starts', () => {
  const [r] = buildReminders(input({ sessions: [session('s1', '2026-11-11T15:00:00Z', '2026-11-11T15:50:00Z')] }));
  assert.equal(r.kind, 'session');
  assert.equal(r.startsAt, at('2026-11-11T15:00:00Z'));
  assert.equal(r.fireAt, at('2026-11-11T14:45:00Z'));
  assert.equal(r.title, 'Work on Essay');
  assert.equal(r.body, 'Work session at 10:00 AM until 10:50 AM');
});

test('breaks, proposed sessions and sessions of finished tasks are not reminded', () => {
  const sessions = [
    session('b', '2026-11-11T15:00:00Z', '2026-11-11T15:10:00Z', { type: 'break', taskId: null }),
    session('p', '2026-11-11T16:00:00Z', '2026-11-11T16:50:00Z', { status: 'proposed' }),
    session('c', '2026-11-11T17:00:00Z', '2026-11-11T17:50:00Z', { status: 'completed' }),
  ];
  assert.deepEqual(buildReminders(input({ sessions })), []);
  const done = buildReminders(input({ tasks: [task({ done: true })], sessions: [session('s', '2026-11-11T15:00:00Z', '2026-11-11T15:50:00Z')] }));
  assert.deepEqual(done, []);
});

test('events are reminded in the account time zone, today and tomorrow only', () => {
  const weekly = event({ repeat: { weekdays: [2, 3], until: '2026-12-31' } }); // Wednesday and Thursday
  const reminders = buildReminders(input({ events: [weekly] }));
  assert.deepEqual(reminders.map(r => r.startsAt), [at('2026-11-11T18:00:00Z'), at('2026-11-12T18:00:00Z')]);
  assert.equal(reminders[0].fireAt, at('2026-11-11T17:45:00Z'));
  assert.equal(reminders[0].body, 'Class at 1:00 PM · Room 4');
  assert.notEqual(reminders[0].key, reminders[1].key);
});

test('all-day items and skipped occurrences are not reminded', () => {
  assert.deepEqual(buildReminders(input({ events: [event({ allDay: true, start: 0, end: 1440 })] })), []);
  assert.deepEqual(buildReminders(input({ events: [event({ skipDates: [TODAY] })] })), []);
});

test('a task with no due time is reminded at 9 AM on its due day', () => {
  const [r] = buildReminders(input({ tasks: [task({ deadline: TODAY })] }));
  assert.equal(r.kind, 'due');
  assert.equal(r.fireAt, at('2026-11-11T14:00:00Z'));
  assert.equal(r.title, 'Essay is due today');
  assert.equal(r.body, 'Due by the end of the day');
});

test('a task with a due time is reminded at least an hour before, or earlier with a longer lead', () => {
  const due = task({ deadline: TOMORROW, dueTime: 12 * 60 });
  const [hour] = buildReminders(input({ tasks: [due] }));
  assert.equal(hour.startsAt, at('2026-11-12T17:00:00Z'));
  assert.equal(hour.fireAt, at('2026-11-12T16:00:00Z'));
  assert.equal(hour.title, 'Essay is due tomorrow');
  const [early] = buildReminders(input({ tasks: [due], leadMinutes: 120 }));
  assert.equal(early.fireAt, at('2026-11-12T15:00:00Z'));
});

test('tasks due later than tomorrow, or already done, get no due reminder', () => {
  assert.deepEqual(buildReminders(input({ tasks: [task({ deadline: '2026-11-13' })] })), []);
  assert.deepEqual(buildReminders(input({ tasks: [task({ deadline: TODAY, done: true })] })), []);
});

test('a reminder is due from its fire time until shortly after the start, and only once', () => {
  const reminders = buildReminders(input({ sessions: [session('s1', '2026-11-11T15:00:00Z', '2026-11-11T15:50:00Z')] }));
  const [r] = reminders;
  assert.deepEqual(dueReminders(reminders, r.fireAt - 1, new Set()), []);
  assert.deepEqual(dueReminders(reminders, r.fireAt, new Set()), [r]);
  assert.deepEqual(dueReminders(reminders, r.startsAt + LATE_GRACE_MS - 1, new Set()), [r]);
  assert.deepEqual(dueReminders(reminders, r.startsAt + LATE_GRACE_MS, new Set()), [], 'stale after the grace period');
  assert.deepEqual(dueReminders(reminders, r.fireAt, new Set([r.key])), [], 'already shown');
});

test('a due-date reminder stops once the task is due', () => {
  const reminders = buildReminders(input({ tasks: [task({ deadline: TODAY, dueTime: 17 * 60 })] }));
  assert.equal(dueReminders(reminders, at('2026-11-11T21:59:00Z'), new Set()).length, 1);
  assert.equal(dueReminders(reminders, at('2026-11-11T22:00:00Z'), new Set()).length, 0);
});

test('lead time 0 reminds when the item starts', () => {
  const [r] = buildReminders(input({ leadMinutes: 0, sessions: [session('s1', '2026-11-11T15:00:00Z', '2026-11-11T15:50:00Z')] }));
  assert.equal(r.fireAt, r.startsAt);
});

test('a moved session gets a new key, so it is reminded again', () => {
  const [before] = buildReminders(input({ sessions: [session('s1', '2026-11-11T15:00:00Z', '2026-11-11T15:50:00Z')] }));
  const [after] = buildReminders(input({ sessions: [session('s1', '2026-11-11T16:00:00Z', '2026-11-11T16:50:00Z')] }));
  assert.notEqual(before.key, after.key);
});

test('nextFireAt finds the next unshown reminder', () => {
  const reminders = buildReminders(input({ sessions: [
    session('s1', '2026-11-11T15:00:00Z', '2026-11-11T15:50:00Z'),
    session('s2', '2026-11-11T17:00:00Z', '2026-11-11T17:50:00Z'),
  ] }));
  const now = at('2026-11-11T13:00:00Z');
  assert.equal(nextFireAt(reminders, now, new Set()), at('2026-11-11T14:45:00Z'));
  assert.equal(nextFireAt(reminders, now, new Set([reminders[0].key])), at('2026-11-11T16:45:00Z'));
  assert.equal(nextFireAt(reminders, at('2026-11-11T18:00:00Z'), new Set()), null);
});

test('pruneShown forgets items that started over two days ago', () => {
  const now = at('2026-11-11T12:00:00Z');
  assert.deepEqual(pruneShown({ old: now - 3 * 24 * 60 * MIN, recent: now - 60 * MIN, future: now + MIN }, now), { recent: now - 60 * MIN, future: now + MIN });
});

test('labels read naturally', () => {
  assert.equal(leadLabel(0), 'when it starts');
  assert.equal(leadLabel(15), '15 min before');
  assert.equal(leadLabel(60), '1 h before');
  const now = at('2026-11-11T12:00:00Z');
  assert.equal(startsIn(now, now), 'now');
  assert.equal(startsIn(now + 15 * MIN, now), 'in 15 min');
  assert.equal(startsIn(now + 90 * MIN, now), 'in 1 h 30 min');
  assert.equal(startsIn(now + 120 * MIN, now), 'in 2 h');
});

test('availability saved before reminder times existed defaults to 15 minutes', () => {
  const legacy = { days: [], weekOverrides: [], timeZone: ZONE, reminders: true } as unknown as Availability;
  assert.equal(normalizeAvailability(legacy).reminderMinutes, 15);
  assert.equal(normalizeAvailability({ ...legacy, reminderMinutes: 0 }).reminderMinutes, 0);
});
