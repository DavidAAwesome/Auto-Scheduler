import { DEFAULT_AI_PROFILE, DEFAULT_PREFERENCES, type ActionResult, type AIProfile, type ApplyResult, type PendingAction, type PendingChoice, type DraftView, type FeasibilityResult, type InterpretResult, type PlanDraft, type Availability, type CalendarConnection, type CalendarEvent, type CalendarEventInput, type CalendarProvider, type ImportedEvent, type PreferenceChange, type SavedSchedule, type SchedulePreferences, type SchedulePreview, type SessionStatus, type Task, type TaskInput, type WorkSession, type WorkSessionInput } from '../types/models.ts';
import { normalizeAvailability } from '../utils/availability.ts';
import { validateEvent, validateSession, validateTask } from './taskRules.ts';

export type AssistantIntent =
  | "show_today"
  | "show_plan"
  | "busy_time"
  | "generate_schedule"
  | "explain_unscheduled"
  | "request_break"
  | "replan"
  | "move_task"
  | "update_preferences"
  | "add_task"
  | "delete_task"
  | "add_event"
  | "delete_event"
  | "clarify"
  | "none";

export interface AssistantReply {
  reply: string;
  intent: AssistantIntent;
  params: {
    breakMinutes: number | null;
    taskId: string | null;
    notBefore: string | null;
    taskTitle: string | null;
    taskDeadline: string | null;
    taskDuration: number | null;
    eventId: string | null;
    eventTitle: string | null;
    eventDate: string | null;
    eventStart: string | null;
    eventEnd: string | null;
    preferences?: PreferenceChange | null;
  };
  provider?: "openai";
}

/** Accepts only a well-formed profile; anything else falls back to defaults so chat never breaks on it. */
export function normalizeProfile(value: unknown): AIProfile {
  const v = (value ?? {}) as Partial<AIProfile>;
  return {
    replyStyle: v.replyStyle === 'concise' || v.replyStyle === 'detailed' ? v.replyStyle : 'balanced',
    tone: v.tone === 'professional' || v.tone === 'motivating' ? v.tone : 'friendly',
    aboutMe: typeof v.aboutMe === 'string' ? v.aboutMe : '',
  };
}
export type Requester = <T>(path: string, options?: RequestInit) => Promise<T>;
export interface WorkspaceState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  tasks: Task[];
  sessions: WorkSession[];
  events: CalendarEvent[];
  connections: CalendarConnection[];
  availability: Availability | null;
  preferences: SchedulePreferences;
  /** How the AI assistant talks to this user (reply style, tone, about-me notes). */
  aiProfile: AIProfile;
  /** Version of the saved schedule; Apply is rejected when a preview was made against an older one. */
  scheduleVersion: number;
  /** A proposal from the scheduling service. It is never saved until Apply succeeds. */
  schedulePreview: SchedulePreview | null;
  /** Inputs changed after the preview was made; Apply will be rejected, so offer to regenerate. */
  previewStale: boolean;
  /** Items read from chat text or an image, waiting for review. Never saved until a plan preview is applied. */
  planDrafts: PlanDrafts | null;
  /** Result of the last "Can this fit?" check for the current drafts (changes no saved data). */
  feasibility: FeasibilityResult | null;
  /** A plan request (reading, checking, previewing drafts) is running. */
  planBusy: boolean;
  /** Changes waiting for confirmation (deletions, saving drafts), as stored by the API, plus their latest outcome. */
  pendingActions: PendingAction[];
  /** The numbered list the chat showed last, so "1" means exactly the first item shown. */
  pendingChoice: PendingChoice | null;
  error: string;
  saving: boolean;
}
export interface PlanDrafts { batchId: string; provider: InterpretResult['provider'] | 'chat'; notes: string[]; views: DraftView[]; horizonDays: number }
export interface ImageAttachment { mediaType: string; dataBase64: string; name: string }
const empty = (): WorkspaceState => ({ status: 'idle', tasks: [], sessions: [], events: [], connections: [], availability: null, preferences: DEFAULT_PREFERENCES, aiProfile: DEFAULT_AI_PROFILE, scheduleVersion: 0, schedulePreview: null, previewStale: false, planDrafts: null, feasibility: null, planBusy: false, pendingActions: [], pendingChoice: null, error: '', saving: false });
const newBatchId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Gives incoming drafts ids that do not clash with drafts already under review, keeping their links. */
export function mergeDrafts(current: DraftView[], incoming: DraftView[]): DraftView[] {
  const taken = new Set(current.map(v => v.draft.id));
  let next = current.length;
  const rename = new Map<string, string>();
  for (const view of incoming) {
    let id = view.draft.id;
    while (taken.has(id)) id = `d${++next}`;
    taken.add(id);
    rename.set(view.draft.id, id);
  }
  return [...current, ...incoming.map(v => ({ ...v, draft: { ...v.draft, id: rename.get(v.draft.id)!, dependsOn: v.draft.dependsOn.map(d => rename.get(d) ?? d) } }))];
}
/** Draft field names as the review uses them, for each form field an edit can change. */
function editedFields(before: PlanDraft, patch: Partial<PlanDraft>): Set<string> {
  const fields = new Set<string>();
  for (const key of Object.keys(patch) as (keyof PlanDraft)[]) {
    if (key === 'repeat') {
      const a = before.repeat, b = patch.repeat;
      fields.add('repeat');
      if (a?.startDate !== b?.startDate) fields.add('repeat.startDate');
      if (a?.until !== b?.until) fields.add('repeat.until');
      if (JSON.stringify(a?.weekdays) !== JSON.stringify(b?.weekdays)) fields.add('repeat.weekdays');
    } else if (key === 'minSessionMinutes' || key === 'maxSessionMinutes') fields.add('minSessionMinutes');
    else if (!['ambiguous', 'unreadable', 'assumed', 'include'].includes(key)) fields.add(key);
  }
  return fields;
}

