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

test('next occurrence skips cancelled classes and ends with the series', async () => {
  const { nextOccurrence } = await import('../src/utils/events.ts');
  assert.equal(nextOccurrence(cls, '2026-10-12'), '2026-10-14'); // Oct 12 is skipped, next is Wed
  assert.equal(nextOccurrence(cls, '2026-10-01'), '2026-10-05'); // before the series starts
  assert.equal(nextOccurrence(cls, '2026-12-10'), null); // after the last class
  assert.equal(nextOccurrence(meetup, '2026-10-08'), '2026-10-08');
  assert.equal(nextOccurrence(meetup, '2026-10-09'), null);
});

test('sidebar groups: one-time upcoming by date, each series once, past most recent first', async () => {
  const { groupEvents } = await import('../src/utils/events.ts');
  const early = { ...meetup, id: 'early', date: '2026-10-07', start: 540 };
  const old = { ...meetup, id: 'old', date: '2026-10-01' };
  const ended = { ...cls, id: 'ended', repeat: { weekdays: [1], until: '2026-10-06' } };
  const { upcoming, repeating, past } = groupEvents([meetup, cls, early, old, ended], '2026-10-07');
  assert.deepEqual(upcoming.map(e => e.event.id), ['early', 'meet']);
  assert.deepEqual(repeating.map(e => [e.event.id, e.date]), [['cls', '2026-10-07']]);
  assert.deepEqual(past.map(e => [e.event.id, e.date]), [['ended', '2026-10-06'], ['old', '2026-10-01']]);
});

test('an imported multi-day event is listed once, as a span', async () => {
  const { groupEvents } = await import('../src/utils/events.ts');
  const piece = (id: string, date: string, start: number, end: number) =>
    ({ ...meetup, id, title: 'Wolfjam 2026', source: 'google' as const, busy: false, location: 'ETEC', date, start, end });
  const pieces = [piece('a', '2026-11-06', 600, 1440), piece('b', '2026-11-07', 0, 1440), piece('c', '2026-11-08', 0, 960)];
  const { upcoming } = groupEvents([...pieces, { ...meetup, date: '2026-11-07' }], '2026-11-04');
  assert.deepEqual(upcoming.map(e => [e.event.id, e.date, e.through]), [
    ['a', '2026-11-06', { date: '2026-11-08', end: 960 }],
    ['meet', '2026-11-07', undefined],
  ]);
  // From the middle of the span, the remaining days still show as one row.
  assert.deepEqual(groupEvents(pieces, '2026-11-07').upcoming.map(e => [e.date, e.through?.date]), [['2026-11-07', '2026-11-08']]);
  // A different event with a gap day is not merged.
  const gap = groupEvents([piece('a', '2026-11-06', 600, 1440), piece('x', '2026-11-08', 0, 960)], '2026-11-04').upcoming;
  assert.equal(gap.length, 2);
});
