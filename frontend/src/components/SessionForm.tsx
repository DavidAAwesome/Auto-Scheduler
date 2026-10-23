import { useState, type FormEvent } from "react";
import type { WorkSession, WorkSessionInput } from "../types/models";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { clock12, clockTime, longDate, parseClock } from "../utils/calendar";
import { resolveDay } from "../utils/availability";
import { localDate } from "../utils/dates";
import { endsAfterDue, outsideAvailability, overlapping, plannedMinutes } from "../utils/planning";
import { duration } from "../utils/taskDisplay";
import Modal from "./Modal";
import { eventClash } from "../utils/events";

/** <input type=time> cannot show 24:00, so midnight at the end of the day is shown as 00:00. */
const timeValue = (minutes: number) => (minutes >= 1440 ? "00:00" : clockTime(minutes));

/** Plan (or edit) a block of time to work on a task. A task can have many sessions across different days. */
export default function SessionForm({ session, taskId, date, start, onClose, onSave }: {
  session?: WorkSession;
  taskId?: string;
  date?: string;
  start?: number;
  onClose: () => void;
  onSave: (message: string) => void;
}) {
  const { tasks, sessions, events, availability } = useWorkspace();
  const choices = tasks.filter(t => !t.done || t.id === session?.taskId).sort((a, b) => a.deadline.localeCompare(b.deadline) || a.dueTime - b.dueTime);
  const [selectedId, setSelectedId] = useState(session?.taskId ?? taskId ?? choices[0]?.id ?? "");
  const task = tasks.find(t => t.id === selectedId);
  const today = localDate();
  const initialDate = session?.date ?? date ?? (task && task.deadline < today ? task.deadline : today);
  const hours = availability ? resolveDay(availability, initialDate) : null;
  const initialStart = session?.start ?? start ?? (hours?.enabled && hours.periods.length ? hours.periods[0].start : 9 * 60);
  const left = task ? task.minutes - plannedMinutes(task.id, sessions) + (session ? session.end - session.start : 0) : 60;
  const initialLength = session ? session.end - session.start : left > 0 ? Math.min(left, 120) : 60;
  const [day, setDay] = useState(initialDate);
  const [from, setFrom] = useState(clockTime(initialStart));
  const [until, setUntil] = useState(timeValue(Math.min(initialStart + initialLength, 1440)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const input: WorkSessionInput = { taskId: selectedId, date: day, start: parseClock(from), end: until === "00:00" ? 1440 : parseClock(until) };
  const length = input.end - input.start;
  const clash = overlapping(input, sessions, session?.id);
  const busyWith = length > 0 ? eventClash(events, input.date, input.start, input.end) : undefined;
  const tooLate = task && endsAfterDue(input, task);
  const offHours = length > 0 && outsideAvailability(input, availability);
  const remainingAfter = left - Math.max(length, 0);
  const setLength = (minutes: number) => setUntil(timeValue(Math.min(input.start + minutes, 1440)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (tooLate) { setError(`This session ends after the task is due (${longDate(task.deadline)} at ${clock12(task.dueTime)}).`); return; }
    if (busyWith) { setError(`This overlaps your event "${busyWith.title}" (${clock12(busyWith.start)} – ${clock12(busyWith.end % 1440)}).`); return; }
    if (clash) { setError(`This overlaps another work session (${clock12(clash.start)} – ${clock12(clash.end)}).`); return; }
    setSaving(true); setError("");
    try {
      if (session) await workspaceService.updateSession(session.id, input);
      else await workspaceService.createSession(input);
      onSave(session ? "Work session updated" : "Work session planned");
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  async function remove() {
    if (!session) return;
    setSaving(true); setError("");
    try { await workspaceService.deleteSession(session.id); onSave("Work session removed"); onClose(); }
    catch (e) { setError((e as Error).message); setSaving(false); }
  }

  if (!choices.length)
    return (
      <Modal eyebrow="WORK SESSION" title="Plan work time" onClose={onClose}>
        <p className="muted">Add a task first, then plan when you’ll work on it.</p>
        <div className="task-dialog-footer"><button className="button" onClick={onClose}>OK</button></div>
      </Modal>
    );
  return (
    <Modal eyebrow="WORK SESSION" title={session ? "Edit work session" : "Plan work time"} busy={saving} onClose={onClose}>
      <form className="task-form" onSubmit={submit}>
        <label>
          Task
          <select value={selectedId} onChange={e => setSelectedId(e.target.value)} disabled={!!session}>
            {choices.map(t => <option key={t.id} value={t.id}>{t.title} (due {longDate(t.deadline)})</option>)}
          </select>
        </label>
        {task && (
          <div className="plan-summary">
            <span>Due <strong>{longDate(task.deadline)}, {clock12(task.dueTime)}</strong></span>
            <span>Needs <strong>{duration(task.minutes)}</strong></span>
            <span className={remainingAfter < 0 ? "over" : ""}>
              {remainingAfter > 0 ? <>After this: <strong>{duration(remainingAfter)}</strong> left to plan</> : remainingAfter === 0 ? <strong>Fully planned ✓</strong> : <>Over by <strong>{duration(-remainingAfter)}</strong></>}
            </span>
          </div>
        )}
        <div className="task-form-grid three">
          <label>
            Day
            <input type="date" required value={day} max={task?.deadline} onChange={e => setDay(e.target.value)} />
          </label>
          <label>
            From
            <input type="time" required step={300} value={from} onChange={e => {
              const next = parseClock(e.target.value);
              setFrom(e.target.value);
              if (Number.isFinite(next) && length > 0) setUntil(timeValue(Math.min(next + length, 1440)));
            }} />
          </label>
          <label>
            Until
            <input type="time" required step={300} value={until} onChange={e => setUntil(e.target.value)} />
          </label>
        </div>
        <div className="quick-lengths" role="group" aria-label="Session length">
          {[30, 60, 90, 120].map(m => <button key={m} type="button" className={`chip ${length === m ? "active" : ""}`} onClick={() => setLength(m)}>{duration(m)}</button>)}
          {left > 0 && ![30, 60, 90, 120].includes(left) && left <= 600 && (
            <button type="button" className={`chip ${length === left ? "active" : ""}`} onClick={() => setLength(left)}>All remaining ({duration(left)})</button>
          )}
        </div>
        {length > 0 && <p className="muted">{duration(length)} on {longDate(day)}, {clock12(input.start)} – {clock12(input.end % 1440)}</p>}
        {tooLate && <p className="form-error">Ends after the task is due. Pick an earlier day or time.</p>}
        {busyWith && <p className="form-error">Overlaps your event “{busyWith.title}” ({clock12(busyWith.start)} – {clock12(busyWith.end % 1440)}).</p>}
        {clash && <p className="form-error">Overlaps another work session ({clock12(clash.start)} – {clock12(clash.end)}).</p>}
        {offHours && !tooLate && <p className="form-warning">This is outside your available hours for that day. That’s allowed, just a heads-up.</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="task-dialog-footer">
          {session && <button className="button ghost danger-text" type="button" disabled={saving} onClick={() => void remove()}>Delete session</button>}
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="button" type="submit" disabled={saving || length <= 0}>{saving ? "Saving…" : session ? "Save" : "Plan session"}</button>
        </div>
      </form>
    </Modal>
  );
}
