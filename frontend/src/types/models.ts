/** Dates are local YYYY-MM-DD strings; start/end are minutes after midnight. */
export type Priority = "High" | "Medium" | "Low";
export type Category = "Project" | "Study" | "Personal" | "Work";
export interface Task {
  id: string;
  title: string;
  deadline: string;
  /** Total estimated work, which can be split across several work sessions. */
  minutes: number;
  /** Work actually done (completed sessions or logged progress). Scheduled work is not completed work. */
  completedMinutes: number;
  /** Always minutes - completedMinutes. */
  remainingMinutes: number;
  /** Due time in minutes after midnight; 1439 (11:59 PM) when the user leaves it blank. */
  dueTime: number;
  priority: Priority;
  category: Category;
  done: boolean;
  earliestStart: string | null;
  allowSplit: boolean;
  minSessionMinutes: number;
  maxSessionMinutes: number;
  dependsOn: string[];
}
export type TaskInput = Omit<Task, "id" | "done" | "remainingMinutes">;
export const DEFAULT_DUE_TIME = 23 * 60 + 59;
export type SessionType = "work" | "break";
/** "proposed" exists only in previews; saved schedules hold saved, completed or cancelled sessions. */
export type SessionStatus = "proposed" | "saved" | "completed" | "cancelled";
/**
 * The canonical schedule session shared by the calendar, Today's Tasks and chat (saved or proposed, work or break).
 * startAt/endAt are UTC instants; date/start/end are the same times in the schedule's timezone, for display.
 * A task's deadline is separate: work for a task due tomorrow can be scheduled today.
 */
export interface ScheduleSession {
  id: string;
  taskId: string | null;
  title: string;
  type: SessionType;
  status: SessionStatus;
  locked: boolean;
  /** "manual" = placed or requested by the user; "auto" = placed by the scheduler. */
  source: "manual" | "auto";
  scheduleVersion: number;
  startAt: string;
  endAt: string;
  date: string;
  start: number;
  end: number;
  /** Previews only: retained (fixed), kept (unchanged saved), new (proposed) or truncated. */
  change?: "retained" | "kept" | "new" | "truncated" | null;
  reason?: string | null;
}
export type WorkSession = ScheduleSession;
export type WorkSessionInput = { taskId: string; date: string; start: number; end: number; locked?: boolean };
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
  /** "manual" = created in AutoPlan; "google" / "outlook" = imported by calendar sync (read-only). */
  source: "manual" | "google" | "outlook";
  /** Imported events: the external calendar's name and a link to the original. */
  calendarName?: string | null;
  link?: string | null;
}
export type CalendarProvider = "google" | "outlook";
/** An external calendar the user connected; its events are imported as read-only CalendarEvents. */
export interface CalendarConnection {
  provider: CalendarProvider;
  account: string;
  lastSynced: string;
  rangeStart: string;
  rangeEnd: string;
  eventCount: number;
}
/** One day's part of an external event, converted to the user's time zone, as sent to /calendar/{provider}/sync. */
export interface ImportedEvent {
  externalId: string;
  title: string;
  kind: EventKind;
  date: string;
  start: number;
  end: number;
  location: string | null;
  calendarName: string | null;
  link: string | null;
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

/** Editable pacing defaults (not medical advice). */
export interface SchedulePreferences {
  focusMinutes: number;
  breakMinutes: number;
  maxDailyWorkMinutes: number;
  lunch: TimePeriod | null;
}
export const DEFAULT_PREFERENCES: SchedulePreferences = { focusMinutes: 50, breakMinutes: 10, maxDailyWorkMinutes: 240, lunch: null };

/** How the AI assistant talks to this user. Changes wording only, never where work is placed. */
export type ReplyStyle = "concise" | "balanced" | "detailed";
export type AssistantTone = "friendly" | "professional" | "motivating";
export interface AIProfile { replyStyle: ReplyStyle; tone: AssistantTone; aboutMe: string }
export const DEFAULT_AI_PROFILE: AIProfile = { replyStyle: "balanced", tone: "friendly", aboutMe: "" };
export const ABOUT_ME_MAX = 400;

/** A preference change the assistant proposed in chat. Nothing is saved until the user presses Save. */
export interface PreferenceChange {
  focusMinutes?: number | null;
  breakMinutes?: number | null;
  maxDailyWorkMinutes?: number | null;
  replyStyle?: ReplyStyle | null;
  tone?: AssistantTone | null;
  rememberNote?: string | null;
}

export interface SavedSchedule { scheduleVersion: number; timeZone: string; sessions: ScheduleSession[] }

export interface AllocationReason { code: string; message: string }
/** Invariant: retainedMinutes + newMinutes + unallocatedMinutes = remainingMinutes + overAllocatedMinutes. */
export interface TaskAllocation {
  taskId: string; title: string; priority: Priority; dueAt: string;
  estimatedMinutes: number; completedMinutes: number; remainingMinutes: number;
  retainedMinutes: number; inProgressMinutes: number; newMinutes: number; unallocatedMinutes: number; overAllocatedMinutes: number;
  atRisk: boolean; slackMinutes: number | null;
  status: "scheduled" | "partial" | "unscheduled" | "complete";
  reasons: AllocationReason[];
}
export interface ScheduleConflict { code: string; message: string; items: { kind: string; id: string | null; title: string; startAt: string | null; endAt: string | null }[] }
export interface SessionRemoval { session: ScheduleSession; reason: string; newEndAt: string | null }
export interface DaySummary { date: string; workMinutes: number; newWorkMinutes: number; breakCount: number; sessionCount: number }
export interface SchedulePreview {
  previewId: string;
  status: "proposed" | "applied";
  mode: "generate" | "repair" | "break";
  baseScheduleVersion: number;
  generatedAt: string;
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  startDate: string;
  endDate: string;
  preferences: SchedulePreferences;
  /** The complete future schedule in the window after Apply: retained, kept, and new sessions (work and breaks). */
  sessions: ScheduleSession[];
  /** Saved sessions Apply deletes (or shortens, when newEndAt is set). */
  removed: SessionRemoval[];
  tasks: TaskAllocation[];
  conflicts: ScheduleConflict[];
  days: DaySummary[];
  firstProposedDate: string | null;
  explanations: string[];
  note: string;
  inputFingerprint: string;
}
export interface ApplyResult { previewId: string; status: "applied"; duplicate: boolean; schedule: SavedSchedule }
