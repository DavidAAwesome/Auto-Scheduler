import { useEffect, useRef, useState, type FormEvent } from "react";
import Icon from "./Icon";
import { authSession, type SignupCodeSent } from "../services/authSession";

export interface PendingSignup { name: string; email: string; password: string; sent: SignupCodeSent; sentAt: number }

const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
const clock = (total: number) => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;

/**
 * Step 2 of sign-up: the 6-digit code emailed to the address. A correct code creates the account and opens Home.
 * The code is valid 5 minutes; a new one can be requested after a minute.
 */
export default function SignupCodeStep({ pending, onResent, onBack }: {
  pending: PendingSignup;
  onResent: (next: PendingSignup) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(`We sent a 6-digit code to ${pending.email}.`);
  const [busy, setBusy] = useState<"verify" | "resend" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, [pending.sentAt]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = seconds(pending.sentAt + pending.sent.expiresInSeconds * 1000 - now);
  const resendIn = seconds(pending.sentAt + pending.sent.resendInSeconds * 1000 - now);

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{6}$/.test(code)) { setError("Enter the 6-digit code from the email."); return; }
    if (!left) { setError("This code has expired. Send a new one."); return; }
    setError(""); setBusy("verify");
    try {
      await authSession.verifySignupCode(pending.email, code);
      setNotice("Email confirmed. Creating your account…");
      await authSession.signup(pending.name, pending.email, pending.password);
      window.location.hash = "/home";
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code could not be checked. Try again.");
      setNotice("");
      setBusy(null);
    }
  }

  async function resend() {
    if (busy || resendIn) return;
    setError(""); setBusy("resend");
    try {
      const sent = await authSession.requestSignupCode(pending.email);
      onResent({ ...pending, sent, sentAt: Date.now() });
      setCode("");
      setNotice(`We sent a new code to ${pending.email}. The previous code no longer works.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send a new code.");
    } finally { setBusy(null); }
  }

  return (
    <form className="prototype-login-form signup-code-step" onSubmit={verify} noValidate>
      <p className="login-eyebrow">CHECK YOUR EMAIL</p>
      <h2 id="login-heading">Enter your code</h2>
      {notice && <p className="login-notice" role="status">{notice}</p>}
      <div className="login-field">
        <label htmlFor="signup-code">6-digit code</label>
        <input
          ref={input}
          id="signup-code"
          name="code"
          className="code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          placeholder="123456"
          value={code}
          disabled={busy === "verify"}
          aria-describedby="code-timer login-error"
          aria-invalid={!!error}
          onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        <p id="code-timer" className={`code-timer ${left ? "" : "expired"}`}>
          {left ? <>Code expires in <strong>{clock(left)}</strong></> : "This code has expired. Send a new one."}
        </p>
      </div>
      <div className="prototype-login-error" id="login-error" aria-live="polite">{error}</div>
      <button className="login-submit" type="submit" disabled={busy !== null || code.length !== 6}>
        {busy === "verify" ? "Checking…" : "Verify and create account"} <Icon name="arrow" size={16} />
      </button>
      <div className="code-actions">
        <button type="button" className="forgot-link" disabled={busy !== null || resendIn > 0} onClick={() => void resend()}>
          {busy === "resend" ? "Sending…" : resendIn ? `Send a new code in ${resendIn}s` : "Send a new code"}
        </button>
        <button type="button" className="forgot-link" disabled={busy === "verify"} onClick={onBack}>Use a different email</button>
      </div>
      <p className="login-account-link">Can’t find it? Check your spam or promotions folder.</p>
    </form>
  );
}
