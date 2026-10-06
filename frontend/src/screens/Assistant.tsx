import { useState } from 'react';
import ScreenHeading from '../components/ScreenHeading';
import { useWorkspace } from '../hooks/useWorkspace';
import { workspaceService } from '../services/workspace';
import './Planning.css';

export default function Assistant() {
  const { plan, saving } = useWorkspace();
  const [error, setError] = useState('');
  async function generate() {
    setError('');
    try {
      // A future provider adapter supplies fresh intervals through this same API.
      // Retain an existing supplied snapshot; never silently discard its conflicts.
      await workspaceService.generatePlan(plan?.busyIntervals ?? [], plan?.source ?? 'availability_only');
    } catch (cause) { setError((cause as Error).message); }
  }
  return <>
    <ScreenHeading eyebrow="A LITTLE HELP GOES A LONG WAY" title="Let’s make a plan." description="Turn your tasks and available hours into a manageable week." />
    <section className="card plan-summary">
      <h2>A calmer week starts here</h2>
      <p className="muted">Plan the next seven days in your saved time zone. Earlier deadlines come first, then priority. Focus blocks last 15–60 minutes, with 15-minute breaks between blocks on the same day.</p>
      <p className="plan-notice">{plan?.source === 'provided'
        ? 'Using the saved busy-time snapshot. This does not refresh your external calendar; new or changed events are not included.'
        : 'Availability-only plan: no external calendar is connected. Calendar events are not checked yet.'}</p>
      <p className="muted">Generating replaces your saved plan. Editing tasks or hours never moves blocks automatically.</p>
      <button className="button primary" disabled={saving} onClick={() => void generate()}>{saving ? 'Saving…' : plan ? 'Replace plan' : 'Generate plan'}</button>
      {' '}<a className="text-link" href="#/settings">Edit available hours →</a>
      {error && <p role="alert" className="form-error">{error}</p>}
    </section>
    {plan && <section className="card plan-summary" aria-live="polite">
      <div className="card-heading"><h2>Your plan · {plan.startDate} – {plan.endDate}</h2><a className="text-link" href="#/calendar">View calendar →</a></div>
      <p className="muted">{plan.timeZone} · {plan.blocks.filter(block => block.type === 'focus').length} focus blocks · {plan.tasks.reduce((total, task) => total + task.scheduledMinutes, 0)} minutes planned</p>
      {plan.stale && <p className="plan-notice">Saved plan needs review. {plan.staleReasons.join(' ')}</p>}
      {!plan.tasks.length && <p className="muted">No unfinished tasks. <a href="#/tasks">Add a task</a> to get started.</p>}
      <ul className="plan-results">{plan.tasks.map(task => <li key={task.taskId}>
        <div><a href="#/tasks"><strong>{task.title}</strong></a><span className={`plan-status ${task.status === 'scheduled' ? 'is-scheduled' : ''}`}>{task.status.replaceAll('_', ' ')}</span></div>
        <p className="muted">Due {task.deadline} · {task.message}</p>
      </li>)}</ul>
    </section>}
  </>;
}
