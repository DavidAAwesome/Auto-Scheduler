import type { Task, TaskInput } from "../types/models.ts";
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
    input.minutes > 720 ||
    input.minutes % 15 !== 0
  )
    throw new Error(
      "Time needed must be 15–720 minutes, in 15-minute increments.",
    );
  if (!["High", "Medium", "Low"].includes(input.priority))
    throw new Error("Choose a valid priority.");
  if (!["Project", "Study", "Personal", "Work"].includes(input.category))
    throw new Error("Choose a valid category.");
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
