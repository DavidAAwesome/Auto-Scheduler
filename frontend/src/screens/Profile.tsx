import ScreenHeading from "../components/ScreenHeading";
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
      </section>
    </>
  );
}
