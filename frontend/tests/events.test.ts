import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventClash, layoutLanes, occurrenceCount, occurrencesOn, occursOn } from '../src/utils/events.ts';
import { validateEvent } from '../src/services/taskRules.ts';
import type { CalendarEvent } from '../src/types/models.ts';

// CS class Mon/Wed 10:00-11:20, Oct 5 - Dec 9 2026, with the Oct 12 class cancelled.
const cls: CalendarEvent = {
  id: 'cls', title: 'CS 450', kind: 'Class', date: '2026-10-05', start: 600, end: 680, location: 'Room 204',
  repeat: { weekdays: [0, 2], until: '2026-12-09' }, skipDates: ['2026-10-12'], source: 'manual',
};
const meetup: CalendarEvent = { ...cls, id: 'meet', title: 'Team meetup', kind: 'Social', date: '2026-10-08', start: 1080, end: 1200, repeat: null, skipDates: [] };

test('weekly events occur on their weekdays between the first and last date, minus skipped ones', () => {
  assert.equal(occursOn(cls, '2026-10-05'), true);   // Mon
  assert.equal(occursOn(cls, '2026-10-07'), true);   // Wed
  assert.equal(occursOn(cls, '2026-10-06'), false);  // Tue
  assert.equal(occursOn(cls, '2026-10-12'), false);  // cancelled
  assert.equal(occursOn(cls, '2026-12-09'), true);   // last day
  assert.equal(occursOn(cls, '2026-12-14'), false);  // after until
  assert.equal(occursOn(cls, '2026-09-30'), false);  // before start
  assert.equal(occursOn(meetup, '2026-10-08'), true);
  assert.equal(occursOn(meetup, '2026-10-15'), false);
});

test('a semester of Mon/Wed classes is counted for the form summary', () => {
  assert.equal(occurrenceCount(cls), 19); // 20 class days (Oct 5 - Dec 9), one cancelled
  assert.equal(occurrenceCount(meetup), 1);
});

test('occurrences for a day are sorted, and clashes find events in a time range', () => {
  const both = { ...meetup, date: '2026-10-07', start: 540, end: 570 };
  assert.deepEqual(occurrencesOn([cls, both], '2026-10-07').map(o => o.event.id), ['meet', 'cls']);
  assert.equal(eventClash([cls], '2026-10-07', 660, 720)?.id, 'cls');
  assert.equal(eventClash([cls], '2026-10-07', 680, 720), undefined); // starts right after class
  assert.equal(eventClash([cls], '2026-10-12', 600, 680), undefined); // cancelled class frees the slot
});

test('overlapping blocks share the column side by side; separate ones use the full width', () => {
  const a = { start: 540, end: 600 }, b = { start: 570, end: 660 }, c = { start: 600, end: 630 }, d = { start: 700, end: 760 };
  const lanes = layoutLanes([a, b, c, d]);
  assert.deepEqual(lanes.get(a), { lane: 0, lanes: 2 });
  assert.deepEqual(lanes.get(b), { lane: 1, lanes: 2 });
  assert.deepEqual(lanes.get(c), { lane: 0, lanes: 2 }); // reuses lane 0 once a has ended
  assert.deepEqual(lanes.get(d), { lane: 0, lanes: 1 });
});

test('event validation', () => {
  const input = { title: 'CS 450', kind: 'Class', date: '2026-10-05', start: 600, end: 680, location: null, repeat: null } as const;
  assert.doesNotThrow(() => validateEvent(input));
  assert.throws(() => validateEvent({ ...input, title: ' ' }), /name/);
  assert.throws(() => validateEvent({ ...input, end: 600 }), /end after/);
  assert.throws(() => validateEvent({ ...input, repeat: { weekdays: [], until: '2026-12-09' } }), /at least one day/);
  assert.throws(() => validateEvent({ ...input, repeat: { weekdays: [0], until: '2026-10-01' } }), /on or after/);
});
