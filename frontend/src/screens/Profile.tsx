import { useState } from "react";
import ScreenHeading from "../components/ScreenHeading";
import { authSession, useAuth } from "../services/authSession";
export default function Profile() {
  const { user } = useAuth();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function logout() { setLoading(true); setError(""); try { await authSession.logout(); } catch(e) { setError(e instanceof Error ? e.message : "Could not sign out."); } finally { setLoading(false); } }
  return <><ScreenHeading title="A space that’s yours." description="Your account and personal details, all in one place."/><section className="card profile-card"><span className="avatar large">{user?.name.charAt(0).toUpperCase()}</span><h2>{user?.name}</h2><p className="muted">{user?.email}</p><a className="button secondary" href="#/settings">Workspace settings →</a>{error && <p role="alert" className="form-error">{error}</p>}<button className="button secondary" disabled={loading} onClick={() => void logout()}>{loading ? "Signing out…" : "Log out"}</button></section></>;
}
