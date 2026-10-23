import { useState } from "react";
import { DEFAULT_DUE_TIME, type CalendarEvent, type Task } from "../types/models";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { clock12, longDate, weekdayIndex } from "../utils/calendar";
import { formatDate } from "../utils/dates";
import { plannedMinutes } from "../utils/planning";
import { eventIcon, occurrencesOn } from "../utils/events";
import Icon from "./Icon";
import { categoryIcon, duration } from "../utils/taskDisplay";

function TaskRow({ task, today, planned, onOpen, onError }: { task: Task; today: string; planned: number; onOpen: (task: Task, rect: DOMRect) => void; onError: (message: string) => void }) {
  const overdue = !task.done && task.deadline < today;
  const due = `${task.deadline === today ? "Today" : formatDate(task.deadline)}${task.dueTime === DEFAULT_DUE_TIME ? "" : ` ${clock12(task.dueTime)}`}`;
  async function toggle() {
    try { await workspaceService.setCompleted(task.id, !task.done); onError(""); }
    catch (e) { onError((e as Error).message); }
  }
  return (
    <li className={`task-row ${task.done ? "done" : ""}`}>
      <input type="checkbox" checked={task.done} onChange={() => void toggle()} aria-label={`${task.done ? "Reopen" : "Complete"} ${task.title}`} />
      <button className={`task-row-main cat-${task.category.toLowerCase()}`} onClick={e => onOpen(task, e.currentTarget.getBoundingClientRect())}>
        <span className={`task-icon cat-${task.category.toLowerCase()}`}><Icon name={categoryIcon[task.category]} size={16} /></span>
        <span className="task-row-text">
          <span className="task-row-title">{task.title}</span>
          <small className={overdue ? "overdue" : ""}>{overdue ? "Overdue · " : ""}Due {due} · {duration(task.minutes)}</small>
          {!task.done && (
            <span className="mini-progress" title={`${duration(planned)} of ${duration(task.minutes)} planned`} aria-label={`${duration(planned)} of ${duration(task.minutes)} planned`}>
              <i style={{ width: `${Math.min(100, (planned / task.minutes) * 100)}%` }} />
            </span>
          )}
        </span>
        <span className={`priority-dot ${task.priority.toLowerCase()}`} title={`${task.priority} priority`} />
      </button>
    </li>
  );
}

export default function TaskSidebar({ today, onAdd, onAddEvent, onOpen, onOpenSession, onOpenEvent }: {
  today: string;
  onAdd: () => void;
  onAddEvent: () => void;
  onOpenEvent: (event: CalendarEvent, date: string, rect: DOMRect) => void;
  onOpen: (task: Task, rect: DOMRect) => void;
  onOpenSession: (task: Task, rect: DOMRect, sessionId: string) => void;
}) {
  const { tasks, sessions, events, availability, saving } = useWorkspace();
  const [error, setError] = useState("");
  const sorted = [...tasks].sort((a, b) => a.deadline.localeCompare(b.deadline) || a.dueTime - b.dueTime || a.title.localeCompare(b.title));
  const dueNow = sorted.filter(t => !t.done && t.deadline <= today);
  const taskById = new Map(tasks.map(t => [t.id, t]));
  // Today's timeline: events you attend and work you planned, in time order (the sketch's "8:00 AM CS Class, 6:00 PM HW").
  const agenda = [
    ...occurrencesOn(events, today).map(({ event }) => ({ key: event.id, start: event.start, event })),
    ...sessions.filter(s => s.date === today && taskById.has(s.taskId)).map(session => ({ key: session.id, start: session.start, session })),
  ].sort((a, b) => a.start - b.start);
  const open = sorted.filter(t => !t.done);
  const done = sorted.filter(t => t.done);
  const hours = availability?.days[weekdayIndex(today)];
  const row = (task: Task) => <TaskRow key={task.id} task={task} today={today} planned={plannedMinutes(task.id, sessions)} onOpen={onOpen} onError={setError} />;
  return (
    <aside className="task-sidebar" aria-label="Tasks" aria-busy={saving}>
      <section className="today-card">
        <h2>Today’s Tasks</h2>
        <p className="today-date">{longDate(today)}</p>
        <p className={`today-hours ${hours?.enabled ? "" : "off"}`}>
          <Icon name="clock" size={14} />
          {hours?.enabled ? `Available ${clock12(hours.start)} – ${clock12(hours.end)}` : <>No available hours · <a href="#/settings">set hours</a></>}
        </p>
        {agenda.length > 0 && (
          <ul className="today-sessions" aria-label="Today's schedule">
            {agenda.map(item => {
              if ("event" in item) {
                const event = item.event;
                return (
                  <li key={item.key}>
                    <button className={`today-event kind-${event.kind.toLowerCase()}`} onClick={e => onOpenEvent(event, today, e.currentTarget.getBoundingClientRect())}>
                      <span className="today-session-time">{clock12(event.start)}</span>
                      <span className="today-session-title"><Icon name={eventIcon[event.kind]} size={13} /> {event.title}</span>
                      <small>{event.location ?? duration(event.end - event.start)}</small>
                    </button>
                  </li>
                );
              }
              const s = item.session;
              const task = taskById.get(s.taskId)!;
              return (
                <li key={item.key}>
                  <button className={`cat-${task.category.toLowerCase()} ${task.done ? "done" : ""}`} onClick={e => onOpenSession(task, e.currentTarget.getBoundingClientRect(), s.id)}>
                    <span className="today-session-time">{clock12(s.start)}</span>
                    <span className="today-session-title">{task.title}</span>
                    <small>{duration(s.end - s.start)}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {dueNow.length > 0 && <h3 className="today-subhead">Due today{dueNow.some(t => t.deadline < today) ? " & overdue" : ""}</h3>}
        {dueNow.length ? <ul className="task-list">{dueNow.map(row)}</ul> : !agenda.length && <p className="muted small">Nothing scheduled or due today.</p>}
      </section>
      <div className="add-buttons">
        <button className="add-task" onClick={onAdd}><Icon name="plus" size={18} /> Add Task</button>
        <button className="add-task event" onClick={onAddEvent}><Icon name="calendar" size={17} /> Add Event</button>
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
      <section className="all-tasks">
        <h2>Tasks <span className="count">{open.length}</span></h2>
        {open.length ? <ul className="task-list">{open.map(row)}</ul> : <p className="muted small">No open tasks. Add one to get started.</p>}
        {done.length > 0 && (
          <details className="completed">
            <summary>Completed ({done.length})</summary>
            <ul className="task-list">{done.map(row)}</ul>
          </details>
        )}
      </section>
    </aside>
  );
}
