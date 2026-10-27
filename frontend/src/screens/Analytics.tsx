import ScreenHeading from "../components/ScreenHeading";
import Icon, { type IconName } from "../components/Icon";
import { duration } from "../utils/taskDisplay";
import { useWorkspace } from "../hooks/useWorkspace";
import { dateInZone } from "../utils/calendar";
import type { Category } from "../types/models";
import { accountTimeZone } from "../utils/timeZones";

type Stat = { icon: IconName; value: string; label: string; tone: "purple" | "green" | "peach" };

export default function Analytics() {
  const { tasks, sessions, availability } = useWorkspace();
  const zone = accountTimeZone(availability);
  const today = dateInZone(zone);
  const done = tasks.filter(t => t.done);
  const open = tasks.filter(t => !t.done);
  const weeklyAvailable = availability?.days.filter(d => d.enabled)
    .reduce((sum, d) => sum + d.periods.reduce((total, p) => total + p.end - p.start, 0), 0) ?? 0;
  const openMinutes = open.reduce((sum, t) => sum + t.remainingMinutes, 0);
  const work = sessions.filter(s => s.type === "work" && s.status === "saved");
  const manualMinutes = work.filter(s => s.source === "manual").reduce((sum, s) => sum + s.end - s.start, 0);
  const autoMinutes = work.filter(s => s.source === "auto").reduce((sum, s) => sum + s.end - s.start, 0);
  const focusToday = work.filter(s => s.date === today).length;
  const completedMinutes = tasks.reduce((sum, t) => sum + t.completedMinutes, 0);
  const categories: Category[] = ["Project", "Study", "Personal", "Work"];
  const rows: Stat[][] = [
    [
      { icon: "tasks", value: String(open.length), label: "Open tasks", tone: "purple" },
      { icon: "clock", value: String(tasks.filter(t => !t.done && t.deadline === today).length), label: "Due today", tone: "green" },
      { icon: "check", value: String(done.length), label: "Completed", tone: "peach" },
      { icon: "analytics", value: duration(openMinutes), label: "Work remaining", tone: "purple" },
    ],
    [
      { icon: "calendar", value: duration(manualMinutes), label: "Planned by you", tone: "green" },
      { icon: "assistant", value: duration(autoMinutes), label: "Auto-planned", tone: "purple" },
      { icon: "planner", value: String(focusToday), label: "Work sessions today", tone: "peach" },
      { icon: "check", value: duration(completedMinutes), label: "Work completed", tone: "green" },
    ],
  ];
  return <>
    <ScreenHeading eyebrow="ANALYTICS" title="Small steps. Meaningful progress." description={`A quick look at your workload · ${duration(weeklyAvailable)} available each week.`} />
    {rows.map((row, index) => (
      <div className="stats-grid" key={index} aria-label={index ? "Plan analytics" : "Task analytics"}>
        {row.map(s => (
          <section className="card stat" key={s.label}>
            <span className={`stat-icon ${s.tone}`}><Icon name={s.icon} size={19} /></span>
            <strong>{s.value}</strong>
            <span className="muted">{s.label}</span>
          </section>
        ))}
      </div>
    ))}
    <section className="card">
      <h2>Open work by category</h2>
      <ul className="category-bars">
        {categories.map(c => {
          const minutes = open.filter(t => t.category === c).reduce((sum, t) => sum + t.remainingMinutes, 0);
          return <li key={c}>
            <span>{c}</span>
            <span className="bar"><i className={`cat-${c.toLowerCase()}`} style={{ width: openMinutes ? `${(minutes / openMinutes) * 100}%` : 0 }} /></span>
            <span className="muted">{duration(minutes)}</span>
          </li>;
        })}
      </ul>
    </section>
  </>;
}
