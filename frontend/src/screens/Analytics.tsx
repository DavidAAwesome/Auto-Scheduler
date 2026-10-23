import ScreenHeading from "../components/ScreenHeading";
import Icon, { type IconName } from "../components/Icon";
import { duration } from "../utils/taskDisplay";
import { useWorkspace } from "../hooks/useWorkspace";
import { dateInZone, intervalOnDate } from "../utils/calendar";
import type { Category } from "../types/models";

type Stat = { icon: IconName; value: string; label: string; tone: "purple" | "green" | "peach" };

export default function Analytics() {
  const { tasks, sessions, availability, plan } = useWorkspace();
  const zone = availability?.timeZone ?? "UTC";
  const today = dateInZone(zone);
  const done = tasks.filter(t => t.done);
  const open = tasks.filter(t => !t.done);
  const weeklyAvailable = availability?.days.filter(d => d.enabled)
    .reduce((sum, d) => sum + d.periods.reduce((total, p) => total + p.end - p.start, 0), 0) ?? 0;
  const openMinutes = open.reduce((sum, t) => sum + t.minutes, 0);
  const manualMinutes = sessions.reduce((sum, s) => sum + s.end - s.start, 0);
  const autoMinutes = plan?.tasks.reduce((sum, t) => sum + t.scheduledMinutes, 0) ?? 0;
  const focusToday = plan?.blocks.filter(b => b.type === "focus" && intervalOnDate(b, today, zone)).length ?? 0;
  const attention = plan?.tasks.filter(t => t.status !== "scheduled").length ?? 0;
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
      { icon: "planner", value: String(focusToday), label: "Focus blocks today", tone: "peach" },
      { icon: "alert", value: String(attention), label: "Need plan attention", tone: "green" },
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
    {plan?.stale && <p className="plan-notice">Saved plan needs review. {plan.staleReasons.join(" ")}</p>}
    <section className="card">
      <h2>Open work by category</h2>
      <ul className="category-bars">
        {categories.map(c => {
          const minutes = open.filter(t => t.category === c).reduce((sum, t) => sum + t.minutes, 0);
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
