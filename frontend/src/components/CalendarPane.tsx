import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { DEFAULT_DUE_TIME, type CalendarEvent, type Task, type WorkSession } from "../types/models";
import { useWorkspace } from "../hooks/useWorkspace";
import { calendarViewStore, useCalendarView } from "../services/uiState";
import {
  clock12, longDate, minutesInZone, shiftAnchor, shortWeekday, tasksByDate, visibleDates, weekdayIndex, type CalendarMode,
} from "../utils/calendar";
import { endsAfterDue, sessionsByDate } from "../utils/planning";
import { eventIcon, layoutLanes, occurrencesOn, type Placed } from "../utils/events";
import Icon from "./Icon";
import { categoryIcon, duration } from "../utils/taskDisplay";

const HOUR_HEIGHT = 48;
const MONTH_ITEM_LIMIT = 3;

export interface CalendarHandlers {
  /** Open a task's card; `sessionId` when it was opened from one of its work sessions. */
  onOpen: (task: Task, rect: DOMRect, sessionId?: string) => void;
  /** Open one occurrence of an event. */
  onOpenEvent: (event: CalendarEvent, date: string, rect: DOMRect) => void;
  /** Add a task due on `date`. */
  onAdd: (date: string) => void;
  /** An empty time slot was clicked: offer to plan work or add an event there. */
  onSlot: (date: string, start: number, rect: DOMRect) => void;
  /** Toolbar buttons: plan work time / add an event (no specific slot). */
  onPlan: (date: string) => void;
  onAddEvent: (date: string) => void;
}

const dueLabel = (task: Task) => (task.dueTime === DEFAULT_DUE_TIME ? "" : clock12(task.dueTime));
const range = (start: number, end: number) => `${clock12(start)} – ${clock12(end % 1440)}`;
/** Horizontal placement for side-by-side (overlapping) blocks. */
const laneStyle = ({ lane, lanes }: Placed, start: number, end: number): CSSProperties => ({
  top: (start / 60) * HOUR_HEIGHT + 1,
  height: Math.max(((end - start) / 60) * HOUR_HEIGHT - 2, 16),
  left: `calc(${(lane / lanes) * 100}% + 3px)`,
  width: `calc(${100 / lanes}% - 6px)`,
});

function TaskChip({ task, onOpen }: { task: Task; onOpen: CalendarHandlers["onOpen"] }) {
  const time = dueLabel(task);
  return (
    <button
      className={`task-chip cat-${task.category.toLowerCase()} prio-${task.priority.toLowerCase()} ${task.done ? "done" : ""}`}
      onClick={e => onOpen(task, e.currentTarget.getBoundingClientRect())}
      title={`${task.title} · due ${longDate(task.deadline)} at ${clock12(task.dueTime)}`}
    >
      <Icon name={categoryIcon[task.category]} size={14} />
      <span>{task.title}</span>
      {time && <small>{time}</small>}
    </button>
  );
}

function SessionBlock({ session, task, place, onOpen }: { session: WorkSession; task: Task; place: Placed; onOpen: CalendarHandlers["onOpen"] }) {
  const length = session.end - session.start;
  const late = endsAfterDue(session, task);
  return (
    <button
      className={`session-block cat-${task.category.toLowerCase()} ${task.done ? "done" : ""} ${late ? "late" : ""} ${length < 45 ? "compact" : ""}`}
      style={laneStyle(place, session.start, session.end)}
      onClick={e => { e.stopPropagation(); onOpen(task, e.currentTarget.getBoundingClientRect(), session.id); }}
      title={`Work on ${task.title} · ${range(session.start, session.end)}${late ? " · ends after the due time" : ""}`}
    >
      <span className="session-title">{late && "⚠ "}{task.title}</span>
      <span className="session-time">{range(session.start, session.end)} · {duration(length)}</span>
    </button>
  );
}

function EventBlock({ event, date, place, onOpen }: { event: CalendarEvent; date: string; place: Placed; onOpen: CalendarHandlers["onOpenEvent"] }) {
  const length = event.end - event.start;
  return (
    <button
      className={`event-block kind-${event.kind.toLowerCase()} ${length < 45 ? "compact" : ""}`}
      style={laneStyle(place, event.start, event.end)}
      onClick={e => { e.stopPropagation(); onOpen(event, date, e.currentTarget.getBoundingClientRect()); }}
      title={`${event.title} · ${range(event.start, event.end)}${event.location ? ` · ${event.location}` : ""}`}
    >
      <span className="event-title"><Icon name={eventIcon[event.kind]} size={13} /> {event.title}</span>
      <span className="event-meta">{range(event.start, event.end)}{event.location && length >= 60 ? ` · ${event.location}` : ""}</span>
    </button>
  );
}

