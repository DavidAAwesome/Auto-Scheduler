import { useEffect, useRef, useState } from "react";
import { authSession } from "../services/authSession";
import Icon from "./Icon";

/** Deletes AutoPlan data, then the Firebase account. Shared by the account menu and Account details. */
export default function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  async function confirm() {
    setBusy(true); setError("");
    try { await authSession.deleteAccount(); } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return (
    <dialog ref={dialog} className="task-dialog confirm-dialog" aria-labelledby="delete-title" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
      <span className="confirm-icon"><Icon name="alert" /></span>
      <h2 id="delete-title">Delete your account?</h2>
      <p className="muted">This permanently deletes your AutoPlan account, tasks, and availability. This can’t be undone.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="task-dialog-footer">
        <button className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="button danger" disabled={busy} onClick={() => void confirm()}>{busy ? "Deleting…" : "Delete account"}</button>
      </div>
    </dialog>
  );
}
