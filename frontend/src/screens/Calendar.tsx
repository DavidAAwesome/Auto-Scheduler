import { useState } from 'react';
import ScreenHeading from '../components/ScreenHeading';
import { useWorkspace } from '../hooks/useWorkspace';
import { addDays, formatDate } from '../utils/dates';
import { WEEKDAYS, clockTime, dateInZone, weekStart } from '../utils/calendar';
import './Tasks.css';
import './Planning.css';
export default function Calendar() {
  const { tasks, availability } = useWorkspace();
  const [offset, setOffset] = useState(0);
  if (!availability) return null;
  const today = dateInZone(availability.timeZone);
  const start = addDays(weekStart(today), offset * 7);
  return <>
    <ScreenHeading title="Make space for your week." description="Your saved task deadlines and available hours, together in one place." />
    <div className="calendar-toolbar">
      <div><h2>{formatDate(start)} – {formatDate(addDays(start, 6))}, {addDays(start, 6).slice(0, 4)}</h2><p className="muted">{availability.timeZone} · Deadlines do not reserve time.</p></div>
      <div className="calendar-controls"><button className="button secondary" onClick={() => setOffset(offset - 1)}>Previous week</button><button className="button secondary" onClick={() => setOffset(0)}>This week</button><button className="button secondary" onClick={() => setOffset(offset + 1)}>Next week</button></div>
    </div>
    <div className="calendar-week">
      {WEEKDAYS.map((day, index) => {
        const date = addDays(start, index);
        const hours = availability.days.find(row => row.day === index)!;
        const due = tasks.filter(task => task.deadline === date);
        return <section className={`card calendar-day ${date === today ? 'calendar-today' : ''}`} key={day} aria-label={`${day} ${date}`}>
          <h2>{day.slice(0, 3)} <span>{formatDate(date)}</span></h2>
          <p className="calendar-hours">{hours.enabled ? `Available ${clockTime(hours.start)}–${clockTime(hours.end)}` : 'No available hours'}</p>
          {due.length ? <ul>{due.map(task => <li key={task.id}><a className={task.done ? 'calendar-done' : ''} href="#/tasks"><strong>{task.title}</strong><small>{task.minutes} min · {task.priority} · {task.done ? 'Done' : 'Open'}</small></a></li>)}</ul> : <p className="muted">No deadlines</p>}
        </section>;
      })}
    </div>
    <div className="two-column calendar-agenda"><section className="card"><div className="card-heading"><h2>All task deadlines</h2><a className="text-link" href="#/tasks">Manage tasks →</a></div>
      {tasks.length ? <ul className="shared-task-list">{[...tasks].sort((a, b) => a.deadline.localeCompare(b.deadline)).map(task => <li key={task.id}><a href="#/tasks"><strong>{task.title}</strong><small>{formatDate(task.deadline)}, {task.deadline.slice(0, 4)} · {task.done ? 'Done' : 'Open'}</small></a></li>)}</ul> : <p className="muted">Add a task to see its deadline here.</p>}
    </section><section className="card"><h2>Your time, at a glance</h2><p className="muted">Available hours repeat weekly in {availability.timeZone}. Automatic scheduling and external calendar sync are planned for Sprint 2.</p><a className="text-link" href="#/settings">Edit available hours →</a></section></div>
  </>;
}
