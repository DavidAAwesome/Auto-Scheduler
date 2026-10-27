import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endsAfterDue, outsideAvailability, overlapping, plannedMinutes, sessionsByDate } from '../src/utils/planning.ts';
import { validateTask } from '../src/services/taskRules.ts';
import type { Availability, WorkSession } from '../src/types/models.ts';

/** A saved work session in the canonical shape the API returns. */
const work = (id: string, taskId: string, date: string, start: number, end: number): WorkSession => ({
  id, taskId, title: taskId, type: 'work', status: 'saved', locked: false, source: 'manual', scheduleVersion: 1,
  startAt: `${date}T00:00:00Z`, endAt: `${date}T00:00:00Z`, date, start, end,
});
const sessions: WorkSession[] = [
  work('a', 'hw', '2026-10-06', 600, 630),
  work('b', 'hw', '2026-10-07', 540, 690),
  work('c', 'essay', '2026-10-07', 480, 540),
];

test('planned minutes add up across days, so a 3h task can be 30m + 2h30m', () => {
  assert.equal(plannedMinutes('hw', sessions), 180);
  assert.equal(plannedMinutes('essay', sessions), 60);
  assert.equal(plannedMinutes('none', sessions), 0);
  // Cancelled sessions and breaks do not count as planned work.
  assert.equal(plannedMinutes('hw', [...sessions, { ...work('d', 'hw', '2026-10-08', 600, 660), status: 'cancelled' }]), 180);
});

test('sessions must finish by the due time; 11:59 PM allows working until midnight', () => {
  const task = { deadline: '2026-10-09', dueTime: 17 * 60 };
  assert.equal(endsAfterDue({ date: '2026-10-08', end: 1440 }, task), false);
  assert.equal(endsAfterDue({ date: '2026-10-09', end: 17 * 60 }, task), false);
  assert.equal(endsAfterDue({ date: '2026-10-09', end: 17 * 60 + 5 }, task), true);
  assert.equal(endsAfterDue({ date: '2026-10-10', end: 600 }, task), true);
  assert.equal(endsAfterDue({ date: '2026-10-09', end: 1440 }, { deadline: '2026-10-09', dueTime: 1439 }), false);
});

test('overlap detection ignores back-to-back sessions and the session being edited', () => {
  const input = { taskId: 'x', date: '2026-10-07', start: 500, end: 530 };
  assert.equal(overlapping(input, sessions)?.id, 'c');
  assert.equal(overlapping({ ...input, start: 690, end: 720 }, sessions), undefined);
  assert.equal(overlapping({ ...input, start: 480, end: 540 }, sessions, 'c'), undefined);
});

test('sessions outside available hours are flagged', () => {
  const availability: Availability = { timeZone: 'UTC', reminders: false, days: Array.from({ length: 7 }, (_, day) => ({ day, enabled: day < 5, start: 540, end: 1020 })) };
  assert.equal(outsideAvailability({ date: '2026-10-06', start: 600, end: 660 }, availability), false);
  assert.equal(outsideAvailability({ date: '2026-10-06', start: 480, end: 600 }, availability), true);
  assert.equal(outsideAvailability({ date: '2026-10-10', start: 600, end: 660 }, availability), true); // Saturday off
  assert.equal(outsideAvailability({ date: '2026-10-10', start: 600, end: 660 }, null), false);
});

test('sessions group by day in start order', () => {
  assert.deepEqual(sessionsByDate(sessions).get('2026-10-07')!.map(s => s.id), ['c', 'b']);
});

test('tasks accept multi-day estimates and an optional due time', () => {
  const base = {
    title: 'Project', deadline: '2026-10-20', priority: 'High', category: 'Project',
    earliestStart: null, allowSplit: true, minSessionMinutes: 15, maxSessionMinutes: 60, dependsOn: [],
  } as const;
  assert.doesNotThrow(() => validateTask({ ...base, minutes: 40 * 60, completedMinutes: 0, dueTime: 1439 }));
  assert.throws(() => validateTask({ ...base, minutes: 6015, completedMinutes: 0, dueTime: 1439 }), /100 hours/);
  assert.throws(() => validateTask({ ...base, minutes: 60, completedMinutes: 0, dueTime: 1440 }), /due time/);
  assert.throws(() => validateTask({ ...base, minutes: 60, completedMinutes: -5, dueTime: 1439 }), /Completed time/);
});

test('wall-clock times convert to UTC instants in the user zone, including DST change days', async () => {
  const { zonedInstant } = await import('../src/utils/planning.ts');
  assert.equal(zonedInstant('2026-10-06', 9 * 60, 'America/New_York'), '2026-10-06T13:00:00.000Z'); // EDT, UTC-4
  assert.equal(zonedInstant('2026-12-01', 9 * 60, 'America/New_York'), '2026-12-01T14:00:00.000Z'); // EST, UTC-5
  assert.equal(zonedInstant('2026-11-01', 12 * 60, 'America/New_York'), '2026-11-01T17:00:00.000Z'); // fall-back day, afternoon
  assert.equal(zonedInstant('2026-10-06', 1440, 'Etc/GMT'), '2026-10-07T00:00:00.000Z'); // end-of-day midnight
});
