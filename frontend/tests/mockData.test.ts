import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDemoStore,
  selectTasks,
  STORAGE_KEY,
} from "../src/services/mockData.ts";
import { createSampleData } from "../src/data/sampleData.ts";
import type { TaskInput } from "../src/types/models.ts";
const input: TaskInput = {
  title: "  New task  ",
  deadline: "2026-10-01",
  minutes: 60,
  priority: "High",
  category: "Project",
};
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
test("first load seeds once and subsequent loads preserve task IDs and original dates", () => {
  const storage = memory();
  const first = createDemoStore(storage, createSampleData("2026-09-25"));
  const second = createDemoStore(storage, createSampleData("2026-10-01"));
  assert.deepEqual(second.getSnapshot(), first.getSnapshot());
});
test("CRUD and completion persist and notify subscribers; editing preserves completion", () => {
  const storage = memory();
  const store = createDemoStore(storage);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  const added = store.createTask(input);
  assert.equal(added.title, "New task");
  store.setCompleted(added.id, true);
  store.updateTask(added.id, { ...input, title: "Edited" });
  let restored = createDemoStore(storage);
  assert.equal(
    restored.getSnapshot().tasks.find((t) => t.id === added.id)?.done,
    true,
  );
  assert.equal(
    restored.getSnapshot().tasks.find((t) => t.id === added.id)?.title,
    "Edited",
  );
  store.deleteTask(added.id);
  restored = createDemoStore(storage);
  assert.equal(
    restored.getSnapshot().tasks.some((t) => t.id === added.id),
    false,
  );
  assert.equal(notifications, 4);
  unsubscribe();
});
test("search is case-insensitive, title-only, and combines with status", () => {
  const tasks = createSampleData().tasks;
  tasks[0].done = true;
  assert.equal(selectTasks(tasks, "SECURITY", "done").length, 1);
  assert.equal(selectTasks(tasks, "security", "open").length, 0);
  assert.equal(selectTasks(tasks, "Study").length, 0);
  assert.equal(selectTasks(tasks, "", "all").length, 4);
});
test("deleting every task stays empty after reload", () => {
  const storage = memory();
  const store = createDemoStore(storage);
  for (const task of [...store.getSnapshot().tasks]) store.deleteTask(task.id);
  assert.deepEqual(createDemoStore(storage).getSnapshot().tasks, []);
});
test("invalid input does not change persisted state", () => {
  const storage = memory();
  const store = createDemoStore(storage);
  const before = storage.getItem(STORAGE_KEY);
  for (const bad of [
    { ...input, title: " " },
    { ...input, minutes: 17 },
    { ...input, deadline: "2026-02-30" },
    { ...input, minutes: 735 },
  ])
    assert.throws(() => store.createTask(bad));
  assert.equal(storage.getItem(STORAGE_KEY), before);
});
test("write failure retains current state and raises an actionable error", () => {
  const storage = memory();
  const store = createDemoStore(storage);
  const before = store.getSnapshot();
  storage.setItem = () => {
    throw new Error("quota");
  };
  assert.throws(() => store.createTask(input), /Could not save/);
  assert.equal(store.getSnapshot(), before);
});
test("corrupt storage recovers visibly; successful save clears notice", () => {
  const storage = memory();
  storage.setItem(STORAGE_KEY, "broken");
  const store = createDemoStore(storage);
  assert.match(store.getLoadNotice(), /could not/);
  store.createTask(input);
  assert.equal(store.getLoadNotice(), "");
  assert.equal(createDemoStore(storage).getSnapshot().tasks.length, 5);
});
test("reload sees changes from another store", () => {
  const storage = memory();
  const first = createDemoStore(storage);
  const second = createDemoStore(storage);
  const task = first.createTask(input);
  second.reload();
  assert.ok(second.getSnapshot().tasks.some((t) => t.id === task.id));
});
test("deleting or completing a task removes linked scheduled blocks", () => {
  const seed = createSampleData();
  seed.scheduledBlocks = [
    {
      id: "block",
      taskId: seed.tasks[0].id,
      title: "Focus",
      date: "2026-10-01",
      start: 540,
      end: 600,
      type: "focus",
    },
  ];
  for (const action of ["complete", "delete"]) {
    const store = createDemoStore(memory(), seed);
    if (action === "delete") store.deleteTask(seed.tasks[0].id);
    else store.setCompleted(seed.tasks[0].id, true);
    assert.equal(store.getSnapshot().scheduledBlocks.length, 0);
  }
});
