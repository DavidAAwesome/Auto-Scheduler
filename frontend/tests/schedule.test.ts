import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkspaceStore, type AssistantReply, type Requester } from '../src/services/workspaceStore.ts';
import { parseRequest, requestFromIntent, runAssistantCommand } from '../src/services/assistantCommands.ts';
import { busyTimeText, calendarSessions, explainText, previewText, timeRange, todayAgenda, todayText } from '../src/utils/schedulePreview.ts';
import { zonedInstant } from '../src/utils/planning.ts';
import type { ApplyResult, Availability, CalendarEvent, SchedulePreferences, SchedulePreview, ScheduleSession, SavedSchedule, Task } from '../src/types/models.ts';

/** Real responses captured from the backend for the acceptance scenario (backend/tests/test_frontend_fixture.py keeps them in sync). */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/acceptance.json', import.meta.url), 'utf8')) as {
  tasks: Task[]; availability: Availability; preferences: SchedulePreferences; schedule: SavedSchedule; preview: SchedulePreview;
};
const NOW = new Date('2026-10-26T12:00:00Z'); // 8:00 AM America/New_York
const TODAY = '2026-10-26';
const ZONE = 'America/New_York';
const [asm, revision] = fixture.tasks;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const EXPECTED = [
  ['09:00-09:50', 'work', 'Asm'], ['09:50-10:00', 'break', 'Break'], ['10:00-10:10', 'work', 'Asm'],
  ['10:10-10:50', 'work', 'Test revision'], ['10:50-11:00', 'break', 'Break'], ['11:00-11:20', 'work', 'Test revision'],
];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const rows = (sessions: ScheduleSession[]) => sessions.map(s => [`${hhmm(s.start)}-${hhmm(s.end)}`, s.type, s.title]);

/** What the backend saves on Apply: the preview's sessions as saved rows. */
function savedFrom(preview: SchedulePreview, version: number): SavedSchedule {
  return {
    scheduleVersion: version, timeZone: preview.timeZone,
    sessions: preview.sessions.map((s, i) => ({ ...s, id: `saved-${i}`, status: 'saved', scheduleVersion: version, change: undefined, reason: null })),
  };
}

/**
 * A stand-in for the HTTP API: it serves the captured responses and keeps saved state between stores, so a
 * second store built on it behaves like a page refresh.
 */
