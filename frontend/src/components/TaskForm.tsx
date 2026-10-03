import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Task, TaskInput } from "../types/models";
import { addDays, localDate } from "../utils/dates";
import { mockDataService } from "../services/mockData";

export default function TaskForm({
  task,
  onClose,
  onSave,
}: {
  task?: Task;
  onClose: () => void;
  onSave: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const node = dialog.current;
    const trigger = document.activeElement as HTMLElement | null;
    node?.showModal();
    node?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      node?.close();
      trigger?.focus();
    };
  }, []);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input: TaskInput = {
      title: String(data.get("title")),
      deadline: String(data.get("deadline")),
      minutes: Number(data.get("minutes")),
      priority: data.get("priority") as TaskInput["priority"],
      category: data.get("category") as TaskInput["category"],
    };
    try {
      if (task) mockDataService.updateTask(task.id, input);
      else mockDataService.createTask(input);
      onSave(task ? "Task updated" : "Task added");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="task-dialog"
      aria-labelledby="task-dialog-title"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const rect = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="task-dialog-header">
        <div>
          <p className="eyebrow">{task ? "EDIT TASK" : "NEW TASK"}</p>
          <h2 id="task-dialog-title">{task ? "Edit task" : "Add a task"}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <form className="task-form" onSubmit={submit}>
        <label>
          Task name
          <input
            name="title"
            required
            maxLength={80}
            autoFocus
            defaultValue={task?.title ?? ""}
            placeholder="e.g. Finish project outline"
          />
        </label>
        <div className="task-form-grid">
          <label>
            Deadline
            <input
              name="deadline"
              type="date"
              required
              min={
                task && task.deadline < localDate()
                  ? task.deadline
                  : localDate()
              }
              defaultValue={task?.deadline ?? addDays(localDate(), 2)}
            />
          </label>
          <label>
            Time needed (minutes)
            <input
              name="minutes"
              type="number"
              min={15}
              max={720}
              step={15}
              required
              defaultValue={task?.minutes ?? 60}
            />
          </label>
          <label>
            Priority
            <select name="priority" defaultValue={task?.priority ?? "High"}>
              {["High", "Medium", "Low"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Category
            <select name="category" defaultValue={task?.category ?? "Project"}>
              {["Project", "Study", "Personal", "Work"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted">
          Save the task, then generate or replan your schedule to place it.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="task-dialog-footer">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button" type="submit">
            {task ? "Save changes" : "Add task"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
