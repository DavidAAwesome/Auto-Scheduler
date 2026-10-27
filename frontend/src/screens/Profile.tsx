import { useRef, useState, type ChangeEvent } from "react";
import ScreenHeading from "../components/ScreenHeading";
import { Avatar } from "../components/AppLayout";
import { authSession, useAuth } from "../services/authSession";

export default function Profile() {
  const { user } = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);

  async function logout() {
    setLoading(true);
    setError("");
    try {
      await authSession.logout();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign out.");
      setLoading(false);
    }
  }

  /** Image → Firebase Storage → https link saved on the MongoDB user (never the image bytes). */
  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setAvatarBusy(true);
    setError("");
    setMessage("");
    try {
      await authSession.setAvatar(file);
      setMessage("Avatar saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save avatar.");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function removeAvatar() {
    setAvatarBusy(true);
    setError("");
    setMessage("");
    try {
      await authSession.clearAvatar();
      setMessage("Avatar removed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove avatar.");
    } finally {
      setAvatarBusy(false);
    }
  }

  return (
    <>
      <ScreenHeading eyebrow="ACCOUNT" title="Account details" description="Your sign-in details and avatar. Tasks, events, and availability are saved to this account." />
      <section className="card profile-card">
        <Avatar size={72} />
        <div className="profile-details">
          <h2>{user?.name}</h2>
          <p className="muted">{user?.email}</p>
          <p className="provider-pill">{user?.provider === "google" ? "Signed in with Google" : "Email & password"}</p>
        </div>
      </section>
      <section className="card profile-avatar">
        <div>
          <h2>Avatar</h2>
          <p className="muted small">JPG, PNG, WebP or GIF. Photos upload to Firebase Storage; AutoPlan saves only the secure link.</p>
        </div>
        <div className="profile-avatar-actions">
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(event) => void onPick(event)} />
          <button type="button" className="button" disabled={avatarBusy} onClick={() => fileInput.current?.click()}>
            {avatarBusy ? "Saving…" : user?.photoURL ? "Change avatar" : "Add avatar"}
          </button>
          {user?.photoURL && (
            <button type="button" className="button secondary" disabled={avatarBusy} onClick={() => void removeAvatar()}>
              Delete avatar
            </button>
          )}
        </div>
      </section>
      <section className="card profile-actions">
        <a className="button secondary" href="#/settings">Availability & settings →</a>
        <button className="button secondary" disabled={loading} onClick={() => void logout()}>{loading ? "Signing out…" : "Log out"}</button>
      </section>
      {error && <p role="alert" className="form-error">{error}</p>}
      <p className="task-status" role="status">{message}</p>
      <p className="settings-note">To delete your account, open the menu under your name in the top-right corner.</p>
    </>
  );
}
