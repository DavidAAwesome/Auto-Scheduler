import { useState } from 'react';
import ScreenHeading from '../components/ScreenHeading';
import { useWorkspace } from '../hooks/useWorkspace';
import { addDays, formatDate } from '../utils/dates';
import { WEEKDAYS, clockTime, dateInZone, weekStart, intervalOnDate } from '../utils/calendar';
import './Tasks.css';
import './Planning.css';
export default function Calendar() {
  const { tasks, availability, plan } = useWorkspace();
  const [offset, setOffset] = useState(0);
  if (!availability) return null;
  const today = dateInZone(availability.timeZone);
  const start = addDays(weekStart(today), offset * 7);
  return <>
    <ScreenHeading title="Make space for your week." description="Your tasks, planned focus time, and available hours in one place." />
    <div className="calendar-toolbar">
      <div><h2>{formatDate(start)} – {formatDate(addDays(start, 6))}, {addDays(start, 6).slice(0, 4)}</h2><p className="muted">{availability.timeZone} · Deadlines do not reserve time.</p></div>
      <div className="calendar-controls"><button className="button secondary" onClick={() => setOffset(offset - 1)}>Previous week</button><button className="button secondary" onClick={() => setOffset(0)}>This week</button><button className="button secondary" onClick={() => setOffset(offset + 1)}>Next week</button></div>
    </div>
    {plan?.stale && <p className="plan-notice">Saved plan needs review. {plan.staleReasons.join(' ')} <a href="#/assistant">Review plan →</a></p>}
    <p className="muted">{plan ? 'Purple: focus · Green: breaks · Gray: supplied busy time.' : 'No plan generated yet.'} <a className="text-link" href="#/assistant">Plan your week →</a></p>
    <div className="calendar-week">
      {WEEKDAYS.map((day, index) => {
        const date = addDays(start, index);
        const hours = availability.days.find(row => row.day === index)!;
        const due = tasks.filter(task => task.deadline === date);
        return <section className={`card calendar-day ${date === today ? 'calendar-today' : ''}`} key={day} aria-label={`${day} ${date}`}>
          <h2>{day.slice(0, 3)} <span>{formatDate(date)}</span></h2>
          <p className="calendar-hours">{hours.enabled ? `Available ${clockTime(hours.start)}–${clockTime(hours.end)}` : 'No available hours'}</p>
          {plan && [...plan.blocks.map(block => ({ ...block, label: block.title })), ...plan.busyIntervals.map((busy, i) => ({ ...busy, id: `busy-${i}`, type: 'busy', label: 'Busy calendar time' }))].sort((a, b) => a.start.localeCompare(b.start)).map(block => {
            const time = intervalOnDate(block, date, availability.timeZone);
            return time && <div className={`calendar-block ${block.type}`} key={block.id}><small>{time} · {block.type}</small><strong>{block.label}</strong></div>;
          })}
          {due.length ? <ul>{due.map(task => <li key={task.id}><a className={task.done ? 'calendar-done' : ''} href="#/tasks"><strong>{task.title}</strong><small>{task.minutes} min · {task.priority} · {task.done ? 'Done' : 'Open'}</small></a></li>)}</ul> : <p className="muted">No deadlines</p>}
        </section>;
      })}
    </div>
    <div className="two-column calendar-agenda"><section className="card"><div className="card-heading"><h2>All task deadlines</h2><a className="text-link" href="#/tasks">Manage tasks →</a></div>
      {tasks.length ? <ul className="shared-task-list">{[...tasks].sort((a, b) => a.deadline.localeCompare(b.deadline)).map(task => <li key={task.id}><a href="#/tasks"><strong>{task.title}</strong><small>{formatDate(task.deadline)}, {task.deadline.slice(0, 4)} · {task.done ? 'Done' : 'Open'}</small></a></li>)}</ul> : <p className="muted">Add a task to see its deadline here.</p>}
    </section><section className="card"><h2>Your time, at a glance</h2><p className="muted">All times are displayed in {availability.timeZone}. Available hours repeat weekly. Generate a plan in Assistant to reserve focus time. External calendar sync is not connected yet.</p><a className="text-link" href="#/settings">Edit available hours →</a></section></div>
  </>;
}
