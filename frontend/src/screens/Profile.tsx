import { useState } from "react";
import ScreenHeading from "../components/ScreenHeading";
import { Avatar } from "../components/AppLayout";
import { authSession, useAuth } from "../services/authSession";
export default function Profile() {
  const { user } = useAuth();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function logout() {
    setLoading(true); setError("");
    try { await authSession.logout(); } catch (e) { setError(e instanceof Error ? e.message : "Could not sign out."); setLoading(false); }
  }
  return <>
    <ScreenHeading eyebrow="ACCOUNT" title="Account details" description="Your sign-in details. Tasks and availability are saved to this account." />
    <section className="card profile-card">
      <Avatar size={64} />
      <div className="profile-details">
        <h2>{user?.name}</h2>
        <p className="muted">{user?.email}</p>
        <p className="provider-pill">{user?.provider === "google" ? "Signed in with Google" : "Email & password"}</p>
      </div>
    </section>
    <section className="card profile-actions">
      <a className="button secondary" href="#/settings">Availability & settings →</a>
      {error && <p role="alert" className="form-error">{error}</p>}
      <button className="button secondary" disabled={loading} onClick={() => void logout()}>{loading ? "Signing out…" : "Log out"}</button>
    </section>
    <p className="settings-note">To delete your account, open the menu under your name in the top-right corner.</p>
  </>;
}
