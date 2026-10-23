import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromGoogle, fromOutlook, localSegments, syncRange } from '../src/utils/externalCalendar.ts';

const NY = 'America/New_York';

test('external events convert to local day blocks, split at midnight, on a 5-minute grid', () => {
  assert.deepEqual(localSegments(new Date('2026-10-21T13:00:00Z'), new Date('2026-10-21T14:30:00Z'), NY),
    [{ date: '2026-10-21', start: 540, end: 630 }]);
  // 10 PM to 1 AM local crosses midnight.
  assert.deepEqual(localSegments(new Date('2026-10-22T02:00:00Z'), new Date('2026-10-22T05:00:00Z'), NY),
    [{ date: '2026-10-21', start: 1320, end: 1440 }, { date: '2026-10-22', start: 0, end: 60 }]);
  // Ending exactly at midnight doesn't create an empty next-day block; odd minutes widen to the grid.
  assert.deepEqual(localSegments(new Date('2026-10-22T03:02:00Z'), new Date('2026-10-22T04:00:00Z'), NY),
    [{ date: '2026-10-21', start: 1380, end: 1440 }]);
  assert.deepEqual(localSegments(new Date('2026-10-21T13:00:00Z'), new Date('2026-10-21T13:00:00Z'), NY), []);
});

test('Google: timed busy events import; all-day, free, cancelled and declined ones are skipped', () => {
  const base = { id: 'g1', summary: 'Standup', start: { dateTime: '2026-10-21T09:00:00-04:00' }, end: { dateTime: '2026-10-21T09:30:00-04:00' },
    htmlLink: 'https://calendar.google.com/event?eid=1', location: ' Zoom ' };
  assert.deepEqual(fromGoogle(base, 'Work', NY), [{ externalId: 'g1', title: 'Standup', kind: 'Other', date: '2026-10-21', start: 540, end: 570,
    location: 'Zoom', calendarName: 'Work', link: 'https://calendar.google.com/event?eid=1' }]);
  assert.equal(fromGoogle({ ...base, attendees: [{ self: true }, {}] }, 'Work', NY)[0].kind, 'Meeting');
  assert.deepEqual(fromGoogle({ ...base, start: { date: '2026-10-21' }, end: { date: '2026-10-22' } }, 'Work', NY), []);
  assert.deepEqual(fromGoogle({ ...base, transparency: 'transparent' }, 'Work', NY), []);
  assert.deepEqual(fromGoogle({ ...base, status: 'cancelled' }, 'Work', NY), []);
  assert.deepEqual(fromGoogle({ ...base, attendees: [{ self: true, responseStatus: 'declined' }] }, 'Work', NY), []);
  assert.equal(fromGoogle({ ...base, summary: undefined, htmlLink: 'http://x' }, 'Work', NY)[0].title, '(No title)');
  assert.equal(fromGoogle({ ...base, htmlLink: 'http://x' }, 'Work', NY)[0].link, null);
});

test('Outlook: Graph UTC times (no Z) convert correctly; all-day, free and declined are skipped', () => {
  const base = { id: 'o1', subject: 'Advisor meeting', start: { dateTime: '2026-10-23T15:00:00.0000000' }, end: { dateTime: '2026-10-23T15:45:00.0000000' },
    location: { displayName: 'Room 12' }, attendees: [{}], webLink: 'https://outlook.office365.com/owa/?itemid=1' };
  assert.deepEqual(fromOutlook(base, NY), [{ externalId: 'o1', title: 'Advisor meeting', kind: 'Meeting', date: '2026-10-23', start: 660, end: 705,
    location: 'Room 12', calendarName: 'Outlook', link: 'https://outlook.office365.com/owa/?itemid=1' }]);
  assert.deepEqual(fromOutlook({ ...base, isAllDay: true }, NY), []);
  assert.deepEqual(fromOutlook({ ...base, showAs: 'free' }, NY), []);
  assert.deepEqual(fromOutlook({ ...base, isCancelled: true }, NY), []);
  assert.deepEqual(fromOutlook({ ...base, responseStatus: { response: 'declined' } }, NY), []);
});

test('sync covers one week back and eight weeks ahead', () => {
  assert.deepEqual(syncRange('2026-10-23'), { rangeStart: '2026-10-16', rangeEnd: '2026-12-18' });
});
