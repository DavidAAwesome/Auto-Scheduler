import type { Availability, BusyInterval, GeneratedPlan, Task, TaskInput } from '../types/models.ts';
import { validateTask } from './taskRules.ts';

export type Requester = <T>(path: string, options?: RequestInit) => Promise<T>;
export interface WorkspaceState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  tasks: Task[];
  availability: Availability | null;
  plan: GeneratedPlan | null;
  error: string;
  saving: boolean;
}
const empty = (): WorkspaceState => ({ status: 'idle', tasks: [], availability: null, plan: null, error: '', saving: false });

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
      const [tasks, availability, plan] = await Promise.all([request<Task[]>('/tasks'), request<Availability>('/availability'), request<GeneratedPlan | null>('/plan')]);
      if (current === generation) publish({ status: 'ready', tasks, availability, plan, error: '', saving: false });
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
      return mutate<void>(`/tasks/${id}`, { method: 'DELETE' }, () => ({ tasks: state.tasks.filter(t => t.id !== id), plan: stalePlan() }));
    },
    saveAvailability(availability: Availability) {
      return mutate<Availability>('/availability', { method: 'PUT', body: JSON.stringify(availability) }, saved => ({
        availability: saved,
        plan: state.availability?.timeZone === saved.timeZone && JSON.stringify(state.availability.days) === JSON.stringify(saved.days) ? state.plan : stalePlan(),
      }));
    },
    generatePlan(busyIntervals: BusyInterval[], source: GeneratedPlan['source']) {
      return mutate<GeneratedPlan>('/plan/generate', { method: 'POST', body: JSON.stringify({ busyIntervals, source }) }, plan => ({ plan }));
    },
  };
}
