import { useAuth } from "../services/authSession";
import ScreenHeading from "../components/ScreenHeading";
import Icon from "../components/Icon";
import { useState } from "react";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { formatDate } from "../utils/dates";

import { dateInZone, intervalOnDate } from "../utils/calendar";
import "./Tasks.css";
export default function Home() {
  const { user } = useAuth();
  const { tasks, saving, availability, plan } = useWorkspace();
  const [error, setError] = useState("");
  const zone = availability?.timeZone ?? "UTC";
  const today = dateInZone(zone);
  const upcoming = tasks
    .filter((task) => !task.done)
    .sort((a, b) => a.deadline.localeCompare(b.deadline))
    .slice(0, 4);
  const todayTasks = tasks.filter(
    (task) => task.deadline === today && !task.done,
  );
  const openCount = tasks.filter((task) => !task.done).length;
  const doneCount = tasks.filter((task) => task.done).length;
  const focusToday =
    plan?.blocks.filter(
      (block) =>
        block.type === "focus" && intervalOnDate(block, today, zone),
    ) ?? [];
  const scheduledMinutes =
    plan?.tasks.reduce((total, task) => total + task.scheduledMinutes, 0) ?? 0;
  const attentionCount =
    plan?.tasks.filter((task) => task.status !== "scheduled").length ?? 0;

  return (
    <>
      <ScreenHeading
        title={`Welcome, ${user?.name || "there"} 👋`}
        description="Here’s what your week is shaping up to look like."
        action={
          <a className="button" href="#/planner">
            Open planner
          </a>
        }
      />

      <section className="hero">
        <div>
          <p className="eyebrow">A LITTLE CLARITY GOES A LONG WAY</p>
          <h2>Turn your to-dos into a doable week.</h2>
          <p>
            Add tasks, choose your available hours, and review a schedule that
            makes room for breaks.
          </p>
          <a className="button" href="#/planner">
            <Icon name="planner" size={18} />
            Open planner
          </a>
        </div>
      </section>
      <div className="stats-grid" id="analytics" aria-label="Workspace analytics">
        {(
          [
            {
              icon: "tasks" as const,
              value: String(openCount),
              label: "Tasks to plan",
              tone: "purple",
            },
            {
              icon: "assistant" as const,
              value: String(todayTasks.length),
              label: "Tasks due today",
              tone: "green",
            },
            {
              icon: "calendar" as const,
              value: String(doneCount),
              label: "Tasks completed",
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
      <div className="stats-grid" aria-label="Plan analytics">
        <section className="card stat">
          <span className="stat-icon purple">
            <Icon name="planner" />
          </span>
          <strong>{String(scheduledMinutes)}</strong>
          <span className="muted">Minutes planned</span>
        </section>
        <section className="card stat">
          <span className="stat-icon green">
            <Icon name="calendar" />
          </span>
          <strong>{String(focusToday.length)}</strong>
          <span className="muted">Focus blocks today</span>
        </section>
        <section className="card stat">
          <span className="stat-icon peach">
            <Icon name="analytics" />
          </span>
          <strong>{String(attentionCount)}</strong>
          <span className="muted">Need plan attention</span>
        </section>
      </div>
      <div className="two-column">
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Upcoming tasks</h2>
              <p className="muted">What needs your attention</p>
            </div>
            <a className="text-link" href="#/planner">
              Open planner →
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
                    disabled={saving}
                    checked={task.done}
                    aria-label={`Complete ${task.title}`}
                    onChange={async () => {
                      try {
                        await workspaceService.setCompleted(task.id, true);
                        setError("");
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  />
                  <a href="#/planner">
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
              <p className="muted">
                Deadlines and focus blocks · {zone}
              </p>
            </div>
            <a className="text-link" href="#/planner">
              Planner →
            </a>
          </div>
          {focusToday.length || todayTasks.length ? (
            <ul className="shared-task-list">
              {focusToday.map((block) => (
                <li key={block.id}>
                  <a href="#/planner">
                    {block.title}
                    <small>
                      Focus · {intervalOnDate(block, today, zone)}
                    </small>
                  </a>
                </li>
              ))}
              {todayTasks.map((task) => (
                <li key={task.id}>
                  <a href="#/planner">
                    {task.title}
                    <small>
                      Deadline today · {task.minutes} min · {task.priority}
                    </small>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="small-empty">
              <Icon name="calendar" size={28} />
              <h3>A little room to breathe</h3>
              <p>
                No open deadlines or focus blocks today. Open the planner to add
                tasks or generate a plan.
              </p>
            </div>
          )}
          {plan?.stale && (
            <p className="plan-notice" style={{ marginTop: 12 }}>
              Saved plan needs review.{" "}
              <a href="#/planner">Review in planner →</a>
            </p>
          )}
        </section>
      </div>
    </>
  );
}
