import ScreenHeading from "../components/ScreenHeading";
import { duration } from "../utils/taskDisplay";
import { useWorkspace } from "../hooks/useWorkspace";
import type { Category } from "../types/models";

export default function Analytics() {
  const { tasks, availability } = useWorkspace();
  const done = tasks.filter(t => t.done);
  const open = tasks.filter(t => !t.done);
  const weeklyAvailable = availability?.days.filter(d => d.enabled).reduce((sum, d) => sum + d.end - d.start, 0) ?? 0;
  const openMinutes = open.reduce((sum, t) => sum + t.minutes, 0);
  const categories: Category[] = ["Project", "Study", "Personal", "Work"];
  const stats = [
    { label: "Open tasks", value: String(open.length) },
    { label: "Completed", value: String(done.length) },
    { label: "Work remaining", value: duration(openMinutes) },
    { label: "Available each week", value: duration(weeklyAvailable) },
  ];
  return <>
    <ScreenHeading eyebrow="ANALYTICS" title="Small steps. Meaningful progress." description="A quick look at your workload. Productivity trends come later." />
    <div className="stats-grid">
      {stats.map(s => <section className="card stat" key={s.label}><strong>{s.value}</strong><span className="muted">{s.label}</span></section>)}
    </div>
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
