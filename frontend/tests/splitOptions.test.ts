import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkspaceStore, type AssistantReply, type Requester } from '../src/services/workspaceStore.ts';
import { parseRequest, requestFromIntent, runAssistantCommand, splitFromEntry } from '../src/services/assistantCommands.ts';
import { activeSplitOptions, calendarSessions, draftsBeforePreview, savedWorkChanges, previewText, splitOptionSessions, splitOptionSummary, splitOptionWarnings } from '../src/utils/schedulePreview.ts';
import type { Availability, DraftView, PlanDraft, SavedSchedule, SchedulePreferences, SchedulePreview, ScheduleSession, SplitOption, SplitOptions, Task } from '../src/types/models.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/acceptance.json', import.meta.url), 'utf8')) as {
  tasks: Task[]; availability: Availability; preferences: SchedulePreferences; schedule: SavedSchedule; preview: SchedulePreview;
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const [asm] = fixture.tasks;

function session(id: string, date: string, start: number, end: number): ScheduleSession {
  return { ...fixture.preview.sessions[0], id, taskId: asm.id, title: asm.title, date, start, end, change: 'new' };
}

function option(id: SplitOption['id'], sessions: ScheduleSession[], extra: Partial<SplitOption> = {}): SplitOption {
  const lengths = sessions.map(s => s.end - s.start);
  return {
    id, label: id, description: id, sessionCount: sessions.length, dayCount: new Set(sessions.map(s => s.date)).size,
    longestMinutes: Math.max(...lengths), shortestMinutes: Math.min(...lengths), scheduledMinutes: lengths.reduce((a, b) => a + b, 0),
    unallocatedMinutes: 0, lastEndAt: null, otherNewMinutes: 0, movedSessions: 0,
    preview: { ...fixture.preview, previewId: `preview-${id}`, mode: 'split', sessions }, ...extra,
  };
}

const split: SplitOptions = {
  taskIds: [asm.id], title: asm.title, remainingMinutes: 60, notes: [],
  options: [
    option('front_loaded', [session('a', '2026-10-26', 540, 590), session('b', '2026-10-26', 600, 610)]),
    option('even', [session('c', '2026-10-26', 540, 570), session('d', '2026-10-27', 540, 570)]),
  ],
};

function backend(conflict = false) {
  const applied: string[] = [];
  const request = (async <T>(path: string, init?: RequestInit) => {
    const routes: Record<string, unknown> = {
      '/tasks': fixture.tasks, '/schedule': { ...fixture.schedule, sessions: [] }, '/schedule/preferences': fixture.preferences,
      '/availability': fixture.availability, '/schedule/split-options': split, '/schedule/preview': fixture.preview,
    };
    if (path === '/schedule/apply') {
      if (conflict) throw Object.assign(new Error('stale'), { status: 409 });
      applied.push(JSON.parse(String(init?.body)).previewId);
      return { previewId: applied.at(-1), status: 'applied', duplicate: false, schedule: fixture.schedule } as T;
    }
    return structuredClone(routes[path] ?? []) as T;
  }) as Requester;
  return { request, applied };
}

async function store(request: Requester) {
  const s = createWorkspaceStore(request);
  s.setUser('owner');
  await tick();
  return s;
}

test('split options preview the first option on the calendar next to saved work, and save nothing', async () => {
  const api = backend();
  const workspace = await store(api.request);
  await workspace.requestSplitOptions([asm.id]);
  const state = workspace.getSnapshot();
  assert.equal(state.schedulePreview?.previewId, 'preview-front_loaded');
  assert.deepEqual(calendarSessions(state.sessions, state.schedulePreview).map(i => [i.session.id, i.kind]), [['a', 'proposed'], ['b', 'proposed']]);
  assert.deepEqual(api.applied, []);
});

test('picking an option changes the preview, and Apply saves only that option', async () => {
  const api = backend();
  const workspace = await store(api.request);
  await workspace.requestSplitOptions([asm.id]);
  workspace.chooseSplitOption('even');
  assert.deepEqual(workspace.getSnapshot().schedulePreview?.sessions.map(s => s.id), ['c', 'd']);
  await workspace.applySchedulePreview();
  assert.deepEqual(api.applied, ['preview-even']);
  assert.equal(workspace.getSnapshot().splitOptions, null);
  assert.equal(workspace.getSnapshot().schedulePreview, null);
});

test('Cancel and a rejected Apply both drop the options', async () => {
  const cancelled = await store(backend().request);
  await cancelled.requestSplitOptions([asm.id]);
  cancelled.clearSchedulePreview();
  assert.equal(cancelled.getSnapshot().splitOptions, null);

  const rejected = await store(backend(true).request);
  await rejected.requestSplitOptions([asm.id]);
  await assert.rejects(rejected.applySchedulePreview());
  assert.equal(rejected.getSnapshot().splitOptions, null);
});

test('options only show while one of them is the preview, so another preview replaces them', async () => {
  const workspace = await store(backend().request);
  await workspace.requestSplitOptions([asm.id]);
  let state = workspace.getSnapshot();
  assert.equal(activeSplitOptions(state.splitOptions, state.schedulePreview)?.taskIds[0], asm.id);
  await workspace.previewSchedule(7);
  state = workspace.getSnapshot();
  assert.equal(activeSplitOptions(state.splitOptions, state.schedulePreview), null);
  assert.equal(activeSplitOptions(null, null), null);
});

test('option text describes the sessions the engine returned and any side effects', () => {
  const [front, even] = split.options;
  assert.equal(splitOptionSummary(front), '2 sessions over 1 day · 10 min–50 min each');
  assert.equal(splitOptionSummary(even), '2 sessions over 2 days · 30 min each');
  assert.deepEqual(splitOptionSessions(even, [asm.id]).map(s => s.id), ['c', 'd']);
  assert.deepEqual(splitOptionWarnings(even), []);
  assert.deepEqual(splitOptionWarnings({ ...even, unallocatedMinutes: 90, otherNewMinutes: 50, movedSessions: 1 }), [
    '1h 30m can’t be placed before the deadline.', 'Also schedules 50 min of your other tasks.', 'Moves 1 saved session of other tasks.',
  ]);
  assert.match(previewText(even.preview), /^Proposed split, /);
});

// ------------------------------------------------------------------ chat

const openDraft = (id: string, title: string): DraftView => ({
  ready: false,
  issues: [{ field: 'minutes', code: 'missing', question: 'How long?', blocking: true }],
  draft: { id, kind: 'task', title, include: true, windows: [] } as unknown as PlanDraft,
});
const chatState = (views: DraftView[] = []) => ({
  tasks: fixture.tasks, availability: fixture.availability,
  planDrafts: views.length ? { batchId: 'b', provider: 'chat' as const, notes: [], views, horizonDays: 7 } : null,
});

for (const phrase of ['show me different ways to split them', 'Show me split options', 'what are my options for splitting these?',
  'how should I split them', 'split them', 'break them up in different ways', 'compare ways to divide my tasks']) {
  test(`chat: "${phrase}" asks for split options for the drafts under review`, () => {
    assert.deepEqual(parseRequest(phrase, chatState([openDraft('a', 'Essay'), openDraft('b', 'Lab')])), { command: 'split_options', target: 'drafts' });
  });
}

test('chat: phrases that are not about splitting keep their own meaning', () => {
  const state = chatState();
  assert.equal(parseRequest('I need a 15-minute break now', state)?.command, 'request_break');
  assert.equal(parseRequest('plan my week', state)?.command, 'generate_schedule');
  assert.equal(parseRequest('Essay, 2 hours, due Friday, split it', state), null);
});

test('chat: a named saved task is used; "them" means every open task; "it" with several asks which', () => {
  const [one, two] = fixture.tasks;
  assert.deepEqual(parseRequest(`ways to split ${one.title}`, chatState()), { command: 'split_options', target: [one.id] });
  assert.deepEqual(parseRequest('ways to split them', chatState()), { command: 'split_options', target: [one.id, two.id] });
  assert.equal(parseRequest('split it', chatState())?.command, 'clarify');
});

test('chat: the model intent resolves to the same request', () => {
  const answer = { reply: 'x', intent: 'split_options', params: { taskId: fixture.tasks[1].id }, provider: 'openai' } as unknown as AssistantReply;
  assert.deepEqual(requestFromIntent(answer, chatState(), 'split that one'), { command: 'split_options', target: [fixture.tasks[1].id] });
});

test('chat: running it previews the first option and offers Apply, with no times from the model', async () => {
  const workspace = await store(backend().request);
  const message = await runAssistantCommand({ command: 'split_options', target: [asm.id] }, workspace);
  assert.match(message.text, /Here are 2 ways to split Asm\. Not saved yet/);
  assert.deepEqual(message.actions, ['apply_schedule', 'cancel_schedule']);
  assert.equal(workspace.getSnapshot().schedulePreview?.previewId, 'preview-front_loaded');
});

test('a split request after new items is separated from them', () => {
  const items = 'Study for calculus 4h due Thu noon high priority; lab report 3h due Sat; class Tue 10-11:30';
  assert.deepEqual(splitFromEntry(`${items}, show me ways to split them`), { entry: items, wantsSplit: true });
  assert.deepEqual(splitFromEntry(`${items} and compare ways to split them.`), { entry: items, wantsSplit: true });
  assert.deepEqual(splitFromEntry(`${items}; split them`), { entry: items, wantsSplit: true });
});

test('items that only mention splitting or showing stay whole', () => {
  for (const text of ['Essay 2h due Friday', 'Show and tell prep 1h due Friday', 'Lab, split the work with Sam 2h due Fri', 'show me different ways to split them']) {
    assert.deepEqual(splitFromEntry(text), { entry: text, wantsSplit: false });
  }
});

test('split options and Apply come before the drafts in the review area', async () => {
  const workspace = await store(backend().request);
  assert.equal(draftsBeforePreview(null, null), true);
  await workspace.requestSplitOptions([asm.id]);
  const state = workspace.getSnapshot();
  assert.equal(draftsBeforePreview(state.splitOptions, state.schedulePreview), false);
  await workspace.previewSchedule(7);
  const after = workspace.getSnapshot();
  assert.equal(draftsBeforePreview(after.splitOptions, after.schedulePreview), true);
});

test('sessions a split replaces are counted, while real moves stay listed', () => {
  const removal = (id: string, reason: string) => ({ session: session(id, '2026-11-05', 540, 590), reason, newEndAt: null });
  const preview = { ...fixture.preview, removed: [
    removal('a', 'Replaced by this split option.'), removal('b', 'Replaced by this split option.'), removal('c', 'It overlaps "Lab".'),
  ] };
  assert.deepEqual(savedWorkChanges(preview), [
    `Replaces 2 saved ${asm.title} sessions with this split.`,
    `Moves ${asm.title} (9 AM–9:50 AM, Thu, Nov 5, 2026): It overlaps "Lab".`,
  ]);
});
