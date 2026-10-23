import { useState } from "react";
import type { Task, WorkSession } from "../types/models";
import { useDismiss } from "../hooks/useDismiss";
import { useAnchoredCard } from "../hooks/useAnchoredCard";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { clock12, longDate } from "../utils/calendar";
import { endsAfterDue, plannedMinutes } from "../utils/planning";
import Icon from "./Icon";
import { categoryIcon, duration } from "../utils/taskDisplay";

/** Task details card from the sketch: pencil (edit) top-left, × (close) top-right, plus the task's work sessions. */
export default function TaskPopover({ task, anchor, focusSessionId, onClose, onEdit, onPlan, onEditSession }: {
  task: Task;
  anchor: DOMRect;
  focusSessionId?: string;
  onClose: () => void;
  onEdit: (task: Task) => void;
  onPlan: (task: Task) => void;
  onEditSession: (session: WorkSession) => void;
}) {
  const { sessions } = useWorkspace();
  const { ref: card, attach, style: position } = useAnchoredCard(anchor);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDismiss(card, true, onClose);
  async function run(action: () => Promise<unknown>, closeAfter: boolean) {
    setBusy(true); setError("");
    try { await action(); if (closeAfter) onClose(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const mine = sessions.filter(s => s.taskId === task.id).sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
  const planned = plannedMinutes(task.id, sessions);
  const percent = Math.min(100, Math.round((planned / task.minutes) * 100));
  return (
    <div ref={attach} className={`task-popover cat-${task.category.toLowerCase()}`} role="dialog" aria-label={task.title} tabIndex={-1} style={position}>
      <div className="task-popover-bar">
        <button className="icon-button ghost small" aria-label="Edit task" title="Edit task" onClick={() => onEdit(task)}><Icon name="pencil" size={16} /></button>
        <button className="icon-button ghost small" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
      <h3><span className="task-icon"><Icon name={categoryIcon[task.category]} size={18} /></span>{task.title}</h3>
      <dl>
        <div><dt>Due</dt><dd>{longDate(task.deadline)}, {clock12(task.dueTime)}</dd></div>
        <div><dt>Priority</dt><dd><span className={`priority-dot ${task.priority.toLowerCase()}`} /> {task.priority} · {task.category}</dd></div>
      </dl>
      <div className="plan-progress">
        <div className="plan-progress-label">
          <span>Work planned</span>
          <strong>{duration(planned)} of {duration(task.minutes)}</strong>
        </div>
        <span className="bar"><i style={{ width: `${percent}%` }} /></span>
      </div>
      {mine.length > 0 && (
        <ul className="session-list">
          {mine.map(s => (
            <li key={s.id} className={s.id === focusSessionId ? "focused" : ""}>
              <button onClick={() => onEditSession(s)} title="Edit work session">
                <span>{longDate(s.date).replace(/, \d{4}$/, "")}</span>
                <span className="muted">{clock12(s.start)} – {clock12(s.end % 1440)}</span>
                {endsAfterDue(s, task) && <span className="late-flag" title="Ends after the task is due">⚠</span>}
                <Icon name="pencil" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!task.done && (
        <button className="button secondary small full" onClick={() => onPlan(task)}>
          <Icon name="plus" size={15} /> {planned >= task.minutes ? "Add another work session" : `Plan work time (${duration(task.minutes - planned)} left)`}
        </button>
      )}
      {error && <p role="alert" className="form-error">{error}</p>}
      {confirming ? (
        <div className="task-popover-actions">
          <span className="confirm-text">Delete this task{mine.length ? " and its sessions" : ""}?</span>
          <button className="button secondary small" disabled={busy} onClick={() => setConfirming(false)}>Keep</button>
          <button className="button danger small" disabled={busy} onClick={() => void run(() => workspaceService.deleteTask(task.id), true)}>Delete</button>
        </div>
      ) : (
        <div className="task-popover-actions">
          <button className="button ghost small" disabled={busy} onClick={() => void run(() => workspaceService.setCompleted(task.id, !task.done), false)}>
            <Icon name="check" size={15} /> {task.done ? "Reopen" : "Mark complete"}
          </button>
          <button className="button ghost small" disabled={busy} onClick={() => setConfirming(true)}><Icon name="trash" size={15} /> Delete</button>
        </div>
      )}
    </div>
  );
}
