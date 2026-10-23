import { useState } from "react";
import type { CalendarEvent } from "../types/models";
import { useDismiss } from "../hooks/useDismiss";
import { useAnchoredCard } from "../hooks/useAnchoredCard";
import { workspaceService } from "../services/workspace";
import { WEEKDAYS, clock12, longDate } from "../utils/calendar";
import { eventIcon } from "../utils/events";
import Icon from "./Icon";

/** Card for one occurrence of an event: details, edit, and delete (this occurrence or the whole series). */
export default function EventPopover({ event, date, anchor, onClose, onEdit }: {
  event: CalendarEvent;
  date: string;
  anchor: DOMRect;
  onClose: () => void;
  onEdit: (event: CalendarEvent) => void;
}) {
  const { ref: card, attach, style: position } = useAnchoredCard(anchor);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDismiss(card, true, onClose);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); onClose(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  const days = event.repeat?.weekdays.map(d => WEEKDAYS[d].slice(0, 3)).join(", ");
  const imported = event.source !== "manual";
  const sourceName = event.source === "google" ? "Google Calendar" : "Outlook";
  return (
    <div ref={attach} className={`task-popover event-popover source-${event.source}`} role="dialog" aria-label={event.title} tabIndex={-1} style={position}>
      <div className="task-popover-bar">
        {imported
          ? <span className={`source-tag ${event.source}`}>{sourceName}{event.calendarName && event.calendarName !== sourceName ? ` · ${event.calendarName}` : ""}</span>
          : <button className="icon-button ghost small" aria-label="Edit event" title={event.repeat ? "Edit every occurrence" : "Edit event"} onClick={() => onEdit(event)}><Icon name="pencil" size={16} /></button>}
        <button className="icon-button ghost small" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
      <h3><span className="task-icon event-icon"><Icon name={eventIcon[event.kind]} size={18} /></span>{event.title}</h3>
      <p className="event-kind">{event.kind}</p>
      <dl>
        <div><dt>When</dt><dd>{longDate(date)}</dd></div>
        <div><dt>Time</dt><dd>{clock12(event.start)} – {clock12(event.end % 1440)}</dd></div>
        {event.location && <div><dt>Where</dt><dd><Icon name="pin" size={13} /> {event.location}</dd></div>}
        {event.repeat && <div><dt>Repeats</dt><dd>Every {days} until {longDate(event.repeat.until)}</dd></div>}
      </dl>
      {error && <p role="alert" className="form-error">{error}</p>}
      {imported ? (
        <div className="task-popover-actions imported-note">
          <span className="muted small">Read-only copy. Change it in {sourceName}, then sync.</span>
          {event.link && <a className="button ghost small" href={event.link} target="_blank" rel="noopener noreferrer">Open in {sourceName} ↗</a>}
        </div>
      ) : confirming ? (
        <div className="task-popover-actions">
          {event.repeat ? (
            <>
              <span className="confirm-text">Delete which?</span>
              <button className="button secondary small" disabled={busy} onClick={() => void run(() => workspaceService.skipEventOccurrence(event.id, date))}>Only this one</button>
              <button className="button danger small" disabled={busy} onClick={() => void run(() => workspaceService.deleteEvent(event.id))}>All</button>
            </>
          ) : (
            <>
              <span className="confirm-text">Delete this event?</span>
              <button className="button secondary small" disabled={busy} onClick={() => setConfirming(false)}>Keep</button>
              <button className="button danger small" disabled={busy} onClick={() => void run(() => workspaceService.deleteEvent(event.id))}>Delete</button>
            </>
          )}
        </div>
      ) : (
        <div className="task-popover-actions">
          <button className="button ghost small" disabled={busy} onClick={() => setConfirming(true)}><Icon name="trash" size={15} /> Delete</button>
        </div>
      )}
    </div>
  );
}
