import ScreenHeading from "../components/ScreenHeading";

export default function Settings() {
  return (
    <>
      <ScreenHeading
        title="Planning, on your terms."
        description="Make AutoPlan fit the way you work and the life you live."
      />
      <section className="card settings-card" aria-label="Settings preview">
        {[
          ["Available hours", "Choose your available hours for each day of the week."],
          ["Time zone", "Keep your plans aligned with your local time."],
          ["Optional reminders", "Choose whether and when AutoPlan reminds you about tasks."],
        ].map(([title, description]) => (
          <div className="settings-row" key={title}>
            <div>
              <h2>{title}</h2>
              <p className="muted">{description}</p>
            </div>
            <span className="preview-label">Coming soon</span>
          </div>
        ))}
      </section>
      <p className="settings-note">
        Your name and email live on{" "}
        <a className="text-link" href="#/profile">Profile →</a>
      </p>
    </>
  );
}
