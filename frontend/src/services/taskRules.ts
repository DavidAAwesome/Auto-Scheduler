import type { CalendarEventInput, Task, TaskInput, WorkSessionInput } from "../types/models.ts";
import { validDate } from "../utils/dates.ts";
export function validateTask(input: TaskInput) {
  if (
    !input ||
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.trim().length > 80
  )
    throw new Error("Enter a task name between 1 and 80 characters.");
  if (!validDate(input.deadline)) throw new Error("Choose a valid deadline.");
  if (
    !Number.isInteger(input.minutes) ||
    input.minutes < 15 ||
    input.minutes > 6000 ||
    input.minutes % 15 !== 0
  )
    throw new Error(
      "Time needed must be between 15 minutes and 100 hours, in 15-minute steps.",
    );
  if (!Number.isInteger(input.dueTime) || input.dueTime < 0 || input.dueTime > 1439)
    throw new Error("Choose a valid due time.");
  if (!["High", "Medium", "Low"].includes(input.priority))
    throw new Error("Choose a valid priority.");
  if (!["Project", "Study", "Personal", "Work"].includes(input.category))
    throw new Error("Choose a valid category.");
  if (
    !Number.isInteger(input.remainingMinutes) ||
    input.remainingMinutes < 0 ||
    input.remainingMinutes > input.minutes ||
    input.remainingMinutes % 15 !== 0
  )
    throw new Error("Remaining time must be a multiple of 15 minutes and not exceed the estimate.");
  if (input.minSessionMinutes > input.maxSessionMinutes)
    throw new Error("Minimum session length cannot exceed the maximum.");
}
export type TaskFilter = "all" | "open" | "done";
export function selectTasks(
  tasks: Task[],
  search = "",
  filter: TaskFilter = "all",
) {
  return tasks.filter(
    (task) =>
      task.title.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "all" || (filter === "done" ? task.done : !task.done)),
  );
}

export function validateSession(input: WorkSessionInput) {
  if (!input.taskId) throw new Error("Choose a task to work on.");
  if (!validDate(input.date)) throw new Error("Choose a valid date.");
  if (![input.start, input.end].every(Number.isInteger) || input.start < 0 || input.end > 1440)
    throw new Error("Choose valid start and end times.");
  if (input.end <= input.start) throw new Error("A work session must end after it starts.");
  if (input.start % 5 || input.end % 5) throw new Error("Use times in 5-minute steps.");
}

export function validateEvent(input: CalendarEventInput) {
  if (!input.title.trim() || input.title.trim().length > 80) throw new Error("Enter an event name between 1 and 80 characters.");
  if (!validDate(input.date)) throw new Error("Choose a valid date.");
  if (input.end <= input.start) throw new Error("An event must end after it starts.");
  if (input.start % 5 || input.end % 5) throw new Error("Use times in 5-minute steps.");
  if (input.repeat) {
    if (!input.repeat.weekdays.length) throw new Error("Choose at least one day for the event to repeat on.");
    if (!validDate(input.repeat.until) || input.repeat.until < input.date) throw new Error("The repeat end date must be on or after the first date.");
  }
}
