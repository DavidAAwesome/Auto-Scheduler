import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dstChanges, easter, electionDay, lastWeekday, nthWeekday, observancesBetween, usObservances } from '../src/utils/holidays.ts';

test('Election Day is the Tuesday after the first Monday in November', () => {
  assert.equal(electionDay(2026), '2026-11-03');
  assert.equal(electionDay(2024), '2024-11-05');
  assert.equal(electionDay(2022), '2022-11-08'); // Nov 1 was a Tuesday, so not Nov 1
  assert.equal(electionDay(2027), '2027-11-02');
});

test('rule-based holidays land on the right dates', () => {
  assert.equal(nthWeekday(2026, 11, 4, 4), '2026-11-26'); // Thanksgiving
  assert.equal(nthWeekday(2026, 1, 1, 3), '2026-01-19'); // MLK Day
  assert.equal(nthWeekday(2026, 9, 1, 1), '2026-09-07'); // Labor Day
  assert.equal(lastWeekday(2026, 5, 1), '2026-05-25'); // Memorial Day
  assert.equal(easter(2026), '2026-04-05');
  assert.equal(easter(2027), '2027-03-28');
  assert.equal(easter(2025), '2025-04-20');
});

test('fixed-date federal holidays on a weekend get an observed weekday', () => {
  const titles = (year: number, date: string) => usObservances(year).filter(o => o.date === date).map(o => o.title);
  assert.deepEqual(titles(2026, '2026-07-03'), ['Independence Day (observed)']); // July 4 2026 is a Saturday
  assert.deepEqual(titles(2027, '2027-12-24'), ['Christmas Eve', 'Christmas Day (observed)']); // Dec 25 2027 is a Saturday
  assert.deepEqual(titles(2026, '2026-11-11'), ['Veterans Day']); // a Wednesday: no extra day
});

test('daylight-saving changes come from the user zone, so they are right anywhere', () => {
  assert.deepEqual(dstChanges(2026, 'America/New_York').map(o => [o.date, o.title]),
    [['2026-03-08', 'Daylight saving time begins'], ['2026-11-01', 'Daylight saving time ends']]);
  assert.deepEqual(dstChanges(2026, 'Europe/London').map(o => o.date), ['2026-03-29', '2026-10-25']);
  assert.deepEqual(dstChanges(2026, 'America/Phoenix'), []); // Arizona doesn't change clocks
  assert.deepEqual(dstChanges(2026, 'Australia/Sydney').map(o => o.title), ['Daylight saving time ends', 'Daylight saving time begins']);
});

test('a date range lists everything in order, across a year boundary', () => {
  const nov = observancesBetween('2026-11-01', '2026-11-30', 'America/New_York').map(o => `${o.date} ${o.title}`);
  assert.deepEqual(nov, ['2026-11-01 Daylight saving time ends', '2026-11-03 Election Day', '2026-11-11 Veterans Day', '2026-11-26 Thanksgiving']);
  const newYear = observancesBetween('2026-12-31', '2027-01-01', 'America/New_York').map(o => o.title);
  assert.deepEqual(newYear, ["New Year's Eve", "New Year's Day"]);
});
