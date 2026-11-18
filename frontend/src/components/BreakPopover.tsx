import { useState } from "react";
import type { ScheduleSession } from "../types/models";
import { useDismiss } from "../hooks/useDismiss";
import { useAnchoredCard } from "../hooks/useAnchoredCard";
import { workspaceService } from "../services/workspace";
import { clock12, longDate } from "../utils/calendar";
import { duration } from "../utils/taskDisplay";
import Icon from "./Icon";

/** Card for a saved break: when it is, who placed it, and delete. */
export default function BreakPopover({ session, anchor, onClose }: { session: ScheduleSession; anchor: DOMRect; onClose: () => void }) {
  const { ref: card, attach, style: position } = useAnchoredCard(anchor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDismiss(card, true, onClose);
  const label = session.locked ? "Protected break" : "Break";
  async function remove() {
    setBusy(true); setError("");
    try { await workspaceService.deleteSession(session.id); onClose(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return (
    <div ref={attach} className="task-popover" role="dialog" aria-label={label} tabIndex={-1} style={position}>
      <div className="task-popover-bar">
        <button className="icon-button ghost small" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
      <h3><span className="task-icon"><Icon name="clock" size={18} /></span>{label}</h3>
      <dl>
        <div><dt>When</dt><dd>{longDate(session.date)}</dd></div>
        <div><dt>Time</dt><dd>{clock12(session.start)} – {clock12(session.end % 1440)} · {duration(session.end - session.start)}</dd></div>
        <div><dt>Placed by</dt><dd>{session.locked ? "You asked for it" : "The scheduler"}</dd></div>
      </dl>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="task-popover-actions">
        <span className="muted small">Work can be planned here once it's gone.</span>
        <button className="button ghost small" disabled={busy} onClick={() => void remove()}><Icon name="trash" size={15} /> Delete break</button>
      </div>
    </div>
  );
}
