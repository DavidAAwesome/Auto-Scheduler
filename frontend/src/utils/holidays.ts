/** Holidays and observances AutoPlan works out on its own (no external service): US federal holidays and
 * common observances, Election Day, and daylight-saving clock changes for the user's own time zone.
 * They're show-only: they appear on the calendar but never block time. */
import { addDays } from './dates.ts';

export interface Observance {
  date: string;
  title: string;
  /** holiday = US federal holiday; observance = widely marked day; dst = clocks change in your time zone. */
  kind: 'holiday' | 'observance' | 'dst';
  note?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;
/** 0 = Sunday … 6 = Saturday. */
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** The nth (1-based) given weekday of a month, e.g. the 4th Thursday of November. */
export function nthWeekday(year: number, month: number, day: number, n: number) {
  const first = ymd(year, month, 1);
  return addDays(first, ((day - weekday(first) + 7) % 7) + (n - 1) * 7);
}
/** The last given weekday of a month, e.g. the last Monday of May. */
export function lastWeekday(year: number, month: number, day: number) {
  const last = addDays(month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1), -1);
  return addDays(last, -((weekday(last) - day + 7) % 7));
}
/** Western (Gregorian) Easter Sunday: the "anonymous Gregorian" computus. */
export function easter(year: number) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}
/** US Election Day: the Tuesday after the first Monday in November (so Nov 2–8). */
export function electionDay(year: number) {
  return addDays(nthWeekday(year, 11, 1, 1), 1);
}

/** When a fixed-date federal holiday falls on a weekend, the day off is the Friday before or the Monday after. */
function withObserved(date: string, title: string): Observance[] {
  const day = weekday(date);
  const observed = day === 6 ? addDays(date, -1) : day === 0 ? addDays(date, 1) : null;
  const holiday: Observance = { date, title, kind: 'holiday' };
  return observed ? [holiday, { date: observed, title: `${title} (observed)`, kind: 'holiday', note: 'Federal day off for the weekend holiday.' }] : [holiday];
}

export function usObservances(year: number): Observance[] {
  const easterSunday = easter(year);
  return [
    ...withObserved(ymd(year, 1, 1), "New Year's Day"),
    { date: nthWeekday(year, 1, 1, 3), title: 'Martin Luther King Jr. Day', kind: 'holiday' },
    { date: ymd(year, 2, 14), title: "Valentine's Day", kind: 'observance' },
    { date: nthWeekday(year, 2, 1, 3), title: "Presidents' Day", kind: 'holiday' },
    { date: ymd(year, 3, 17), title: "St. Patrick's Day", kind: 'observance' },
    { date: addDays(easterSunday, -2), title: 'Good Friday', kind: 'observance' },
    { date: easterSunday, title: 'Easter Sunday', kind: 'observance' },
    { date: nthWeekday(year, 5, 0, 2), title: "Mother's Day", kind: 'observance' },
    { date: lastWeekday(year, 5, 1), title: 'Memorial Day', kind: 'holiday' },
    { date: nthWeekday(year, 6, 0, 3), title: "Father's Day", kind: 'observance' },
    ...withObserved(ymd(year, 6, 19), 'Juneteenth'),
    ...withObserved(ymd(year, 7, 4), 'Independence Day'),
    { date: nthWeekday(year, 9, 1, 1), title: 'Labor Day', kind: 'holiday' },
    { date: nthWeekday(year, 10, 1, 2), title: "Columbus Day / Indigenous Peoples' Day", kind: 'holiday' },
    { date: ymd(year, 10, 31), title: 'Halloween', kind: 'observance' },
    {
      date: electionDay(year), title: 'Election Day', kind: 'observance',
      note: year % 2 === 0 ? 'US general election.' : 'Many states and cities hold local elections this year.',
    },
    ...withObserved(ymd(year, 11, 11), 'Veterans Day'),
    { date: nthWeekday(year, 11, 4, 4), title: 'Thanksgiving', kind: 'holiday' },
    { date: ymd(year, 12, 24), title: 'Christmas Eve', kind: 'observance' },
    ...withObserved(ymd(year, 12, 25), 'Christmas Day'),
    { date: ymd(year, 12, 31), title: "New Year's Eve", kind: 'observance' },
  ];
}

/** Minutes the zone is ahead of UTC at local noon on `date`. */
function offsetAtNoon(date: string, zone: string) {
  const [year, month, day] = date.split('-').map(Number);
  const instant = Date.UTC(year, month - 1, day, 12);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(instant)).map(p => [p.type, Number(p.value)]));
  return Math.round((Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - instant) / 60_000);
}

const dstCache = new Map<string, Observance[]>();
/** Days the clocks change in `zone` during `year` (none for zones without daylight saving). Clocks change overnight,
 * so the change belongs to the day whose noon offset differs from the day before. */
export function dstChanges(year: number, zone: string): Observance[] {
  const key = `${zone}|${year}`;
  const cached = dstCache.get(key);
  if (cached) return cached;
  const changes: Observance[] = [];
  let previous = offsetAtNoon(ymd(year - 1, 12, 31), zone);
  for (let date = ymd(year, 1, 1); date.startsWith(String(year)); date = addDays(date, 1)) {
    const offset = offsetAtNoon(date, zone);
    if (offset !== previous) {
      const hours = Math.abs(offset - previous) / 60;
      const amount = hours === 1 ? '1 hour' : `${hours} hours`;
      changes.push(offset > previous
        ? { date, title: 'Daylight saving time begins', kind: 'dst', note: `Clocks spring forward ${amount} overnight (${zone}).` }
        : { date, title: 'Daylight saving time ends', kind: 'dst', note: `Clocks fall back ${amount} overnight (${zone}).` });
    }
    previous = offset;
  }
  dstCache.set(key, changes);
  return changes;
}

/** Everything between two dates (inclusive), sorted: US holidays and observances plus your zone's clock changes. */
export function observancesBetween(startDate: string, endDate: string, zone: string): Observance[] {
  const all: Observance[] = [];
  for (let year = Number(startDate.slice(0, 4)); year <= Number(endDate.slice(0, 4)); year++) {
    all.push(...usObservances(year), ...dstChanges(year, zone));
  }
  const order = { dst: 0, holiday: 1, observance: 2 };
  return all.filter(o => o.date >= startDate && o.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || a.title.localeCompare(b.title));
}
