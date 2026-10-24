import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceStore, type Requester } from '../src/services/workspaceStore.ts';
import { commandFor, runAssistantCommand } from '../src/services/assistantCommands.ts';
import { busyTimeText, previewText, timeRange } from '../src/utils/schedulePreview.ts';
import type { Availability, CalendarEvent, SchedulePreviewPayload, Task, WorkSession } from '../src/types/models.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const NOW = new Date('2026-10-05T12:00:00Z');
const availability: Availability = { days: Array.from({ length: 7 }, (_, day) => ({ day, enabled: true, periods: [{ start: 540, end: 1020 }] })), weekOverrides: [], timeZone: 'UTC', reminders: false };

const task: Task = {
  id: 't1', title: 'Essay', deadline: '2026-10-06', minutes: 120, remainingMinutes: 120, dueTime: 1439, priority: 'High', category: 'Study',
  done: false, earliestStart: null, allowSplit: true, minSessionMinutes: 60, maxSessionMinutes: 60, dependsOn: [],
};
const dinner: CalendarEvent = { id: 'e1', title: 'Dinner', kind: 'Other', date: '2026-10-05', start: 19 * 60, end: 20 * 60, location: 'Home', repeat: null, skipDates: [], source: 'manual' };
const classEvent: CalendarEvent = { id: 'e2', title: 'Biology', kind: 'Class', date: '2026-10-05', start: 9 * 60, end: 10 * 60, location: null, repeat: { weekdays: [0, 2], until: '2026-10-31' }, skipDates: [], source: 'google' };

const schedule: SchedulePreviewPayload = {
  version: 1, generatedAt: '2026-10-05T12:00:00Z', startDate: '2026-10-05', endDate: '2026-10-11', timeZone: 'UTC',
  sessions: [
    { taskId: 't1', title: 'Essay', date: '2026-10-05', start: 18 * 60, end: 19 * 60, source: 'auto', locked: false, kept: false },
    { taskId: 't1', title: 'Essay', date: '2026-10-06', start: 9 * 60, end: 10 * 60, source: 'auto', locked: false, kept: false },
  ],
  tasks: [{ taskId: 't1', title: 'Essay', remainingMinutes: 120, scheduledMinutes: 120, unscheduledMinutes: 0, status: 'scheduled', reason: 'scheduled', message: 'All covered.' }],
  explanations: [], inputFingerprint: 'fingerprint',
};

/** A fake API: records every request and answers from fixtures, with per-path overrides. */
function api(options: { sessions?: WorkSession[]; events?: CalendarEvent[]; handlers?: Record<string, () => unknown>; log?: string[] } = {}): Requester {
  const log = options.log ?? [];
  const defaults: Record<string, () => unknown> = {
    '/tasks': () => [task],
    '/sessions': () => options.sessions ?? [],
    '/events': () => options.events ?? [],
    '/calendar/connections': () => [],
    '/availability': () => availability,
    '/plan': () => null,
    '/schedule/preview': () => ({ previewId: 'preview', status: 'pending', schedule }),
  };
  return (async <T>(path: string, init?: RequestInit) => {
    log.push(`${init?.method ?? 'GET'} ${path}`);
    const handler = options.handlers?.[path] ?? defaults[path];
    return structuredClone(handler ? await handler() : []) as T;
  }) as Requester;
}

async function loaded(requester: Requester) {
  const store = createWorkspaceStore(requester);
  store.setUser('owner');
  await tick();
  return store;
}

test('deterministic routing sends schedule and busy-time requests to commands, not to free-text chat', () => {
  assert.equal(commandFor('plan my week'), 'generate_schedule');
  assert.equal(commandFor('Generate plan'), 'generate_schedule');
  assert.equal(commandFor('Schedule my essay around dinner'), 'generate_schedule');
  assert.equal(commandFor('show my plan'), 'show_plan');
  assert.equal(commandFor("What didn't fit?"), 'show_plan');
  assert.equal(commandFor('Busy time'), 'busy_time');
  assert.equal(commandFor('what is on my calendar Monday'), 'busy_time');
  assert.equal(commandFor('Today’s tasks'), null);
});

test('the Generate Schedule button and chat use the same service and produce the same preview', async () => {
  const buttonLog: string[] = [];
  const buttonStore = await loaded(api({ log: buttonLog }));
  await buttonStore.previewSchedule(7);

  const chatLog: string[] = [];
  const chatStore = await loaded(api({ log: chatLog }));
  const message = await runAssistantCommand('generate_schedule', chatStore, NOW);

  assert.deepEqual(chatLog.filter(p => p.includes('/schedule/')), buttonLog.filter(p => p.includes('/schedule/')));
  assert.deepEqual(chatStore.getSnapshot().schedulePreview, buttonStore.getSnapshot().schedulePreview);
  assert.equal(message.text, previewText(schedule));
  assert.deepEqual(message.actions, ['apply_schedule', 'cancel_schedule']);
});

test('a failed generation never reports a proposal or a save', async () => {
  const store = await loaded(api({ handlers: { '/schedule/preview': () => { throw new Error('MongoDB rejected the saved document'); } } }));
  const message = await runAssistantCommand('generate_schedule', store, NOW);
  assert.match(message.text, /couldn’t build a schedule: MongoDB rejected/);
  assert.match(message.text, /Nothing was saved/);
  assert.doesNotMatch(message.text, /Proposed schedule|Saved|session\(s\) to your calendar/);
  assert.equal(store.getSnapshot().schedulePreview, null);
  assert.deepEqual(store.getSnapshot().sessions, []);
});