function backend(options: { events?: CalendarEvent[]; sessions?: ScheduleSession[]; handlers?: Record<string, (body: unknown) => unknown> } = {}) {
  const log: string[] = [];
  const bodies: Record<string, unknown> = {};
  let schedule: SavedSchedule = { ...fixture.schedule, sessions: options.sessions ?? [] };
  const routes: Record<string, (body: unknown) => unknown> = {
    '/tasks': () => fixture.tasks,
    '/schedule': () => schedule,
    '/schedule/preferences': () => fixture.preferences,
    '/events': () => options.events ?? [],
    '/calendar/connections': () => [],
    '/availability': () => fixture.availability,
    '/schedule/preview': () => fixture.preview,
    '/schedule/repair': () => ({ ...fixture.preview, mode: 'repair' }),
    '/schedule/apply': () => {
      schedule = savedFrom(fixture.preview, schedule.scheduleVersion + 1);
      return { previewId: fixture.preview.previewId, status: 'applied', duplicate: false, schedule } satisfies ApplyResult;
    },
  };
  const request = (async <T>(path: string, init?: RequestInit) => {
    log.push(`${init?.method ?? 'GET'} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    bodies[path] = body;
    const handler = options.handlers?.[path] ?? routes[path];
    return structuredClone(handler ? await handler(body) : []) as T;
  }) as Requester;
  return { request, log, bodies };
}

async function store(request: Requester) {
  const s = createWorkspaceStore(request);
  s.setUser('owner');
  await tick();
  return s;
}

test('acceptance: preview, calendar, Today panel and chat all show the same six sessions', async () => {
  const api = backend();
  const workspace = await store(api.request);
  const preview = await workspace.previewSchedule(1);
  assert.deepEqual(rows(preview.sessions), EXPECTED);

  const state = workspace.getSnapshot();
  const calendar = calendarSessions(state.sessions, state.schedulePreview);
  assert.deepEqual(rows(calendar.map(i => i.session)), EXPECTED);
  assert.ok(calendar.every(i => i.kind === 'proposed'));
  assert.equal(preview.firstProposedDate, TODAY);

  const agenda = todayAgenda(state, TODAY);
  assert.deepEqual(rows(agenda.items.flatMap(i => (i.kind === 'session' ? [i.item.session] : []))), EXPECTED);
  assert.deepEqual(agenda.dueToday, [], 'deadlines are tomorrow, so they are not listed as today');

  const message = await runAssistantCommand(parseRequest('Today’s tasks', state, NOW)!, workspace, NOW);
  assert.equal(message.text, todayText(agenda, TODAY, ZONE, state.tasks));
  assert.doesNotMatch(message.text, /Nothing is scheduled/);
  let at = 0;
  for (const s of preview.sessions) {
    const index = message.text.indexOf(timeRange(s.start, s.end), at);
    assert.ok(index >= at, `chat lists ${timeRange(s.start, s.end)} in order`);
    at = index;
  }
  assert.match(message.text, /proposed/);
  assert.match(message.text, /No deadlines today\. Next due: Asm/);
});

test('acceptance: preview day summary and per-task allocation balance', () => {
  assert.deepEqual(fixture.preview.days.map(d => [d.date, d.workMinutes, d.breakCount]), [[TODAY, 120, 2]]);
  for (const t of fixture.preview.tasks) {
    assert.equal(t.retainedMinutes + t.newMinutes + t.unallocatedMinutes, t.remainingMinutes + t.overAllocatedMinutes);
    assert.equal(t.unallocatedMinutes, 0);
  }
  const text = previewText(fixture.preview);
  assert.match(text, /Not saved yet/);
  assert.match(text, /All remaining work fits/);
});

test('the Generate button and chat call the same endpoint and get the same preview', async () => {
  const button = backend();
  const buttonStore = await store(button.request);
  await buttonStore.previewSchedule(7);
  const chat = backend();
  const chatStore = await store(chat.request);
  const message = await runAssistantCommand(parseRequest('plan my week', chatStore.getSnapshot(), NOW)!, chatStore, NOW);
  assert.deepEqual(chat.log.filter(p => p.includes('/schedule/')), button.log.filter(p => p.includes('/schedule/')));
  assert.deepEqual(chat.bodies['/schedule/preview'], button.bodies['/schedule/preview']);
  assert.equal(message.text, previewText(chatStore.getSnapshot().schedulePreview!));
  assert.deepEqual(message.actions, ['apply_schedule', 'cancel_schedule']);
});

test('Apply saves, clears the preview, and the saved schedule survives a fresh store', async () => {
  const api = backend();
  const workspace = await store(api.request);
  await workspace.previewSchedule(1);
  const message = await runAssistantCommand('apply_schedule', workspace, NOW);
  assert.match(message.text, /^Saved\. Your schedule now has 4 upcoming work session\(s\) and 2 break\(s\)/);
  const state = workspace.getSnapshot();
  assert.equal(state.schedulePreview, null);
  assert.deepEqual(rows(state.sessions), EXPECTED);
  assert.ok(state.sessions.every(s => s.status === 'saved'));

  const refreshed = await store(api.request);
  assert.deepEqual(refreshed.getSnapshot().sessions, state.sessions);
  assert.equal(refreshed.getSnapshot().scheduleVersion, state.scheduleVersion);
  const today = todayText(todayAgenda(refreshed.getSnapshot(), TODAY), TODAY, ZONE, refreshed.getSnapshot().tasks);
  assert.doesNotMatch(today, /proposed/);
  assert.match(today, /Asm/);
});

test('a stale preview (409) is discarded and chat offers to regenerate', async () => {
  const api = backend({ handlers: { '/schedule/apply': () => { throw Object.assign(new Error('Your schedule changed after this preview was made. Generate a new preview.'), { status: 409 }); } } });
  const workspace = await store(api.request);
  await workspace.previewSchedule(1);
  const message = await runAssistantCommand('apply_schedule', workspace, NOW);
  assert.match(message.text, /^Not saved: Your schedule changed/);
  assert.equal(workspace.getSnapshot().schedulePreview, null);
  assert.deepEqual(workspace.getSnapshot().sessions, []);
  assert.deepEqual(message.actions, ['generate_schedule']);
});

test('a database error keeps the preview for retry and saves nothing', async () => {
  const api = backend({ handlers: { '/schedule/apply': () => { throw Object.assign(new Error('Database authentication failed.'), { status: 503 }); } } });
  const workspace = await store(api.request);
  await workspace.previewSchedule(1);
  const message = await runAssistantCommand('apply_schedule', workspace, NOW);
  assert.equal(message.text, 'Not saved: Database authentication failed.');
  assert.ok(workspace.getSnapshot().schedulePreview);
  assert.deepEqual(workspace.getSnapshot().sessions, []);
  assert.deepEqual(message.actions, ['apply_schedule', 'cancel_schedule']);
});

test('two Apply presses in flight send one save', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const api = backend({ handlers: { '/schedule/apply': async () => { await gate; return { previewId: 'p', status: 'applied', duplicate: false, schedule: savedFrom(fixture.preview, 4) }; } } });
  const workspace = await store(api.request);
  await workspace.previewSchedule(1);
  const first = runAssistantCommand('apply_schedule', workspace, NOW);
  const second = await runAssistantCommand('apply_schedule', workspace, NOW);
  release();
  await first;
  assert.equal(api.log.filter(entry => entry === 'POST /schedule/apply').length, 1);
  assert.match(second.text, /^Not saved: A change is still saving/);
});

test('a late Apply response cannot publish sessions into another account', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const api = backend({ handlers: { '/schedule/apply': async () => { await gate; return { previewId: 'p', status: 'applied', duplicate: false, schedule: savedFrom(fixture.preview, 4) }; } } });
  const workspace = await store(api.request);
  await workspace.previewSchedule(1);
  const applying = workspace.applySchedulePreview();
  workspace.setUser(null);
  release();
  await assert.rejects(applying, /account changed/);
  assert.deepEqual(workspace.getSnapshot().sessions, []);
});

test('Cancel discards the proposal and leaves saved sessions alone', async () => {
  const saved = savedFrom(fixture.preview, 3).sessions.slice(0, 1);
  const workspace = await store(backend({ sessions: saved }).request);
  await workspace.previewSchedule(1);
  const message = await runAssistantCommand('cancel_schedule', workspace, NOW);
  assert.equal(message.text, 'Proposal discarded. Nothing was changed.');
  assert.equal(workspace.getSnapshot().schedulePreview, null);
  assert.deepEqual(workspace.getSnapshot().sessions, saved);
});

test('editing a task after previewing marks the preview stale', async () => {
  const api = backend({ handlers: { [`/tasks/${asm.id}/completion`]: () => ({ ...asm, done: true }) } });
  const workspace = await store(api.request);
  await workspace.previewSchedule(1);
  assert.equal(workspace.getSnapshot().previewStale, false);
  await workspace.setCompleted(asm.id, true);
  assert.equal(workspace.getSnapshot().previewStale, true);
});

test('chat parsing: breaks, moves, repair, explanations and today map to service requests', () => {
  const state = { tasks: fixture.tasks, availability: fixture.availability };
  assert.deepEqual(parseRequest('I need a 30-minute break now', state, NOW), { command: 'request_break', minutes: 30 });
  assert.deepEqual(parseRequest('take a 15 min break', state, NOW), { command: 'request_break', minutes: 15 });
  assert.equal(parseRequest('I need a break', state, NOW)?.command, 'clarify');
  assert.equal(parseRequest('I need a 2 minute break now', state, NOW)?.command, 'clarify');
  assert.deepEqual(parseRequest('Move Asm to tomorrow', state, NOW), {
    command: 'move_task', taskId: asm.id, notBefore: zonedInstant('2026-10-27', 0, ZONE), label: 'Asm to tomorrow',
  });
  const which = parseRequest('move it to tomorrow', state, NOW);
  assert.equal(which?.command, 'clarify');
  assert.match(which && 'question' in which ? which.question : '', /Which task.*“Asm”.*“Test revision”/);
  assert.equal(parseRequest('Move Test revision', state, NOW)?.command, 'clarify', 'a move with no target asks when');
  assert.deepEqual(parseRequest('replan my schedule', state, NOW), { command: 'replan' });
  assert.deepEqual(parseRequest("What didn't fit?", state, NOW), { command: 'explain_unscheduled' });
  assert.deepEqual(parseRequest('Today’s tasks', state, NOW), { command: 'show_today' });
  assert.deepEqual(parseRequest('show my plan', state, NOW), { command: 'show_plan' });
  assert.deepEqual(parseRequest('Busy time', state, NOW), { command: 'busy_time' });
  assert.deepEqual(parseRequest('plan my week', state, NOW), { command: 'generate_schedule' });
  assert.equal(parseRequest('hello there', state, NOW), null);
});

test('model intents are validated before anything runs', () => {
  const answer = (intent: AssistantReply['intent'], params: Partial<AssistantReply['params']> = {}): AssistantReply =>
    ({ reply: 'Which one?', intent, params: { breakMinutes: null, taskId: null, notBefore: null, ...params }, provider: 'openai' });
  const state = { tasks: fixture.tasks };
  assert.equal(requestFromIntent(answer('none'), state), null);
  assert.deepEqual(requestFromIntent(answer('show_today'), state), { command: 'show_today' });
  assert.deepEqual(requestFromIntent(answer('request_break', { breakMinutes: 30 }), state), { command: 'request_break', minutes: 30 });
  assert.equal(requestFromIntent(answer('request_break'), state)?.command, 'clarify');
  assert.equal(requestFromIntent(answer('move_task', { taskId: 'not-a-task', notBefore: '2026-10-27T04:00:00Z' }), state)?.command, 'clarify');
  assert.equal(requestFromIntent(answer('move_task', { taskId: revision.id }), state)?.command, 'clarify');
  assert.deepEqual(requestFromIntent(answer('move_task', { taskId: revision.id, notBefore: '2026-10-27T04:00:00Z' }), state),
    { command: 'move_task', taskId: revision.id, notBefore: '2026-10-27T04:00:00Z', label: 'Test revision' });
  assert.deepEqual(requestFromIntent(answer('clarify'), state), { command: 'clarify', question: 'Which one?' });
});

test('a break request asks the service for a protected break and reports only what it returned', async () => {
  const brk: ScheduleSession = { ...fixture.preview.sessions[1], id: 'proposed-b', locked: true, start: 480, end: 510, startAt: '2026-10-26T12:00:00Z', endAt: '2026-10-26T12:30:00Z' };
  const breakPreview: SchedulePreview = { ...fixture.preview, mode: 'break', sessions: [brk, ...fixture.preview.sessions] };
  const api = backend({ handlers: { '/schedule/break': () => breakPreview } });
  const workspace = await store(api.request);
  const message = await runAssistantCommand(parseRequest('I need a 30-minute break now', workspace.getSnapshot(), NOW)!, workspace, NOW);
  assert.deepEqual(api.bodies['/schedule/break'], { minutes: 30 });
  assert.match(message.text, /^Proposed protected break 8 AM–8:30 AM\./);
  assert.match(message.text, /Not saved yet/);
  assert.deepEqual(message.actions, ['apply_schedule', 'cancel_schedule']);

  const refused: SchedulePreview = { ...fixture.preview, mode: 'break', sessions: [], conflicts: [{ code: 'break_conflict', message: 'Team meeting is fixed from 8 AM to 9 AM, so a break can’t start now.', items: [] }] };
  const blocked = await store(backend({ handlers: { '/schedule/break': () => refused } }).request);
  const reply = await runAssistantCommand({ command: 'request_break', minutes: 30 }, blocked, NOW);
  assert.match(reply.text, /^No break was added: Team meeting is fixed/);
  assert.doesNotMatch(reply.text, /Proposed protected break/);
});

test('a move request sends the task and earliest start to repair', async () => {
  const api = backend();
  const workspace = await store(api.request);
  const request = parseRequest('Move Asm to tomorrow', workspace.getSnapshot(), NOW)!;
  const message = await runAssistantCommand(request, workspace, NOW);
  assert.deepEqual(api.bodies['/schedule/repair'], { horizonDays: 7, moves: [{ taskId: asm.id, notBefore: zonedInstant('2026-10-27', 0, ZONE) }] });
  assert.match(message.text, /^Moving Asm to tomorrow\./);
});

test('a failed preview never reports a proposal or a save', async () => {
  const workspace = await store(backend({ handlers: { '/schedule/preview': () => { throw new Error('No availability is set.'); } } }).request);
  const message = await runAssistantCommand('generate_schedule', workspace, NOW);
  assert.match(message.text, /^I couldn’t build a preview: No availability is set\. Nothing was changed or saved\./);
  assert.equal(workspace.getSnapshot().schedulePreview, null);
});

test('explaining unscheduled work uses the preview’s reasons and the heuristic note', () => {
  const short: SchedulePreview = {
    ...fixture.preview,
    tasks: fixture.preview.tasks.map((t, i) => i ? { ...t, newMinutes: 30, unallocatedMinutes: 30, status: 'partial', reasons: [{ code: 'daily_limit', message: 'The 4h daily work limit is reached on the days before its deadline.' }] } : t),
  };
  const text = explainText(short, fixture.tasks, [], NOW);
  assert.match(text, /Test revision: 30 min not placed\. The 4h daily work limit/);
  assert.match(text, /not proof that no schedule exists/);
  assert.match(explainText(fixture.preview, fixture.tasks, [], NOW), /Nothing is unscheduled/);
});

test('busy time lists events and saved sessions, labelled apart', async () => {
  const meeting: CalendarEvent = { id: 'e1', title: 'Standup', kind: 'Meeting', date: TODAY, start: 13 * 60, end: 13 * 60 + 30, location: null, repeat: null, skipDates: [], source: 'google' };
  const saved = savedFrom(fixture.preview, 3).sessions;
  const workspace = await store(backend({ events: [meeting], sessions: saved }).request);
  const state = workspace.getSnapshot();
  const message = await runAssistantCommand('busy_time', workspace, NOW);
  assert.match(message.text, /Standup, fixed event \(meeting\) · from Google Calendar/);
  assert.match(message.text, /Asm, planned work, saved by the scheduler/);
  assert.match(message.text, /Break, saved break/);
  assert.equal(message.text, busyTimeText(state.events, state.sessions, state.tasks, TODAY, 7, false));
});
