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
  const [notice, setNotice] = useState("");
  async function google() {
    if (loading) return;
    setError(""); setNotice(""); setLoading(true);
    try { await authSession.loginWithGoogle(); window.location.hash = "/home"; }
    catch (err) { setError(err instanceof Error ? err.message : "Google sign-in failed."); }
    finally { setLoading(false); }
  }
  async function forgotPassword(form: HTMLFormElement | null) {
    const email = String(new FormData(form ?? undefined).get("email") ?? "").trim();
    setError(""); setNotice("");
    if (!email) { setError("Enter your email address first, then choose Forgot password."); return; }
    try { await authSession.resetPassword(email); setNotice(`If an account exists for ${email}, a reset link is on its way.`); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not send a reset email."); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    setError(""); setNotice("");
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
          {!signup && <button type="button" className="forgot-link" disabled={loading} onClick={e => void forgotPassword(e.currentTarget.form)}>Forgot password?</button>}
          <div
            className="prototype-login-error"
            id="login-error"
            aria-live="polite"
          >
            {error}
          </div>
          {notice && <p className="login-notice" role="status">{notice}</p>}
          <button className="login-submit" type="submit" disabled={loading}>
            {loading ? "Please wait…" : signup ? "Create account" : "Sign in"} <Icon name="arrow" size={16} />
          </button>
          <div className="login-divider"><span>or</span></div>
          <button type="button" className="google-button" disabled={loading} onClick={() => void google()}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
            Continue with Google
          </button>
          <p className="login-account-link">
            {signup ? "Already have an account?" : "New to AutoPlan?"}{" "}<a className="text-link" href={signup ? "#/login" : "#/signup"}>{signup ? "Sign in" : "Create an account"}</a>
          </p>
        </form>
      </section>
    </main>
  );
}
