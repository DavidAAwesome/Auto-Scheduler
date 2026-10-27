import type { Availability, AvailableDay, TimePeriod, WeekOverride } from "../types/models.ts";
import { addDays } from "./dates.ts";
import { clockTime, weekStart } from "./calendar.ts";

export const DEFAULT_PERIOD: TimePeriod = { start: 540, end: 1020 };

/** 24-hour clock options from 00:00 through 23:45, plus 24:00 for period ends. */
export function timeOptions(includeEndOfDay = false) {
  const values: string[] = [];
  for (let minute = 0; minute < 1440; minute += 15) values.push(clockTime(minute));
  if (includeEndOfDay) values.push("24:00");
  return values;
}

export function emptyWeekDays(): AvailableDay[] {
  return Array.from({ length: 7 }, (_, day) => ({
    day,
    enabled: false,
    periods: [{ ...DEFAULT_PERIOD }],
  }));
}

export function normalizeAvailability(value: Availability): Availability {
  return {
    timeZone: value.timeZone,
    reminders: value.reminders,
    days: value.days.map(normalizeDay),
    weekOverrides: (value.weekOverrides ?? []).map((week) => ({
      weekStart: week.weekStart,
      days: week.days.map(normalizeDay),
    })),
  };
}

export function normalizeDay(day: AvailableDay & { start?: number; end?: number }): AvailableDay {
  const legacy =
    (!day.periods || day.periods.length === 0) &&
    typeof day.start === "number" &&
    typeof day.end === "number"
      ? [{ start: day.start, end: day.end }]
      : day.periods;
  return {
    day: day.day,
    enabled: day.enabled,
    periods: (legacy?.length ? legacy : [{ ...DEFAULT_PERIOD }]).map((period) => ({
      start: period.start,
      end: period.end,
    })),
  };
}

export function mondayOf(date: string) {
  return weekStart(date);
}

export function resolveDay(availability: Availability, date: string): AvailableDay {
  const monday = mondayOf(date);
  const override = (availability.weekOverrides ?? []).find(
    (week) => week.weekStart === monday,
  );
  const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const source = override?.days ?? availability.days;
  return normalizeDay(
    source.find((row) => row.day === weekday) ?? {
      day: weekday,
      enabled: false,
      periods: [{ ...DEFAULT_PERIOD }],
    },
  );
}

export function periodLabel(period: TimePeriod) {
  return `${clockTime(period.start)}–${clockTime(period.end)}`;
}

export function weekLabel(weekStartDate: string) {
  return `Week of ${weekStartDate} – ${addDays(weekStartDate, 6)}`;
}

export function cloneDays(days: AvailableDay[]): AvailableDay[] {
  return days.map((day) => ({
    day: day.day,
    enabled: day.enabled,
    periods: day.periods.map((period) => ({ ...period })),
  }));
}

export function upsertWeekOverride(
  overrides: WeekOverride[],
  weekStartDate: string,
  days: AvailableDay[],
): WeekOverride[] {
  const next = overrides.filter((week) => week.weekStart !== weekStartDate);
  next.push({ weekStart: weekStartDate, days: cloneDays(days) });
  return next.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}
