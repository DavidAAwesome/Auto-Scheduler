import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../hooks/useWorkspace';
import { clockTime, dateInZone, intervalOnDate } from '../utils/calendar';
import { formatDate } from '../utils/dates';
import { calendarDates, moveDate, type CalendarView } from '../utils/planner';

export interface PlannerSelection { taskId?: string; title: string; time?: string; kind?: string }
const HOUR_HEIGHT = 96;
export default function PlannerCalendar({ onSelect }: { onSelect: (selection: PlannerSelection) => void }) {
  const { tasks, availability, plan } = useWorkspace();
  const zone = availability?.timeZone ?? 'UTC';
  const today = dateInZone(zone);
  const [date, setDate] = useState(today);
  const [view, setView] = useState<CalendarView>('week');
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 8 * HOUR_HEIGHT; }, [view]);
  const dates = calendarDates(date, view);
  const blocks = [
    ...(plan?.blocks ?? []).map(block => ({ ...block, kind: block.type, taskId: block.taskId ?? undefined })),
    ...(plan?.busyIntervals ?? []).map((busy, index) => ({ ...busy, id: `busy-${index}`, title: 'Supplied busy time', kind: 'busy', taskId: undefined })),
  ];
  function dateHeader(day: string) {
    return <><span>{new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(day + 'T12:00:00Z'))}</span><strong>{formatDate(day)}</strong></>;
  }
  function deadlines(day: string) {
    return tasks.filter(task => task.deadline === day).map(task => <button key={task.id} className={`planner-deadline ${task.done ? 'is-done' : ''}`} onClick={() => onSelect({ taskId: task.id, title: task.title, kind: 'Deadline', time: `${task.deadline} · no reserved time` })}><span>◇ {task.done ? 'Done' : 'Due'}</span> {task.title}</button>);
  }
  return <div className="planner-calendar">
    <div className="planner-calendar-heading"><div><p className="eyebrow">YOUR TIME, TOGETHER</p><h2>{new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'))}</h2></div><div className="planner-view" aria-label="Calendar view">{(['day', 'week', 'month'] as const).map(mode => <button key={mode} aria-pressed={view === mode} onClick={() => setView(mode)}>{mode}</button>)}</div></div>
    <div className="planner-date-nav"><button className="icon-button" aria-label={`Previous ${view}`} onClick={() => setDate(moveDate(date, view, -1))}>‹</button><button className="button secondary" onClick={() => setDate(today)}>Today</button><button className="icon-button" aria-label={`Next ${view}`} onClick={() => setDate(moveDate(date, view, 1))}>›</button><label className="planner-date-label">Go to date<input type="date" aria-label="Calendar date" value={date} onChange={event => { if (event.target.value) setDate(event.target.value); }} /></label></div>
    <p className="muted">{zone} · {dates[0]} – {dates[dates.length - 1]}</p>
    <div className="planner-legend"><span>◇ Deadline</span><span>■ Focus</span><span>▧ Break</span><span>▰ Busy snapshot</span></div>
    {plan?.stale && <p className="plan-notice">Saved plan needs review. Tasks may have changed; confirm a replacement in Assistant.</p>}
    {!plan && <p className="planner-calendar-empty">No saved plan. Add tasks and available hours, then Generate plan in Assistant.</p>}
    {view === 'month' ? <div className="planner-month">{dates.map(day => <section key={day} className={`${day === today ? 'is-today' : ''} ${day.slice(0, 7) !== date.slice(0, 7) ? 'outside-month' : ''}`} aria-label={day}><button className="planner-day-title" aria-label={`View ${day}`} onClick={() => { setDate(day); setView('day'); }}>{dateHeader(day)}</button>{deadlines(day)}{blocks.map(block => { const time = intervalOnDate(block, day, zone); return time && <button className={`planner-event ${block.kind}`} key={block.id} onClick={() => onSelect({ ...block, time: `${day} ${time} · ${zone}` })}><small>{time} · {block.kind}</small>{block.title}</button>; })}</section>)}</div> : <div className="planner-calendar-scroll" ref={scroller} tabIndex={0} aria-label="Scrollable calendar. Scroll to view all hours and days.">
      <div className={`planner-time-grid ${view}`} style={{ gridTemplateColumns: `48px repeat(${dates.length}, minmax(${view === 'day' ? '180' : '88'}px, 1fr))` }}>
        <div className="planner-grid-corner">Due</div>{dates.map(day => <div className={`planner-column-heading ${day === today ? 'is-today' : ''}`} key={day}>{dateHeader(day)}{deadlines(day)}</div>)}
        <div className="planner-time-labels">{Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>{clockTime(hour * 60)}</span>)}</div>
        {dates.map(day => {
          const weekday = (new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7;
          const hours = availability?.days.find(row => row.day === weekday);
          return <section className={`planner-time-column ${day === today ? 'is-today' : ''}`} key={day} aria-label={`${day}, ${zone}`}>
            {hours?.enabled && <div className="planner-available" style={{ top: hours.start * HOUR_HEIGHT / 60, height: (hours.end - hours.start) * HOUR_HEIGHT / 60 }}><span>Available {clockTime(hours.start)}–{clockTime(hours.end)}</span></div>}
            {blocks.map(block => {
              const time = intervalOnDate(block, day, zone);
              if (!time) return null;
              const [from, to] = time.split('–').map(value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; });
              return <button key={block.id} className={`planner-event timed ${block.kind}`} style={{ top: from * HOUR_HEIGHT / 60, height: Math.max(2, (to - from) * HOUR_HEIGHT / 60) }} aria-label={`${block.title} · ${day} ${time} · ${block.kind}`} title={`${block.title} · ${time} · ${block.kind}`} onClick={() => onSelect({ ...block, time: `${day} ${time} · ${zone}` })}><small>{time} · {block.kind}</small><strong>{block.title}</strong></button>;
            })}
          </section>;
        })}
      </div>
    </div>}
    <details className="planner-connection"><summary>Google Calendar · not connected</summary><p>Google sign-in does not connect a calendar. A calendar provider API is not implemented in this repository. Supplied busy intervals are read-only snapshots, not live Google events.</p></details>
  </div>;
}
