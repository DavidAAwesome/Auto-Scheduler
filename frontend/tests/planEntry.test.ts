import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkspaceStore, mergeDrafts, type Requester } from '../src/services/workspaceStore.ts';
import { parseRequest, runAssistantCommand } from '../src/services/assistantCommands.ts';
import { draftsReply, emptyDraft, firstOpenQuestion, looksLikePlanEntry } from '../src/services/planEntry.ts';
import { calendarSessions, previewText, todayAgenda, todayText } from '../src/utils/schedulePreview.ts';
import type {
  ApplyResult, Availability, CalendarEvent, DraftView, FeasibilityResult, InterpretResult, SchedulePreferences, SchedulePreview,
  SavedSchedule, Task,
} from '../src/types/models.ts';

/**
 * Real responses for the bulk-message demo (backend/tests/test_frontend_fixture.py keeps them in sync):
 * "Lab report 90 min due tomorrow high priority / Advisor meeting today 11-11:30am / Gym 30 min sometime today, low priority",
 * read by the built-in parser, checked, and previewed for one day.
 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/plan.json', import.meta.url), 'utf8')) as {
  tasks: Task[]; availability: Availability; preferences: SchedulePreferences; schedule: SavedSchedule;
  interpret: InterpretResult; review: DraftView[]; feasibility: FeasibilityResult; preview: SchedulePreview;
};
const NOW = new Date('2026-10-26T12:00:00Z'); // 8:00 AM America/New_York
const TODAY = '2026-10-26';
const ZONE = 'America/New_York';
const BULK = 'Lab report 90 min due tomorrow high priority\nAdvisor meeting today 11-11:30am\nGym 30 min sometime today, low priority';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Stand-in for the API that keeps saved state, so a second store on it behaves like a refresh. */
function backend(options: { fail?: Record<string, number> } = {}) {
  const log: string[] = [];
  let tasks: Task[] = [...fixture.tasks];
  let events: CalendarEvent[] = [];
  let schedule: SavedSchedule = fixture.schedule;
  let applied = new Set<string>();
  const routes: Record<string, (body: Record<string, unknown>) => unknown> = {
    '/tasks': () => tasks,
    '/events': () => events,
    '/schedule': () => schedule,
    '/schedule/preferences': () => fixture.preferences,
    '/calendar/connections': () => [],
    '/availability': () => fixture.availability,
    '/plan/interpret': () => fixture.interpret,
    '/plan/review': () => fixture.review,
    '/plan/feasibility': () => fixture.feasibility,
    '/plan/preview': () => fixture.preview,
    '/schedule/apply': body => {
      if (applied.has(String(body.previewId))) return { previewId: String(body.previewId), status: 'applied', duplicate: true, schedule } satisfies ApplyResult;
      applied = new Set([...applied, String(body.previewId)]);
      // What _apply does: drafts become real tasks/events and the draft sessions point at the new task ids.
      const created: Task[] = fixture.preview.tasks.map((a, i) => ({
        ...fixture.tasks[0], id: `task-${i}`, title: a.title, priority: a.priority, minutes: a.remainingMinutes, completedMinutes: 0,
        remainingMinutes: a.remainingMinutes, done: false, kind: a.kind ?? 'task', windows: [],
      } as Task));
      const ids = new Map(fixture.preview.tasks.map((a, i) => [a.taskId, created[i].id]));
      const newEvents: CalendarEvent[] = (fixture.preview.proposedEvents ?? []).map((e, i) => ({
        id: `event-${i}`, title: e.title, kind: e.kind, date: e.date, start: e.start, end: e.end, location: null, repeat: null, skipDates: [], source: 'manual',
      }));
      tasks = [...tasks, ...created];
      events = [...events, ...newEvents];
      schedule = {
        scheduleVersion: schedule.scheduleVersion + 1, timeZone: fixture.preview.timeZone,
        sessions: fixture.preview.sessions.map((s, i) => ({ ...s, id: `saved-${i}`, taskId: s.taskId ? ids.get(s.taskId)! : null, status: 'saved', change: undefined, reason: null })),
      };
      return { previewId: String(body.previewId), status: 'applied', duplicate: false, schedule, tasks: created, events: newEvents } satisfies ApplyResult;
    },
  };
  const request = (async <T>(path: string, init?: RequestInit) => {
    log.push(`${init?.method ?? 'GET'} ${path}`);
    if (options.fail?.[path]) throw Object.assign(new Error('The AI provider is unavailable. Your input was kept.'), { status: options.fail[path] });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return structuredClone(routes[path]?.(body) ?? []) as T;
  }) as Requester;
  return { request, log, counts: () => ({ tasks: tasks.length, events: events.length, sessions: schedule.sessions.length }) };
}

async function store(request: Requester) {
  const s = createWorkspaceStore(request);
  s.setUser('owner');
  await tick();
  return s;
}

test('chat recognises several tasks in one message, but not questions', () => {
  assert.ok(looksLikePlanEntry(BULK));
  assert.ok(looksLikePlanEntry('Essay draft 2 hours due Friday'));
  assert.ok(looksLikePlanEntry('add gym 45 min tomorrow'));
  assert.ok(!looksLikePlanEntry('What should I work on today?'));
  assert.ok(!looksLikePlanEntry('Show my plan'));
  assert.ok(!looksLikePlanEntry('thanks!'));
});

