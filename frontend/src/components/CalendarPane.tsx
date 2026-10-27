import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { DEFAULT_DUE_TIME, DRAFT_PREFIX, type CalendarEvent, type ProposedEvent, type ScheduleConflict, type ScheduleSession, type Task, type WorkSession } from "../types/models";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { calendarViewStore, useCalendarView } from "../services/uiState";
import {
  clock12, longDate, minutesInZone, shiftAnchor, shortWeekday, tasksByDate, visibleDates, type CalendarMode,
} from "../utils/calendar";
import { resolveDay } from "../utils/availability";
import { endsAfterDue } from "../utils/planning";
import { eventIcon, layoutLanes, occurrencesOn, type Placed } from "../utils/events";
import Icon from "./Icon";
import { categoryIcon, duration } from "../utils/taskDisplay";
import { calendarSessions, proposedEventsOn, unscheduledLine, type CalendarItem } from "../utils/schedulePreview";
import DraftReview from "./DraftReview";

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
  /** Toolbar button: plan work time (no specific slot). Events are added from the sidebar or an empty slot. */
  onPlan: (date: string) => void;
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
  const done = task.done || session.status === "completed";
  return (
    <button
      className={`session-block cat-${task.category.toLowerCase()} ${done ? "done" : ""} ${late ? "late" : ""} ${length < 45 ? "compact" : ""}`}
      style={laneStyle(place, session.start, session.end)}
      onClick={e => { e.stopPropagation(); onOpen(task, e.currentTarget.getBoundingClientRect(), session.id); }}
      title={`Work on ${task.title} · ${range(session.start, session.end)} · saved${session.locked ? ", locked" : ""}${session.status === "completed" ? ", done" : ""}${late ? " · ends after the due time" : ""}`}
    >
      <span className="session-title">{late && "⚠ "}{session.locked && "🔒 "}{task.title}</span>
      <span className="session-time">{range(session.start, session.end)} · {duration(length)}</span>
    </button>
  );
}

/** A break, saved or proposed. Breaks are reserved time: work is never placed on top of them. */
function BreakBlock({ item, place }: { item: CalendarItem; place: Placed }) {
  const { session } = item;
  const proposed = item.kind === "proposed";
  const label = session.locked ? "Protected break" : "Break";
  return (
    <div
      className={`plan-block break ${proposed ? "preview" : ""} ${session.end - session.start < 45 ? "compact" : ""}`}
      style={laneStyle(place, session.start, session.end)}
      title={`${label} · ${range(session.start, session.end)} · ${proposed ? "proposed, not saved" : "saved"}`}
    >
      <span className="session-title">{label}</span>
      <span className="session-time">{range(session.start, session.end)}{proposed ? " · proposed" : ""}</span>
    </div>
  );
}

/** A saved session the pending preview would remove; shown so nothing changes silently. */
function RemovedBlock({ item, place }: { item: CalendarItem; place: Placed }) {
  const { session } = item;
  return (
    <div className="plan-block removed compact" style={laneStyle(place, session.start, session.end)}
      title={`Apply removes this saved ${session.type === "break" ? "break" : `session for ${session.title}`}: ${item.reason ?? ""}`}>
      <span className="session-title">{session.type === "break" ? "Break" : session.title}</span>
      <span className="session-time">moves</span>
    </div>
  );
}

function EventBlock({ event, date, place, onOpen }: { event: CalendarEvent; date: string; place: Placed; onOpen: CalendarHandlers["onOpenEvent"] }) {
  const length = event.end - event.start;
  return (
    <button
      className={`event-block kind-${event.kind.toLowerCase()} source-${event.source} ${length < 45 ? "compact" : ""}`}
      style={laneStyle(place, event.start, event.end)}
      onClick={e => { e.stopPropagation(); onOpen(event, date, e.currentTarget.getBoundingClientRect()); }}
      title={`${event.title} · ${range(event.start, event.end)}${event.location ? ` · ${event.location}` : ""}${event.source === "google" ? " · from Google Calendar" : event.source === "outlook" ? " · from Outlook" : ""}`}
    >
      <span className="event-title"><Icon name={eventIcon[event.kind]} size={13} /> {event.title}</span>
      <span className="event-meta">{range(event.start, event.end)}{event.location && length >= 60 ? ` · ${event.location}` : ""}</span>
    </button>
  );
}

