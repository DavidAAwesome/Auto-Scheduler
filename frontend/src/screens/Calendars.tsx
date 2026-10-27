import { useState } from "react";
import ScreenHeading from "../components/ScreenHeading";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { PROVIDERS, fetchExternalCalendar, forgetProvider, providerConfigError } from "../services/calendarProviders";
import type { CalendarProvider } from "../types/models";
import { dateInZone, longDate } from "../utils/calendar";
import { accountTimeZone } from "../utils/timeZones";
import { SYNC_DAYS_AHEAD, SYNC_DAYS_BACK, syncRange } from "../utils/externalCalendar";

function ago(iso: string, zone: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleDateString("en-US", { timeZone: zone, dateStyle: "medium" });
}

function ProviderCard({ provider }: { provider: CalendarProvider }) {
  const { connections, availability, saving } = useWorkspace();
  const connection = connections.find(c => c.provider === provider);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const setupProblem = providerConfigError(provider);
  const { name } = PROVIDERS[provider];

  async function sync() {
    if (!availability) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const zone = accountTimeZone(availability);
      const range = syncRange(dateInZone(zone));
      const fetched = await fetchExternalCalendar(provider, range.rangeStart, range.rangeEnd, zone);
      const saved = await workspaceService.syncCalendar(provider, { account: fetched.account, ...range, events: fetched.events });
      setMessage(`Imported ${saved.eventCount} event${saved.eventCount === 1 ? "" : "s"} from ${saved.account}.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError(""); setMessage("");
    try {
      await workspaceService.disconnectCalendar(provider);
      await forgetProvider(provider);
      setConfirming(false);
      setMessage(`Disconnected. Imported ${name} events were removed from AutoPlan (nothing changed in ${name}).`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <section className={`card provider-card provider-${provider}`} aria-labelledby={`${provider}-title`}>
      <div className="provider-head">
        <span className={`calendar-dot ${provider}`} aria-hidden="true" />
        <div>
          <h2 id={`${provider}-title`}>{name}</h2>
          <p className="muted small">
            {connection
              ? <>Connected as <strong>{connection.account}</strong> · {connection.eventCount} events · synced {ago(connection.lastSynced, accountTimeZone(availability))}</>
              : "Not connected"}
          </p>
        </div>
        <span className={`status-pill ${connection ? "on" : ""}`}>{connection ? "Connected" : "Off"}</span>
      </div>
      {connection && <p className="muted small">Covers {longDate(connection.rangeStart)} – {longDate(connection.rangeEnd)}.</p>}
      {setupProblem && <p className="form-warning">{setupProblem}</p>}
      <div className="provider-actions">
        <button className="button" disabled={busy || saving || !!setupProblem} onClick={() => void sync()}>
          {busy && !confirming ? "Syncing…" : connection ? "Sync now" : `Connect ${name}`}
        </button>
        {connection && !confirming && <button className="button ghost" disabled={busy} onClick={() => setConfirming(true)}>Disconnect</button>}
        {confirming && (
          <>
            <span className="confirm-text">Remove imported {name} events?</span>
            <button className="button secondary small" disabled={busy} onClick={() => setConfirming(false)}>Keep</button>
            <button className="button danger small" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
          </>
        )}
      </div>
      <p className="task-status" role="status">{message}</p>
      {error && <p role="alert" className="form-error">{error}</p>}
    </section>
  );
}

/** Connect Google Calendar / Outlook. Imported events are read-only and treated as busy time. */
export default function Calendars() {
  return <>
    <ScreenHeading eyebrow="CONNECTED CALENDARS" title="Bring your calendars in." description="Import events from Google Calendar or Outlook so AutoPlan plans your work around them." />
    <ProviderCard provider="google" />
    <ProviderCard provider="outlook" />
    <section className="card provider-notes">
      <h2>How syncing works</h2>
      <ul>
        <li><strong>Read-only.</strong> AutoPlan asks only to read your calendar and never changes it. Edit imported events in Google Calendar or Outlook, then sync again.</li>
        <li><strong>What’s imported:</strong> timed events from {SYNC_DAYS_BACK} days ago to {SYNC_DAYS_AHEAD / 7} weeks ahead. All-day events, events marked “free”, and invitations you declined are skipped.</li>
        <li><strong>Busy time:</strong> imported events block work sessions and the plan generator schedules around them, like your own events.</li>
        <li><strong>Sync now:</strong> Google and Microsoft give browser apps short-lived access, so press Sync now after your calendar changes. Syncing again replaces the previous copy, so nothing is duplicated.</li>
      </ul>
    </section>
  </>;
}