test('bulk message: drafts → “Can this fit?” → preview → Apply, and preview, calendar, Today and chat agree', async () => {
  const api = backend();
  const workspace = await store(api.request);
  const before = api.counts();

  const result = await workspace.interpretPlan(BULK);
  assert.deepEqual(result.drafts.map(v => [v.draft.kind, v.draft.title]), [['task', 'Lab report'], ['fixed_event', 'Advisor meeting'], ['flexible_event', 'Gym']]);
  const reply = draftsReply(result.drafts, result.provider, result.notes);
  assert.match(reply, /Nothing is saved yet/);
  assert.doesNotMatch(reply, /\bsaved\b(?! yet)|created|added to your calendar/i, 'chat never claims a save after reading');
  assert.equal(workspace.getSnapshot().planDrafts?.views.length, 3);

  const fit = await workspace.checkFit();
  assert.equal(fit.status, 'fits_without_moving');
  assert.equal(fit.savedDataChanged, false);
  assert.deepEqual(api.counts(), before, 'the check changes no saved data');

  const preview = await workspace.previewDrafts();
  assert.equal(preview.mode, 'plan');
  assert.deepEqual(api.counts(), before, 'a preview changes no saved data');
  const state = workspace.getSnapshot();
  const proposed = calendarSessions(state.sessions, state.schedulePreview).filter(i => i.kind === 'proposed');
  assert.deepEqual(proposed.map(i => i.session.id), preview.sessions.map(s => s.id), 'the calendar shows exactly the preview sessions');
  assert.ok(proposed.some(i => i.session.type === 'break'), 'reserved breaks are on the calendar');
  assert.equal(preview.firstProposedDate, TODAY);

  const agenda = todayAgenda(state, TODAY);
  const agendaKinds = agenda.items.map(i => (i.kind === 'proposedEvent' ? `event:${i.proposed.title}` : i.kind === 'session' ? `${i.item.session.type}:${i.item.session.title}` : i.kind));
  assert.deepEqual(agendaKinds, ['work:Lab report', 'break:Break', 'work:Lab report', 'event:Advisor meeting', 'work:Gym']);
  const chat = await runAssistantCommand(parseRequest('Today’s tasks', state, NOW)!, workspace, NOW);
  assert.equal(chat.text, todayText(agenda, TODAY, ZONE, state.tasks));
  assert.match(chat.text, /Advisor meeting/);
  assert.match(chat.text, /Gym/);
  assert.match(previewText(preview), /Not saved yet/);
  assert.match(previewText(preview), /Advisor meeting/);

  await workspace.applySchedulePreview();
  const after = workspace.getSnapshot();
  assert.equal(after.planDrafts, null, 'applied drafts leave the review panel');
  assert.equal(after.schedulePreview, null);
  assert.deepEqual(after.tasks.slice(fixture.tasks.length).map(t => t.title).sort(), ['Gym', 'Lab report']);
  assert.ok(after.tasks.some(t => t.title === 'Gym' && t.kind === 'flexible_event'));
  assert.ok(after.events.some(e => e.title === 'Advisor meeting'));
  assert.ok(after.sessions.every(s => !s.taskId?.startsWith('draft:')), 'saved sessions point at real tasks');

  // Refresh: a new store reads the same saved state back.
  const refreshed = await store(api.request);
  const snap = refreshed.getSnapshot();
  assert.equal(snap.sessions.length, preview.sessions.length);
  assert.ok(snap.events.some(e => e.title === 'Advisor meeting'));
  assert.equal(snap.planDrafts, null);
});

test('a failed extraction keeps nothing half-done and leaves the drafts untouched', async () => {
  const api = backend({ fail: { '/plan/interpret': 502 } });
  const workspace = await store(api.request);
  await assert.rejects(workspace.interpretPlan(BULK), /input was kept/);
  const state = workspace.getSnapshot();
  assert.equal(state.planDrafts, null);
  assert.equal(state.planBusy, false);
  assert.ok(!api.log.some(l => l.includes('/schedule/apply')));
});

test('a reply answers the first open question on the same draft', () => {
  const views: DraftView[] = [
    { draft: emptyDraft('d1', { title: 'Essay', minutes: 60, deadline: '2026-10-30' }), issues: [], ready: true },
    { draft: emptyDraft('d2', { kind: 'fixed_event', title: 'CS 101', start: 540, end: 590, repeat: { weekdays: [0, 2], startDate: null, until: null } }),
      issues: [{ field: 'repeat.startDate', question: 'Which date does CS 101 start repeating?', blocking: true, code: 'missing' }], ready: false },
  ];
  assert.deepEqual(firstOpenQuestion(views), { draftId: 'd2', field: 'repeat.startDate', question: 'Which date does CS 101 start repeating?' });
  assert.equal(firstOpenQuestion([{ ...views[1], draft: { ...views[1].draft, include: false } }]), null, 'unticked items are skipped');
  assert.match(draftsReply(views, 'local'), /weekly event.*start \?/);
  assert.match(draftsReply(views, 'local'), /First question: Which date does CS 101 start repeating\?/);
});

test('new drafts never take the id of a draft already under review, and keep their links', () => {
  const current: DraftView[] = [{ draft: emptyDraft('d1', { title: 'A' }), issues: [], ready: true }];
  const incoming: DraftView[] = [
    { draft: emptyDraft('d1', { title: 'B' }), issues: [], ready: true },
    { draft: emptyDraft('d2', { title: 'C', dependsOn: ['d1'] }), issues: [], ready: true },
  ];
  const merged = mergeDrafts(current, incoming);
  assert.equal(merged[0].draft.id, 'd1');
  assert.equal(new Set(merged.map(v => v.draft.id)).size, 3);
  const b = merged.find(v => v.draft.title === 'B')!;
  const c = merged.find(v => v.draft.title === 'C')!;
  assert.deepEqual(c.draft.dependsOn, [b.draft.id], 'C still depends on B, not on the older A');
});
