import { addDays } from './dates.ts';
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export function clockTime(minutes: number) { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }
export function parseClock(value: string) { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; }
export function dateInZone(zone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}-${parts.find(p => p.type === 'day')!.value}`;
}
export function weekStart(date: string) { return addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7)); }
