import { useState, type FormEvent } from "react";
import Icon from "../components/Icon";
import { authSession } from "../services/authSession";
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

export default function LoginPage({ signup = false }: { signup?: boolean }) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    setError("");
    if (signup && password !== data.get("confirmPassword")) { setError("Passwords do not match."); return; }
    if (signup && !String(data.get("name") ?? "").trim()) { setError("Enter your name."); return; }
    setLoading(true);
    try {
      if (signup) await authSession.signup(String(data.get("name")).trim(), email, password);
      else await authSession.login(email, password);
      window.location.hash = "/home";
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to sign in. Please try again."); }
    finally { setLoading(false); }
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
          <p className="login-eyebrow">{signup ? "WELCOME TO AUTOPLAN" : "WELCOME BACK"}</p>
          <h2 id="login-heading">{signup ? "Create your space" : "Sign in to your space"}</h2>
          <p className="login-subtitle">
            {signup ? "A calmer week starts with your account." : "Your tasks, time, and priorities await."}
          </p>
          {signup && <div className="login-field"><label htmlFor="signup-name">Name</label><input id="signup-name" name="name" autoComplete="name" maxLength={80} required disabled={loading} /></div>}
          <div className="login-field">
            <label htmlFor="login-email">Email address</label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="username"
              maxLength={254}
              disabled={loading}
              required
              placeholder="you@example.com"
              aria-describedby="login-error"
              aria-invalid={!!error}
            />
          </div>
          <div className="login-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete={signup ? "new-password" : "current-password"}
              minLength={signup ? 8 : undefined}
              maxLength={128}
              disabled={loading}
              required
              placeholder={signup ? "At least 8 characters" : "Enter your password"}
              aria-describedby="login-error"
              aria-invalid={!!error}
            />
          </div>
          {signup && <div className="login-field"><label htmlFor="confirm-password">Confirm password</label><input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" required maxLength={128} disabled={loading} aria-describedby="login-error" /></div>}
          <div
            className="prototype-login-error"
            id="login-error"
            aria-live="polite"
          >
            {error}
          </div>
          <button className="login-submit" type="submit" disabled={loading}>
            {loading ? "Please wait…" : signup ? "Create account" : "Sign in"} <Icon name="arrow" size={16} />
          </button>
          <p className="login-account-link">
            {signup ? "Already have an account?" : "New to AutoPlan?"}{" "}<a className="text-link" href={signup ? "#/login" : "#/signup"}>{signup ? "Sign in" : "Create an account"}</a>
          </p>
        </form>
      </section>
    </main>
  );
}
