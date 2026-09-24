import { useRef, useState, type FormEvent } from 'react';
import ScreenHeading from '../components/ScreenHeading';
import { useMockData } from '../hooks/useMockData';
import { mockDataService, todayInZone, type Task, type TaskInput } from '../services/mockData';
export default function Tasks() {
  const { tasks, settings } = useMockData();
  const blank = (): TaskInput => ({ title: '', date: todayInZone(settings.timeZone), startTime: '', duration: 30, priority: 'Medium', notes: '' });
  const [draft, setDraft] = useState<TaskInput | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [deleted, setDeleted] = useState<Task | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  function begin(task?: Task) { setEditing(task?.id ?? null); setDraft(task ? { ...task } : blank()); setError(''); setMessage(''); }
  function close() { setDraft(null); setEditing(null); addButton.current?.focus(); }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    try { if (editing) mockDataService.updateTask(editing, draft); else mockDataService.createTask(draft); setMessage(editing ? 'Task updated.' : 'Task added.'); setError(''); close(); }
    catch (e) { setError((e as Error).message); }
  }
  function remove(task: Task) {
    try { mockDataService.deleteTask(task.id); setDeleted(task); setMessage(`Deleted “${task.title}”.`); setError(''); if (editing === task.id) close(); }
    catch (e) { setError((e as Error).message); }
  }
  const shown = tasks.filter(task => filter === 'all' || (filter === 'completed' ? task.completed : !task.completed)).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  return <><ScreenHeading title="Your tasks, all in one place." description="Turn what’s on your mind into a plan you can work with." action={<button ref={addButton} className="button" onClick={() => begin()}>+ Add task</button>} />
    <div className="feedback" role="status">{message}{deleted && <button className="text-button" onClick={() => { try { mockDataService.restoreTask(deleted); setDeleted(null); setMessage('Task restored.'); setError(''); } catch(e) { setError((e as Error).message); } }}>Undo delete</button>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {draft && <section className="card task-editor"><h2>{editing ? 'Edit task' : 'Add a task'}</h2><form className="workspace-form" onSubmit={save}>
      <label>Task title<input autoFocus value={draft.title} required maxLength={120} placeholder="What would you like to get done?" onChange={e => setDraft({...draft, title:e.target.value})} /></label>
      <div className="form-grid"><label>Task date<input type="date" required value={draft.date} onChange={e => setDraft({...draft, date:e.target.value})} /></label><label>Start time (optional)<input type="time" value={draft.startTime} onChange={e => setDraft({...draft, startTime:e.target.value})} /></label><label>Duration (minutes)<input type="number" min={5} max={720} step={1} required value={draft.duration || ''} onChange={e => setDraft({...draft, duration:Number(e.target.value)})} /></label><label>Priority<select value={draft.priority} onChange={e => setDraft({...draft, priority:e.target.value as TaskInput['priority']})}><option>Low</option><option>Medium</option><option>High</option></select></label></div>
      <p className="muted">Times use {settings.timeZone}. Leave start time empty to keep the task unassigned to a time on its date.</p>
      <label>Notes (optional)<textarea rows={3} maxLength={2000} value={draft.notes} onChange={e => setDraft({...draft, notes:e.target.value})} /></label>
      <div className="form-actions"><button className="button" type="submit">{editing ? 'Save changes' : 'Create task'}</button><button className="button secondary" type="button" onClick={close}>Cancel</button></div>
    </form></section>}
    <section className="card task-list"><div className="list-toolbar"><h2>{tasks.filter(t=>!t.completed).length} open · {tasks.filter(t=>t.completed).length} completed</h2><label className="filter-label">Show<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All tasks</option><option value="open">Open tasks</option><option value="completed">Completed tasks</option></select></label></div>
      {!shown.length && <div className="small-empty"><h3>{tasks.length ? 'No tasks match this view' : 'A fresh start'}</h3><p>{tasks.length ? 'Try another filter to see your tasks.' : 'Add your first task to see it here and on your calendar.'}</p></div>}
      <ul className="task-items">{shown.map(task => <li key={task.id} className={`task-row ${task.completed ? 'is-complete' : ''}`}><input className="task-check" type="checkbox" checked={task.completed} aria-label={`${task.completed ? 'Reopen' : 'Complete'} ${task.title}`} onChange={e => { try { mockDataService.setCompleted(task.id,e.target.checked); setMessage(e.target.checked ? 'Task completed.' : 'Task reopened.'); setError(''); } catch(err) { setError((err as Error).message); } }} /><div className="task-copy"><h3>{task.title}</h3><p className="muted">{task.date} · {task.startTime || 'No time assigned'} · {task.duration} min</p>{task.notes && <p className="task-notes">{task.notes}</p>}<span className={`priority priority-${task.priority.toLowerCase()}`}>{task.priority}</span>{task.completed && <span className="completion-label">Completed</span>}</div><div className="task-actions"><button className="text-button" aria-label={`Edit ${task.title}`} onClick={()=>begin(task)}>Edit</button><button className="text-button danger" aria-label={`Delete ${task.title}`} onClick={()=>remove(task)}>Delete</button></div></li>)}</ul>
    </section></>;
}
