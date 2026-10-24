import { DEFAULT_PREFERENCES, type ApplyResult, type Availability, type CalendarConnection, type CalendarEvent, type CalendarEventInput, type CalendarProvider, type ImportedEvent, type SavedSchedule, type SchedulePreferences, type SchedulePreview, type SessionStatus, type Task, type TaskInput, type WorkSession, type WorkSessionInput } from '../types/models.ts';
import { normalizeAvailability } from '../utils/availability.ts';
import { validateEvent, validateSession, validateTask } from './taskRules.ts';

export type AssistantIntent = 'show_today' | 'show_plan' | 'busy_time' | 'generate_schedule' | 'explain_unscheduled' | 'request_break' | 'replan' | 'move_task' | 'clarify' | 'none';
export interface AssistantReply { reply: string; intent: AssistantIntent; params: { breakMinutes: number | null; taskId: string | null; notBefore: string | null }; provider: 'openai' }
export type Requester = <T>(path: string, options?: RequestInit) => Promise<T>;
export interface WorkspaceState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  tasks: Task[];
  sessions: WorkSession[];
  events: CalendarEvent[];
  connections: CalendarConnection[];
  availability: Availability | null;
  preferences: SchedulePreferences;
  /** Version of the saved schedule; Apply is rejected when a preview was made against an older one. */
  scheduleVersion: number;
  /** A proposal from the scheduling service. It is never saved until Apply succeeds. */
  schedulePreview: SchedulePreview | null;
  /** Inputs changed after the preview was made; Apply will be rejected, so offer to regenerate. */
  previewStale: boolean;
  error: string;
  saving: boolean;
}
const empty = (): WorkspaceState => ({ status: 'idle', tasks: [], sessions: [], events: [], connections: [], availability: null, preferences: DEFAULT_PREFERENCES, scheduleVersion: 0, schedulePreview: null, previewStale: false, error: '', saving: false });
export type PreviewRequest = { kind: 'generate'; horizonDays?: number } | { kind: 'repair'; horizonDays?: number; moves?: { taskId: string; notBefore: string }[] } | { kind: 'break'; minutes: number };

