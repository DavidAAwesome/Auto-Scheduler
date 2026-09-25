/** Clearly isolated browser-only demo store. No FastAPI or Google requests. */
import type { DemoWorkspace, Task, TaskInput } from "../types/models.ts";
import { createSampleData } from "../data/sampleData.ts";
import { validDate } from "../utils/dates.ts";
export const STORAGE_KEY = "autoplan.demo.workspace.v2";
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
function taskFields(input: TaskInput): TaskInput {
  return {
    title: input.title.trim(),
    deadline: input.deadline,
    minutes: input.minutes,
    priority: input.priority,
    category: input.category,
  };
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
function validateWorkspace(data: DemoWorkspace) {
  if (
    !data ||
    data.version !== 2 ||
    !Array.isArray(data.tasks) ||
    !Array.isArray(data.calendarEvents) ||
    !Array.isArray(data.scheduledBlocks)
  )
    throw new Error("Invalid saved workspace");
  const ids = new Set<string>();
  for (const task of data.tasks) {
    validateTask(task);
    if (
      typeof task.id !== "string" ||
      !task.id ||
      ids.has(task.id) ||
      typeof task.done !== "boolean"
    )
      throw new Error("Invalid saved task");
    ids.add(task.id);
  }
  if (
    !data.availability ||
    !Number.isInteger(data.availability.start) ||
    !Number.isInteger(data.availability.end) ||
    data.availability.start < 0 ||
    data.availability.end > 1440 ||
    data.availability.end <= data.availability.start ||
    typeof data.availability.weekends !== "boolean"
  )
    throw new Error("Invalid availability");
  for (const event of [...data.calendarEvents, ...data.scheduledBlocks]) {
    if (
      typeof event.id !== "string" ||
      typeof event.title !== "string" ||
      !validDate(event.date) ||
      !Number.isInteger(event.start) ||
      !Number.isInteger(event.end) ||
      event.start < 0 ||
      event.end > 1440 ||
      event.end <= event.start
    )
      throw new Error("Invalid calendar entry");
  }
  for (const block of data.scheduledBlocks) {
    if (
      !["focus", "break"].includes(block.type) ||
      (block.taskId !== null && !ids.has(block.taskId))
    )
      throw new Error("Invalid scheduled block");
  }
}
export function createDemoStore(
  storage?: Pick<Storage, "getItem" | "setItem">,
  seed = createSampleData(),
) {
  let workspace = structuredClone(seed);
  let notice = "";
  const listeners = new Set<() => void>();
  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        validateWorkspace(saved);
        workspace = saved;
      } else storage.setItem(STORAGE_KEY, JSON.stringify(workspace));
    } catch {
      notice =
        "Saved demo data could not be loaded or initialized. Samples are shown; a successful save will replace invalid data.";
    }
  } else notice = "Browser storage is unavailable. Changes cannot be saved.";
  function commit(next: DemoWorkspace) {
    try {
      if (!storage) throw new Error();
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      throw new Error(
        "Could not save changes. Allow browser storage or free up space, then try again.",
      );
    }
    workspace = next;
    notice = "";
    listeners.forEach((listener) => listener());
  }
  function requireTask(id: string) {
    const task = workspace.tasks.find((t) => t.id === id);
    if (!task) throw new Error("This task no longer exists.");
    return task;
  }
  return {
    getSnapshot: () => workspace,
    getLoadNotice: () => notice,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reload() {
      if (!storage) return;
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        validateWorkspace(saved);
        workspace = saved;
        notice = "";
      } catch {
        notice =
          "Another tab saved unreadable data. Your current view has been kept.";
      }
      listeners.forEach((listener) => listener());
    },
    createTask(input: TaskInput) {
      validateTask(input);
      const task: Task = {
        ...taskFields(input),
        id: crypto.randomUUID(),
        done: false,
      };
      commit({ ...workspace, tasks: [...workspace.tasks, task] });
      return task;
    },
    updateTask(id: string, input: TaskInput) {
      validateTask(input);
      requireTask(id);
      commit({
        ...workspace,
        tasks: workspace.tasks.map((t) =>
          t.id === id ? { ...t, ...taskFields(input) } : t,
        ),
        scheduledBlocks: [],
      });
    },
    setCompleted(id: string, done: boolean) {
      requireTask(id);
      commit({
        ...workspace,
        tasks: workspace.tasks.map((t) => (t.id === id ? { ...t, done } : t)),
        scheduledBlocks: workspace.scheduledBlocks.filter(
          (b) => b.taskId !== id,
        ),
      });
    },
    deleteTask(id: string) {
      requireTask(id);
      commit({
        ...workspace,
        tasks: workspace.tasks.filter((t) => t.id !== id),
        scheduledBlocks: workspace.scheduledBlocks.filter(
          (b) => b.taskId !== id,
        ),
      });
    },
  };
}
let browserStorage: Storage | undefined;
try {
  browserStorage = globalThis.localStorage;
} catch {
  /* Handled by the store. */
}
export const mockDataService = createDemoStore(browserStorage);
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) mockDataService.reload();
  });
