import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Task, TaskInput } from "../types/models";
import { addDays, localDate } from "../utils/dates";
import { workspaceService } from "../services/workspace";

export default function TaskForm({
  task,
  onClose,
  onSave,
  onSaveAndPlan,
}: {
  task?: Task;
  onClose: () => void;
  onSave: (message: string) => void;
  onSaveAndPlan?: (task: Task) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
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
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;

    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const shouldPlan = submitter?.value === "plan";
    const data = new FormData(event.currentTarget);
    
    const totalMinutes =
      Number(data.get("hours")) * 60 +
      Number(data.get("durationMinutes"));

    if (totalMinutes < 15) {
      setError("Time needed must be at least 15 minutes.");
      return;
    }
    const input: TaskInput = {
      title: String(data.get("title")),
      deadline: String(data.get("deadline")),
      dueTime: String(data.get("dueTime") || "") || null,
      minutes: totalMinutes,
      priority: data.get("priority") as TaskInput["priority"],
      category: data.get("category") as TaskInput["category"],
    };
    setSaving(true);
   try {
     if (task) {
       await workspaceService.updateTask(task.id, input);
       onSave("Task updated");
       onClose();
  } else {
    const createdTask = await workspaceService.createTask(input);

    if (shouldPlan && onSaveAndPlan) {
      onSaveAndPlan(createdTask);
    } else {
      onSave("Task added");
    }

    onClose();
  }
} catch (e) {
      setError((e as Error).message);
    } finally { setSaving(false); }
  }
  return (
    <dialog
      ref={dialog}
      className="task-dialog"
      aria-labelledby="task-dialog-title"
      onCancel={(e) => { if (saving) e.preventDefault(); else onClose(); }}
      onClick={(e) => {
        if (!saving && e.target === e.currentTarget) {
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
        <button className="icon-button" onClick={onClose} disabled={saving} aria-label="Close">
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
            Due time (optional)
            <input
              name="dueTime"
              type="time"
               defaultValue={task?.dueTime ?? ""}
            />
          </label>
          <label>
           Time needed in total
           <div className="task-duration">
            <input
              name="hours"
              type="number"
              min={0}
              max={12}
              defaultValue={task ? Math.floor(task.minutes / 60) : 1}
              aria-label="Hours"
            />
            <span>h</span>

            <select
              name="durationMinutes"
              defaultValue={task ? task.minutes % 60 : 0}
              aria-label="Minutes"
            >
              <option value="0">0</option>
              <option value="15">15</option>
              <option value="30">30</option>
              <option value="45">45</option>
              </select>
              <span>m</span>
           </div>
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
          Save a deadline to show this task on your calendar. Automatic scheduling comes in Sprint 2.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="task-dialog-footer">
          <button 
            className="button secondary" 
            type="button" 
            disabled={saving} 
            onClick={onClose}
          >
            Cancel
          </button>

          {!task && onSaveAndPlan && (
            <button
              className="button secondary"
              type="submit"
              name="action"
              value="plan"
              disabled={saving}
            >
      Add & plan work time
    </button>
  )}
          <button className="button" type="submit" disabled={saving}>
            {saving ? "Saving…" : task ? "Save changes" : "Add task"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
