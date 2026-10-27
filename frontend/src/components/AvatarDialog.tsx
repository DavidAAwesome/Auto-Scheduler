import { useEffect, useRef, useState, type ChangeEvent } from "react";
import Modal from "./Modal";
import Icon from "./Icon";
import { Avatar } from "./AppLayout";
import { authSession, useAuth } from "../services/authSession";
import { AVATAR_ACCEPT, AVATAR_GUIDANCE, avatarFileError } from "../services/avatarUpload";

/**
 * Picks, previews and saves an avatar. The current avatar stays in place until the
 * server confirms the replacement; the local preview is labelled as pending.
 */
export default function AvatarDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const { user } = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "upload" | "remove">("");
  const [error, setError] = useState("");
  const title = user?.photoURL ? "Change avatar" : "Add avatar";

  // Release the temporary preview URL whenever it is replaced or the dialog closes.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function run(kind: "upload" | "remove", action: () => Promise<void>, success: string) {
    if (inFlight.current) return; // Ignore double clicks and repeated picks while saving.
    inFlight.current = true;
    setBusy(kind);
    setError("");
    try {
      await action();
      onSaved(success);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Your previous avatar is unchanged.");
    } finally {
      inFlight.current = false;
      setBusy("");
      setPreview(null);
    }
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // Allow choosing the same file again after an error.
    if (!file || inFlight.current) return; // Cancelling the picker changes nothing.
    const problem = avatarFileError(file);
    if (problem) { setError(problem); return; }
    setPreview(URL.createObjectURL(file));
    void run("upload", () => authSession.setAvatar(file), "Avatar saved.");
  }

  return (
    <Modal eyebrow="ACCOUNT" title={title} busy={Boolean(busy)} onClose={onClose}>
      <div className="avatar-dialog">
        <div className="avatar-dialog-preview" aria-busy={busy === "upload"}>
          {preview
            ? <img className="avatar" src={preview} alt="Preview of your new avatar, not saved yet" width={112} height={112} />
            : <Avatar size={112} />}
          {preview && <span className="avatar-pending"><span className="spinner" aria-hidden="true" /> Pending</span>}
        </div>
        <p id="avatar-guidance" className="muted small">{AVATAR_GUIDANCE}</p>
        <p className="task-status" role="status">{busy === "upload" ? "Uploading… your current avatar stays until this is saved." : busy === "remove" ? "Removing…" : ""}</p>
        {error && <p role="alert" className="form-error">{error}</p>}
      </div>
      <input ref={fileInput} type="file" accept={AVATAR_ACCEPT} hidden onChange={onPick} />
      <div className="task-dialog-footer">
        {user?.hasCustomAvatar && (
          <button type="button" className="button ghost avatar-remove" disabled={Boolean(busy)}
            onClick={() => void run("remove", () => authSession.clearAvatar(), "Avatar removed.")}>
            <Icon name="trash" size={16} /> Remove
          </button>
        )}
        <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={onClose}>Cancel</button>
        <button type="button" className="button" disabled={Boolean(busy)} aria-describedby="avatar-guidance" onClick={() => fileInput.current?.click()}>
          {busy === "upload" ? "Uploading…" : "Choose image"}
        </button>
      </div>
    </Modal>
  );
}
