import { addDays } from "./dates.ts";
import { weekStart } from "./calendar.ts";

export type CalendarView = "day" | "week" | "month";

export function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}

export function monthLabel(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

export function dayLabel(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

/** Shift the anchor date by one unit of the active calendar view. */
export function shiftAnchor(date: string, view: CalendarView, delta: number) {
  if (view === "day") return addDays(date, delta);
  if (view === "week") return addDays(date, delta * 7);
  const [year, month] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  return next.toISOString().slice(0, 10);
}

export function monthGrid(anchor: string) {
  const start = monthStart(anchor);
  const gridStart = weekStart(start);
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

export function datesInView(anchor: string, view: CalendarView) {
  if (view === "day") return [anchor];
  if (view === "week") {
    const start = weekStart(anchor);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }
  return monthGrid(anchor);
}
