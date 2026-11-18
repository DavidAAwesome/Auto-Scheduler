import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkspaceStore, editedView, missingSummary, type Requester } from '../src/services/workspaceStore.ts';
import { deleteRequest, parseRequest, requestFromIntent, runAssistantCommand } from '../src/services/assistantCommands.ts';
import { emptyDraft } from '../src/services/planEntry.ts';
import { CANCEL, CONFIRM, openActions, parseSelection, resolveConfirm } from '../src/services/pendingActions.ts';
import type {
  ActionResult, Availability, DraftView, InterpretResult, PendingAction, PlanDraft, SchedulePreferences, SavedSchedule, Task,
} from '../src/types/models.ts';

/** Saved state from the captured plan fixture (availability, preferences); tasks below are disposable test records. */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/plan.json', import.meta.url), 'utf8')) as {
  availability: Availability; preferences: SchedulePreferences; schedule: SavedSchedule;
};
const NOW = new Date('2026-10-26T12:00:00Z');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
  id, title, deadline: '2026-10-30', dueTime: 1439, minutes: 60, completedMinutes: 0, remainingMinutes: 60, done: false,
  priority: 'Medium', category: 'Study', earliestStart: null, allowSplit: true, minSessionMinutes: 15, maxSessionMinutes: 60,
  dependsOn: [], kind: 'task', windows: [], ...extra,
} as Task);

/**
 * An in-memory API with the same action rules as the backend: proposals store exact targets, confirm runs once
 * (a repeat returns duplicate: true), cancel changes nothing, and a failure leaves the action retryable.
 */
