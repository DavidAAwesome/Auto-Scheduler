import type { Availability, BusyInterval, CalendarConnection, CalendarEvent, CalendarEventInput, CalendarProvider, GeneratedPlan, ImportedEvent, Task, TaskInput, WorkSession, WorkSessionInput } from '../types/models.ts';
import { normalizeAvailability } from '../utils/availability.ts';
import { validateEvent, validateSession, validateTask } from './taskRules.ts';

export type Requester = <T>(path: string, options?: RequestInit) => Promise<T>;
export interface WorkspaceState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  tasks: Task[];
  sessions: WorkSession[];
  events: CalendarEvent[];
  connections: CalendarConnection[];
  availability: Availability | null;
  plan: GeneratedPlan | null;
  error: string;
  saving: boolean;
}
const empty = (): WorkspaceState => ({ status: 'idle', tasks: [], sessions: [], events: [], connections: [], availability: null, plan: null, error: '', saving: false });

// Injectable transport lets tests exercise request failures and account-change races.
export function createWorkspaceStore(request: Requester) {
  let state = empty();
  let owner: string | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: WorkspaceState) => { state = next; listeners.forEach(fn => fn()); };
  const stalePlan = () => state.plan ? { ...state.plan, stale: true, staleReasons: ['Tasks or availability changed. Generate a new plan when ready.'] } : null;
  async function load() {
    if (!owner || state.saving) return;
    const current = ++generation;
    publish({ ...state, status: 'loading', error: '' });
    try {
      const [tasks, sessions, events, connections, availability, plan] = await Promise.all([request<Task[]>('/tasks'), request<WorkSession[]>('/sessions'), request<CalendarEvent[]>('/events'), request<CalendarConnection[]>('/calendar/connections'), request<Availability>('/availability'), request<GeneratedPlan | null>('/plan')]);
      if (current === generation) publish({ status: 'ready', tasks, sessions, events, connections, availability: normalizeAvailability(availability), plan, error: '', saving: false });
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
  return {
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
      return mutate<Task>('/tasks', { method: 'POST', body: JSON.stringify(input) }, task => ({ tasks: [...state.tasks, task], plan: stalePlan() }));
    },
    updateTask(id: string, input: TaskInput) {
      validateTask(input);
      return mutate<Task>(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(input) }, task => ({ tasks: state.tasks.map(t => t.id === id ? task : t), plan: stalePlan() }));
    },
    setCompleted(id: string, done: boolean) {
      return mutate<Task>(`/tasks/${id}/completion`, { method: 'PATCH', body: JSON.stringify({ done }) }, task => ({ tasks: state.tasks.map(t => t.id === id ? task : t), plan: stalePlan() }));
    },
    deleteTask(id: string) {
      return mutate<void>(`/tasks/${id}`, { method: 'DELETE' }, () => ({ tasks: state.tasks.filter(t => t.id !== id), sessions: state.sessions.filter(s => s.taskId !== id), plan: stalePlan() }));
    },
    createSession(input: WorkSessionInput) {
      validateSession(input);
      return mutate<WorkSession>('/sessions', { method: 'POST', body: JSON.stringify(input) }, session => ({ sessions: [...state.sessions, session] }));
    },
    updateSession(id: string, input: WorkSessionInput) {
      validateSession(input);
      return mutate<WorkSession>(`/sessions/${id}`, { method: 'PUT', body: JSON.stringify(input) }, session => ({ sessions: state.sessions.map(s => s.id === id ? session : s) }));
    },
    deleteSession(id: string) {
      return mutate<void>(`/sessions/${id}`, { method: 'DELETE' }, () => ({ sessions: state.sessions.filter(s => s.id !== id) }));
    },
    createEvent(input: CalendarEventInput) {
      validateEvent(input);
      return mutate<CalendarEvent>('/events', { method: 'POST', body: JSON.stringify(input) }, event => ({ events: [...state.events, event] }));
    },
    updateEvent(id: string, input: CalendarEventInput) {
      validateEvent(input);
      return mutate<CalendarEvent>(`/events/${id}`, { method: 'PUT', body: JSON.stringify(input) }, event => ({ events: state.events.map(e => e.id === id ? event : e) }));
    },
    /** Removes one occurrence of a repeating event (e.g. a cancelled class). */
    skipEventOccurrence(id: string, date: string) {
      return mutate<CalendarEvent>(`/events/${id}/skip`, { method: 'POST', body: JSON.stringify({ date }) }, event => ({ events: state.events.map(e => e.id === id ? event : e) }));
    },
    /** Uploads a fresh snapshot of an external calendar, then reloads events (the server replaced the old copies). */
    async syncCalendar(provider: CalendarProvider, payload: { account: string; rangeStart: string; rangeEnd: string; events: ImportedEvent[] }) {
      const connection = await mutate<CalendarConnection>(`/calendar/${provider}/sync`, { method: 'PUT', body: JSON.stringify(payload) },
        saved => ({ connections: [...state.connections.filter(c => c.provider !== provider), saved] }));
      const events = await request<CalendarEvent[]>('/events');
      publish({ ...state, events });
      return connection;
    },
    disconnectCalendar(provider: CalendarProvider) {
      return mutate<void>(`/calendar/${provider}`, { method: 'DELETE' }, () => ({
        connections: state.connections.filter(c => c.provider !== provider),
        events: state.events.filter(e => e.source !== provider),
      }));
    },
    deleteEvent(id: string) {
      return mutate<void>(`/events/${id}`, { method: 'DELETE' }, () => ({ events: state.events.filter(e => e.id !== id) }));
    },
    saveAvailability(availability: Availability) {
      const payload = normalizeAvailability(availability);
      return mutate<Availability>('/availability', { method: 'PUT', body: JSON.stringify(payload) }, saved => {
        const next = normalizeAvailability(saved);
        return {
          availability: next,
          plan: state.availability?.timeZone === next.timeZone
            && JSON.stringify(state.availability.days) === JSON.stringify(next.days)
            && JSON.stringify(state.availability.weekOverrides ?? []) === JSON.stringify(next.weekOverrides ?? [])
            ? state.plan
            : stalePlan(),
        };
      });
    },
    generatePlan(busyIntervals: BusyInterval[], source: GeneratedPlan['source']) {
      return mutate<GeneratedPlan>('/plan/generate', { method: 'POST', body: JSON.stringify({ busyIntervals, source }) }, plan => ({ plan }));
    },
    /** OpenAI assistant; does not mutate workspace state. Falls through to caller on 503 when unset. */
    chatAssistant(message: string, history: { role: 'user' | 'assistant'; text: string }[]) {
      if (!owner || state.status !== 'ready') throw new Error('Wait for your workspace to load.');
      return request<{
        reply: string;
        pendingAction: { type: 'generate_plan'; label: string } | null;
        provider: 'openai';
      }>('/assistant/chat', {
        method: 'POST',
        body: JSON.stringify({ message, history: history.slice(-8) }),
      });
    },
  };
}
