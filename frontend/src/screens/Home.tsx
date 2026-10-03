import ScreenHeading from "../components/ScreenHeading";
import Icon from "../components/Icon";
import { useState } from "react";
import { useMockData } from "../hooks/useMockData";
import { mockDataService } from "../services/mockData";
import { formatDate, localDate } from "../utils/dates";
import MockNotice from "../components/MockNotice";
import "./Tasks.css";
export default function Home() {
  const { tasks, scheduledBlocks } = useMockData();
  const [error, setError] = useState("");
  const upcoming = tasks
    .filter((task) => !task.done)
    .sort((a, b) => a.deadline.localeCompare(b.deadline))
    .slice(0, 4);
  const focus = scheduledBlocks.filter((block) => block.type === "focus");
  return (
    <>
      <ScreenHeading
        title="Good morning, Mia 👋"
        description="Here’s what your week is shaping up to look like."
        action={
          <a className="button" href="#/tasks">
            + New task
          </a>
        }
      />
      <MockNotice />
      <section className="hero">
        <div>
          <p className="eyebrow">A LITTLE CLARITY GOES A LONG WAY</p>
          <h2>Turn your to-dos into a doable week.</h2>
          <p>
            Add tasks, choose your available hours, and review a schedule that
            makes room for breaks.
          </p>
          <a className="button" href="#/assistant">
            <Icon name="assistant" size={18} />
            Plan my week
          </a>
        </div>
      </section>
      <div className="stats-grid">
        {(
          [
            {
              icon: "tasks",
              value: String(tasks.filter((task) => !task.done).length),
              label: "Tasks to plan",
              tone: "purple",
            },
            {
              icon: "assistant",
              value: `${(focus.filter((block) => block.date === localDate()).reduce((sum, block) => sum + block.end - block.start, 0) / 60).toFixed(1)}h`,
              label: "Focus time today",
              tone: "green",
            },
            {
              icon: "calendar",
              value: String(focus.length),
              label: "Scheduled focus blocks",
              tone: "peach",
            },
          ] as const
        ).map((stat) => (
          <section className="card stat" key={stat.label}>
            <span className={`stat-icon ${stat.tone}`}>
              <Icon name={stat.icon} />
            </span>
            <strong>{stat.value}</strong>
            <span className="muted">{stat.label}</span>
          </section>
        ))}
      </div>
      <div className="two-column">
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Upcoming tasks</h2>
              <p className="muted">What needs your attention</p>
            </div>
            <a className="text-link" href="#/tasks">
              View all →
            </a>
          </div>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {upcoming.length ? (
            <ul className="shared-task-list">
              {upcoming.map((task) => (
                <li key={task.id}>
                  <input
                    type="checkbox"
                    checked={task.done}
                    aria-label={`Complete ${task.title}`}
                    onChange={() => {
                      try {
                        mockDataService.setCompleted(task.id, true);
                        setError("");
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  />
                  <a href="#/tasks">
                    {task.title}
                    <small>
                      {task.category} · {task.minutes} min · Due{" "}
                      {formatDate(task.deadline)}
                    </small>
                  </a>
                  <span
                    className={`task-priority ${task.priority.toLowerCase()}`}
                  >
                    {task.priority}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="small-empty">
              <h3>You’re all caught up</h3>
              <p>Add a task when you’re ready to plan something new.</p>
            </div>
          )}
        </section>
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Today’s timeline</h2>
              <p className="muted">Make room for your priorities</p>
            </div>
            <a className="text-link" href="#/calendar">
              Calendar →
            </a>
          </div>
          <div className="small-empty">
            <Icon name="calendar" size={28} />
            <h3>A little room to breathe</h3>
            <p>Your scheduled focus blocks will appear here.</p>
          </div>
        </section>
      </div>
    </>
  );
}
