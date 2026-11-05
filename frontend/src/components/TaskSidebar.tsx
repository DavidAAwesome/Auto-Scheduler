import { useState } from "react";
import { DEFAULT_DUE_TIME, type CalendarEvent, type ScheduleSession, type Task } from "../types/models";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { clock12, longDate } from "../utils/calendar";
import { resolveDay } from "../utils/availability";
import { formatDate } from "../utils/dates";
import { plannedMinutes } from "../utils/planning";
import { selectTasks, type TaskFilter } from "../services/taskRules";
import { allDayOn, blocksTime, eventIcon } from "../utils/events";
import { observancesBetween } from "../utils/holidays";
import { useShowHolidays } from "../services/uiState";
import { accountTimeZone } from "../utils/timeZones";
import { todayAgenda } from "../utils/schedulePreview";
import Icon from "./Icon";
import EventList from "./EventList";
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

export default function TaskSidebar({ today, onAdd, onAddEvent, onOpen, onOpenSession, onOpenEvent, onOpenBreak }: {
  today: string;
  onAdd: () => void;
  onAddEvent: () => void;
  onOpenEvent: (event: CalendarEvent, date: string, rect: DOMRect) => void;
  onOpen: (task: Task, rect: DOMRect) => void;
  onOpenSession: (task: Task, rect: DOMRect, sessionId: string) => void;
  onOpenBreak: (session: ScheduleSession, rect: DOMRect) => void;
}) {
  const { tasks, sessions, events, availability, schedulePreview, saving } = useWorkspace();
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("open");
  const sorted = [...tasks].sort((a, b) => a.deadline.localeCompare(b.deadline) || a.dueTime - b.dueTime || a.title.localeCompare(b.title));
  const dueNow = sorted.filter(t => !t.done && t.deadline <= today);
  const taskById = new Map(tasks.map(t => [t.id, t]));
  // Today's timeline comes from the same list the calendar and chat use: events, saved and proposed work, and breaks.
  // Deadlines are listed separately below, because a due date is not a work time.
  const agenda = todayAgenda({ sessions, events, tasks, schedulePreview }, today).items;
  const open = sorted.filter(t => !t.done);
  const done = sorted.filter(t => t.done);
  // Search/filter from the old Planner page. "Open" keeps completed tasks tucked under their own toggle.
  const shown = selectTasks(sorted, search.trim(), filter);
  const hours = availability ? resolveDay(availability, today) : null;
  // Show-only items for today: holidays/clock changes AutoPlan knows, and all-day events (none block time).
  const showHolidays = useShowHolidays();
  const marks = showHolidays ? observancesBetween(today, today, accountTimeZone(availability)) : [];
  const allDayToday = allDayOn(events, today);
  const row = (task: Task) => <TaskRow key={task.id} task={task} today={today} planned={plannedMinutes(task.id, sessions)} onOpen={onOpen} onError={setError} />;
  return (
    <aside className="task-sidebar" aria-label="Tasks" aria-busy={saving}>
      <section className="today-card">
        <h2>Today’s Tasks</h2>
        <p className="today-date">{longDate(today)}</p>
        {(marks.length > 0 || allDayToday.length > 0) && (
          <ul className="today-marks" aria-label="All day today">
            {marks.map(m => <li key={m.title} className={`observance-chip ${m.kind}`} title={m.note}><Icon name={m.kind === "dst" ? "clock" : "calendar"} size={12} /> <span>{m.title}</span></li>)}
            {allDayToday.map(e => (
              <li key={e.id}>
                <button className={`allday-chip source-${e.source}`} onClick={ev => onOpenEvent(e, today, ev.currentTarget.getBoundingClientRect())}>
                  <Icon name={eventIcon[e.kind]} size={12} /> <span>{e.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className={`today-hours ${hours?.enabled ? "" : "off"}`}>
          <Icon name="clock" size={14} />
          {hours?.enabled ? `Available ${hours.periods.map(p => `${clock12(p.start)} – ${clock12(p.end)}`).join(", ")}` : <span>No available hours · <a href="#/settings">set&nbsp;hours</a></span>}
        </p>
        {agenda.length > 0 && (
          <ul className="today-sessions" aria-label="Today's schedule">
            {agenda.map(item => {
              if (item.kind === "event") {
                const event = item.event;
                return (
                  <li key={`e-${event.id}`}>
                    <button className={`today-event kind-${event.kind.toLowerCase()} source-${event.source}`} onClick={e => onOpenEvent(event, today, e.currentTarget.getBoundingClientRect())}>
                      <span className="today-session-time">{clock12(event.start)}</span>
                      <span className="today-session-title"><Icon name={eventIcon[event.kind]} size={13} /> {event.title}</span>
                      <small>{blocksTime(event) ? event.location ?? duration(event.end - event.start) : "Free"}</small>
                    </button>
                  </li>
                );
              }
              if (item.kind === "proposedEvent") {
                const e = item.proposed;
                return (
                  <li key={`pe-${e.draftId}-${e.date}`}>
                    <span className={`today-event kind-${e.kind.toLowerCase()} proposed`}>
                      <span className="today-session-time">{clock12(e.start)}</span>
                      <span className="today-session-title"><Icon name={eventIcon[e.kind]} size={13} /> {e.title}</span>
                      <small>{duration(e.end - e.start)} · proposed</small>
                    </span>
                  </li>
                );
              }
              const s = item.item.session;
              const proposed = item.item.kind === "proposed";
              const task = s.taskId ? taskById.get(s.taskId) : undefined;
              if (s.type === "work" && !task) {
                // Work for an item still under review: it has no saved task yet, only the preview.
                return (
                  <li key={s.id}>
                    <span className="today-break proposed draft-work">
                      <span className="today-session-time">{clock12(s.start)}</span>
                      <span className="today-session-title">✦ {s.title}</span>
                      <small>{duration(s.end - s.start)} · proposed</small>
                    </span>
                  </li>
                );
              }
              if (s.type === "break" || !task) {
                const content = <>
                  <span className="today-session-time">{clock12(s.start)}</span>
                  <span className="today-session-title">{s.locked ? "Protected break" : "Break"}</span>
                  <small>{duration(s.end - s.start)}{proposed ? " · proposed" : ""}</small>
                </>;
                return (
                  <li key={s.id}>
                    {proposed || s.type !== "break"
                      ? <span className={`today-break ${proposed ? "proposed" : ""}`}>{content}</span>
                      : <button className="today-break" onClick={e => onOpenBreak(s, e.currentTarget.getBoundingClientRect())}>{content}</button>}
                  </li>
                );
              }
              return (
                <li key={s.id}>
                  <button className={`cat-${task.category.toLowerCase()} ${task.done || s.status === "completed" ? "done" : ""} ${proposed ? "proposed" : ""}`}
                    onClick={e => (proposed ? onOpen(task, e.currentTarget.getBoundingClientRect()) : onOpenSession(task, e.currentTarget.getBoundingClientRect(), s.id))}>
                    <span className="today-session-time">{clock12(s.start)}</span>
                    <span className="today-session-title">{task.title}</span>
                    <small>{duration(s.end - s.start)}{proposed ? " · proposed" : ""}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {agenda.some(i => i.kind === "proposedEvent" || (i.kind === "session" && i.item.kind === "proposed")) && <p className="muted small">Proposed items are a preview until you Apply.</p>}
        {dueNow.length > 0 && <h3 className="today-subhead">Deadlines: due today{dueNow.some(t => t.deadline < today) ? " & overdue" : ""}</h3>}
        {dueNow.length ? <ul className="task-list">{dueNow.map(row)}</ul> : !agenda.length && <p className="muted small">Nothing scheduled or due today.</p>}
      </section>
      <div className="add-buttons">
        <button className="add-task" onClick={onAdd}><Icon name="plus" size={18} /> Add Task</button>
        <button className="add-task event" onClick={onAddEvent}><Icon name="calendar" size={17} /> Add Event</button>
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
      <section className="all-tasks">
        <h2>Tasks <span className="count">{open.length}</span></h2>
        {tasks.length > 0 && (
          <div className="task-tools">
            <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tasks…" aria-label="Search tasks" />
            <select value={filter} onChange={e => setFilter(e.target.value as TaskFilter)} aria-label="Filter tasks">
              <option value="open">Open</option>
              <option value="done">Completed</option>
              <option value="all">All</option>
            </select>
          </div>
        )}
        {shown.length ? <ul className="task-list">{shown.map(row)}</ul> : <p className="muted small">{tasks.length ? "No tasks match." : "No open tasks. Add one to get started."}</p>}
        {filter === "open" && !search && done.length > 0 && (
          <details className="completed">
            <summary>Completed ({done.length})</summary>
            <ul className="task-list">{done.map(row)}</ul>
          </details>
        )}
      </section>
      <EventList today={today} onOpen={onOpenEvent} />
    </aside>
  );
}