/** A draft after a form edit: the edited values are the user's own, so their flags and questions go away now. */
export function editedView(view: DraftView, patch: Partial<PlanDraft>): DraftView {
  const touched = editedFields(view.draft, patch);
  if (patch.kind && patch.kind !== view.draft.kind) {
    // Another kind needs other fields: keep only the values, and let the next review ask afresh.
    const draft = { ...view.draft, ...patch };
    return { draft, issues: [], ready: false };
  }
  const draft = {
    ...view.draft, ...patch,
    ambiguous: (patch.ambiguous ?? view.draft.ambiguous).filter(f => !touched.has(f)),
    unreadable: (patch.unreadable ?? view.draft.unreadable).filter(f => !touched.has(f)),
    assumed: (patch.assumed ?? view.draft.assumed).filter(f => !touched.has(f)),
  };
  const issues = view.issues.filter(i => !touched.has(i.field) && !(i.field === 'repeat' && touched.has('kind')));
  return { draft, issues, ready: !issues.some(i => i.blocking) && (view.ready || view.issues.some(i => i.blocking)) };
}

/** What still blocks the selected drafts: one entry per item, with the fields in words. Unselected items never block. */
export function missingSummary(views: DraftView[]) {
  return views.flatMap((v, index) => {
    if (!v.draft.include || v.ready) return [];
    const fields = v.issues.filter(i => i.blocking).map(i => FIELD_WORDS[i.field] ?? i.field);
    return [{ draftId: v.draft.id, index, title: v.draft.title ? `“${v.draft.title}”` : `Item ${index + 1}`, fields: fields.length ? fields : ['being checked'] }];
  });
}
export const FIELD_WORDS: Record<string, string> = {
  title: 'name', minutes: 'length', deadline: 'due date', dueTime: 'due time', date: 'date', start: 'start time', end: 'end time',
  'repeat.until': 'last date', 'repeat.startDate': 'first date', 'repeat.weekdays': 'weekdays', repeat: 'weekly repeat',
  priority: 'priority', earliestStart: 'earliest start', location: 'location', dependsOn: 'depends on', minSessionMinutes: 'session lengths',
};
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
  const isAction = (a: unknown): a is PendingAction => !!a && typeof a === 'object' && 'type' in a && 'status' in a && 'version' in a;
  /** Open actions from the server, so a refresh still shows what is waiting. Optional: failures leave the list as is. */
  async function refreshActions(current = generation) {
    try {
      const open = (await request<PendingAction[]>('/actions')).filter(isAction);
      if (current !== generation) return;
      const known = new Set(open.map(a => a.id));
      publish({ ...state, pendingActions: [...state.pendingActions.filter(a => !known.has(a.id)), ...open] });
    } catch { /* the workspace still works without the list */ }
  }
  const putAction = (action: PendingAction) =>
    state.pendingActions.some(a => a.id === action.id) ? state.pendingActions.map(a => (a.id === action.id ? action : a)) : [...state.pendingActions, action];
  /** Saving drafts was proposed for their old values; once they change, that proposal no longer matches. */
  function dropCreateActions(note: string) {
    const open = state.pendingActions.filter(a => a.type === 'create_items' && (a.status === 'awaiting_confirmation' || a.status === 'failed'));
    if (!open.length) return {};
    for (const a of open) void request(`/actions/${a.id}/cancel`, { method: 'POST' }).catch(() => undefined);
    return { pendingActions: state.pendingActions.map(a => (open.includes(a) ? { ...a, status: 'cancelled' as const, error: note } : a)) };
  }
  async function load() {
    if (!owner || state.saving) return;
    const current = ++generation;
    publish({ ...state, status: 'loading', error: '' });
    try {
      // The AI profile is optional: if it cannot load, the workspace still opens with default personalization.
      const profile = request<AIProfile>('/assistant/profile').then(normalizeProfile, () => DEFAULT_AI_PROFILE);
      const [tasks, schedule, events, connections, availability, preferences, aiProfile] = await Promise.all([request<Task[]>('/tasks'), request<SavedSchedule>('/schedule'), request<CalendarEvent[]>('/events'), request<CalendarConnection[]>('/calendar/connections'), request<Availability>('/availability'), request<SchedulePreferences>('/schedule/preferences'), profile]);
      if (current === generation) publish({ status: 'ready', tasks, sessions: schedule.sessions, scheduleVersion: schedule.scheduleVersion, events, connections, availability: normalizeAvailability(availability), preferences: preferences ?? DEFAULT_PREFERENCES, aiProfile, schedulePreview: null, previewStale: false, planDrafts: state.planDrafts, feasibility: null, planBusy: false, pendingActions: state.pendingActions, pendingChoice: null, error: '', saving: false });
        void refreshActions(current);
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
  /** Draft edits make a pending plan preview out of date (it no longer matches what is under review). */
  const draftsChanged = () => ({
    ...(state.schedulePreview?.mode === 'plan' ? { previewStale: true } : {}),
    ...dropCreateActions('The items changed after this was proposed, so nothing was saved. Review them in the panel.'),
  });
  async function planCall<T>(path: string, body: unknown): Promise<T> {
    if (!owner || state.status !== 'ready') throw new Error('Wait for your workspace to load.');
    const current = generation;
    publish({ ...state, planBusy: true });
    try {
      const result = await request<T>(path, { method: 'POST', body: JSON.stringify(body) });
      if (current !== generation) throw new Error('Your account changed. Please try again.');
      return result;
    } finally {
      if (current === generation) publish({ ...state, planBusy: false });
    }
  }
  /** Re-checks the drafts as they are now, and refuses with exactly what is missing from the selected ones. */
  async function reviewed(what: 'check' | 'preview' | 'save') {
    if (!state.planDrafts) throw new Error(`There is nothing to ${what} yet.`);
    const views = await api.reviewDrafts();
    const plan = state.planDrafts;
    if (!plan.views.some(v => v.draft.include)) throw new Error(`Tick at least one item to ${what}.`);
    const missing = missingSummary(views);
    if (missing.length) throw new Error(`Still needed: ${missing.map(m => `${m.title} (${m.fields.join(', ')})`).join('; ')}.`);
    return plan;
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
    /** Reply style, tone and about-me notes. Wording only, so a pending schedule preview stays valid. */
    saveAIProfile(profile: AIProfile) {
      return mutate<AIProfile>('/assistant/profile', { method: 'PUT', body: JSON.stringify(profile) }, saved => ({ aiProfile: normalizeProfile(saved) }));
    },
    /** Saves a change the user confirmed in chat. The server re-checks every value before saving. */
    applyPreferenceChange(change: PreferenceChange) {
      const pacing = change.focusMinutes != null || change.breakMinutes != null || change.maxDailyWorkMinutes != null;
      return mutate<{ preferences: SchedulePreferences; profile: AIProfile }>('/assistant/preferences/apply', { method: 'POST', body: JSON.stringify(change) },
        saved => ({ preferences: saved.preferences, aiProfile: normalizeProfile(saved.profile), ...(pacing ? stale() : {}) }));
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
          saved => ({
            sessions: saved.schedule.sessions, scheduleVersion: saved.schedule.scheduleVersion, schedulePreview: null, previewStale: false, error: '',
            // Tasks and events created from drafts by this Apply join the shared state; the drafts are done.
            tasks: [...state.tasks, ...(saved.tasks ?? []).filter(t => !state.tasks.some(x => x.id === t.id))],
            events: [...state.events, ...(saved.events ?? []).filter(e => !state.events.some(x => x.id === e.id))],
            ...(preview.mode === 'plan' ? { planDrafts: null, feasibility: null, ...dropCreateActions('These items were saved with the schedule.') } : {}),
          }),
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
      if (result.duplicate && preview.mode === 'plan') void load(); // already saved earlier: show what is stored
      return result.schedule.sessions;
    },
    // ------------------------------------------------------------ plan entry (drafts)
    /** Reads text and/or an image into drafts for review. Saves nothing; the caller keeps its input on failure. */
    async interpretPlan(text: string, image?: ImageAttachment | null) {
      const batch = state.planDrafts?.batchId ?? newBatchId();
      const result = await planCall<InterpretResult>('/plan/interpret', { text, image: image ?? null, batchId: batch });
      const views = mergeDrafts(state.planDrafts?.views ?? [], result.drafts);
      publish({ ...state, planDrafts: { batchId: batch, provider: result.provider, notes: result.notes, views, horizonDays: state.planDrafts?.horizonDays ?? 7 }, feasibility: null, ...draftsChanged() });
      return { ...result, drafts: views.slice(views.length - result.drafts.length) };
    },
    /** Adds structured drafts (e.g. a chat "add task" request) to the review panel instead of saving them directly. */
    async addDrafts(drafts: PlanDraft[]) {
      const batch = state.planDrafts?.batchId ?? newBatchId();
      const merged = mergeDrafts(state.planDrafts?.views ?? [], drafts.map(draft => ({ draft, issues: [], ready: false })));
      publish({ ...state, planDrafts: { batchId: batch, provider: 'chat', notes: [], views: merged, horizonDays: state.planDrafts?.horizonDays ?? 7 }, feasibility: null, ...draftsChanged() });
      await api.reviewDrafts();
      return state.planDrafts!.views.slice(merged.length - drafts.length);
    },
    /**
     * Local edit of one draft. The edited fields are now the user's values, so their "unclear"/"unreadable" flags
     * and the questions about them are cleared right away; the backend re-checks with reviewDrafts().
     */
    updateDraft(id: string, patch: Partial<PlanDraft>) {
      if (!state.planDrafts) return;
      const views = state.planDrafts.views.map(v => (v.draft.id === id ? editedView(v, patch) : v));
      publish({ ...state, planDrafts: { ...state.planDrafts, views }, feasibility: null, ...draftsChanged() });
    },
    removeDraft(id: string) {
      if (!state.planDrafts) return;
      const views = state.planDrafts.views.filter(v => v.draft.id !== id)
        .map(v => ({ ...v, draft: { ...v.draft, dependsOn: v.draft.dependsOn.filter(d => d !== id) } }));
      publish({ ...state, planDrafts: views.length ? { ...state.planDrafts, views } : null, feasibility: null, ...draftsChanged() });
    },
    setPlanHorizon(days: number) {
      if (!state.planDrafts) return;
      publish({ ...state, planDrafts: { ...state.planDrafts, horizonDays: days }, feasibility: null, ...draftsChanged() });
    },
    clearDrafts() {
      const plan = state.schedulePreview?.mode === 'plan';
      publish({ ...state, planDrafts: null, feasibility: null, ...(plan ? { schedulePreview: null, previewStale: false } : {}) });
    },
    /** Business-rule review of every draft by the backend: questions for anything missing or ambiguous. */
    async reviewDrafts() {
      const plan = state.planDrafts;
      if (!plan) return [];
      const sent = JSON.stringify(plan.views.map(v => v.draft));
      const views = await planCall<DraftView[]>('/plan/review', { drafts: plan.views.map(v => v.draft), horizonDays: plan.horizonDays, batchId: plan.batchId });
      // An answer for drafts that have been edited since is stale: keep the newer edits (another review follows).
      const now = state.planDrafts;
      if (!now || now.batchId !== plan.batchId || JSON.stringify(now.views.map(v => v.draft)) !== sent) return now?.views ?? [];
      publish({ ...state, planDrafts: { ...now, views } });
      return views;
    },
    /** A focused answer ("PM", "Dec 12") updates the same draft. */
    async clarifyDraft(id: string, field: string, answer: string) {
      const plan = state.planDrafts;
      const view = plan?.views.find(v => v.draft.id === id);
      if (!plan || !view) throw new Error('That item is no longer in the review list.');
      const updated = await planCall<DraftView>('/plan/clarify', { draft: view.draft, field, answer, otherDraftIds: plan.views.map(v => v.draft.id) });
      if (state.planDrafts) publish({ ...state, planDrafts: { ...state.planDrafts, views: state.planDrafts.views.map(v => (v.draft.id === id ? updated : v)) }, feasibility: null, ...draftsChanged() });
      return updated;
    },
    /** "Can this fit?": the backend reads only; nothing is saved, not even a proposal. */
    async checkFit() {
      const plan = await reviewed('check');
      const result = await planCall<FeasibilityResult>('/plan/feasibility', { drafts: plan.views.map(v => v.draft), horizonDays: plan.horizonDays, batchId: plan.batchId });
      publish({ ...state, feasibility: result });
      return result;
    },
    /** Complete calendar preview with the drafts added. Apply saves tasks, events and sessions together. */
    async previewDrafts() {
      const plan = await reviewed('preview');
      if (state.saving) throw new Error('A change is still saving. Please try again shortly.');
      const preview = await planCall<SchedulePreview>('/plan/preview', { drafts: plan.views.map(v => v.draft), horizonDays: plan.horizonDays, batchId: plan.batchId });
      publish({ ...state, schedulePreview: preview, previewStale: false, error: '' });
      return preview;
    },
    // ------------------------------------------------------------ pending actions (confirm / cancel)
    /** Proposes deleting these exact tasks. Nothing is deleted until confirmAction(id). */
    async proposeDeleteTasks(taskIds: string[]) {
      if (!owner || state.status !== 'ready') throw new Error('Wait for your workspace to load.');
      const action = await request<PendingAction>('/actions/delete-tasks', { method: 'POST', body: JSON.stringify({ taskIds }) });
      publish({ ...state, pendingActions: putAction(action), pendingChoice: null });
      return action;
    },
    /** Proposes saving the selected drafts as tasks and events, without scheduling them. */
    async proposeCreateItems() {
      const plan = await reviewed('save');
      const action = await request<PendingAction>('/actions/create-items', { method: 'POST', body: JSON.stringify({ drafts: plan.views.map(v => v.draft), batchId: plan.batchId }) });
      publish({ ...state, pendingActions: putAction(action) });
      return action;
    },
    /**
     * Runs a pending action once. A second call while it runs is refused here, and the server refuses a second
     * run too (it returns the finished action with duplicate: true). Errors are kept on the action for display.
     */
    async confirmAction(id: string): Promise<ActionResult> {
      const action = state.pendingActions.find(a => a.id === id);
      if (!action) throw new Error('That action is no longer waiting for confirmation.');
      if (action.status === 'processing') throw new Error('This is already running.');
      if (action.status === 'succeeded') throw new Error('This was already done.');
      if (action.status === 'cancelled') throw new Error('This was cancelled. Ask again if you still want it.');
      const current = generation;
      publish({ ...state, pendingActions: putAction({ ...action, status: 'processing', error: null }) });
      let result: ActionResult;
      try {
        result = await request<ActionResult>(`/actions/${id}/confirm`, { method: 'POST', body: JSON.stringify({ version: action.version }) });
      } catch (error) {
        if (current === generation) publish({ ...state, pendingActions: putAction({ ...action, status: 'failed', error: (error as Error).message }) });
        throw error;
      }
      if (current !== generation) throw new Error('Your account changed. Please try again.');
      const deleted = new Set(result.deletedTaskIds ?? []);
      const created = new Set(result.action.type === 'create_items' ? result.action.targets.map(t => t.id) : []);
      const views = state.planDrafts?.views.filter(v => !created.has(v.draft.id)) ?? [];
      publish({
        ...state,
        pendingActions: putAction(result.action),
        tasks: [...state.tasks.filter(t => !deleted.has(t.id)), ...(result.tasks ?? []).filter(t => !state.tasks.some(x => x.id === t.id))],
        events: [...state.events, ...(result.events ?? []).filter(e => !state.events.some(x => x.id === e.id))],
        sessions: state.sessions.filter(s => !s.taskId || !deleted.has(s.taskId)),
        scheduleVersion: result.scheduleVersion ?? state.scheduleVersion,
        ...(created.size && state.planDrafts ? { planDrafts: views.length ? { ...state.planDrafts, views } : null, feasibility: null } : {}),
        ...(result.duplicate ? {} : stale()),
      });
      return result;
    },
    /** Cancels a pending action. Changes nothing else. */
    async cancelAction(id: string) {
      const action = state.pendingActions.find(a => a.id === id);
      if (!action) return;
      const cancelled = await request<PendingAction>(`/actions/${id}/cancel`, { method: 'POST' });
      publish({ ...state, pendingActions: putAction(cancelled) });
      return cancelled;
    },
    setChoice(choice: PendingChoice | null) {
      publish({ ...state, pendingChoice: choice });
    },
    refreshActions: () => refreshActions(),
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
