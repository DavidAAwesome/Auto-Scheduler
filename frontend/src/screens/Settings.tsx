import { useState, type FormEvent } from 'react';
import ScreenHeading from '../components/ScreenHeading';
import { useWorkspace } from '../hooks/useWorkspace';
import { workspaceService } from '../services/workspace';
import type { Availability } from '../types/models';
import { WEEKDAYS, clockTime, parseClock } from '../utils/calendar';
import './Planning.css';

function AvailabilityForm({ initial }: { initial: Availability }) {
  const [draft, setDraft] = useState(() => ({ ...initial, days: initial.days.map(row => ({ ...row, start: clockTime(row.start), end: clockTime(row.end) })) }));
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const { saving } = useWorkspace();
  function changeDay(day: number, patch: Partial<typeof draft.days[number]>) {
    setDraft(current => ({ ...current, days: current.days.map(row => row.day === day ? { ...row, ...patch } : row) }));
    setMessage('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(''); setError('');
    const input: Availability = { ...draft, days: draft.days.map(row => ({ ...row, start: parseClock(row.start), end: parseClock(row.end) })) };
    if (input.days.some(day => !Number.isFinite(day.start) || !Number.isFinite(day.end) || day.end <= day.start)) { setError('Each end time must be later than its start time.'); return; }
    try {
      const saved = await workspaceService.saveAvailability(input);
      setDraft({ ...saved, days: saved.days.map(row => ({ ...row, start: clockTime(row.start), end: clockTime(row.end) })) }); setMessage('Availability saved to your account.');
    } catch (err) { setError((err as Error).message); }
  }
  return <form className="card availability-form" onSubmit={save}>
    <h2>Available hours</h2>
    <p className="muted">Choose a time window for each day. Unchecked days have no available time.</p>
    <fieldset disabled={saving}>
      <legend className="sr-only">Weekly availability</legend>
      {draft.days.map(row => <div className="availability-row" key={row.day}>
        <label className="day-toggle"><input type="checkbox" checked={row.enabled} onChange={e => changeDay(row.day, { enabled: e.target.checked })} />{WEEKDAYS[row.day]}</label>
        <label>From<input aria-label={`${WEEKDAYS[row.day]} start`} type="time" required disabled={!row.enabled} value={row.start} onChange={e => changeDay(row.day, { start: e.target.value })} /></label>
        <label>Until<input aria-label={`${WEEKDAYS[row.day]} end`} type="text" inputMode="numeric" pattern="([01][0-9]|2[0-3]):[0-5][0-9]|24:00" title="HH:MM, or 24:00 for the end of the day" required disabled={!row.enabled} value={row.end} onChange={e => changeDay(row.day, { end: e.target.value })} /></label>
      </div>)}
      <div className="settings-row"><label className="timezone-field">Time zone<input required list="time-zones" maxLength={100} value={draft.timeZone} onChange={e => { setDraft({ ...draft, timeZone: e.target.value }); setMessage(''); }} placeholder="America/New_York" /><datalist id="time-zones">{['UTC', ...Intl.supportedValuesOf('timeZone')].map(zone => <option key={zone} value={zone} />)}</datalist><small className="muted">Hours use this time zone. Task deadlines are dates, not UTC timestamps.</small></label></div>
      <div className="settings-row"><div><h2>Optional reminders</h2><p className="muted">Preference only. Reminder delivery is planned for Sprint 3.</p></div><label><input type="checkbox" checked={draft.reminders} onChange={e => { setDraft({ ...draft, reminders: e.target.checked }); setMessage(''); }} /> Enable when available</label></div>
      <button className="button" type="submit">{saving ? 'Saving…' : 'Save availability'}</button>
    </fieldset>
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="task-status" role="status">{message}</p>
  </form>;
}

export default function Settings() {
  const { availability } = useWorkspace();
  return <><ScreenHeading title="Planning, on your terms." description="Make AutoPlan fit the way you work and the life you live." />
    {availability && <AvailabilityForm initial={availability} />}
    <p className="settings-note">Your name and email live on <a className="text-link" href="#/profile">Profile →</a></p>
  </>;
}
