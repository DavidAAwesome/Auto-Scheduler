import { useState } from 'react';
import { useWorkspace } from '../hooks/useWorkspace';
import { workspaceService } from '../services/workspace';
import { explainPlan } from '../utils/planner';

export default function PlannerAssistant({ onInspect, onGenerated }: { onInspect?: (id: string) => void; onGenerated?: () => void }) {
  const { tasks, availability, plan, saving } = useWorkspace();
  const [messages, setMessages] = useState<{ question: string; answer: string }[]>([]);
  const [input, setInput] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  if (!availability) return null;
  function ask(question: string) {
    if (!question.trim() || !availability) return;
    setMessages(previous => [...previous.slice(-9), { question, answer: explainPlan(question, tasks, availability, plan) }]);
    setInput('');
  }
  async function generate() {
    setError('');
    try {
      await workspaceService.generatePlan(plan?.busyIntervals ?? [], plan?.source ?? 'availability_only');
      setConfirm(false);
      setNotice('Plan saved. Open Calendar to inspect the blocks.');
      onGenerated?.();
    } catch (cause) { setError((cause as Error).message); }
  }
  return <div className="planner-assistant">
    <p className="eyebrow">A LITTLE CLARITY</p><h2>Planning assistant</h2>
    <p className="muted">Rules-based · your account data · no AI service</p>
    <div className="planner-chat" role="log" aria-label="Planning conversation" aria-live="polite">
      <p className="chat-answer">Let’s make room for what matters. Ask about your tasks or review what fits this week. Replies are snapshots of your data when asked.</p>
      {messages.map((message, index) => <div key={index}><p className="chat-question">{message.question}</p><p className="chat-answer">{message.answer}</p></div>)}
    </div>
    <div className="planner-prompts">{['Today’s tasks', 'My schedule', 'Conflicts / unscheduled', 'Available hours'].map(prompt => <button key={prompt} onClick={() => ask(prompt)}>{prompt}</button>)}</div>
    <form className="planner-ask" onSubmit={event => { event.preventDefault(); ask(input); }}>
      <label htmlFor="planner-question">Ask about your plan</label>
      <div><input id="planner-question" value={input} maxLength={500} onChange={event => setInput(event.target.value)} placeholder="What didn’t fit?" /><button className="button" disabled={!input.trim()} type="submit">Send</button></div>
    </form>
    <div className="planner-generation">
      <p className="muted">{plan?.source === 'provided' ? 'Uses the saved busy-time snapshot; external events are not refreshed.' : 'Availability only. Google Calendar is not connected.'}</p>
      {plan?.stale && <p className="plan-notice">Plan needs review. {plan.staleReasons.join(' ')}</p>}
      {confirm ? <div role="group" aria-label="Confirm plan generation"><p>Generate the next seven days? This replaces the saved plan. Tasks and available hours stay the same.</p><button className="button" disabled={saving} onClick={() => void generate()}>{saving ? 'Generating…' : 'Confirm generation'}</button> <button className="button secondary" disabled={saving} onClick={() => setConfirm(false)}>Cancel</button></div> : <button className="button" disabled={saving} onClick={() => { setNotice(''); setConfirm(true); }}>{plan ? 'Replace plan…' : 'Generate plan…'}</button>}
      <p role="status">{notice}</p>{error && <p role="alert" className="form-error">{error}</p>}
      <a className="text-link" href="#/settings">Set available hours →</a>
    </div>
    {plan && <section className="planner-unfilled"><h3>Needs your attention</h3>{plan.tasks.filter(task => task.unscheduledMinutes > 0).map(task => <div key={task.taskId}><button className="planner-text-button" onClick={() => onInspect ? onInspect(task.taskId) : window.location.assign('#/tasks')}>{task.title}</button><p>{task.unscheduledMinutes} min unplanned · {task.message}</p></div>)}{!plan.tasks.some(task => task.unscheduledMinutes > 0) && <p className="muted">No unplanned work in the saved plan.</p>}</section>}
  </div>;
}