// Injectable transport lets tests exercise request failures and account-change races.
export function createWorkspaceStore(request: Requester) {
  let state = empty();
  let owner: string | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: WorkspaceState) => { state = next; listeners.forEach(fn => fn()); };
  /** Any change to tasks, sessions, events, availability or preferences makes a pending preview stale. */
  const stale = () => ({ previewStale: state.schedulePreview !== null });
  async function load() {
    if (!owner || state.saving) return;
    const current = ++generation;
    publish({ ...state, status: 'loading', error: '' });
    try {
      const [tasks, schedule, events, connections, availability, preferences] = await Promise.all([request<Task[]>('/tasks'), request<SavedSchedule>('/schedule'), request<CalendarEvent[]>('/events'), request<CalendarConnection[]>('/calendar/connections'), request<Availability>('/availability'), request<SchedulePreferences>('/schedule/preferences')]);
      if (current === generation) publish({ status: 'ready', tasks, sessions: schedule.sessions, scheduleVersion: schedule.scheduleVersion, events, connections, availability: normalizeAvailability(availability), preferences: preferences ?? DEFAULT_PREFERENCES, schedulePreview: null, previewStale: false, error: '', saving: false });
    } catch (error) {
      if (current === generation) publish({ ...empty(), status: 'error', error: (error as Error).message });
    }
  }
  async function mutate<T>(path: string, options: RequestInit, apply: (result: T) => Partial<WorkspaceState>) {
    if (!owner || state.status !== 'ready') throw new Error('Wait for your workspace to load.');
    if (state.saving) throw new Error('A change is still saving. Please try again shortly.');
    const current = generation;
    publish({ ...state, saving: true });
    try {
      const result = await request<T>(path, options);
      if (current !== generation) throw new Error('Your account changed. Please try again.');
      publish({ ...state, ...apply(result), saving: false });
      return result;
    } finally {
      if (current === generation && state.saving) publish({ ...state, saving: false });
    }
  }
  const api = {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    setUser(id: string | null) {
      if (owner === id) return;
      owner = id;
      ++generation;
      publish(empty());
      if (id) void load();
    },
    load,
    createTask(input: TaskInput) {
      validateTask(input);
      return mutate<Task>('/tasks', { method: 'POST', body: JSON.stringify(input) }, task => ({ tasks: [...state.tasks, task], ...stale() }));
    },
    updateTask(id: string, input: TaskInput) {
      validateTask(input);
      return mutate<Task>(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(input) }, task => ({ tasks: state.tasks.map(t => t.id === id ? task : t), ...stale() }));
    },
    setCompleted(id: string, done: boolean) {
      return mutate<Task>(`/tasks/${id}/completion`, { method: 'PATCH', body: JSON.stringify({ done }) }, task => ({ tasks: state.tasks.map(t => t.id === id ? task : t), ...stale() }));
    },
    deleteTask(id: string) {
      return mutate<void>(`/tasks/${id}`, { method: 'DELETE' }, () => ({ tasks: state.tasks.filter(t => t.id !== id), sessions: state.sessions.filter(s => s.taskId !== id), ...stale() }));
    },
    createSession(input: WorkSessionInput) {
      validateSession(input);
      const payload = { ...input, locked: input.locked ?? false };
      return mutate<WorkSession>('/sessions', { method: 'POST', body: JSON.stringify(payload) }, session => ({ sessions: [...state.sessions, session], ...stale() }));
    },
    updateSession(id: string, input: WorkSessionInput) {
      validateSession(input);
      const payload = { ...input, locked: input.locked ?? false };
      return mutate<WorkSession>(`/sessions/${id}`, { method: 'PUT', body: JSON.stringify(payload) }, session => ({ sessions: state.sessions.map(s => s.id === id ? session : s), ...stale() }));
    },
    deleteSession(id: string) {
      return mutate<void>(`/sessions/${id}`, { method: 'DELETE' }, () => ({ sessions: state.sessions.filter(s => s.id !== id), ...stale() }));
    },
    createEvent(input: CalendarEventInput) {
      validateEvent(input);
      return mutate<CalendarEvent>('/events', { method: 'POST', body: JSON.stringify(input) }, event => ({ events: [...state.events, event], ...stale() }));
    },
    updateEvent(id: string, input: CalendarEventInput) {
      validateEvent(input);
      return mutate<CalendarEvent>(`/events/${id}`, { method: 'PUT', body: JSON.stringify(input) }, event => ({ events: state.events.map(e => e.id === id ? event : e), ...stale() }));
    },
    /** Removes one occurrence of a repeating event (e.g. a cancelled class). */
    skipEventOccurrence(id: string, date: string) {
      return mutate<CalendarEvent>(`/events/${id}/skip`, { method: 'POST', body: JSON.stringify({ date }) }, event => ({ events: state.events.map(e => e.id === id ? event : e), ...stale() }));
    },
    /** Uploads a fresh snapshot of an external calendar, then reloads events (the server replaced the old copies). */
    async syncCalendar(provider: CalendarProvider, payload: { account: string; rangeStart: string; rangeEnd: string; events: ImportedEvent[] }) {
      const connection = await mutate<CalendarConnection>(`/calendar/${provider}/sync`, { method: 'PUT', body: JSON.stringify(payload) },
        saved => ({ connections: [...state.connections.filter(c => c.provider !== provider), saved], ...stale() }));
      const events = await request<CalendarEvent[]>('/events');
      publish({ ...state, events });
      return connection;
    },
    disconnectCalendar(provider: CalendarProvider) {
      return mutate<void>(`/calendar/${provider}`, { method: 'DELETE' }, () => ({
        connections: state.connections.filter(c => c.provider !== provider),
        events: state.events.filter(e => e.source !== provider),
        ...stale(),
      }));
    },
    deleteEvent(id: string) {
      return mutate<void>(`/events/${id}`, { method: 'DELETE' }, () => ({ events: state.events.filter(e => e.id !== id), ...stale() }));
    },
    saveAvailability(availability: Availability) {
      const payload = normalizeAvailability(availability);
      return mutate<Availability>('/availability', { method: 'PUT', body: JSON.stringify(payload) }, saved => ({ availability: normalizeAvailability(saved), ...stale() }));
    },
    savePreferences(preferences: SchedulePreferences) {
      return mutate<SchedulePreferences>('/schedule/preferences', { method: 'PUT', body: JSON.stringify(preferences) }, saved => ({ preferences: saved, ...stale() }));
    },
    /** Marks a work session completed (its minutes become completed work), reopens it, or cancels it. */
    async setSessionStatus(id: string, status: Exclude<SessionStatus, 'proposed'>) {
      const session = await mutate<WorkSession>(`/sessions/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) },
        saved => ({ sessions: state.sessions.map(s => s.id === id ? saved : s), ...stale() }));
      if (session.taskId) {
        const task = await request<Task>(`/tasks/${session.taskId}`);
        publish({ ...state, tasks: state.tasks.map(t => t.id === task.id ? task : t) });
      }
      return session;
    },
    /** Asks the shared scheduling service for a preview. Nothing is saved until applySchedulePreview succeeds. */
    async requestPreview(req: PreviewRequest) {
      if (!owner || state.status !== 'ready') throw new Error('Wait for your workspace to load.');
      if (state.saving) throw new Error('A change is still saving. Please try again shortly.');
      const current = generation;
      const [path, body] = req.kind === 'break'
        ? ['/schedule/break', { minutes: req.minutes }]
        : req.kind === 'repair'
          ? ['/schedule/repair', { horizonDays: req.horizonDays ?? 7, moves: req.moves ?? [] }]
          : ['/schedule/preview', { horizonDays: req.horizonDays ?? 7 }];
      publish({ ...state, saving: true, error: '' });
      try {
        const preview = await request<SchedulePreview>(path, { method: 'POST', body: JSON.stringify(body) });
        if (current !== generation) throw new Error('Your account changed. Please try again.');
        publish({ ...state, schedulePreview: preview, previewStale: false, saving: false, error: '' });
        return preview;
      } catch (error) {
        if (current === generation) publish({ ...state, saving: false, error: (error as Error).message });
        throw error;
      }
    },
    /** Fresh plan for the next `horizonDays` days (Generate Schedule button and "plan my week"). */
    previewSchedule(horizonDays = 7) {
      return api.requestPreview({ kind: 'generate', horizonDays });
    },
    clearSchedulePreview() {
      publish({ ...state, schedulePreview: null, previewStale: false, error: '' });
    },
    /** Saves the pending preview. Shared state changes only after the server confirms the commit. */
    async applySchedulePreview() {
      const preview = state.schedulePreview;
      if (!preview) throw new Error('Generate a schedule preview first.');
      publish({ ...state, error: '' });
      let result: ApplyResult;
      try {
        result = await mutate<ApplyResult>(
          '/schedule/apply',
          { method: 'POST', body: JSON.stringify({ previewId: preview.previewId }) },
          saved => ({ sessions: saved.schedule.sessions, scheduleVersion: saved.schedule.scheduleVersion, schedulePreview: null, previewStale: false, error: '' }),
        );
      } catch (error) {
        // 409 means the server rejected this proposal as stale or invalid: drop it so the user regenerates.
        if ((error as { status?: number }).status === 409 && state.schedulePreview?.previewId === preview.previewId) {
          publish({ ...state, schedulePreview: null, previewStale: false });
        }
        throw error;
      }
      // Publish only the committed response. A second GET could fail after a
      // successful commit or publish another account's data after sign-out.
      return result.schedule.sessions;
    },
    /** OpenAI assistant; never builds or saves schedules. Its intents run through requestPreview/applySchedulePreview. */
    chatAssistant(message: string, history: { role: 'user' | 'assistant'; text: string }[]) {
      if (!owner || state.status !== 'ready') throw new Error('Wait for your workspace to load.');
      return request<AssistantReply>('/assistant/chat', {
        method: 'POST',
        body: JSON.stringify({ message, history: history.slice(-8), previewId: state.schedulePreview?.previewId ?? null }),
      });
    },
  };
  return api;
}
