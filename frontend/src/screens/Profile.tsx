import ScreenHeading from "../components/ScreenHeading";
import { demoSession } from "../services/demoSession";
export default function Profile() {
  return (
    <>
      <ScreenHeading
        title="A space that’s yours."
        description="Your account and personal details, all in one place."
      />
      <section className="card profile-card">
        <span className="avatar large">M</span>
        <h2>Mia</h2>
        <p className="muted">demo@autoplan.app</p>
        <span className="preview-label">Demo account</span>
        <p className="muted">
          Profile editing will be available in a future update.
        </p>
        <a className="button secondary" href="#/settings">
          Workspace settings →
        </a>
        <p className="muted">
          This is a local demo. No real account is authenticated.
        </p>
        <button
          className="button secondary"
          onClick={() => demoSession.logout()}
        >
          Log out of demo
        </button>
      </section>
    </>
  );
}
