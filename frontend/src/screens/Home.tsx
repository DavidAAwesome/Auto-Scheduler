import ScreenHeading from "../components/ScreenHeading";
import Icon from "../components/Icon";
export default function Home() {
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
              value: "0",
              label: "Tasks to plan",
              tone: "purple",
            },
            {
              icon: "assistant",
              value: "0.0h",
              label: "Focus time today",
              tone: "green",
            },
            {
              icon: "calendar",
              value: "0",
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
          <div className="small-empty">
            <Icon name="tasks" size={28} />
            <h3>A fresh start</h3>
            <p>Your upcoming tasks will appear here.</p>
          </div>
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