function backend(options: { failConfirm?: number; interpret?: (text: string) => InterpretResult } = {}) {
  const log: string[] = [];
  let tasks: Task[] = [task('t1', 'Disposable essay'), task('t2', 'Disposable essay'), task('t3', 'Disposable lab')];
  let sessions = [{ id: 's1', taskId: 't3', title: 'Disposable lab' }];
  const actions = new Map<string, PendingAction & { payload: unknown }>();
  let failures = options.failConfirm ?? 0;
  let seq = 0;
  const routes: Record<string, (body: Record<string, unknown>, path: string) => unknown> = {
    '/tasks': () => tasks,
    '/events': () => [],
    '/schedule': () => ({ ...fixture.schedule, sessions: [] }),
    '/schedule/preferences': () => fixture.preferences,
    '/calendar/connections': () => [],
    '/availability': () => fixture.availability,
    '/actions': () => [...actions.values()].filter(a => a.status === 'awaiting_confirmation' || a.status === 'failed'),
    '/plan/review': body => (body.drafts as PlanDraft[]).map(draft => ({ draft, issues: [], ready: true })),
    '/plan/interpret': body => options.interpret!(String(body.text)),
    '/actions/delete-tasks': body => {
      const ids = body.taskIds as string[];
      const targets = ids.map(id => { const t = tasks.find(x => x.id === id)!; return { id, title: t.title, detail: `${sessions.filter(s => s.taskId === id).length} sessions` }; });
      const count = sessions.filter(s => ids.includes(s.taskId)).length;
      const action = { id: `a${++seq}`, type: 'delete_tasks' as const, status: 'awaiting_confirmation' as const, version: 3, summary: `Delete ${targets.map(t => `“${t.title}”`).join(', ')}? This also removes ${count} scheduled sessions.`, targets, sessionCount: count, error: null, createdAt: NOW.toISOString(), payload: ids };
      actions.set(action.id, action);
      return action;
    },
    '/actions/create-items': body => {
      const drafts = (body.drafts as PlanDraft[]).filter(d => d.include);
      const action = { id: `a${++seq}`, type: 'create_items' as const, status: 'awaiting_confirmation' as const, version: 1, summary: `Save ${drafts.length} items?`, targets: drafts.map(d => ({ id: d.id, title: d.title! })), sessionCount: 0, error: null, createdAt: NOW.toISOString(), payload: drafts };
      actions.set(action.id, action);
      return action;
    },
  };
  const request = (async <T>(path: string, init?: RequestInit) => {
    log.push(`${init?.method ?? 'GET'} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const confirm = path.match(/^\/actions\/(\w+)\/(confirm|cancel)$/);
    if (confirm) {
      const action = actions.get(confirm[1]);
      if (!action) throw Object.assign(new Error('That action was not found.'), { status: 404 });
      const { payload, ...visible } = action;
      if (confirm[2] === 'cancel') { action.status = 'cancelled'; return structuredClone({ ...visible, status: 'cancelled' }) as T; }
      if (action.status === 'succeeded') return structuredClone({ action: visible, duplicate: true, deletedTaskIds: [], tasks: [], events: [], scheduleVersion: null }) as T;
      if (body.version !== action.version) throw Object.assign(new Error('This confirmation is out of date. Nothing was changed; ask again.'), { status: 409 });
      if (failures-- > 0) { action.status = 'failed'; action.error = 'The database could not complete it.'; throw Object.assign(new Error('The database could not complete it.'), { status: 503 }); }
      await tick(); // a real request takes time: a second click arrives while this one runs
      action.status = 'succeeded';
      let result: Partial<ActionResult>;
      if (action.type === 'delete_tasks') {
        const ids = payload as string[];
        tasks = tasks.filter(t => !ids.includes(t.id));
        sessions = sessions.filter(s => !ids.includes(s.taskId));
        result = { deletedTaskIds: ids, tasks: [], scheduleVersion: 4 };
      } else {
        const created = (payload as PlanDraft[]).map((d, i) => task(`new${i}`, d.title!, { deadline: d.deadline!, dueTime: d.dueTime ?? 1439, minutes: d.minutes! }));
        tasks = [...tasks, ...created];
        result = { deletedTaskIds: [], tasks: created, scheduleVersion: 4 };
      }
      return structuredClone({ action: { ...visible, status: 'succeeded' }, duplicate: false, events: [], ...result }) as T;
    }
    const handler = routes[path];
    return structuredClone(handler ? handler(body, path) : []) as T;
  }) as Requester;
  return { request, log, tasks: () => tasks, sessions: () => sessions, confirms: () => log.filter(l => l.endsWith('/confirm')).length };
}

async function store(request: Requester) {
  const s = createWorkspaceStore(request);
  s.setUser('owner');
  await tick(); await tick();
  return s;
}

test('delete: the confirm button deletes exactly once, even when pressed twice', async () => {
  const api = backend();
  const workspace = await store(api.request);
  const message = await runAssistantCommand({ command: 'delete_task', taskIds: ['t3'] }, workspace, NOW);
  assert.ok(message.actionId, 'the message carries a real pending action, so it can show buttons');
  assert.match(message.text, /“Disposable lab”.*1 scheduled sessions/);
  assert.equal(api.tasks().length, 3, 'proposing deletes nothing');

  const results = await Promise.allSettled([workspace.confirmAction(message.actionId!), workspace.confirmAction(message.actionId!)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(api.confirms(), 1, 'one request reached the server');
  assert.deepEqual(api.tasks().map(t => t.id), ['t1', 't2']);
  const state = workspace.getSnapshot();
  assert.deepEqual(state.tasks.map(t => t.id), ['t1', 't2'], 'shared state updated only from the server result');
  assert.equal(state.pendingActions.find(a => a.id === message.actionId)?.status, 'succeeded');
  await assert.rejects(workspace.confirmAction(message.actionId!), /already done/);
  assert.equal(api.confirms(), 1);
});

test('cancel performs no mutation, and a cancelled action cannot be confirmed', async () => {
  const api = backend();
  const workspace = await store(api.request);
  const action = await workspace.proposeDeleteTasks(['t1']);
  await workspace.cancelAction(action.id);
  assert.equal(api.tasks().length, 3);
  assert.equal(workspace.getSnapshot().pendingActions[0].status, 'cancelled');
  await assert.rejects(workspace.confirmAction(action.id), /cancelled/);
  assert.equal(api.confirms(), 0);
});

test('a backend error stays visible on the action and a retry is safe', async () => {
  const api = backend({ failConfirm: 1 });
  const workspace = await store(api.request);
  const action = await workspace.proposeDeleteTasks(['t3']);
  await assert.rejects(workspace.confirmAction(action.id), /database could not complete/);
  const failed = workspace.getSnapshot().pendingActions[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /database could not complete/);
  assert.equal(api.tasks().length, 3, 'nothing changed');
  await workspace.confirmAction(action.id);
  assert.equal(api.tasks().length, 2);
});

test('typed “confirm” resolves one unambiguous action, and asks which when several wait', async () => {
  assert.ok(CONFIRM.test('confirm') && CONFIRM.test('Yes, do it') && CONFIRM.test('ok!'));
  assert.ok(!CONFIRM.test('yes I want to plan my week') && CANCEL.test('cancel'));
  const api = backend();
  const workspace = await store(api.request);
  assert.equal(resolveConfirm(openActions(workspace.getSnapshot())).kind, 'none');
  const one = await workspace.proposeDeleteTasks(['t3']);
  const decision = resolveConfirm(openActions(workspace.getSnapshot()));
  assert.equal(decision.kind, 'one');
  assert.equal(decision.kind === 'one' && decision.target.id, one.id, 'routed to the same handler as the button');
  await workspace.proposeDeleteTasks(['t1']);
  const several = resolveConfirm(openActions(workspace.getSnapshot()));
  assert.equal(several.kind, 'several');
  assert.equal(several.kind === 'several' && several.options.length, 2);
});

test('“1” picks from exactly the list that was shown, not a fresh one', async () => {
  const api = backend();
  const workspace = await store(api.request);
  const request = parseRequest('delete task disposable essay', workspace.getSnapshot(), NOW);
  assert.equal(request?.command, 'pick_tasks', 'two tasks share the name, so ask');
  const message = await runAssistantCommand(request!, workspace, NOW);
  assert.match(message.text, /1\. Disposable essay[\s\S]*2\. Disposable essay/);
  const shown = workspace.getSnapshot().pendingChoice!;
  assert.deepEqual(shown.options.map(o => o.id), ['t1', 't2']);
  // The task list changes order afterwards; "2" still means the second item shown.
  workspace.getSnapshot().tasks.reverse();
  const pick = parseSelection('2', shown.options.length);
  assert.ok(pick && 'indexes' in pick);
  assert.deepEqual(pick && 'indexes' in pick ? pick.indexes.map(i => shown.options[i].id) : [], ['t2']);
  assert.deepEqual(parseSelection('7', 2), { error: 'Choose a number from 1 to 2.' });
  assert.equal(parseSelection('delete everything', 2), null);
  // An exact name needs no list; the model's delete intent is a pending action too, never a bare sentence.
  assert.deepEqual(deleteRequest('Disposable lab', workspace.getSnapshot().tasks), { command: 'delete_task', taskIds: ['t3'] });
  assert.deepEqual(requestFromIntent({ reply: 'Okay', intent: 'delete_task', params: { taskId: 't3' } } as never, workspace.getSnapshot()), { command: 'delete_task', taskIds: ['t3'] });
});

test('completing a field clears its blocking question at once; stale review answers are ignored', async () => {
  const view: DraftView = {
    draft: emptyDraft('d1', { title: 'Essay', minutes: 60, deadline: '2026-10-30', dueTime: 720, ambiguous: ['deadline', 'dueTime'] }),
    issues: [
      { field: 'deadline', code: 'ambiguous', question: 'Please confirm the deadline of "Essay".', blocking: true },
      { field: 'dueTime', code: 'ambiguous', question: 'Please confirm the due time of "Essay".', blocking: true },
    ],
    ready: false,
  };
  const edited = editedView(editedView(view, { deadline: '2026-10-31' }), { dueTime: 720 });
  assert.deepEqual(edited.draft.ambiguous, [], 'the form value is now the source of truth');
  assert.deepEqual(edited.issues, []);
  assert.equal(edited.ready, true);
  assert.deepEqual(missingSummary([edited]), []);

  // The panel's review: an answer for drafts that changed while it was in flight must not undo the edit.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const api = backend();
  let hold = false;
  const slow: Requester = (async <T>(path: string, init?: RequestInit) => {
    if (path === '/plan/review' && hold) {
      const sent = JSON.parse(String(init!.body)).drafts as PlanDraft[];
      await gate;
      return sent.map(draft => ({ draft, issues: [{ field: 'deadline', code: 'missing', question: 'When is it due?', blocking: true }], ready: false })) as T;
    }
    return api.request<T>(path, init);
  }) as Requester;
  const workspace = await store(slow);
  await workspace.addDrafts([emptyDraft('d1', { title: 'Essay', minutes: 60 })]);
  hold = true;
  const pending = workspace.reviewDrafts();
  workspace.updateDraft('d1', { deadline: '2026-10-30' });
  release();
  await pending;
  const now = workspace.getSnapshot().planDrafts!.views[0];
  assert.equal(now.draft.deadline, '2026-10-30', 'the newer edit is kept');
  assert.ok(!now.issues.some(i => i.question === 'When is it due?'), 'the stale “missing deadline” answer was dropped');
});

test('an unselected incomplete draft never blocks the selected ones', () => {
  const ok: DraftView = { draft: emptyDraft('d1', { title: 'Essay', minutes: 60, deadline: '2026-10-30' }), issues: [], ready: true };
  const broken: DraftView = { draft: emptyDraft('d2', { title: 'Gym', include: false }), issues: [{ field: 'minutes', code: 'missing', question: 'How long?', blocking: true }], ready: false };
  assert.deepEqual(missingSummary([ok, broken]), []);
  assert.deepEqual(missingSummary([ok, { ...broken, draft: { ...broken.draft, include: true } }]), [{ draftId: 'd2', index: 1, title: '“Gym”', fields: ['length'] }]);
});

test('chat “add task … at noon” keeps noon from the parser to the saved task, after a refresh', async () => {
  const noon = (text: string): InterpretResult => {
    assert.equal(text, 'Study Networking, due October 30 at noon, 50 minutes.');
    return { batchId: 'b1', provider: 'local', notes: [], now: NOW.toISOString(), timeZone: 'America/New_York',
      drafts: [{ draft: emptyDraft('d1', { title: 'Study Networking', minutes: 50, deadline: '2026-10-30', dueTime: 720, assumed: ['priority'] }), issues: [], ready: true }] };
  };
  const api = backend({ interpret: noon });
  const workspace = await store(api.request);
  const request = parseRequest('Add a task called Study Networking, due October 30 at noon, with a duration of 50 minutes.', workspace.getSnapshot(), NOW);
  assert.deepEqual(request, { command: 'add_task', text: 'Study Networking, due October 30 at noon, 50 minutes.' });
  const message = await runAssistantCommand(request!, workspace, NOW);
  assert.match(message.text, /Study Networking: task, 50 min, due 2026-10-30 12 PM/);
  assert.ok(message.actionId && !api.log.includes('POST /tasks'), 'nothing saved before Confirm tasks');
  await workspace.confirmAction(message.actionId!);
  const saved = workspace.getSnapshot().tasks.find(t => t.title === 'Study Networking')!;
  assert.equal(saved.dueTime, 720);
  assert.equal(workspace.getSnapshot().planDrafts, null, 'saved drafts leave the review panel');
  const refreshed = await store(api.request);
  assert.equal(refreshed.getSnapshot().tasks.find(t => t.title === 'Study Networking')?.dueTime, 720);
});

test('editing a draft withdraws an unconfirmed “save these items” proposal', async () => {
  const api = backend({ interpret: () => ({ batchId: 'b1', provider: 'local', notes: [], now: NOW.toISOString(), timeZone: 'UTC',
    drafts: [{ draft: emptyDraft('d1', { title: 'Essay', minutes: 60, deadline: '2026-10-30' }), issues: [], ready: true }] }) });
  const workspace = await store(api.request);
  await workspace.interpretPlan('Essay 60 min due Oct 30');
  const action = await workspace.proposeCreateItems();
  workspace.updateDraft('d1', { minutes: 90 });
  const after = workspace.getSnapshot().pendingActions.find(a => a.id === action.id)!;
  assert.equal(after.status, 'cancelled');
  await assert.rejects(workspace.confirmAction(action.id), /cancelled/);
  assert.equal(api.tasks().length, 3);
});
