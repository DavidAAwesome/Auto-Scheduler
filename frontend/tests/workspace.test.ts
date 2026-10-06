import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceStore, type Requester } from '../src/services/workspaceStore.ts';
import type { Availability, TaskInput, Task } from '../src/types/models.ts';
import { dateInZone, weekStart } from '../src/utils/calendar.ts';
const availability: Availability = { days: Array.from({ length: 7 }, (_, day) => ({ day, enabled: false, start: 540, end: 1020 })), timeZone: 'UTC', reminders: false };
const input: TaskInput = { title: 'Test task', deadline: '2026-10-09', minutes: 60, priority: 'High', category: 'Project' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('API-backed tasks, completion and availability survive a fresh store', async () => {
  let tasks: Task[] = [];
  let saved = structuredClone(availability);
  const request: Requester = async <T>(path: string, options?: RequestInit): Promise<T> => {
    const data = options?.body ? JSON.parse(String(options.body)) : null;
    let result: unknown;
    if (path === '/plan') result = null;
    else if (path === '/availability') { if (data) saved = data; result = saved; }
    else if (!options) result = tasks;
    else if (options.method === 'POST') { const task = { ...data, id: 'server-id', done: false }; tasks = [...tasks, task]; result = task; }
    else if (options.method === 'DELETE') tasks = [];
    else { tasks = [{ ...tasks[0], ...data }]; result = tasks[0]; }
    return structuredClone(result) as T;
  };
  const store = createWorkspaceStore(request);
  store.setUser('a'); await tick();
  assert.equal(store.getSnapshot().status, 'ready');
  const task = await store.createTask(input);
  await store.updateTask(task.id, { ...input, title: 'Edited' });
  await store.setCompleted(task.id, true);
  await store.saveAvailability({ ...availability, timeZone: 'America/New_York', reminders: true });
  const reloaded = createWorkspaceStore(request);
  reloaded.setUser('a'); await tick();
  assert.equal(reloaded.getSnapshot().tasks[0].title, 'Edited');
  assert.equal(reloaded.getSnapshot().tasks[0].done, true);
  assert.equal(reloaded.getSnapshot().availability?.timeZone, 'America/New_York');
  await reloaded.deleteTask(task.id);
  assert.deepEqual(reloaded.getSnapshot().tasks, []);
});

test('failed writes preserve confirmed data and expose failures; failed loads can retry', async () => {
  let fail = true;
  const request: Requester = async <T>(path: string, options?: RequestInit) => {
    if (fail || options) throw new Error('Database unavailable');
    return (path === '/tasks' ? [] : path === '/plan' ? null : availability) as T;
  };
  const store = createWorkspaceStore(request);
  store.setUser('a'); await tick();
  assert.equal(store.getSnapshot().status, 'error');
  fail = false; await store.load();
  await assert.rejects(store.createTask(input), /Database unavailable/);
  assert.deepEqual(store.getSnapshot().tasks, []);
  assert.equal(store.getSnapshot().saving, false);
});

test('late responses cannot restore another account’s tasks after logout', async () => {
  let resolveTasks!: (value: Task[]) => void;
  const deferred = new Promise<Task[]>(resolve => { resolveTasks = resolve; });
  const request: Requester = async <T>(path: string) => (path === '/tasks' ? await deferred : path === '/plan' ? null : availability) as T;
  const store = createWorkspaceStore(request);
  store.setUser('a');
  store.setUser(null);
  resolveTasks([{ ...input, id: 'private', done: false }]); await tick();
  assert.equal(store.getSnapshot().status, 'idle');
  assert.deepEqual(store.getSnapshot().tasks, []);
  assert.equal(store.getSnapshot().availability, null);
});

test('calendar uses saved timezone and Monday-based weeks across DST and year boundaries', () => {
  assert.equal(dateInZone('America/New_York', new Date('2026-01-01T02:00:00Z')), '2025-12-31');
  assert.equal(weekStart('2026-01-01'), '2025-12-29');
  assert.equal(weekStart('2026-03-08'), '2026-03-02');
});
