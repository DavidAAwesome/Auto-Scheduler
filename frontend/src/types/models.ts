/** Dates are local YYYY-MM-DD strings; start/end are minutes after midnight. */
export type Priority = "High" | "Medium" | "Low";
export type Category = "Project" | "Study" | "Personal" | "Work";
export interface Task {
  id: string;
  title: string;
  deadline: string;
  /** Total estimated work, which can be split across several work sessions. */
  minutes: number;
  /** Due time in minutes after midnight; 1439 (11:59 PM) when the user leaves it blank. */
  dueTime: number;
  priority: Priority;
  category: Category;
  done: boolean;
}
export type TaskInput = Omit<Task, "id" | "done">;
export const DEFAULT_DUE_TIME = 23 * 60 + 59;
/** Time set aside on a specific day to work on a task. */
export interface WorkSession {
  id: string;
  taskId: string;
  date: string;
  start: number;
  end: number;
  /** "manual" = placed by the user; "auto" = placed by the future AI scheduler. */
  source: "manual" | "auto";
}
export type WorkSessionInput = Omit<WorkSession, "id" | "source">;
export type EventKind = "Class" | "Meeting" | "Appointment" | "Social" | "Other";
/** Repeats every week on `weekdays` (Monday = 0) from the event's date through `until`. */
export interface Repeat { weekdays: number[]; until: string }
/** A fixed-time commitment you attend (class, meeting, meetup). Not "due"; work is never planned on top of it. */
export interface CalendarEvent {
  id: string;
  title: string;
  kind: EventKind;
  date: string;
  start: number;
  end: number;
  location: string | null;
  repeat: Repeat | null;
  /** Cancelled single occurrences of a repeating event. */
  skipDates: string[];
  /** "manual" = created in AutoPlan; calendar sync will add "google" / "outlook". */
  source: "manual" | "google" | "outlook";
}
export type CalendarEventInput = Pick<CalendarEvent, "title" | "kind" | "date" | "start" | "end" | "location" | "repeat">;
/** One occurrence of an event on a specific date (repeating events have many). */
export interface EventOccurrence { event: CalendarEvent; date: string }

/** Weekly wall-clock hours in the selected IANA timezone. Monday = 0. Times are minutes after midnight (end may be 1440). */
export interface TimePeriod { start: number; end: number }
export interface AvailableDay { day: number; enabled: boolean; periods: TimePeriod[] }
export interface WeekOverride { weekStart: string; days: AvailableDay[] }
export interface Availability {
  days: AvailableDay[];
  weekOverrides: WeekOverride[];
  timeZone: string;
  reminders: boolean;
}

/** Live API plans use timezone-aware ISO instants, unlike legacy demo fixtures. */
export interface BusyInterval { start: string; end: string }
export interface PlanBlock extends BusyInterval {
  id: string; taskId: string | null; title: string; type: 'focus' | 'break';
}
export interface PlanTaskResult {
  taskId: string; title: string; deadline: string;
  requestedMinutes: number; scheduledMinutes: number; unscheduledMinutes: number;
  status: 'scheduled' | 'partial' | 'unscheduled' | 'overdue' | 'outside_window';
  reason: string | null; message: string;
}
export interface GeneratedPlan {
  version: 1; generatedAt: string; startDate: string; endDate: string; timeZone: string;
  source: 'provided' | 'availability_only'; busyIntervals: BusyInterval[];
  blocks: PlanBlock[]; tasks: PlanTaskResult[]; stale: boolean; staleReasons: string[];
}
