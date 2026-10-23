import { useState, type FormEvent } from "react";
import type { CalendarEvent, CalendarEventInput, EventKind } from "../types/models";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { WEEKDAYS, clock12, clockTime, parseClock, weekdayIndex } from "../utils/calendar";
import { addDays, localDate } from "../utils/dates";
import { EVENT_KINDS, eventIcon, occurrenceCount, occursOn } from "../utils/events";
import Icon from "./Icon";
import Modal from "./Modal";

const timeValue = (minutes: number) => (minutes >= 1440 ? "00:00" : clockTime(minutes));

/** Add or edit a fixed-time commitment (class, meeting, meetup). Weekly repeat covers a class schedule. */
export default function EventForm({ event, date, start, onClose, onSave }: {
  event?: CalendarEvent;
  date?: string;
  start?: number;
  onClose: () => void;
  onSave: (message: string) => void;
}) {
  const { sessions, events } = useWorkspace();
  const first = event?.date ?? date ?? localDate();
  const begin = event?.start ?? start ?? 10 * 60;
  const [kind, setKind] = useState<EventKind>(event?.kind ?? "Meeting");
  const [day, setDay] = useState(first);
  const [from, setFrom] = useState(timeValue(begin));
  const [until, setUntil] = useState(timeValue(event?.end ?? Math.min(begin + 60, 1440)));
  const [repeats, setRepeats] = useState(!!event?.repeat);
  const [weekdays, setWeekdays] = useState<number[]>(event?.repeat?.weekdays ?? [weekdayIndex(first)]);
  // Default to about a semester's worth of weeks.
  const [repeatUntil, setRepeatUntil] = useState(event?.repeat?.until ?? addDays(first, 7 * 14));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const startMin = parseClock(from);
  const endMin = until === "00:00" ? 1440 : parseClock(until);
  const repeat = repeats ? { weekdays: [...weekdays].sort(), until: repeatUntil } : null;
  const draft: CalendarEvent = {
    id: event?.id ?? "draft", title: "", kind, date: day, start: startMin, end: endMin, location: null, repeat,
    skipDates: event?.skipDates ?? [], source: "manual",
  };
  const count = repeat && weekdays.length && repeatUntil >= day ? occurrenceCount(draft) : 1;
  // Work already planned in this time slot: allowed to save, but the user should move it.
  const conflicts = endMin > startMin ? sessions.filter(s => s.start < endMin && s.end > startMin && occursOn(draft, s.date)) : [];
  const overlapsEvent = endMin > startMin && events.some(e => e.id !== event?.id && e.start < endMin && e.end > startMin && occursOn(e, day) && occursOn(draft, day));

  function toggleWeekday(index: number) {
    setWeekdays(current => current.includes(index) ? current.filter(d => d !== index) : [...current, index]);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    const data = new FormData(e.currentTarget);
    const input: CalendarEventInput = {
      title: String(data.get("title")),
      kind,
      date: day,
      start: startMin,
      end: endMin,
      location: String(data.get("location") ?? "").trim() || null,
      repeat,
    };
    setSaving(true); setError("");
    try {
      if (event) await workspaceService.updateEvent(event.id, input);
      else await workspaceService.createEvent(input);
      onSave(event ? "Event updated" : repeat ? `Event added (${count} times)` : "Event added");
      onClose();
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }
  return (
    <Modal eyebrow={event ? "EDIT EVENT" : "NEW EVENT"} title={event ? "Edit event" : "Add an event"} busy={saving} onClose={onClose}>
      <form className="task-form" onSubmit={submit}>
        <label>
          Event name
          <input name="title" required maxLength={80} defaultValue={event?.title ?? ""} placeholder="e.g. CS 450 lecture, Team meetup" />
        </label>
        <div className="kind-picker" role="radiogroup" aria-label="Event type">
          {EVENT_KINDS.map(k => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={`chip kind-chip ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>
              <Icon name={eventIcon[k]} size={14} /> {k}
            </button>
          ))}
        </div>
        <div className="task-form-grid three">
          <label>
            {repeats ? "Starts on" : "Date"}
            <input type="date" required value={day} onChange={e => {
              setDay(e.target.value);
              if (!event && !repeats && e.target.value) setWeekdays([weekdayIndex(e.target.value)]);
            }} />
          </label>
          <label>
            From
            <input type="time" required step={300} value={from} onChange={e => {
              const length = endMin - startMin;
              setFrom(e.target.value);
              const next = parseClock(e.target.value);
              if (Number.isFinite(next) && length > 0) setUntil(timeValue(Math.min(next + length, 1440)));
            }} />
          </label>
          <label>
            Until
            <input type="time" required step={300} value={until} onChange={e => setUntil(e.target.value)} />
          </label>
        </div>
        <label>
          <span>Location <span className="optional">optional</span></span>
          <input name="location" maxLength={120} defaultValue={event?.location ?? ""} placeholder="e.g. Room 204, Zoom, Campus Center" />
        </label>
        <div className="repeat-box">
          <label className="check-row">
            <input type="checkbox" checked={repeats} onChange={e => setRepeats(e.target.checked)} />
            <Icon name="repeat" size={15} /> Repeats weekly <span className="optional">for classes and regular meetings</span>
          </label>
          {repeats && (
            <>
              <div className="weekday-picker" role="group" aria-label="Repeat on">
                {WEEKDAYS.map((name, index) => (
                  <button key={name} type="button" aria-pressed={weekdays.includes(index)} title={name} onClick={() => toggleWeekday(index)}>{name.slice(0, 2)}</button>
                ))}
              </div>
              <label className="inline-label">
                Until (last class / meeting day)
                <input type="date" required min={day} value={repeatUntil} onChange={e => setRepeatUntil(e.target.value)} />
              </label>
              <p className="muted small">
                {weekdays.length ? `Happens ${count} time${count === 1 ? "" : "s"}, ${clock12(startMin)} – ${clock12(endMin % 1440)}.` : "Choose at least one day."}
                {event?.repeat && " Changes apply to every occurrence."}
              </p>
            </>
          )}
        </div>
        {conflicts.length > 0 && (
          <p className="form-warning">
            {conflicts.length} planned work session{conflicts.length > 1 ? "s overlap" : " overlaps"} this time. You can still save, then move {conflicts.length > 1 ? "them" : "it"}.
          </p>
        )}
        {overlapsEvent && <p className="form-warning">This overlaps another event on {day}.</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="task-dialog-footer">
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="button" type="submit" disabled={saving || endMin <= startMin || (repeats && !weekdays.length)}>
            {saving ? "Saving…" : event ? "Save changes" : "Add event"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
