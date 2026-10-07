import { useRef, useState, type ChangeEvent } from "react";
import ScreenHeading from "../components/ScreenHeading";
import { authSession, useAuth } from "../services/authSession";

export default function Profile() {
  const { user } = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const initial = user?.name.charAt(0).toUpperCase() || "?";

  async function logout() {
    setLoading(true);
    setError("");
    try {
      await authSession.logout();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign out.");
    } finally {
      setLoading(false);
    }
  }

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
      <ScreenHeading
        title="A space that’s yours."
        description="Your account and personal details, all in one place."
      />
      <section className="card profile-card">
        <div className="profile-avatar-block">
          {user?.photoURL ? (
            <img
              className="avatar large avatar-image"
              src={user.photoURL}
              alt={`${user.name}’s avatar`}
            />
          ) : (
            <span className="avatar large" aria-hidden="true">
              {initial}
            </span>
          )}
          <div className="profile-avatar-actions">
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              hidden
              onChange={(event) => void onPick(event)}
            />
            <button
              type="button"
              className="button"
              disabled={avatarBusy}
              onClick={() => fileInput.current?.click()}
            >
              {avatarBusy
                ? "Saving…"
                : user?.photoURL
                  ? "Change avatar"
                  : "Add avatar"}
            </button>
            {user?.photoURL && (
              <button
                type="button"
                className="button secondary"
                disabled={avatarBusy}
                onClick={() => void removeAvatar()}
              >
                Delete avatar
              </button>
            )}
          </div>
          <p className="muted profile-avatar-note">
            Photos upload to Firebase Storage. AutoPlan saves only the secure
            https link in MongoDB (not the image bytes).
          </p>
        </div>
        <h2>{user?.name}</h2>
        <p className="muted">{user?.email}</p>
        <a className="button secondary" href="#/settings">
          Workspace settings →
        </a>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <p className="task-status" role="status">
          {message}
        </p>
        <button
          className="button secondary"
          disabled={loading}
          onClick={() => void logout()}
        >
          {loading ? "Signing out…" : "Log out"}
        </button>
      </section>
    </>
  );
}
