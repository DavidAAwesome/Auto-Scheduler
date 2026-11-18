import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { derivedBreaks, isDerivedBreak, type BreakContext } from '../src/utils/breaks.ts';
import { calendarSessions, todayAgenda } from '../src/utils/schedulePreview.ts';
import { parseRequest, requestFromIntent, runAssistantCommand, type CommandWorkspace } from '../src/services/assistantCommands.ts';
import { BUTTONS } from '../src/services/pendingActions.ts';
import { createWorkspaceStore, type AssistantReply, type Requester } from '../src/services/workspaceStore.ts';
import { DEFAULT_PREFERENCES, type CalendarEvent, type PendingAction, type SchedulePreview, type ScheduleSession, type Task } from '../src/types/models.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/acceptance.json', import.meta.url), 'utf8')) as { tasks: Task[]; preview: SchedulePreview; availability: never };
const DAY = '2026-11-05';
const iso = (minute: number, date = DAY) => new Date(Date.parse(`${date}T00:00:00Z`) + minute * 60_000).toISOString();

function work(id: string, start: number, end: number, overrides: Partial<ScheduleSession> = {}): ScheduleSession {
  return { id, taskId: 't', title: 'Essay', type: 'work', status: 'saved', locked: false, source: 'auto', scheduleVersion: 1,
    startAt: iso(start), endAt: iso(end), date: DAY, start, end, ...overrides };
}
const context = (extra: Partial<BreakContext> = {}): BreakContext => ({
  preferences: DEFAULT_PREFERENCES, events: [], tasks: [{ id: 't', done: false, kind: 'task' }, { id: 'o', done: false, kind: 'task' }], ...extra,
});
const spans = (sessions: ScheduleSession[], ctx = context()) => derivedBreaks(sessions, ctx).map(s => [s.start, s.end]);
const event = (start: number, end: number) => ({ id: 'e', title: 'Class', kind: 'Class', date: DAY, start, end, location: null, repeat: null, skipDates: [], source: 'manual' }) as CalendarEvent;

test('a break is drawn between work sessions over the focus limit', () => {
  assert.deepEqual(spans([work('a', 540, 590), work('b', 600, 650)]), [[590, 600]]);
  assert.deepEqual(spans([work('a', 540, 590), work('b', 600, 650), work('c', 660, 710)]), [[590, 600], [650, 660]]);
});

test('the derived breaks match the ones the engine proposes', () => {
  const planned = fixture.preview.sessions;
  const saved = planned.filter(s => s.type === 'work').map(s => ({ ...s, status: 'saved' as const, change: null }));
  const tasks = fixture.tasks.map(t => ({ id: t.id, done: false, kind: t.kind }));
  assert.deepEqual(derivedBreaks(saved, context({ tasks })).map(s => [s.startAt, s.endAt].map(x => Date.parse(x))),
    planned.filter(s => s.type === 'break').map(s => [s.startAt, s.endAt].map(x => Date.parse(x))));
});

test('no break without work on both sides, or when the work fits the focus limit', () => {
  assert.deepEqual(spans([]), []);
  assert.deepEqual(spans([work('a', 540, 590)]), []);
  assert.deepEqual(spans([work('a', 540, 560), work('b', 570, 590)]), []);
  assert.deepEqual(spans([work('a', 540, 590), work('b', 600, 650, { date: '2026-11-06' })]), []);
});

test('breaks follow the work: deleted tasks, finished tasks and cancelled sessions leave none behind', () => {
  const sessions = [work('a', 540, 590), work('b', 600, 650)];
  assert.deepEqual(spans(sessions, context({ tasks: [] })), [], 'task deleted');
  assert.deepEqual(spans(sessions, context({ tasks: [{ id: 't', done: true, kind: 'task' }] })), [], 'task completed');
  assert.deepEqual(spans([sessions[0]]), [], 'session deleted');
  assert.deepEqual(spans([sessions[0], { ...sessions[1], status: 'cancelled' }]), [], 'session cancelled');
  assert.deepEqual(spans([work('a', 540, 590), work('b', 720, 770)]), [[590, 600]], 'rescheduled: the break moves with the work');
});

test('events, lunch and protected breaks shape the break', () => {
  const sessions = [work('a', 540, 590), work('b', 660, 710)];
  assert.deepEqual(spans(sessions, context({ events: [event(590, 620)] })), [[620, 630]], 'an event in the gap is not rest');
  const lunch = { ...DEFAULT_PREFERENCES, lunch: { start: 600, end: 630 } };
  assert.deepEqual(spans(sessions, context({ preferences: lunch })), [], 'lunch already gives the rest');
  const protectedBreak = work('p', 600, 620, { type: 'break', taskId: null, locked: true, source: 'manual' });
  assert.deepEqual(spans([...sessions, protectedBreak]), [], 'a break you asked for already gives the rest');
});

