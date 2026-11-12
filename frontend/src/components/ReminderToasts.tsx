import { useEffect, useState } from "react";
import { useReminders } from "../hooks/useReminders";
import { startsIn, type ReminderKind } from "../utils/reminders";
import Icon, { type IconName } from "./Icon";

const kindIcon: Record<ReminderKind, IconName> = { session: "clock", event: "calendar", due: "tasks" };

/** In-app reminder cards, newest first. They stay until dismissed so a reminder is never missed while away. */
export default function ReminderToasts() {
  const { toasts, dismiss } = useReminders();
  // Re-render each minute so "in 5 min" counts down.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!toasts.length) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [toasts.length]);
  return (
    <div className="reminder-toasts" role="status" aria-live="polite" aria-label="Reminders">
      {toasts.map(t => (
        <div key={t.key} className={`reminder-toast ${t.kind}`}>
          <Icon name={kindIcon[t.kind]} size={18} />
          <div>
            <strong>{t.title}</strong>
            <small>{t.body} · {t.kind === "due" ? (t.startsAt > now ? `due ${startsIn(t.startsAt, now)}` : "due now") : startsIn(t.startsAt, Math.max(now, t.shownAt))}</small>
          </div>
          <button className="icon-button ghost small" aria-label={`Dismiss reminder: ${t.title}`} onClick={() => dismiss(t.key)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
