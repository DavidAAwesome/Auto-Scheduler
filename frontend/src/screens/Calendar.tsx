import ScreenHeading from "../components/ScreenHeading";
import MockNotice from "../components/MockNotice";
import { useMockData } from "../hooks/useMockData";
import { formatDate } from "../utils/dates";
import "./Tasks.css";
export default function Calendar() {
  const { tasks, calendarEvents } = useMockData();
  const ordered = [...tasks].sort((a, b) =>
    a.deadline.localeCompare(b.deadline),
  );
  return (
    <>
      <ScreenHeading
        title="Make space for your week."
        description="Task deadlines and sample calendar events, together in one place."
      />
      <MockNotice />
      <div className="two-column">
        <section className="card">
          <div className="card-heading">
            <h2>Task deadlines</h2>
            <a className="text-link" href="#/tasks">
              Manage tasks →
            </a>
          </div>
          <p className="muted">
            Deadlines are not scheduled focus blocks. Automatic scheduling is
            coming later.
          </p>
          {ordered.length ? (
            <ul className="shared-task-list">
              {ordered.map((task) => (
                <li key={task.id}>
                  <a href="#/tasks">
                    <strong>{task.title}</strong>
                    <small>
                      {formatDate(task.deadline)} · {task.minutes} min ·{" "}
                      {task.done ? "Done" : "Open"}
                    </small>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="small-empty">
              <p>No task deadlines yet.</p>
            </div>
          )}
        </section>
        <section className="card">
          <h2>Sample calendar events</h2>
          <ul className="shared-task-list">
            {calendarEvents.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{event.title}</strong>
                  <small>
                    {formatDate(event.date)} ·{" "}
                    {String(Math.floor(event.start / 60)).padStart(2, "0")}:
                    {String(event.start % 60).padStart(2, "0")} –{" "}
                    {String(Math.floor(event.end / 60)).padStart(2, "0")}:
                    {String(event.end % 60).padStart(2, "0")}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
