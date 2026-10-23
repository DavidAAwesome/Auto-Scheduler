import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, clock12, rangeTitle, shiftAnchor, tasksByDate, visibleDates, weekdayIndex } from '../src/utils/calendar.ts';
import { duration } from '../src/utils/taskDisplay.ts';
import type { Task } from '../src/types/models.ts';

test('day, week and month views show the right dates', () => {
  assert.deepEqual(visibleDates('day', '2026-10-07'), ['2026-10-07']);
  const week = visibleDates('week', '2026-10-07');
  assert.equal(week[0], '2026-10-05'); // Monday
  assert.equal(week[6], '2026-10-11');
  const month = visibleDates('month', '2026-10-20');
  assert.equal(month.length, 42);
  assert.equal(month[0], '2026-09-28'); // Monday before Oct 1
  assert.ok(month.includes('2026-10-31'));
});

test('navigation steps by the visible unit and clamps month ends', () => {
  assert.equal(shiftAnchor('day', '2026-12-31', 1), '2027-01-01');
  assert.equal(shiftAnchor('week', '2026-10-07', -1), '2026-09-30');
  assert.equal(shiftAnchor('month', '2026-01-31', 1), '2026-02-01');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-01');
});

test('titles name the visible month, or both months when a week spans two', () => {
  assert.equal(rangeTitle('week', '2026-10-07'), 'October 2026');
  assert.equal(rangeTitle('week', '2026-09-30'), 'Sep – Oct 2026');
  assert.equal(rangeTitle('week', '2026-12-30'), 'Dec 2026 – Jan 2027');
  assert.equal(rangeTitle('month', '2026-10-20'), 'October 2026');
});

test('time and duration formatting', () => {
  assert.equal(clock12(0), '12 AM');
  assert.equal(clock12(9 * 60), '9 AM');
  assert.equal(clock12(13 * 60 + 30), '1:30 PM');
  assert.equal(duration(45), '45m');
  assert.equal(duration(90), '1h 30m');
  assert.equal(duration(120), '2h');
  assert.equal(weekdayIndex('2026-10-05'), 0);
  assert.equal(weekdayIndex('2026-10-11'), 6);
});

test('tasks group by due date with open, high-priority tasks first', () => {
  const base = { deadline: '2026-10-07', minutes: 60, category: 'Study' } as const;
  const tasks: Task[] = [
    { ...base, id: 'a', title: 'Low', priority: 'Low', done: false },
    { ...base, id: 'b', title: 'Done high', priority: 'High', done: true },
    { ...base, id: 'c', title: 'High', priority: 'High', done: false },
    { ...base, id: 'd', title: 'Other day', priority: 'Medium', done: false, deadline: '2026-10-08' },
  ];
  const map = tasksByDate(tasks);
  assert.deepEqual(map.get('2026-10-07')!.map(t => t.id), ['c', 'a', 'b']);
  assert.deepEqual(map.get('2026-10-08')!.map(t => t.id), ['d']);
});
