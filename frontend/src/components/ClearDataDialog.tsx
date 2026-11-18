import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import type { ClearedCounts } from "../services/workspaceStore";
import Icon from "./Icon";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Are you sure?" for deleting all tasks, events and history. Says exactly what goes and what stays. */
export default function ClearDataDialog({ onClose, onCleared }: { onClose: () => void; onCleared: (counts: ClearedCounts) => void }) {
  const { tasks, sessions, events, connections } = useWorkspace();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    node?.querySelector<HTMLButtonElement>(".button.secondary")?.focus();  // the safe choice has focus
    return () => node?.close();
  }, []);
  async function confirm() {
    setBusy(true); setError("");
    try {
      onCleared(await workspaceService.clearData());
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const manualEvents = events.filter(e => e.source === "manual").length;
  const imported = events.length - manualEvents;
  return (
    <dialog ref={dialog} className="task-dialog confirm-dialog" aria-labelledby="clear-title" aria-describedby="clear-what"
      onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
      <span className="confirm-icon"><Icon name="alert" /></span>
      <h2 id="clear-title">Delete all your tasks and events?</h2>
      <div id="clear-what" className="clear-summary">
        <p className="muted">This permanently deletes:</p>
        <ul>
          <li>{plural(tasks.length, "task")}{sessions.length ? ` and ${plural(sessions.length, "planned session")} (work and breaks)` : ""}</li>
          {(manualEvents > 0 || imported > 0) && <li>{[manualEvents ? `${plural(manualEvents, "event")} you added` : "", imported ? plural(imported, "imported event") : ""].filter(Boolean).join(" and ")}</li>}
          <li>Your analytics history, which is built from those tasks and sessions</li>
          {connections.length > 0 && <li>Your Google/Outlook connection{connections.length === 1 ? "" : "s"} (connect again to re-import)</li>}
        </ul>
        <p className="muted small">Your account, availability, focus and break settings, and assistant settings are kept.</p>
        <p className="clear-warning"><strong>This can’t be undone.</strong></p>
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="task-dialog-footer">
        <button className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="button danger" disabled={busy} onClick={() => void confirm()}>{busy ? "Deleting…" : "Yes, delete everything"}</button>
      </div>
    </dialog>
  );
}