function TimeGrid({ dates, today, onOpen, onOpenEvent, onAdd, onSlot }: CalendarHandlers & { dates: string[]; today: string }) {
  const { tasks, sessions, events, availability } = useWorkspace();
  const scroller = useRef<HTMLDivElement>(null);
  const zone = availability?.timeZone ?? "UTC";
  const [now, setNow] = useState(() => minutesInZone(zone));
  const byDate = tasksByDate(tasks);
  const sessionsOn = sessionsByDate(sessions);
  const taskById = new Map(tasks.map(t => [t.id, t]));
  useEffect(() => {
    const timer = setInterval(() => setNow(minutesInZone(zone)), 60_000);
    return () => clearInterval(timer);
  }, [zone]);
  // Open the grid at the start of the user's day rather than at midnight.
  const firstStart = Math.min(...(availability?.days.filter(d => d.enabled).map(d => d.start) ?? []), 8 * 60);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (firstStart / 60 - 0.5) * HOUR_HEIGHT);
  }, [firstStart, dates.length]);
  function slotAt(date: string, event: MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
    const start = Math.min(Math.floor((y / HOUR_HEIGHT) * 4) * 15, 1440 - 15);
    onSlot(date, start, new DOMRect(event.clientX, event.clientY, 0, 0));
  }
  const columns = { "--cols": dates.length } as CSSProperties;
  return (
    <div className="time-grid" ref={scroller} style={columns}>
      <div className="grid-head">
        <div className="corner" />
        {dates.map(date => (
          <div key={date} className={`day-head ${date === today ? "is-today" : ""}`}>
            <span className="dow">{shortWeekday(date)}</span>
            <button className="day-num" aria-label={`Open ${longDate(date)}`} onClick={() => calendarViewStore.set({ mode: "day", anchor: date })}>{Number(date.slice(8))}</button>
            <button className="day-add" aria-label={`Add task due ${longDate(date)}`} title="Add a task due this day" onClick={() => onAdd(date)}><Icon name="plus" size={14} /></button>
          </div>
        ))}
        <div className="due-label">Due</div>
        {dates.map(date => (
          <div key={date} className="due-cell">
            {(byDate.get(date) ?? []).map(task => <TaskChip key={task.id} task={task} onOpen={onOpen} />)}
          </div>
        ))}
      </div>
      <div className="grid-body">
        <div className="hours">
          {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR_HEIGHT }}>{h ? clock12(h * 60) : ""}</span>)}
        </div>
        {dates.map(date => {
          const hours = availability?.days[weekdayIndex(date)];
          const work = (sessionsOn.get(date) ?? []).filter(s => taskById.has(s.taskId));
          const occurrences = occurrencesOn(events, date);
          const items = [...occurrences.map(o => ({ kind: "event" as const, start: o.event.start, end: o.event.end, event: o.event })),
            ...work.map(s => ({ kind: "session" as const, start: s.start, end: s.end, session: s }))];
          const lanes = layoutLanes(items);
          return (
            <div key={date} className={`day-col ${date === today ? "is-today" : ""}`} onClick={e => slotAt(date, e)} title="Click to plan work or add an event">
              {hours?.enabled && (
                <div className="availability-block" style={{ top: (hours.start / 60) * HOUR_HEIGHT, height: ((hours.end - hours.start) / 60) * HOUR_HEIGHT }}>
                  <span>Available {range(hours.start, hours.end)}</span>
                </div>
              )}
              {(byDate.get(date) ?? []).filter(t => !t.done && t.dueTime !== DEFAULT_DUE_TIME).map(task => (
                <div key={task.id} className={`due-marker cat-${task.category.toLowerCase()}`} style={{ top: (task.dueTime / 60) * HOUR_HEIGHT }}>
                  <span>{task.title} due</span>
                </div>
              ))}
              {items.map(item => item.kind === "event"
                ? <EventBlock key={item.event.id} event={item.event} date={date} place={lanes.get(item)!} onOpen={onOpenEvent} />
                : <SessionBlock key={item.session.id} session={item.session} task={taskById.get(item.session.taskId)!} place={lanes.get(item)!} onOpen={onOpen} />)}
              {date === today && <div className="now-line" style={{ top: (now / 60) * HOUR_HEIGHT }} aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthGrid({ anchor, today, onOpen, onOpenEvent, onAdd }: Pick<CalendarHandlers, "onOpen" | "onOpenEvent" | "onAdd"> & { anchor: string; today: string }) {
  const { tasks, sessions, events } = useWorkspace();
  const byDate = tasksByDate(tasks);
  const sessionsOn = sessionsByDate(sessions);
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const dates = visibleDates("month", anchor);
  const month = anchor.slice(0, 7);
  return (
    <div className="month-grid">
      {dates.slice(0, 7).map(date => <div key={date} className="month-dow">{shortWeekday(date)}</div>)}
      {dates.map(date => {
        const occurrences = occurrencesOn(events, date);
        const due = byDate.get(date) ?? [];
        const work = (sessionsOn.get(date) ?? []).filter(s => taskById.has(s.taskId));
        const shownEvents = occurrences.slice(0, MONTH_ITEM_LIMIT);
        const shownDue = due.slice(0, MONTH_ITEM_LIMIT - shownEvents.length);
        const shownWork = work.slice(0, MONTH_ITEM_LIMIT - shownEvents.length - shownDue.length);
        const hidden = occurrences.length + due.length + work.length - shownEvents.length - shownDue.length - shownWork.length;
        return (
          <div key={date} className={`month-cell ${date.slice(0, 7) === month ? "" : "other-month"} ${date === today ? "is-today" : ""}`}>
            <div className="month-cell-head">
              <button className="day-num" aria-label={`Open ${longDate(date)}`} onClick={() => calendarViewStore.set({ mode: "day", anchor: date })}>{Number(date.slice(8))}</button>
              <button className="day-add" aria-label={`Add task due ${longDate(date)}`} onClick={() => onAdd(date)}><Icon name="plus" size={14} /></button>
            </div>
            {shownEvents.map(({ event }) => (
              <button key={event.id} className={`event-line kind-${event.kind.toLowerCase()}`} onClick={e => onOpenEvent(event, date, e.currentTarget.getBoundingClientRect())}>
                <Icon name={eventIcon[event.kind]} size={12} /> {clock12(event.start)} {event.title}
              </button>
            ))}
            {shownDue.map(task => <TaskChip key={task.id} task={task} onOpen={onOpen} />)}
            {shownWork.map(session => {
              const task = taskById.get(session.taskId)!;
              return (
                <button key={session.id} className={`session-line cat-${task.category.toLowerCase()}`} onClick={e => onOpen(task, e.currentTarget.getBoundingClientRect(), session.id)}>
                  <i /> {clock12(session.start)} {task.title}
                </button>
              );
            })}
            {hidden > 0 && <button className="more-link" onClick={() => calendarViewStore.set({ mode: "day", anchor: date })}>+{hidden} more</button>}
          </div>
        );
      })}
    </div>
  );
}

export default function CalendarPane({ today, ...handlers }: CalendarHandlers & { today: string }) {
  const view = useCalendarView();
  const dates = visibleDates(view.mode, view.anchor);
  const showsToday = view.mode === "month" ? view.anchor.slice(0, 7) === today.slice(0, 7) : dates.includes(today);
  const setMode = (mode: CalendarMode) => calendarViewStore.set({ mode, anchor: showsToday ? today : view.anchor });
  const step = (direction: 1 | -1) => calendarViewStore.set({ ...view, anchor: shiftAnchor(view.mode, view.anchor, direction) });
  const focusDate = view.mode === "day" ? view.anchor : today;
  return (
    <section className="calendar-pane" aria-label="Calendar">
      <div className="calendar-toolbar">
        <div className="calendar-nav">
          <button className="today-label" onClick={() => calendarViewStore.set({ ...view, anchor: today })} disabled={showsToday && view.anchor === today}>
            Today, {longDate(today)}
          </button>
          <button className="icon-button ghost small" aria-label="Previous" onClick={() => step(-1)}><Icon name="chevronLeft" size={18} /></button>
          <button className="icon-button ghost small" aria-label="Next" onClick={() => step(1)}><Icon name="chevronRight" size={18} /></button>
          {view.mode === "day" && <span className="range-label">{longDate(view.anchor)}</span>}
        </div>
        <div className="calendar-actions">
          <button className="button secondary small" onClick={() => handlers.onAddEvent(focusDate)} aria-label="Add event">
            <Icon name="calendar" size={15} /> <span>Add event</span>
          </button>
          <button className="button secondary small" onClick={() => handlers.onPlan(focusDate)} aria-label="Plan work time">
            <Icon name="clock" size={15} /> <span>Plan work time</span>
          </button>
          <div className="segmented" role="group" aria-label="Calendar view">
            {(["day", "week", "month"] as const).map(mode => (
              <button key={mode} aria-pressed={view.mode === mode} title={mode[0].toUpperCase() + mode.slice(1)} onClick={() => setMode(mode)}>
                {mode[0].toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>
      {view.mode === "month"
        ? <MonthGrid anchor={view.anchor} today={today} onOpen={handlers.onOpen} onOpenEvent={handlers.onOpenEvent} onAdd={handlers.onAdd} />
        : <TimeGrid dates={dates} today={today} {...handlers} />}
      <div className="calendar-legend">
        <span><i className="swatch event" /> Event</span>
        <span><i className="swatch session" /> Work session</span>
        <span><i className="swatch due" /> Task due</span>
        <span><i className="swatch available" /> Available hours</span>
        <span className="muted">Click an empty time slot to plan work or add an event.</span>
      </div>
    </section>
  );
}
