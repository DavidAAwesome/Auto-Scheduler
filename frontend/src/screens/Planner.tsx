import { useEffect, useRef, useState } from 'react';
import TaskForm from '../components/TaskForm';
import PlannerAssistant from '../components/PlannerAssistant';
import PlannerCalendar, { type PlannerSelection } from '../components/PlannerCalendar';
import { useWorkspace } from '../hooks/useWorkspace';
import { workspaceService } from '../services/workspace';
import { selectTasks, type TaskFilter } from '../services/taskRules';
import { dateInZone } from '../utils/calendar';
import type { Task } from '../types/models';
import './Tasks.css';
import './Planning.css';
import './Planner.css';

function TaskDetails({ selection, close, edit }: { selection: PlannerSelection; close: () => void; edit: (task: Task) => void }) {
  const { tasks, saving } = useWorkspace();
  const task = tasks.find(item => item.id === selection.taskId);
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    const trigger = document.activeElement as HTMLElement | null;
    node?.showModal();
    return () => { node?.close(); trigger?.focus(); };
  }, []);
  async function change(remove: boolean) {
    if (!task) return;
    try { if (remove) { await workspaceService.deleteTask(task.id); close(); } else await workspaceService.setCompleted(task.id, !task.done); }
    catch (cause) { setError((cause as Error).message); }
  }
  return <dialog className="task-dialog planner-details" ref={dialog} aria-labelledby="planner-detail-title" onCancel={event => { if (saving) event.preventDefault(); else close(); }}><div className="task-dialog-header"><h2 id="planner-detail-title">{task?.title ?? selection.title}</h2><button className="icon-button" aria-label="Close details" disabled={saving} onClick={close}>×</button></div><p className="eyebrow">{selection.kind ?? 'Task details'}</p>{selection.time && <p>{selection.time}</p>}{task ? <><dl><dt>Status</dt><dd>{task.done ? 'Completed' : 'Open'}</dd><dt>Deadline</dt><dd>{task.deadline}</dd><dt>Duration</dt><dd>{task.minutes} minutes</dd><dt>Priority / category</dt><dd>{task.priority} / {task.category}</dd></dl><p className="muted">Changes mark the saved plan for review. Blocks move only after you confirm a replacement.</p><div className="planner-detail-actions"><button className="button" disabled={saving} onClick={() => edit(task)}>Edit task</button><button className="button secondary" disabled={saving} onClick={() => void change(false)}>{task.done ? 'Reopen task' : 'Complete task'}</button><button className="button secondary" disabled={saving} onClick={() => setDeleting(true)}>Delete…</button></div>{deleting && <div role="group" aria-label="Confirm task deletion"><p>Delete this task permanently?</p><button className="button" disabled={saving} onClick={() => void change(true)}>Confirm delete</button> <button className="button secondary" disabled={saving} onClick={() => setDeleting(false)}>Cancel</button></div>}</> : <p className="muted">{selection.taskId ? 'This task is no longer in your task list. The saved plan needs review.' : 'This is a read-only calendar interval. Breaks and supplied busy time cannot be edited as tasks.'}</p>}{error && <p role="alert" className="form-error">{error}</p>}</dialog>;
}

export default function Planner() {
  const { tasks, availability, saving } = useWorkspace();
  const [panel, setPanel] = useState('calendar');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [selection, setSelection] = useState<PlannerSelection | null>(null);
  const [editor, setEditor] = useState<Task | 'new' | null>(null);
  const [message, setMessage] = useState('');
  const zone = availability?.timeZone ?? 'UTC';
  const today = dateInZone(zone);
  const due = tasks.filter(task => task.deadline === today && !task.done);
  const shown = selectTasks(tasks, search, filter);
  const inspect = (id: string) => setSelection({ taskId: id, title: tasks.find(task => task.id === id)?.title ?? 'Saved task' });
  function taskButton(task: Task) {
    return <button className={`planner-task ${task.done ? 'is-done' : ''}`} onClick={() => inspect(task.id)}><span className={`task-priority ${task.priority.toLowerCase()}`}>{task.priority}</span><strong>{task.title}</strong><small>{task.minutes} min · Due {task.deadline} · {task.done ? 'Done' : 'Open'}</small></button>;
  }
  return <div className="planner-page"><div className="planner-page-title"><div><p className="eyebrow">A LITTLE MORE SPACE</p><h1>Your planner</h1><p className="muted">Tasks, time, and a clear next step · {zone}</p></div><a className="text-link" href="#/home">← Home</a></div>
    <div className="planner-mobile-switch" role="group" aria-label="Planner panels">{['tasks', 'calendar', 'assistant'].map(name => <button key={name} aria-pressed={panel === name} aria-controls={`planner-${name}`} onClick={() => setPanel(name)}>{name}</button>)}</div>
    <p role="status" className="planner-save-status">{saving ? 'Saving to your account…' : message}</p>
    <div className="planner-columns" data-panel={panel}>
      <section id="planner-tasks" className="card planner-tasks" aria-label="Tasks"><div className="card-heading"><h2>Today’s tasks</h2><span className="planner-count">{due.length}</span></div><p className="muted">Due {today}</p>{due.length ? <ul className="planner-task-list">{due.map(task => <li key={task.id}>{taskButton(task)}</li>)}</ul> : <p className="planner-empty">No open deadlines today.</p>}<button className="button planner-add" disabled={saving} onClick={() => setEditor('new')}>+ Add task</button><h3>All tasks <span className="muted">({tasks.length})</span></h3><label className="planner-search">Search tasks<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a task…" /></label><select aria-label="Filter tasks" value={filter} onChange={event => setFilter(event.target.value as TaskFilter)}><option value="all">All tasks</option><option value="open">Open</option><option value="done">Completed</option></select><ul className="planner-task-list">{shown.map(task => <li key={task.id}>{taskButton(task)}</li>)}</ul>{!shown.length && <p className="planner-empty">{tasks.length ? 'No tasks match this search.' : 'Add your first task to start planning.'}</p>}</section>
      <section id="planner-calendar" className="card planner-center" aria-label="Calendar"><PlannerCalendar onSelect={setSelection} /></section>
      <section id="planner-assistant" className="card planner-right" aria-label="Assistant"><PlannerAssistant onInspect={inspect} onGenerated={() => { setMessage('Plan saved to your account.'); setPanel('calendar'); }} /></section>
    </div>
    {selection && <TaskDetails selection={selection} close={() => setSelection(null)} edit={task => { setSelection(null); setEditor(task); }} />}
    {editor && <TaskForm task={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} onSave={setMessage} />}
  </div>;
}
