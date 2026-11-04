import { useEffect, useState, type FormEvent } from "react";
import ScreenHeading from "../components/ScreenHeading";
import { Avatar } from "../components/AppLayout";
import AvatarDialog from "../components/AvatarDialog";
import DeleteAccountDialog from "../components/DeleteAccountDialog";
import Icon from "../components/Icon";
import { useSaveStatus } from "../hooks/useSaveStatus";
import { useWorkspace } from "../hooks/useWorkspace";
import { authSession, useAuth } from "../services/authSession";
import { accountTimeZone } from "../utils/timeZones";

function NameForm({ name }: { name: string }) {
  const [value, setValue] = useState(name);
  const [saved, setSaved] = useState(name);
  const save = useSaveStatus();
  const dirty = value.trim() !== saved && value.trim() !== "";
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return save.fail("Enter a name.");
    await save.run(async () => {
      await authSession.updateName(value);
      setSaved(value.trim());
      setValue(value.trim());
    });
  }
  return (
    <form className="name-form" onSubmit={submit} noValidate>
      <label htmlFor="display-name">Display name</label>
      <div className="name-form-row">
        <input id="display-name" value={value} maxLength={80} autoComplete="name"
          aria-invalid={save.status === "error" || undefined} aria-describedby={save.status === "error" ? "display-name-error" : undefined}
          onChange={e => { setValue(e.target.value); save.edited(); }} />
        <button className={`button secondary ${save.status === "saved" && !dirty ? "is-saved" : ""}`} type="submit" disabled={!dirty || save.status === "saving"}>
          {save.status === "saving" ? "Saving…" : save.status === "saved" && !dirty ? <><Icon name="check" size={15} /> Saved</> : "Save"}
        </button>
      </div>
      {save.status === "error" && <p id="display-name-error" className="form-error" role="alert">{save.error}</p>}
      <p className="sr-only" role="status">{save.status === "saved" ? "Name saved" : ""}</p>
    </form>
  );
}

/** A button that runs one account email action and reports what actually happened. */
function EmailAction({ label, run, done }: { label: string; run: () => Promise<unknown>; done: string }) {
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  async function click() {
    setState("busy"); setError("");
    try { await run(); setState("sent"); } catch (e) { setState("error"); setError((e as Error).message); }
  }
  return (
    <div className="account-action">
      {state === "sent"
        ? <p className="account-done" role="status"><Icon name="check" size={15} /> {done}</p>
        : <button type="button" className="button secondary small" disabled={state === "busy"} onClick={() => void click()}>{state === "busy" ? "Sending…" : label}</button>}
      {state === "error" && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export default function Profile() {
  const { user } = useAuth();
  const { availability } = useWorkspace();
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const avatarLabel = user?.photoURL ? "Change avatar" : "Add avatar";
  const memberSince = user?.createdAt
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: accountTimeZone(availability) }).format(new Date(user.createdAt))
    : null;

  // Picks up a verification completed in another tab or on another device.
  useEffect(() => { void authSession.refreshAccount(); }, []);

  async function logout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      await authSession.logout();
    } catch (e) {
      setLogoutError(e instanceof Error ? e.message : "Could not sign out.");
      setLoggingOut(false);
    }
  }

  if (!user) return null;
  const google = user.provider === "google";

  return (
    <div className="account-page">
      <ScreenHeading eyebrow="ACCOUNT" title="Account details" />

      <section className="account-card" aria-labelledby="profile-title">
        <h2 id="profile-title">Profile</h2>
        <div className="profile-main">
          <div className="avatar-control">
            <Avatar size={72} />
            <button type="button" className="avatar-edit" aria-haspopup="dialog" data-tooltip={avatarLabel}
              aria-label={avatarLabel} onClick={() => { setAvatarMessage(""); setAvatarOpen(true); }}>
              <Icon name={user.photoURL ? "pencil" : "plus"} size={14} />
            </button>
          </div>
          <div className="profile-fields">
            <NameForm key={user.id} name={user.name} />
          </div>
        </div>
        <dl className="account-list">
          <div><dt>Email</dt><dd className="account-email">{user.email}</dd></div>
          {memberSince && <div><dt>Member since</dt><dd>{memberSince}</dd></div>}
        </dl>
        <p className={avatarMessage ? "task-status avatar-status" : "sr-only"} role="status">{avatarMessage}</p>
      </section>

      <section className="account-card" aria-labelledby="security-title">
        <h2 id="security-title">Security</h2>
        <dl className="account-list">
          <div>
            <dt>Sign-in method</dt>
            <dd><span className="provider-pill">{google ? "Google" : "Email & password"}</span></dd>
          </div>
          <div>
            <dt>Email verification</dt>
            <dd>
              {user.emailVerified
                ? <span className="status-pill ok"><Icon name="check" size={13} /> Verified</span>
                : <span className="status-pill warn">Not verified</span>}
              {!user.emailVerified && !google && (
                <EmailAction label="Send verification email" done={`Sent to ${user.email}`} run={() => authSession.sendVerificationEmail()} />
              )}
            </dd>
          </div>
          {!google && (
            <div>
              <dt>Password</dt>
              <dd>
                <EmailAction label="Send password reset link" done={`Reset link sent to ${user.email}`} run={() => authSession.sendPasswordReset()} />
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section className="account-card" aria-labelledby="actions-title">
        <h2 id="actions-title">Account</h2>
        <div className="account-links">
          <a className="account-link" href="#/settings">
            <Icon name="settings" size={18} />
            <span>Availability &amp; settings</span>
            <Icon name="chevronRight" size={16} />
          </a>
          <button type="button" className="account-link" disabled={loggingOut} onClick={() => void logout()}>
            <Icon name="logout" size={18} />
            <span>{loggingOut ? "Signing out…" : "Log out"}</span>
          </button>
        </div>
        {logoutError && <p role="alert" className="form-error">{logoutError}</p>}
        <div className="danger-zone">
          <div>
            <h3>Delete account</h3>
            <p className="muted small">Permanently removes your account, tasks, events, and settings.</p>
          </div>
          <button type="button" className="button danger-outline" onClick={() => setConfirmDelete(true)}>Delete account</button>
        </div>
      </section>

      {avatarOpen && <AvatarDialog onClose={() => setAvatarOpen(false)} onSaved={setAvatarMessage} />}
      {confirmDelete && <DeleteAccountDialog onClose={() => setConfirmDelete(false)} />}
    </div>
  );
}
