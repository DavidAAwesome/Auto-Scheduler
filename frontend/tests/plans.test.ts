import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceStore, type Requester } from '../src/services/workspaceStore.ts';
import type { GeneratedPlan, Availability } from '../src/types/models.ts';
import { intervalOnDate } from '../src/utils/calendar.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const availability: Availability = {
  days: Array.from({ length: 7 }, (_, day) => ({ day, enabled: true, periods: [{ start: 540, end: 1020 }] })),
  weekOverrides: [],
  timeZone: 'UTC',
  reminders: false,
};
const plan: GeneratedPlan = {
  version: 1, generatedAt: '2026-10-05T09:00:00Z', startDate: '2026-10-05', endDate: '2026-10-11', timeZone: 'UTC', source: 'provided',
  busyIntervals: [{ start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z' }],
  blocks: [{ id: 'block', taskId: 'task', title: 'Focus', type: 'focus', start: '2026-10-05T09:00:00Z', end: '2026-10-05T10:00:00Z' }], tasks: [], stale: false, staleReasons: [],
};

test('plans load, replace rather than append, preserve busy input, and survive store reload', async () => {
  let saved: GeneratedPlan | null = null;
  const request: Requester = async <T>(path: string, options?: RequestInit) => {
    if (path === '/plan/generate') {
      assert.deepEqual(JSON.parse(String(options?.body)), { busyIntervals: plan.busyIntervals, source: 'provided' });
      saved = structuredClone(plan);
    }
    return structuredClone(path === '/availability' ? availability : path === '/tasks' ? [] : saved) as T;
  };
  const store = createWorkspaceStore(request); store.setUser('a'); await tick();
  assert.equal(store.getSnapshot().plan, null);
  await store.generatePlan(plan.busyIntervals, plan.source);
  await store.generatePlan(plan.busyIntervals, plan.source);
  assert.equal(store.getSnapshot().plan?.blocks.length, 1);
  const reloaded = createWorkspaceStore(request); reloaded.setUser('a'); await tick();
  assert.deepEqual(reloaded.getSnapshot().plan, plan);
  reloaded.setUser(null);
  assert.equal(reloaded.getSnapshot().plan, null);
});

test('task edits flag a plan for review without moving blocks; failed generation retains it', async () => {
  const input = { title: 'Edited', deadline: '2026-10-06', minutes: 60, priority: 'High', category: 'Project' } as const;
  const request: Requester = async <T>(path: string, options?: RequestInit) => {
    if (path === '/plan/generate') throw new Error('Calendar unavailable');
    return structuredClone(path === '/plan' ? plan : path === '/availability' ? availability : options ? { ...input, id: 'task', done: false } : []) as T;
  };
  const store = createWorkspaceStore(request); store.setUser('a'); await tick();
  await store.updateTask('task', input);
  assert.equal(store.getSnapshot().plan?.stale, true);
  assert.deepEqual(store.getSnapshot().plan?.blocks, plan.blocks);
  await assert.rejects(store.generatePlan([], 'availability_only'), /Calendar unavailable/);
  assert.deepEqual(store.getSnapshot().plan?.blocks, plan.blocks);
  assert.equal(store.getSnapshot().saving, false);
});

test('a late generation response cannot leak a plan into another account', async () => {
  let resolve!: (value: GeneratedPlan) => void;
  const deferred = new Promise<GeneratedPlan>(done => { resolve = done; });
  const request: Requester = async <T>(path: string) => (path === '/plan/generate' ? await deferred : path === '/plan' ? null : path === '/tasks' ? [] : availability) as T;
  const store = createWorkspaceStore(request); store.setUser('a'); await tick();
  const pending = store.generatePlan([], 'availability_only');
  store.setUser('b'); resolve(plan);
  await assert.rejects(pending, /account changed/); await tick();
  assert.equal(store.getSnapshot().plan, null);
});

test('calendar clips busy intervals across local dates and exclusive midnight boundaries', () => {
  const busy = { start: '2026-01-01T04:30:00Z', end: '2026-01-01T05:30:00Z' };
  assert.equal(intervalOnDate(busy, '2025-12-31', 'America/New_York'), '23:30–24:00');
  assert.equal(intervalOnDate(busy, '2026-01-01', 'America/New_York'), '00:00–00:30');
  assert.equal(intervalOnDate(busy, '2026-01-02', 'America/New_York'), null);
  assert.equal(intervalOnDate({ ...busy, end: '2026-01-01T05:00:00Z' }, '2026-01-01', 'America/New_York'), null);
});
