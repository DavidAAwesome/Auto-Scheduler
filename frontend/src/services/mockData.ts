/** Browser-only mock service. Replace this module with a FastAPI adapter later. */
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export type Weekday = typeof WEEKDAYS[number];
export type Availability = { enabled: boolean; start: string; end: string };
export type Settings = { timeZone: string; availability: Record<Weekday, Availability>; reminders: { enabled: boolean; minutesBefore: number } };
export type TaskInput = { title: string; date: string; startTime: string; duration: number; priority: 'Low' | 'Medium' | 'High'; notes: string };
export type Task = TaskInput & { id: string; completed: boolean };
export type Workspace = { version: 1; tasks: Task[]; settings: Settings };
export const MOCK_PROFILE = { name: 'Mia', email: 'demo@autoplan.app' };
const DATA_KEY = 'autoplan.mock.workspace.v1';
const SESSION_KEY = 'autoplan.mock.session.v1';
const listeners = new Set<() => void>();
const sessionListeners = new Set<() => void>();
export const timeZones = [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone'), Intl.DateTimeFormat().resolvedOptions().timeZone])].sort();
export function todayInZone(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function weekDates(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const monday = shiftDate(date, -((day + 6) % 7));
  return WEEKDAYS.map((_, index) => shiftDate(monday, index));
}
export const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export function taskEnd(task: TaskInput) {
  const total = minutes(task.startTime) + task.duration;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function validTime(time: unknown): time is string { return typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time); }
export function validateTask(task: TaskInput) {
  if (typeof task.title !== 'string' || !task.title.trim() || task.title.trim().length > 120) throw new Error('Enter a task title between 1 and 120 characters.');
  if (typeof task.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(task.date) || Number.isNaN(Date.parse(`${task.date}T12:00:00Z`)) || new Date(`${task.date}T12:00:00Z`).toISOString().slice(0, 10) !== task.date) throw new Error('Choose a valid task date.');
  if (!Number.isInteger(task.duration) || task.duration < 5 || task.duration > 720) throw new Error('Duration must be between 5 and 720 whole minutes.');
  if (task.startTime !== '' && !validTime(task.startTime)) throw new Error('Choose a valid start time, or leave it empty.');
  if (task.startTime && minutes(task.startTime) + task.duration > 1440) throw new Error('The task must finish by midnight. Choose an earlier start time or shorter duration.');
  if (!['Low', 'Medium', 'High'].includes(task.priority)) throw new Error('Choose a valid priority.');
  if (typeof task.notes !== 'string' || task.notes.length > 2000) throw new Error('Notes must be 2,000 characters or fewer.');
}
export function validateSettings(settings: Settings) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: settings.timeZone }); } catch { throw new Error('Choose a valid time zone.'); }
  if (!settings.timeZone) throw new Error('Choose a time zone.');
  for (const day of WEEKDAYS) {
    const hours = settings.availability?.[day];
    if (!hours || typeof hours.enabled !== 'boolean' || !validTime(hours.start) || !validTime(hours.end)) throw new Error(`Enter valid hours for ${day}.`);
    if (hours.enabled && hours.end <= hours.start) throw new Error(`${day}: end time must be after start time. Overnight availability is not supported yet.`);
  }
  if (typeof settings.reminders?.enabled !== 'boolean' || ![5, 10, 15, 30, 60].includes(settings.reminders.minutesBefore)) throw new Error('Choose a valid reminder lead time.');
}
function defaults(): Workspace {
  return { version: 1, tasks: [], settings: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', availability: Object.fromEntries(WEEKDAYS.map((day, index) => [day, { enabled: index < 5, start: '09:00', end: '17:00' }])) as Record<Weekday, Availability>, reminders: { enabled: false, minutesBefore: 15 } } };
}
let loadNotice = '';
function loadWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(DATA_KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw) as Workspace;
    if (saved.version !== 1 || !Array.isArray(saved.tasks)) throw new Error();
    validateSettings(saved.settings);
    const ids = new Set<string>();
    saved.tasks.forEach(task => { validateTask(task); if (typeof task.id !== 'string' || !task.id || ids.has(task.id) || typeof task.completed !== 'boolean') throw new Error(); ids.add(task.id); });
    return saved;
  } catch { loadNotice = 'Saved mock data could not be read. This workspace is using defaults; the next save will replace that data.'; return defaults(); }
}
let workspace = loadWorkspace();
let authenticated = false;
try { authenticated = sessionStorage.getItem(SESSION_KEY) === 'demo'; } catch { /* In-memory session still works. */ }
function commit(next: Workspace) {
  try { localStorage.setItem(DATA_KEY, JSON.stringify(next)); }
  catch { throw new Error('Could not save mock data in this browser. Allow local storage or free up space, then try again.'); }
  workspace = next;
  loadNotice = '';
  listeners.forEach(listener => listener());
}
export const mockDataService = {
  getSnapshot: () => workspace,
  getLoadNotice: () => loadNotice,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSession: () => authenticated,
  subscribeSession(listener: () => void) { sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
  async login(email: string, password: string) {
    // A Promise matches the future API boundary; passwords are never persisted.
    if (email.trim().toLowerCase() !== MOCK_PROFILE.email || password !== 'autoplan') throw new Error('Use demo@autoplan.app and the password autoplan to sign in.');
    try { sessionStorage.setItem(SESSION_KEY, 'demo'); } catch { /* Session lasts until reload if storage is disabled. */ }
    authenticated = true;
    sessionListeners.forEach(listener => listener());
  },
  logout() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* Clear in-memory session regardless. */ }
    authenticated = false;
    sessionListeners.forEach(listener => listener());
  },
  createTask(input: TaskInput) {
    validateTask(input);
    const task: Task = { ...input, title: input.title.trim(), id: crypto.randomUUID(), completed: false };
    commit({ ...workspace, tasks: [...workspace.tasks, task] });
    return task;
  },
  updateTask(id: string, input: TaskInput) {
    validateTask(input);
    if (!workspace.tasks.some(task => task.id === id)) throw new Error('This task no longer exists.');
    commit({ ...workspace, tasks: workspace.tasks.map(task => task.id === id ? { ...task, ...input, title: input.title.trim() } : task) });
  },
  setCompleted(id: string, completed: boolean) {
    if (!workspace.tasks.some(task => task.id === id)) throw new Error('This task no longer exists.');
    commit({ ...workspace, tasks: workspace.tasks.map(task => task.id === id ? { ...task, completed } : task) });
  },
  deleteTask(id: string) { commit({ ...workspace, tasks: workspace.tasks.filter(task => task.id !== id) }); },
  restoreTask(task: Task) {
    validateTask(task);
    if (!workspace.tasks.some(item => item.id === task.id)) commit({ ...workspace, tasks: [...workspace.tasks, task] });
  },
  saveSettings(settings: Settings) { validateSettings(settings); commit({ ...workspace, settings: structuredClone(settings) }); },
};
