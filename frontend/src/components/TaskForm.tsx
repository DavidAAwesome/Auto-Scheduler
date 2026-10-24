import { useState, type FormEvent } from "react";
import { DEFAULT_DUE_TIME, type Task, type TaskInput } from "../types/models";
import { addDays, localDate } from "../utils/dates";
import { clock12, clockTime, parseClock } from "../utils/calendar";
import { endsAfterDue, plannedMinutes } from "../utils/planning";
import { duration } from "../utils/taskDisplay";
import { workspaceService } from "../services/workspace";
import { useWorkspace } from "../hooks/useWorkspace";
import Modal from "./Modal";

export default function TaskForm({
  task,
  onClose,
  onSave,
  defaultDeadline,
}: {
  task?: Task;
  onClose: () => void;
  /** `planNext` asks the caller to open the work-session form for the saved task. */
  onSave: (message: string, saved: Task, planNext: boolean) => void;
  defaultDeadline?: string;
}) {
  const { sessions } = useWorkspace();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deadline, setDeadline] = useState(task?.deadline ?? defaultDeadline ?? addDays(localDate(), 2));
  // Blank means "no specific time", saved as 11:59 PM.
  const [dueTime, setDueTime] = useState(task && task.dueTime !== DEFAULT_DUE_TIME ? clockTime(task.dueTime) : "");
  const today = localDate();
  const taskSessions = task ? sessions.filter(s => s.taskId === task.id) : [];
  const dueMinutes = dueTime ? parseClock(dueTime) : DEFAULT_DUE_TIME;
  const stranded = taskSessions.filter(s => endsAfterDue(s, { deadline, dueTime: dueMinutes })).length;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const planNext = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "plan";
    const data = new FormData(event.currentTarget);
    const minutes = Number(data.get("hours")) * 60 + Number(data.get("extraMinutes"));
    const input: TaskInput = {
      title: String(data.get("title")),
      deadline,
      dueTime: dueMinutes,
      minutes,
      remainingMinutes: task?.remainingMinutes ?? minutes,
      priority: data.get("priority") as TaskInput["priority"],
      category: data.get("category") as TaskInput["category"],
      earliestStart: task?.earliestStart ?? null,
      allowSplit: data.get("allowSplit") === "on",
      minSessionMinutes: Number(data.get("minSessionMinutes") || task?.minSessionMinutes || 15),
      maxSessionMinutes: Number(data.get("maxSessionMinutes") || task?.maxSessionMinutes || 60),
      dependsOn: task?.dependsOn ?? [],
    };
    setSaving(true);
    setError("");
    try {
      const saved = task ? await workspaceService.updateTask(task.id, input) : await workspaceService.createTask(input);
      onSave(task ? "Task updated" : "Task added", saved, planNext);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally { setSaving(false); }
  }
  const minutes = task?.minutes ?? 60;
  return (
    <Modal eyebrow={task ? "EDIT TASK" : "NEW TASK"} title={task ? "Edit task" : "Add a task"} busy={saving} onClose={onClose}>
      <form className="task-form" onSubmit={submit}>
        <label>
          Task name
          <input name="title" required maxLength={80} defaultValue={task?.title ?? ""} placeholder="e.g. Computer vision homework" />
        </label>
        <div className="task-form-grid">
          <label>
            Due date
            <input type="date" required min={deadline < today ? deadline : today} value={deadline} onChange={e => setDeadline(e.target.value)} />
          </label>
          <label>
            <span>Due time <span className="optional">optional</span></span>
            <span className="input-with-clear">
              <input type="time" value={dueTime} onChange={e => setDueTime(e.target.value)} aria-describedby="due-time-hint" />
              {dueTime && <button type="button" className="clear-button" onClick={() => setDueTime("")} aria-label="Clear due time">×</button>}
            </span>
            <small id="due-time-hint" className="hint">{dueTime ? `Due at ${clock12(dueMinutes)}` : "Blank = 11:59 PM"}</small>
          </label>
          <fieldset className="duration-field">
            <legend>Time needed in total</legend>
            <label className="sr-only" htmlFor="task-hours">Hours</label>
            <input id="task-hours" name="hours" type="number" min={0} max={100} required defaultValue={Math.floor(minutes / 60)} />
            <span>h</span>
            <label className="sr-only" htmlFor="task-minutes">Minutes</label>
            <select id="task-minutes" name="extraMinutes" defaultValue={minutes % 60}>
              {[0, 15, 30, 45].map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <span>m</span>
          </fieldset>
          <label>
            Priority
            <select name="priority" defaultValue={task?.priority ?? "High"}>
              {["High", "Medium", "Low"].map((v) => <option key={v}>{v}</option>)}
            </select>
          </label>
          <label>
            Category
            <select name="category" defaultValue={task?.category ?? "Project"}>
              {["Project", "Study", "Personal", "Work"].map((v) => <option key={v}>{v}</option>)}
            </select>
          </label>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" name="allowSplit" value="on" defaultChecked={task?.allowSplit ?? true} />
          Allow splitting into multiple sessions (respects min/max session length)
        </label>
        <input type="hidden" name="minSessionMinutes" value={task?.minSessionMinutes ?? 15} />
        <input type="hidden" name="maxSessionMinutes" value={task?.maxSessionMinutes ?? 60} />
        {task && (
          <p className="muted">
            {taskSessions.length
              ? `${duration(plannedMinutes(task.id, sessions))} planned across ${taskSessions.length} work session${taskSessions.length > 1 ? "s" : ""}.`
              : "No work time planned yet. Open the task on the calendar to plan work sessions."}
          </p>
        )}
        {!task && <p className="muted">You can split the work across several days after adding it.</p>}
        {stranded > 0 && (
          <p className="form-warning" role="status">
            {stranded} planned work session{stranded > 1 ? "s" : ""} would end after this new due time. Move or delete {stranded > 1 ? "them" : "it"} afterwards.
          </p>
        )}
        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="task-dialog-footer">
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>Cancel</button>
          {!task && <button className="button secondary" type="submit" value="plan" disabled={saving}>Add &amp; plan work time</button>}
          <button className="button" type="submit" disabled={saving}>{saving ? "Saving…" : task ? "Save changes" : "Add task"}</button>
        </div>
      </form>
    </Modal>
  );
}
