import { useState, type FormEvent } from "react";
import Icon from "../components/Icon";
import { demoSession, DEMO_LOGIN_ERROR } from "../services/demoSession";
import "./LoginPage.css";

function LoginBrand() {
  return (
    <div className="login-logo">
      <span className="login-logo-mark" aria-hidden="true">
        ✦
      </span>
      <span>autoplan</span>
    </div>
  );
}

export default function LoginPage() {
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (
      !demoSession.login(
        String(data.get("email") ?? ""),
        String(data.get("password") ?? ""),
      )
    ) {
      setError(DEMO_LOGIN_ERROR);
      return;
    }
    setError("");
    window.location.hash = "/home";
  }
  return (
    <main className="prototype-login">
      <section className="login-left" aria-label="A calmer way to plan">
        <div className="login-copy">
          <LoginBrand />
          <p className="login-eyebrow">A CALMER WAY TO PLAN</p>
          <h1>
            Make room for
            <br />
            what matters.
          </h1>
          <p className="login-description">
            Your tasks, time, and priorities in one clear place.
          </p>
          <section className="login-preview" aria-label="Sample daily plan">
            <p className="login-eyebrow">TODAY’S FOCUS</p>
            <h3>A plan you can actually do</h3>
            <div className="login-preview-event">
              <strong>Review security lecture</strong>
              <small>9:00 – 10:00 AM</small>
            </div>
            <div className="login-preview-event break">
              <strong>Short break</strong>
              <small>10:00 – 10:10 AM</small>
            </div>
          </section>
        </div>
      </section>
      <section className="login-right" aria-labelledby="login-heading">
        <form className="prototype-login-form" onSubmit={submit}>
          <LoginBrand />
          <p className="login-eyebrow">WELCOME BACK</p>
          <h2 id="login-heading">Sign in to your space</h2>
          <p className="login-subtitle">
            Try the planning flow with a demo account.
          </p>
          <div className="prototype-login-notice" id="demo-login-notice">
            Prototype login. Use <strong>demo@autoplan.app</strong> and{" "}
            <strong>autoplan</strong>. No real account is created.
          </div>
          <div className="login-field">
            <label htmlFor="login-email">Email address</label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="username"
              required
              placeholder="demo@autoplan.app"
              aria-describedby="demo-login-notice login-error"
              aria-invalid={!!error}
            />
          </div>
          <div className="login-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="Enter demo password"
              aria-describedby="login-error"
              aria-invalid={!!error}
            />
          </div>
          <div
            className="prototype-login-error"
            id="login-error"
            aria-live="polite"
          >
            {error}
          </div>
          <button className="login-submit" type="submit">
            Continue to demo <Icon name="arrow" size={16} />
          </button>
          <p className="prototype-demo-label">
            Private prototype · No Google account connection
          </p>
        </form>
      </section>
    </main>
  );
}
