import { addDays } from './dates.ts';
import type { Task } from '../types/models.ts';
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export function clockTime(minutes: number) { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }
export function parseClock(value: string) { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; }
export function dateInZone(zone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}-${parts.find(p => p.type === 'day')!.value}`;
}
export function minutesInZone(zone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
}
export function weekStart(date: string) { return addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7)); }
/** Monday = 0, matching the availability API. */
export function weekdayIndex(date: string) { return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; }

export type CalendarMode = 'day' | 'week' | 'month';
export function addMonths(date: string, count: number) {
  const [year, month] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + count, 1, 12));
  return target.toISOString().slice(0, 10);
}
/** Dates shown by each view; month view is a full 6-week grid so rows never jump in height. */
export function visibleDates(mode: CalendarMode, anchor: string) {
  if (mode === 'day') return [anchor];
  if (mode === 'week') { const start = weekStart(anchor); return Array.from({ length: 7 }, (_, i) => addDays(start, i)); }
  const start = weekStart(`${anchor.slice(0, 7)}-01`);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
export function shiftAnchor(mode: CalendarMode, anchor: string, direction: 1 | -1) {
  if (mode === 'day') return addDays(anchor, direction);
  if (mode === 'week') return addDays(anchor, 7 * direction);
  return addMonths(anchor, direction);
}

const utc = (date: string) => new Date(`${date}T12:00:00Z`);
const format = (date: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(utc(date));
export const monthName = (date: string) => format(date, { month: 'long' });
export const longDate = (date: string) => format(date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
export const shortWeekday = (date: string) => format(date, { weekday: 'short' });
/** Title for the visible range, e.g. "October 2026" or "Sep – Oct 2026" when a week spans two months. */
export function rangeTitle(mode: CalendarMode, anchor: string) {
  const dates = visibleDates(mode, anchor);
  if (mode === 'month') return format(anchor, { month: 'long', year: 'numeric' });
  const first = dates[0], last = dates[dates.length - 1];
  if (first.slice(0, 7) === last.slice(0, 7)) return format(first, { month: 'long', year: 'numeric' });
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${format(first, sameYear ? { month: 'short' } : { month: 'short', year: 'numeric' })} – ${format(last, { month: 'short', year: 'numeric' })}`;
}
export function clock12(minutes: number) {
  const hours = Math.floor(minutes / 60) % 24, mins = minutes % 60;
  return `${hours % 12 || 12}${mins ? `:${String(mins).padStart(2, '0')}` : ''} ${hours < 12 ? 'AM' : 'PM'}`;
}
export function tasksByDate(tasks: Task[]) {
  const map = new Map<string, Task[]>();
  for (const task of tasks) map.set(task.deadline, [...(map.get(task.deadline) ?? []), task]);
  for (const list of map.values()) list.sort((a, b) => Number(a.done) - Number(b.done) || 'HML'.indexOf(a.priority[0]) - 'HML'.indexOf(b.priority[0]));
  return map;
}
