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
  minutes: number;
  priority: Priority;
  category: Category;
  done: boolean;
}
export type TaskInput = Omit<Task, "id" | "done">;
export interface Availability {
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
  availability: Availability;
  calendarEvents: CalendarEvent[];
  scheduledBlocks: ScheduledBlock[];
}
