import { test } from 'node:test';
import assert from 'node:assert/strict';

test('account switches isolate tasks and restore each account’s saved workspace', async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  const { mockDataService: store, setWorkspaceUser } = await import('../src/services/mockData.ts');
  setWorkspaceUser('alice-test');
  const task = store.createTask({ title: 'Alice private demo task', deadline: '2026-10-10', minutes: 30, priority: 'High', category: 'Study' });
  setWorkspaceUser('bob-test');
  assert.equal(store.getSnapshot().tasks.some(t => t.id === task.id), false);
  setWorkspaceUser(null);
  assert.equal(store.getSnapshot().tasks.some(t => t.id === task.id), false);
  setWorkspaceUser('alice-test');
  assert.equal(store.getSnapshot().tasks.find(t => t.id === task.id)?.title, 'Alice private demo task');
  assert.equal(values.size, 2);
  setWorkspaceUser(null);
  Reflect.deleteProperty(globalThis, 'localStorage');
});