/** A fixed event that exists only as a draft: drawn dashed until Apply saves it. */
function ProposedEventBlock({ event, place }: { event: ProposedEvent; place: Placed }) {
  return (
    <div className={`event-block kind-${event.kind.toLowerCase()} preview ${event.end - event.start < 45 ? "compact" : ""}`}
      style={laneStyle(place, event.start, event.end)} title={`Proposed event: ${event.title} · ${range(event.start, event.end)} · not saved`}>
      <span className="event-title"><Icon name={eventIcon[event.kind]} size={13} /> ✦ {event.title}</span>
      <span className="event-meta">{range(event.start, event.end)} · proposed</span>
    </div>
  );
}

function PreviewBlock({ session, place }: { session: ScheduleSession; place: Placed }) {
  return (
    <div
      className={`plan-block focus preview ${session.end - session.start < 45 ? "compact" : ""}`}
      style={laneStyle(place, session.start, session.end)}
      title={`Proposed: ${session.title} · ${range(session.start, session.end)}`}
    >
      <span className="session-title">✦ {session.title}</span>
      <span className="session-time">{range(session.start, session.end)} · proposed</span>
    </div>
  );
}

function TimeGrid({ dates, today, onOpen, onOpenEvent, onAdd, onSlot }: CalendarHandlers & { dates: string[]; today: string }) {
  const { tasks, sessions, events, availability, schedulePreview } = useWorkspace();
  const scroller = useRef<HTMLDivElement>(null);
  const zone = availability?.timeZone ?? "UTC";
  const [now, setNow] = useState(() => minutesInZone(zone));
  const byDate = tasksByDate(tasks);
  const taskById = new Map(tasks.map(t => [t.id, t]));
  // The same list Today's Tasks and chat read: saved sessions, or the preview's proposed schedule on top of them.
  const shown = calendarSessions(sessions, schedulePreview);
  useEffect(() => {
    const timer = setInterval(() => setNow(minutesInZone(zone)), 60_000);
    return () => clearInterval(timer);
  }, [zone]);
  // Open the grid at the start of the user's day rather than at midnight.
  const firstStart = Math.min(...(availability?.days.filter(d => d.enabled).flatMap(d => d.periods.map(p => p.start)) ?? []), 8 * 60);
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
          const hours = availability ? resolveDay(availability, date) : null;
          const occurrences = occurrencesOn(events, date);
          // Proposed work for a draft has no saved task yet; it is drawn from the preview alone.
          const onDay = shown.filter(i => i.session.date === date && (i.session.type === "break" || taskById.has(i.session.taskId ?? "")
            || (i.kind === "proposed" && (i.session.taskId ?? "").startsWith(DRAFT_PREFIX))));
          const items = [...occurrences.map(o => ({ kind: "event" as const, start: o.event.start, end: o.event.end, event: o.event })),
            ...proposedEventsOn(schedulePreview, date).map(e => ({ kind: "proposedEvent" as const, start: e.start, end: e.end, proposed: e })),
            ...onDay.map(i => ({ kind: i.kind === "removed" ? "removed" as const : i.session.type === "break" ? "break" as const : i.kind === "proposed" ? "preview" as const : "session" as const,
              start: i.session.start, end: i.session.end, session: i.session, item: i }))];
          const lanes = layoutLanes(items);
          return (
            <div key={date} className={`day-col ${date === today ? "is-today" : ""}`} onClick={e => slotAt(date, e)} title="Click to plan work or add an event">
              {hours?.enabled && hours.periods.map(period => (
                <div key={period.start} className="availability-block" style={{ top: (period.start / 60) * HOUR_HEIGHT, height: ((period.end - period.start) / 60) * HOUR_HEIGHT }}>
                  <span>Available {range(period.start, period.end)}</span>
                </div>
              ))}
              {(byDate.get(date) ?? []).filter(t => !t.done && t.dueTime !== DEFAULT_DUE_TIME).map(task => (
                <div key={task.id} className={`due-marker cat-${task.category.toLowerCase()}`} style={{ top: (task.dueTime / 60) * HOUR_HEIGHT }}>
                  <span>{task.title} due</span>
                </div>
              ))}
              {items.map(item => item.kind === "event"
                ? <EventBlock key={item.event.id} event={item.event} date={date} place={lanes.get(item)!} onOpen={onOpenEvent} />
                : item.kind === "proposedEvent"
                  ? <ProposedEventBlock key={`pe-${item.proposed.draftId}`} event={item.proposed} place={lanes.get(item)!} />
                : item.kind === "session"
                  ? <SessionBlock key={item.session.id} session={item.session} task={taskById.get(item.session.taskId ?? "")!} place={lanes.get(item)!} onOpen={onOpen} />
                  : item.kind === "preview"
                    ? <PreviewBlock key={`preview-${item.session.id}`} session={item.session} place={lanes.get(item)!} />
                    : item.kind === "break"
                      ? <BreakBlock key={`break-${item.session.id}`} item={item.item} place={lanes.get(item)!} />
                      : <RemovedBlock key={`removed-${item.session.id}`} item={item.item} place={lanes.get(item)!} />)}
              {date === today && <div className="now-line" style={{ top: (now / 60) * HOUR_HEIGHT }} aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthGrid({ anchor, today, onOpen, onOpenEvent, onAdd }: Pick<CalendarHandlers, "onOpen" | "onOpenEvent" | "onAdd"> & { anchor: string; today: string }) {
  const { tasks, sessions, events, schedulePreview } = useWorkspace();
  const byDate = tasksByDate(tasks);
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const shown = calendarSessions(sessions, schedulePreview).filter(i => i.kind !== "removed" && i.session.type === "work"
    && (taskById.has(i.session.taskId ?? "") || (i.kind === "proposed" && (i.session.taskId ?? "").startsWith(DRAFT_PREFIX))));
  const dates = visibleDates("month", anchor);
  const month = anchor.slice(0, 7);
  return (
    <div className="month-grid">
      {dates.slice(0, 7).map(date => <div key={date} className="month-dow">{shortWeekday(date)}</div>)}
      {dates.map(date => {
        const occurrences = occurrencesOn(events, date);
        const newEvents = proposedEventsOn(schedulePreview, date);
        const due = byDate.get(date) ?? [];
        const work = shown.filter(i => i.session.date === date);
        const shownEvents = occurrences.slice(0, MONTH_ITEM_LIMIT);
        const shownDue = due.slice(0, MONTH_ITEM_LIMIT - shownEvents.length);
        const shownWork = work.slice(0, MONTH_ITEM_LIMIT - shownEvents.length - shownDue.length);
        const hidden = occurrences.length + due.length + work.length - shownEvents.length - shownDue.length - shownWork.length;
        const draftLines = newEvents.map(e => <span key={`pe-${e.draftId}`} className={`event-line kind-${e.kind.toLowerCase()} proposed`} title="Proposed, not saved"><Icon name={eventIcon[e.kind]} size={12} /> ✦ {clock12(e.start)} {e.title}</span>);
        return (
          <div key={date} className={`month-cell ${date.slice(0, 7) === month ? "" : "other-month"} ${date === today ? "is-today" : ""}`}>
            <div className="month-cell-head">
              <button className="day-num" aria-label={`Open ${longDate(date)}`} onClick={() => calendarViewStore.set({ mode: "day", anchor: date })}>{Number(date.slice(8))}</button>
              <button className="day-add" aria-label={`Add task due ${longDate(date)}`} onClick={() => onAdd(date)}><Icon name="plus" size={14} /></button>
            </div>
            {shownEvents.map(({ event }) => (
              <button key={event.id} className={`event-line kind-${event.kind.toLowerCase()} source-${event.source}`} onClick={e => onOpenEvent(event, date, e.currentTarget.getBoundingClientRect())}>
                <Icon name={eventIcon[event.kind]} size={12} /> {clock12(event.start)} {event.title}
              </button>
            ))}
            {draftLines}
            {shownDue.map(task => <TaskChip key={task.id} task={task} onOpen={onOpen} />)}
            {shownWork.map(({ session, kind }) => {
              const task = taskById.get(session.taskId ?? "");
              if (!task) return <span key={session.id} className="session-line proposed" title="Proposed, not saved"><i /> ✦ {clock12(session.start)} {session.title}</span>;
              return kind === "proposed"
                ? <span key={session.id} className={`session-line cat-${task.category.toLowerCase()} proposed`} title="Proposed, not saved"><i /> ✦ {clock12(session.start)} {task.title}</span>
                : (
                  <button key={session.id} className={`session-line cat-${task.category.toLowerCase()} ${session.source === "auto" ? "auto" : ""}`} onClick={e => onOpen(task, e.currentTarget.getBoundingClientRect(), session.id)}>
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
  const { connections, availability, schedulePreview, previewStale, sessions, events, saving, error } = useWorkspace();
  const [scheduleError, setScheduleError] = useState("");
  const lastPreview = useRef<string | null>(null);
  const dates = visibleDates(view.mode, view.anchor);
  const showsToday = view.mode === "month" ? view.anchor.slice(0, 7) === today.slice(0, 7) : dates.includes(today);
  const setMode = (mode: CalendarMode) => calendarViewStore.set({ mode, anchor: showsToday ? today : view.anchor });
  const step = (direction: 1 | -1) => calendarViewStore.set({ ...view, anchor: shiftAnchor(view.mode, view.anchor, direction) });
  const focusDate = view.mode === "day" ? view.anchor : today;
  const zone = availability?.timeZone ?? "UTC";
  const unscheduled = schedulePreview?.tasks.filter(t => t.unallocatedMinutes > 0) ?? [];
  const added = schedulePreview?.sessions.filter(s => s.change === "new") ?? [];
  const moved = schedulePreview?.removed.filter(r => r.session.type === "work") ?? [];
  const nowIso = new Date().toISOString();
  // Saved flexible work that a newer event now overlaps: offer a local repair instead of moving it silently.
  const clashing = schedulePreview ? [] : sessions.filter(s => s.type === "work" && s.status === "saved" && s.source === "auto" && !s.locked
    && s.endAt > nowIso && occurrencesOn(events, s.date).some(o => o.event.start < s.end && o.event.end > s.start));

  // Show every new preview: jump to its first proposed session when that day is not on screen.
  useEffect(() => {
    if (!schedulePreview || lastPreview.current === schedulePreview.previewId) return;
    lastPreview.current = schedulePreview.previewId;
    const first = schedulePreview.firstProposedDate;
    if (first && !visibleDates(view.mode, view.anchor).includes(first)) calendarViewStore.set({ ...view, anchor: first });
  }, [schedulePreview, view]);

  async function preview(run: () => Promise<unknown>) {
    setScheduleError("");
    try {
      await run();
    } catch (e) {
      setScheduleError((e as Error).message);
    }
  }
  const generateSchedule = () => preview(() => workspaceService.previewSchedule(7));
  const repairSchedule = () => preview(() => workspaceService.requestPreview({ kind: "repair", horizonDays: 7 }));
  /** A conflict choice is applied only when the user picks it. For drafts it edits the draft and previews again. */
  async function choose(conflict: ScheduleConflict, choice: string) {
    const target = conflict.items.find(i => (i.id ?? "").startsWith(DRAFT_PREFIX));
    if (choice === "raise_focus_limit" || !target) { window.location.assign("#/settings"); return; }
    const draftId = target.id!.slice(DRAFT_PREFIX.length);
    workspaceService.updateDraft(draftId, choice === "allow_split" ? { allowSplit: true } : { kind: "flexible_event", allowSplit: false });
    await preview(() => workspaceService.reviewDrafts().then(() => workspaceService.previewDrafts()));
  }
  async function applySchedule() {
    setScheduleError("");
    try {
      await workspaceService.applySchedulePreview();
    } catch (e) {
      setScheduleError((e as Error).message);
    }
  }

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
          <span className="range-label muted small">{zone}</span>
        </div>
        <div className="calendar-actions">
          <button className="button small" disabled={saving} onClick={() => void generateSchedule()} aria-label="Generate schedule">
            <Icon name="assistant" size={15} /> <span>{saving ? "Scheduling…" : "Generate Schedule"}</span>
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
      <DraftReview />
      {clashing.length > 0 && (
        <div className="schedule-preview-bar" role="region" aria-label="Schedule conflicts">
          <div><strong>{clashing.length} saved session{clashing.length === 1 ? "" : "s"} now overlap{clashing.length === 1 ? "s" : ""} an event.</strong> Nothing was moved yet.</div>
          <div className="schedule-preview-actions">
            <button className="button small" disabled={saving} onClick={() => void repairSchedule()}>Repair schedule</button>
          </div>
        </div>
      )}
      {schedulePreview && (
        <div className="schedule-preview-bar" role="region" aria-label="Schedule preview">
          <div>
            <strong>Proposed, not saved</strong> {longDate(schedulePreview.startDate)} – {longDate(schedulePreview.endDate)} ({schedulePreview.timeZone})
            {(schedulePreview.proposedEvents?.length ?? 0) > 0 && <>{" · "}{schedulePreview.proposedEvents!.length} new event occurrence{schedulePreview.proposedEvents!.length === 1 ? "" : "s"}</>}
            {" · "}{added.filter(s => s.type === "work").length} new work session{added.filter(s => s.type === "work").length === 1 ? "" : "s"}, {added.filter(s => s.type === "break").length} break{added.filter(s => s.type === "break").length === 1 ? "" : "s"}
            {moved.length > 0 && <>{" · "}{moved.length} saved session{moved.length === 1 ? "" : "s"} move</>}
            {schedulePreview.days.some(d => d.newWorkMinutes > 0) && (
              <div className="preview-days" aria-label="Scheduled days">
                {schedulePreview.days.filter(d => d.newWorkMinutes > 0 || d.breakCount > 0).map(d => (
                  <button key={d.date} className="chip" onClick={() => calendarViewStore.set({ ...view, anchor: d.date })}>
                    {shortWeekday(d.date)} {Number(d.date.slice(8))}: {duration(d.workMinutes)} work{d.breakCount ? `, ${d.breakCount} break${d.breakCount === 1 ? "" : "s"}` : ""}
                  </button>
                ))}
              </div>
            )}
            {unscheduled.length > 0 && (
              <p className="form-warning small" role="status">
                <strong>Partial plan:</strong> {unscheduled.reduce((n, t) => n + t.unallocatedMinutes, 0)} min of work can’t be placed in this window. You can still apply what fits; the rest stays on {unscheduled.length === 1 ? "its task" : "the tasks"} as unscheduled work (listed below).
              </p>
            )}
            {added.length === 0 && moved.length === 0 && !(schedulePreview.proposedEvents?.length) && (
              <p className="muted small" role="status">
                {schedulePreview.mode === "plan"
                  ? "No sessions could be placed in this window. Applying saves the new items with their work unscheduled."
                  : schedulePreview.tasks.length === 0 ? "Nothing to schedule: you have no open tasks with remaining work in this window." : "Nothing changes: your saved plan already covers everything that fits."}
              </p>
            )}
            {previewStale && <p className="form-warning small">{schedulePreview.mode === "plan" ? "The items under review changed after this preview. Preview again before applying." : "Your tasks, events or settings changed after this preview. Generate it again before applying."}</p>}
            {(unscheduled.length > 0 || schedulePreview.conflicts.length > 0 || moved.length > 0) && (
              <ul className="form-warning small">
                {moved.map(r => <li key={r.session.id}>{r.newEndAt ? "Shortens" : "Moves"} {r.session.title} ({range(r.session.start, r.session.end)}): {r.reason}</li>)}
                {schedulePreview.conflicts.map((c, i) => (
                  <li key={`c${i}`}>{c.message}
                    {(c.choices ?? []).length > 0 && (
                      <span className="conflict-choices">
                        {c.choices!.map(choice => <button key={choice.id} className="chip" disabled={saving} onClick={() => void choose(c, choice.id)}>{choice.label}</button>)}
                      </span>
                    )}
                  </li>
                ))}
                {unscheduled.map(t => <li key={t.taskId}>{unscheduledLine(t)}</li>)}
              </ul>
            )}
          </div>
          <div className="schedule-preview-actions">
            <button className="button small" disabled={saving || previewStale} onClick={() => void applySchedule()}>{saving ? "Applying…" : unscheduled.length ? "Apply partial plan" : "Apply schedule"}</button>
            <button className="button secondary small" disabled={saving} onClick={() => workspaceService.clearSchedulePreview()}>Cancel</button>
          </div>
        </div>
      )}
      {(scheduleError || error) && <p role="alert" className="form-error">{scheduleError || error}</p>}
      {view.mode === "month"
        ? <MonthGrid anchor={view.anchor} today={today} onOpen={handlers.onOpen} onOpenEvent={handlers.onOpenEvent} onAdd={handlers.onAdd} />
        : <TimeGrid dates={dates} today={today} {...handlers} />}
      <div className="calendar-legend">
        <span><i className="swatch event" /> Event</span>
        <span><i className="swatch session" /> Saved work session</span>
        <span><i className="swatch plan" /> Proposed (not saved)</span>
        {schedulePreview?.mode === "plan" && <span>✦ New item from your message</span>}
        <span><i className="swatch break" /> Break</span>
        <span><i className="swatch due" /> Task due</span>
        <span><i className="swatch available" /> Available hours</span>
        {connections.some(c => c.provider === "google") && <span><i className="swatch event source-google" /> From Google</span>}
        {connections.some(c => c.provider === "outlook") && <span><i className="swatch event source-outlook" /> From Outlook</span>}
        <span className="muted">Click an empty time slot to plan work or add an event.</span>
      </div>
    </section>
  );
}