test('the calendar and Today show derived breaks, which have no saved card', () => {
  const sessions = [work('a', 540, 590), work('b', 600, 650)];
  const items = calendarSessions(sessions, null, context());
  assert.deepEqual(items.map(i => i.session.type), ['work', 'break', 'work']);
  assert.ok(isDerivedBreak(items[1].session) && !isDerivedBreak(sessions[0]));
  assert.equal(items[1].kind, 'saved');
  const tasks = [{ ...fixture.tasks[0], id: 't' }];
  const agenda = todayAgenda({ sessions, events: [], tasks, schedulePreview: null }, DAY);
  assert.equal(agenda.items.length, 3);
  assert.equal(todayAgenda({ sessions, events: [], tasks: [], schedulePreview: null }, DAY).items.filter(i => i.kind === 'session' && i.item.session.type === 'break').length, 0);
});

test('a preview draws its own breaks once, as proposals', () => {
  const planned = { ...fixture.preview, sessions: [work('p1', 540, 590, { status: 'proposed', change: 'new' }),
    work('pb', 590, 600, { type: 'break', taskId: null, status: 'proposed', change: 'derived' }),
    work('p2', 600, 650, { status: 'proposed', change: 'new' })], removed: [] };
  assert.deepEqual(calendarSessions([], planned, context()).map(i => [i.session.id, i.kind]), [['p1', 'proposed'], ['pb', 'proposed'], ['p2', 'proposed']]);
});

// ------------------------------------------------------------------ chat

const state = { tasks: [], availability: null };

test('chat: asking to remove breaks is a break deletion, not a task one', () => {
  for (const text of ['delete breaks', 'Delete all my breaks', 'remove the breaks', 'clear my breaks', 'cancel my break', 'get rid of these breaks']) {
    assert.deepEqual(parseRequest(text, state), { command: 'delete_breaks' }, text);
  }
  assert.equal(parseRequest('I need a 15-minute break now', state)?.command, 'request_break');
  const answer = { reply: 'x', intent: 'delete_breaks', params: {}, provider: 'openai' } as unknown as AssistantReply;
  assert.deepEqual(requestFromIntent(answer, state, 'get these breaks off my calendar'), { command: 'delete_breaks' });
});

const action = (count: number) => ({ id: 'a1', type: 'delete_breaks', status: 'awaiting_confirmation', version: 3, summary: `Delete ${count} saved breaks?`,
  targets: Array.from({ length: count }, (_, i) => ({ id: `b${i}`, title: 'Break', detail: null })), sessionCount: count, error: null, createdAt: '' }) as PendingAction;

test('chat: saved breaks need confirmation, and the button says how many', async () => {
  const brk = work('b0', 600, 615, { type: 'break', taskId: null, locked: true, source: 'manual' });
  let proposed = 0;
  const workspace = { getSnapshot: () => ({ availability: null, sessions: [brk] }), proposeDeleteBreaks: async () => { proposed++; return action(2); } } as unknown as CommandWorkspace;
  const message = await runAssistantCommand({ command: 'delete_breaks' }, workspace);
  assert.equal(proposed, 1);
  assert.equal(message.actionId, 'a1');
  assert.match(message.text, /Nothing is deleted until you confirm/);
  assert.equal(BUTTONS.delete_breaks.confirm(action(2)), 'Delete 2 breaks');
  assert.equal(BUTTONS.delete_breaks.confirm(action(1)), 'Delete break');
});

test('chat: with no saved breaks it explains the automatic ones and proposes nothing', async () => {
  const workspace = { getSnapshot: () => ({ availability: null, sessions: [work('a', 540, 590)] }), proposeDeleteBreaks: async () => { throw new Error('not called'); } } as unknown as CommandWorkspace;
  const message = await runAssistantCommand({ command: 'delete_breaks' }, workspace);
  assert.match(message.text, /no saved breaks to delete/);
  assert.equal(message.actionId, undefined);
  assert.doesNotMatch(message.text, /open tasks/);
});

test('confirming removes the breaks from the calendar without a reload', async () => {
  const brk = work('b0', 600, 615, { type: 'break', taskId: null, locked: true, source: 'manual' });
  const keep = work('a', 540, 590);
  const request = (async <T>(path: string) => {
    const routes: Record<string, unknown> = {
      '/tasks': [], '/schedule': { scheduleVersion: 3, timeZone: 'UTC', sessions: [keep, brk] }, '/schedule/preferences': DEFAULT_PREFERENCES,
      '/availability': fixture.availability, '/actions/delete-breaks': action(1),
      '/actions/a1/confirm': { action: { ...action(1), status: 'succeeded' }, duplicate: false, deletedTaskIds: [], deletedSessionIds: ['b0'], tasks: [], events: [], scheduleVersion: 4 },
    };
    return structuredClone(routes[path] ?? []) as T;
  }) as Requester;
  const workspace = createWorkspaceStore(request);
  workspace.setUser('owner');
  await new Promise(resolve => setImmediate(resolve));
  await workspace.proposeDeleteBreaks();
  await workspace.confirmAction('a1');
  assert.deepEqual(workspace.getSnapshot().sessions.map(s => s.id), ['a']);
  assert.equal(workspace.getSnapshot().scheduleVersion, 4);
});
