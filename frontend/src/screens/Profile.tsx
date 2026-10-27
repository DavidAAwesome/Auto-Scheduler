import { useState } from "react";
import ScreenHeading from "../components/ScreenHeading";
import { Avatar } from "../components/AppLayout";
import AvatarDialog from "../components/AvatarDialog";
import Icon from "../components/Icon";
import { authSession, useAuth } from "../services/authSession";

export default function Profile() {
  const { user } = useAuth();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarLabel = user?.photoURL ? "Change avatar" : "Add avatar";

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

  return (
    <>
      <ScreenHeading eyebrow="ACCOUNT" title="Account details" description="Your sign-in details and avatar. Tasks, events, and availability are saved to this account." />
      <section className="card profile-card">
        <div className="avatar-control">
          <Avatar size={72} />
          <button type="button" className="avatar-edit" aria-haspopup="dialog" data-tooltip={avatarLabel}
            aria-label={avatarLabel} onClick={() => { setMessage(""); setAvatarOpen(true); }}>
            <Icon name={user?.photoURL ? "pencil" : "plus"} size={14} />
          </button>
        </div>
        <div className="profile-details">
          <h2>{user?.name}</h2>
          <p className="muted">{user?.email}</p>
          <p className="provider-pill">{user?.provider === "google" ? "Signed in with Google" : "Email & password"}</p>
        </div>
      </section>
      <section className="card profile-actions">
        <a className="button secondary" href="#/settings">Availability & settings →</a>
        <button className="button secondary" disabled={loading} onClick={() => void logout()}>{loading ? "Signing out…" : "Log out"}</button>
      </section>
      {error && <p role="alert" className="form-error">{error}</p>}
      <p className="task-status" role="status">{message}</p>
      {avatarOpen && <AvatarDialog onClose={() => setAvatarOpen(false)} onSaved={setMessage} />}
      <p className="settings-note">To delete your account, open the menu under your name in the top-right corner.</p>
    </>
  );
}
