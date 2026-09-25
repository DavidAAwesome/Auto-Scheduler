import { useState } from "react";
import ScreenHeading from "../components/ScreenHeading";
import TaskForm from "../components/TaskForm";
import MockNotice from "../components/MockNotice";
import { useMockData } from "../hooks/useMockData";
import {
  mockDataService,
  selectTasks,
  type TaskFilter,
} from "../services/mockData";
import { formatDate } from "../utils/dates";
import type { Task } from "../types/models";
import "./Tasks.css";
export default function Tasks() {
  const { tasks } = useMockData();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [editor, setEditor] = useState<Task | "new" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const shown = selectTasks(tasks, search, filter);
  function mutate(action: () => void, message: string) {
    try {
      action();
      setMessage(message);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <ScreenHeading
        eyebrow="PLAN YOUR WORK"
        title="Tasks"
        description="Capture what matters, then make space for it on your calendar."
        action={
          <button className="button" onClick={() => setEditor("new")}>
            + Add task
          </button>
        }
      />
      <MockNotice />
      <div className="tasks-toolbar">
        <input
          type="search"
          aria-label="Search tasks"
          placeholder="Search tasks"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Filter tasks"
          value={filter}
          onChange={(e) => setFilter(e.target.value as TaskFilter)}
        >
          <option value="all">All</option>
          <option value="open">Open</option>
          <option value="done">Done</option>
        </select>
        <a className="button secondary" href="#/assistant">
          Planning assistant →
        </a>
      </div>
      <div role="status" className="task-status">
        {message}
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <section className="card">
        <div className="card-heading">
          <h2>Your tasks</h2>
          <p className="muted">
            {shown.length} shown · {tasks.filter((t) => !t.done).length} open
          </p>
        </div>
        {shown.length === 0 ? (
          <div className="small-empty">
            <h3>Nothing here yet</h3>
            <p>
              {tasks.length
                ? "Try another search or filter."
                : "Add a task to start building your plan."}
            </p>
          </div>
        ) : (
          <ul className="prototype-tasks">
            {shown.map((task) => (
              <li key={task.id} className={task.done ? "task-done" : ""}>
                <input
                  type="checkbox"
                  checked={task.done}
                  aria-label={`${task.done ? "Reopen" : "Complete"} ${task.title}`}
                  onChange={(e) =>
                    mutate(
                      () =>
                        mockDataService.setCompleted(task.id, e.target.checked),
                      e.target.checked ? "Task completed" : "Task reopened",
                    )
                  }
                />
                <div className="prototype-task-copy">
                  <strong>{task.title}</strong>
                  <small>
                    {task.category} · {task.minutes} min · Due{" "}
                    {formatDate(task.deadline)}
                  </small>
                </div>
                <span
                  className={`task-priority ${task.priority.toLowerCase()}`}
                >
                  {task.priority}
                </span>
                <div className="prototype-task-actions">
                  <button
                    className="button secondary"
                    aria-label={`Edit ${task.title}`}
                    onClick={() => setEditor(task)}
                  >
                    Edit
                  </button>
                  <button
                    className="button secondary"
                    aria-label={`Delete ${task.title}`}
                    onClick={() =>
                      mutate(
                        () => mockDataService.deleteTask(task.id),
                        "Task deleted",
                      )
                    }
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="muted task-footnote">
        Demo tasks are saved in this browser. Scheduling is not implemented yet;
        deadlines do not reserve calendar time.
      </p>
      {editor && (
        <TaskForm
          task={editor === "new" ? undefined : editor}
          onClose={() => setEditor(null)}
          onSave={(message) => {
            setMessage(message);
            setError("");
          }}
        />
      )}
    </>
  );
}