test('busy time lists existing calendar events and saved sessions, labelled apart', async () => {
  const session: WorkSession = { id: 's1', taskId: 't1', date: '2026-10-05', start: 14 * 60, end: 15 * 60, source: 'manual', locked: false };
  const store = await loaded(api({ events: [dinner, classEvent], sessions: [session] }));
  const state = store.getSnapshot();
  const message = await runAssistantCommand('busy_time', store, NOW);

  assert.match(message.text, /• 9 AM–10 AM Biology, fixed event \(class\) · from Google Calendar/);
  assert.match(message.text, /• 7 PM–8 PM Dinner, fixed event \(other\) at Home/);
  assert.match(message.text, /• 2 PM–3 PM Essay, planned work, placed by you/);
  assert.equal(message.text, busyTimeText(state.events, state.sessions, state.tasks, '2026-10-05', 7, false));
});

test('busy time with nothing stored says so without asking for more information', () => {
  const text = busyTimeText([], [], [], '2026-10-05', 7, false);
  assert.match(text, /Nothing is busy/);
  assert.doesNotMatch(text, /\?/);
});

test('show my plan reports a missing schedule and offers Generate', async () => {
  const store = await loaded(api());
  const message = await runAssistantCommand('show_plan', store, NOW);
  assert.match(message.text, /no proposed schedule and no saved work sessions/);
  assert.deepEqual(message.actions, ['generate_schedule']);
});

test('show my plan shows the pending preview before anything saved', async () => {
  const store = await loaded(api());
  await store.previewSchedule(7);
  const message = await runAssistantCommand('show_plan', store, NOW);
  assert.equal(message.text, previewText(schedule));
});

test('preview text lists every session the calendar draws and the reasons for unplaced minutes', () => {
  const partial: SchedulePreviewPayload = {
    ...schedule,
    tasks: [{ taskId: 't1', title: 'Essay', remainingMinutes: 120, scheduledMinutes: 60, unscheduledMinutes: 60, status: 'partial', reason: 'no_contiguous_slot', message: '' }],
  };
  const text = previewText(partial);
  for (const session of partial.sessions) assert.match(text, new RegExp(`${timeRange(session.start, session.end).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · ${session.title}`));
  assert.match(text, /Essay: 60 min unscheduled, because no single free block is long enough/);
  assert.match(text, /Not saved yet/);
});

test('Apply saves the preview, updates shared state, and reports the saved count', async () => {
  const store = await loaded(api({ handlers: { '/schedule/apply': () => ({ previewId: 'preview', status: 'applied', sessions: [{ id: 'new1', taskId: 't1', date: '2026-10-05', start: 1080, end: 1140, source: 'auto', locked: false }] }) } }));
  await store.previewSchedule(7);
  const message = await runAssistantCommand('apply_schedule', store, NOW);
  assert.match(message.text, /^Saved 1 session\(s\) to your calendar/);
  assert.equal(store.getSnapshot().schedulePreview, null);
  assert.deepEqual(store.getSnapshot().sessions.map(s => s.id), ['new1']);
});

test('a database error on Apply is shown accurately and keeps the proposal for retry', async () => {
  const store = await loaded(api({ handlers: { '/schedule/apply': () => { throw new Error('Database authentication failed. Reference abc123.'); } } }));
  await store.previewSchedule(7);
  const message = await runAssistantCommand('apply_schedule', store, NOW);
  assert.equal(message.text, 'Not saved: Database authentication failed. Reference abc123.');
  assert.ok(store.getSnapshot().schedulePreview, 'proposal stays so the user can retry or cancel');
  assert.deepEqual(message.actions, ['apply_schedule', 'cancel_schedule']);
});

test('a stale preview (409) is discarded so the user regenerates instead of retrying', async () => {
  const store = await loaded(api({ handlers: { '/schedule/apply': () => { throw Object.assign(new Error('This preview is stale.'), { status: 409 }); } } }));
  await store.previewSchedule(7);
  const message = await runAssistantCommand('apply_schedule', store, NOW);
  assert.match(message.text, /^Not saved: This preview is stale/);
  assert.equal(store.getSnapshot().schedulePreview, null);
  assert.deepEqual(message.actions, ['generate_schedule']);
});

test('two Apply requests in flight send one save', async () => {
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store = await loaded(api({ log, handlers: { '/schedule/apply': async () => { await gate; return { previewId: 'preview', status: 'applied', sessions: [] }; } } }));
  await store.previewSchedule(7);
  const first = runAssistantCommand('apply_schedule', store, NOW);
  const second = await runAssistantCommand('apply_schedule', store, NOW);
  release();
  await first;
  assert.equal(log.filter(entry => entry === 'POST /schedule/apply').length, 1);
  assert.match(second.text, /^Not saved: A change is still saving/);
});

test('Cancel discards the proposal without touching saved sessions', async () => {
  const session: WorkSession = { id: 's1', taskId: 't1', date: '2026-10-05', start: 840, end: 900, source: 'manual', locked: false };
  const store = await loaded(api({ sessions: [session] }));
  await store.previewSchedule(7);
  const message = await runAssistantCommand('cancel_schedule', store, NOW);
  assert.equal(message.text, 'Proposed schedule discarded. Nothing was changed.');
  assert.equal(store.getSnapshot().schedulePreview, null);
  assert.deepEqual(store.getSnapshot().sessions.map(s => s.id), ['s1']);
});
