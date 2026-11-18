import { useEffect, useRef, useState, type FormEvent } from "react";
import Icon from "./Icon";
import { authSession } from "../services/authSession";

const RESEND_AFTER_SECONDS = 60;

/**
 * "Forgot password?": emails Firebase's reset link. The link opens Firebase's page to choose a new password (the
 * Firebase password policy applies there), and its Continue button returns to AutoPlan's sign-in page.
 */
export default function ResetPasswordStep({ initialEmail, onBack }: { initialEmail: string; onBack: (email: string) => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [sentTo, setSentTo] = useState("");
  const [sentAt, setSentAt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (!sentAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sentAt]);
  const waitSeconds = sentAt ? Math.max(0, Math.ceil((sentAt + RESEND_AFTER_SECONDS * 1000 - now) / 1000)) : 0;
  const trimmed = email.trim();

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || (waitSeconds && trimmed === sentTo)) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) { setError("Enter the email address you signed up with."); return; }
    setError(""); setBusy(true);
    try {
      await authSession.resetPassword(trimmed);
      setSentTo(trimmed);
      setSentAt(Date.now());
      setNow(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send a reset email. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <form className="prototype-login-form reset-password-step" onSubmit={send} noValidate>
      <p className="login-eyebrow">FORGOT PASSWORD</p>
      <h2 id="login-heading">Reset your password</h2>
      <p className="login-subtitle">Enter your account email and we’ll send you a link to choose a new password.</p>
      <div className="login-field">
        <label htmlFor="reset-email">Email address</label>
        <input
          ref={input}
          id="reset-email"
          name="email"
          type="email"
          autoComplete="username"
          maxLength={254}
          placeholder="you@example.com"
          value={email}
          disabled={busy}
          aria-describedby="login-error"
          aria-invalid={!!error}
          onChange={e => setEmail(e.target.value)}
        />
      </div>
      {sentTo && (
        <div className="login-notice" role="status">
          If an account exists for <strong>{sentTo}</strong>, a reset link is on its way. Open it, choose a new password,
          then sign in with it. The link works for 1 hour; check spam if you don’t see it.
        </div>
      )}
      <div className="prototype-login-error" id="login-error" aria-live="polite">{error}</div>
      <button className="login-submit" type="submit" disabled={busy || (waitSeconds > 0 && trimmed === sentTo)}>
        {busy ? "Sending…" : !sentTo ? "Send reset link"
          : waitSeconds > 0 && trimmed === sentTo ? `Send again in ${waitSeconds}s` : "Send link again"}
        {!busy && !(waitSeconds > 0 && trimmed === sentTo) && <Icon name="arrow" size={16} />}
      </button>
      <p className="login-account-link">
        Remembered it?{" "}
        <button type="button" className="text-link link-button" onClick={() => onBack(trimmed)}>Back to sign in</button>
      </p>
    </form>
  );
}
