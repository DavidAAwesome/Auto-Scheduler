import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkspaceStore, type Requester } from '../src/services/workspaceStore.ts';
import { activeSplitOptions, calendarSessions, previewText, splitOptionSessions, splitOptionSummary, splitOptionWarnings } from '../src/utils/schedulePreview.ts';
import type { Availability, SavedSchedule, SchedulePreferences, SchedulePreview, ScheduleSession, SplitOption, SplitOptions, Task } from '../src/types/models.ts';

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
  taskId: asm.id, title: asm.title, dueAt: '2026-10-28T03:59:00Z', remainingMinutes: 60, notes: [],
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
  await workspace.requestSplitOptions(asm.id);
  const state = workspace.getSnapshot();
  assert.equal(state.schedulePreview?.previewId, 'preview-front_loaded');
  assert.deepEqual(calendarSessions(state.sessions, state.schedulePreview).map(i => [i.session.id, i.kind]), [['a', 'proposed'], ['b', 'proposed']]);
  assert.deepEqual(api.applied, []);
});

test('picking an option changes the preview, and Apply saves only that option', async () => {
  const api = backend();
  const workspace = await store(api.request);
  await workspace.requestSplitOptions(asm.id);
  workspace.chooseSplitOption('even');
  assert.deepEqual(workspace.getSnapshot().schedulePreview?.sessions.map(s => s.id), ['c', 'd']);
  await workspace.applySchedulePreview();
  assert.deepEqual(api.applied, ['preview-even']);
  assert.equal(workspace.getSnapshot().splitOptions, null);
  assert.equal(workspace.getSnapshot().schedulePreview, null);
});

test('Cancel and a rejected Apply both drop the options', async () => {
  const cancelled = await store(backend().request);
  await cancelled.requestSplitOptions(asm.id);
  cancelled.clearSchedulePreview();
  assert.equal(cancelled.getSnapshot().splitOptions, null);

  const rejected = await store(backend(true).request);
  await rejected.requestSplitOptions(asm.id);
  await assert.rejects(rejected.applySchedulePreview());
  assert.equal(rejected.getSnapshot().splitOptions, null);
});

test('options only show while one of them is the preview, so another preview replaces them', async () => {
  const workspace = await store(backend().request);
  await workspace.requestSplitOptions(asm.id);
  let state = workspace.getSnapshot();
  assert.equal(activeSplitOptions(state.splitOptions, state.schedulePreview)?.taskId, asm.id);
  await workspace.previewSchedule(7);
  state = workspace.getSnapshot();
  assert.equal(activeSplitOptions(state.splitOptions, state.schedulePreview), null);
  assert.equal(activeSplitOptions(null, null), null);
});

test('option text describes the sessions the engine returned and any side effects', () => {
  const [front, even] = split.options;
  assert.equal(splitOptionSummary(front), '2 sessions over 1 day · 10 min–50 min each');
  assert.equal(splitOptionSummary(even), '2 sessions over 2 days · 30 min each');
  assert.deepEqual(splitOptionSessions(even, asm.id).map(s => s.id), ['c', 'd']);
  assert.deepEqual(splitOptionWarnings(even), []);
  assert.deepEqual(splitOptionWarnings({ ...even, unallocatedMinutes: 90, otherNewMinutes: 50, movedSessions: 1 }), [
    '1h 30m can’t be placed before the deadline.', 'Also schedules 50 min of your other tasks.', 'Moves 1 saved session of other tasks.',
  ]);
  assert.match(previewText(even.preview), /^Proposed split, /);
});
