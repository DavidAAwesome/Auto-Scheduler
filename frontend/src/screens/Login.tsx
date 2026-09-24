import { useState, type FormEvent } from "react";
import Icon from "../components/Icon";
export default function Login() {
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (
      String(data.get("email")).trim().toLowerCase() !== "demo@autoplan.app" ||
      data.get("password") !== "autoplan"
    ) {
      setError("Use the demo email and password shown above to continue.");
      return;
    }
    window.location.hash = "/home";
  }
  return (
    <main className="login-page">
      <section className="login-card">
        <a className="brand" href="#/login" aria-label="AutoPlan login">
          <span className="brand-mark">✦</span>
          <span className="brand-name">autoplan</span>
        </a>
        <p className="eyebrow">WELCOME BACK</p>
        <h1>Sign in to your space</h1>
        <p className="muted">A little planning. A lot more breathing room.</p>
        <div className="demo-note">
          Try the planning flow with a demo account.
          <br />
          <strong>demo@autoplan.app</strong>
          <span> / </span>
          <strong>autoplan</strong>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            placeholder="demo@autoplan.app"
            required
            aria-describedby={error ? "login-error" : undefined}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Enter demo password"
            required
            aria-describedby={error ? "login-error" : undefined}
          />
          {error && (
            <p id="login-error" className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button" type="submit">
            Continue to demo
            <Icon name="arrow" size={18} />
          </button>
        </form>
        <p className="login-footnote">
          Private prototype · No Google account connection
        </p>
        <a className="text-link login-browse" href="#/home">
          Explore the workspace preview →
        </a>
      </section>
    </main>
  );
}
