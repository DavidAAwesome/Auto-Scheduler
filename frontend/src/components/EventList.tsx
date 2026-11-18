import { useState } from "react";
import type { CalendarEvent } from "../types/models";
import { useWorkspace } from "../hooks/useWorkspace";
import { WEEKDAYS, clock12, longDate } from "../utils/calendar";
import { addDays, formatDate } from "../utils/dates";
import { eventIcon, groupEvents, type ListedEvent } from "../utils/events";
import Icon from "./Icon";

type EventFilter = "upcoming" | "repeating" | "past";
const PAGE = 12; // rows shown before "Show more"
const SOURCE_NAME = { google: "Google Calendar", outlook: "Outlook" } as const;

/** "9 AM – 10 AM", "All day", or "Free · 10 AM – 12 AM" for show-only events that don't block time. */
const range = (e: CalendarEvent) => e.allDay ? "All day" : `${e.busy === false ? "Free · " : ""}${clock12(e.start)} – ${clock12(e.end % 1440)}`;
/** "Mon, Wed" for a weekly series. */
const weekdays = (e: CalendarEvent) => e.repeat!.weekdays.map(d => WEEKDAYS[d].slice(0, 3)).join(", ");

function dayHeading(date: string, today: string) {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  return longDate(date).replace(/, \d{4}$/, "");
}

function EventRow({ item, filter, onOpen }: { item: ListedEvent; filter: EventFilter; onOpen: (event: CalendarEvent, date: string, rect: DOMRect) => void }) {
  const { event, date } = item;
  const imported = event.source !== "manual";
  // Line 1: when it happens. Line 2 (series only): where, and until when, so neither gets cut off.
  // A multi-day imported event is one row: "Free · 10 AM → Nov 8, 4 PM" or "All day → Nov 8".
  const span = item.through && `${event.busy === false && !event.allDay ? "Free · " : ""}${event.allDay ? "All day" : clock12(event.start)} → ${formatDate(item.through.date)}${event.allDay || item.through.end === 1440 ? "" : `, ${clock12(item.through.end)}`}`;
  const when = event.repeat ? `${weekdays(event)} · ${range(event)}`
    : `${filter === "past" ? `${formatDate(date)} · ` : ""}${span || range(event)}${event.location ? ` · ${event.location}` : ""}`;
  const series = event.repeat && [event.location, `${filter === "past" ? "ended" : "until"} ${formatDate(event.repeat.until)}`].filter(Boolean).join(" · ");
  return (
    <li className={`event-row ${filter === "past" ? "past" : ""}`}>
      <button className={`event-row-main source-${event.source}`} onClick={e => onOpen(event, date, e.currentTarget.getBoundingClientRect())}
        title={imported ? `From ${SOURCE_NAME[event.source as "google" | "outlook"]}` : undefined}>
        <span className="task-icon event-row-icon"><Icon name={eventIcon[event.kind]} size={15} /></span>
        <span className="task-row-text">
          <span className="task-row-title">{event.title}</span>
          <small>{when}</small>
          {series && <small>{series}</small>}
        </span>
        {event.repeat && <span className="event-row-mark" aria-label="Repeats weekly"><Icon name="repeat" size={13} /></span>}
        {imported && <span className={`source-dot ${event.source}`} aria-label={`From ${SOURCE_NAME[event.source as "google" | "outlook"]}`} />}
      </button>
    </li>
  );
}

/** Every event in the sidebar, like the task list: upcoming one-time events by day, each repeating series once, and past ones. */
export default function EventList({ today, onOpen }: { today: string; onOpen: (event: CalendarEvent, date: string, rect: DOMRect) => void }) {
  const { events } = useWorkspace();
  const [filter, setFilter] = useState<EventFilter>("upcoming");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const groups = groupEvents(events, today);
  const query = search.trim().toLowerCase();
  const matches = (item: ListedEvent) => !query || `${item.event.title} ${item.event.location ?? ""} ${item.event.kind}`.toLowerCase().includes(query);
  const list = groups[filter].filter(matches);
  const visible = showAll ? list : list.slice(0, PAGE);
  const row = (item: ListedEvent) => <EventRow key={`${item.event.id}-${item.date}`} item={item} filter={filter} onOpen={onOpen} />;
  const empty = query ? "No events match."
    : filter === "upcoming" ? (groups.repeating.length ? "No one-time events coming up. Your repeating events are under Repeating." : "No upcoming events. Add one, or connect a calendar from the ☰ menu.")
    : filter === "repeating" ? "No repeating events. Add a class and turn on “Repeats weekly”."
    : "No past events.";

  return (
    <section className="all-events" aria-label="Events">
      <h2>Events <span className="count">{groups.upcoming.length + groups.repeating.length}</span></h2>
      {events.length > 0 && (
        <div className="task-tools">
          <input type="search" value={search} onChange={e => { setSearch(e.target.value); setShowAll(false); }} placeholder="Search…" aria-label="Search events" />
          <select value={filter} onChange={e => { setFilter(e.target.value as EventFilter); setShowAll(false); }} aria-label="Filter events">
            <option value="upcoming">Upcoming ({groups.upcoming.length})</option>
            <option value="repeating">Repeating ({groups.repeating.length})</option>
            <option value="past">Past ({groups.past.length})</option>
          </select>
        </div>
      )}
      {!list.length ? <p className="muted small">{events.length ? empty : "No events yet. Add classes, meetings and appointments so planned work avoids them."}</p>
        : filter === "upcoming" ? (
          // Upcoming one-time events, grouped under day headings.
          visible.reduce<{ date: string; items: ListedEvent[] }[]>((days, item) => {
            const last = days[days.length - 1];
            if (last?.date === item.date) last.items.push(item); else days.push({ date: item.date, items: [item] });
            return days;
          }, []).map(day => (
            <div key={day.date} className="event-day">
              <h3 className="event-day-head">{dayHeading(day.date, today)}</h3>
              <ul className="task-list">{day.items.map(row)}</ul>
            </div>
          ))
        ) : <ul className="task-list">{visible.map(row)}</ul>}
      {list.length > PAGE && (
        <button className="show-more" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${list.length}`}</button>
      )}
    </section>
  );
}
