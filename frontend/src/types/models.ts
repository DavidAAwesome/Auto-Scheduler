/** Task fields verified against the prototype's rendered task form.
 * Availability/event/block shapes are provisional until app.js is supplied.
 * Dates are local YYYY-MM-DD strings; start/end are minutes after midnight.
 */
export type Priority = "High" | "Medium" | "Low";
export type Category = "Project" | "Study" | "Personal" | "Work";
export interface Task {
  id: string;
  title: string;
  deadline: string;
  dueTime?: string | null;
  minutes: number;
  priority: Priority;
  category: Category;
  done: boolean;
}
export type TaskInput = Omit<Task, "id" | "done">;
export interface DemoAvailability {
  start: number;
  end: number;
  weekends: boolean;
}
export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  start: number;
  end: number;
}
export interface ScheduledBlock {
  id: string;
  taskId: string | null;
  title: string;
  date: string;
  start: number;
  end: number;
  type: "focus" | "break";
}
export interface DemoWorkspace {
  version: 2;
  tasks: Task[];
  availability: DemoAvailability;
  calendarEvents: CalendarEvent[];
  scheduledBlocks: ScheduledBlock[];
}

/** Weekly wall-clock hours in the selected IANA timezone. Monday = 0. */
export interface AvailableDay { day: number; enabled: boolean; start: number; end: number }
export interface Availability { days: AvailableDay[]; timeZone: string; reminders: boolean }

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
