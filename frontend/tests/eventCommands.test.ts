import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmEventAction, eventFromIntent, parseDate, parseEventRequest, parseTimes } from "../src/services/eventCommands.ts";
import { parseRequest, runAssistantCommand, type CommandWorkspace } from "../src/services/assistantCommands.ts";
import { DEFAULT_AI_PROFILE, DEFAULT_PREFERENCES, type Availability, type CalendarEvent } from "../src/types/models.ts";
import { dateInZone } from "../src/utils/calendar.ts";
import { addDays } from "../src/utils/dates.ts";

const availability: Availability = {
  days: Array.from({ length: 7 }, (_, day) => ({ day, enabled: true, periods: [{ start: 540, end: 1020 }] })),
  weekOverrides: [], timeZone: "UTC", reminders: false,
};
const today = dateInZone("UTC");
const tomorrow = addDays(today, 1);
const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: "e1", title: "Project sync", kind: "Meeting", date: tomorrow, start: 900, end: 960, location: null, repeat: null,
  skipDates: [], source: "manual", ...over,
});
const state = (events: CalendarEvent[] = []) => ({ events, availability });

test("times: ranges, shared am/pm, single times and durations", () => {
  assert.deepEqual(parseTimes("from 3pm to 4pm"), { start: 900, end: 960, assumed: [] });
  assert.deepEqual(parseTimes("3-4:30pm"), { start: 900, end: 990, assumed: [] });
  assert.deepEqual(parseTimes("11am-1pm"), { start: 660, end: 780, assumed: [] });
  assert.deepEqual(parseTimes("at 2pm for 90 minutes"), { start: 840, end: 930, assumed: [] });
  assert.deepEqual(parseTimes("at 10am"), { start: 600, end: 660, assumed: ["1 hour long"] });
  assert.deepEqual(parseTimes("from 3 to 4"), { start: 900, end: 960, assumed: ["am/pm"] });
  assert.equal(parseTimes("on 2026-10-30"), null);
});

test("dates: today, tomorrow, weekdays, month names and ISO", () => {
  assert.equal(parseDate("today", today), today);
  assert.equal(parseDate("tomorrow", today), tomorrow);
  assert.equal(parseDate("on 2026-12-01", today), "2026-12-01");
  assert.equal(parseDate("Dec 1, 2027", today), "2027-12-01");
  const friday = parseDate("on friday", "2026-10-27"); // a Tuesday
  assert.equal(friday, "2026-10-30");
  assert.equal(parseDate("no date here", today), null);
});

test("add event: proposal shows exactly what will be saved, nothing is saved yet", () => {
  const proposal = parseEventRequest("Add a meeting called Project sync tomorrow from 3pm to 4pm", state());
  assert.ok(proposal?.action && proposal.action.type === "add_event");
  if (proposal?.action?.type !== "add_event") return;
  assert.deepEqual(proposal.action.input, { title: "Project sync", kind: "Meeting", date: tomorrow, start: 900, end: 960, location: null, repeat: null });
  assert.match(proposal.summary, /Add this event/);
  assert.match(proposal.summary, /3 PM–4 PM/);
  assert.match(proposal.summary, /Nothing is saved until you press Add event/);
});

test("add event: title from 'with', kind detection, weekly repeat", () => {
  const meeting = parseEventRequest("schedule a meeting with Prof Smith tomorrow at 2pm", state());
  assert.equal(meeting?.action?.type, "add_event");
  if (meeting?.action?.type === "add_event") {
    assert.equal(meeting.action.input.title, "Meeting with Prof Smith");
    assert.match(meeting.summary, /assumed 1 hour long/);
  }
  const weekly = parseEventRequest('add a class "Network Security" on 2026-11-02 from 2pm to 3:15pm every week', state());
  assert.equal(weekly?.action?.type, "add_event");
  if (weekly?.action?.type === "add_event") {
    assert.equal(weekly.action.input.kind, "Class");
    assert.deepEqual(weekly.action.input.repeat?.weekdays, [0]);
    assert.match(weekly.summary, /Repeats every Monday/);
  }
});

test("add event: missing pieces become one question", () => {
  assert.equal(parseEventRequest("add an event", state())?.action, null);
  const noTime = parseEventRequest("add a meeting called Standup tomorrow", state());
  assert.equal(noTime?.action, null);
  if (noTime && !noTime.action) assert.match(noTime.question, /What time is “Standup”/);
  const noDay = parseEventRequest("add a meeting called Standup at 9am", state());
  if (noDay && !noDay.action) assert.match(noDay.question, /Which day/);
  const odd = parseEventRequest("add a meeting called Standup tomorrow at 9:03am", state());
  if (odd && !odd.action) assert.match(odd.question, /5-minute steps/);
});

test("add event: warns about overlaps", () => {
  const proposal = parseEventRequest("add an event called Dentist tomorrow from 3:30pm to 4:30pm", state([event({})]));
  assert.equal(proposal?.action?.type, "add_event");
  if (proposal?.action) assert.match(proposal.summary, /overlaps “Project sync”/);
});

test("delete event: finds it by name and asks to confirm", () => {
  const proposal = parseEventRequest("Delete the event called Project sync", state([event({})]));
  assert.deepEqual(proposal?.action, { type: "delete_event", eventId: "e1", title: "Project sync" });
  if (proposal?.action) assert.match(proposal.summary, /Nothing changes until you press Delete event/);
});

test("delete event: unknown, duplicate, imported", () => {
  const missing = parseEventRequest("delete the meeting called Lunch", state([event({})]));
  if (missing && !missing.action) assert.match(missing.question, /couldn't find .*Your events include “Project sync”/);
  const twice = parseEventRequest("delete the event called Project sync", state([event({}), event({ id: "e2", date: addDays(today, 3) })]));
  if (twice && !twice.action) assert.match(twice.question, /More than one event matches/);
  const imported = parseEventRequest("delete the event called Project sync", state([event({ source: "google" })]));
  if (imported && !imported.action) assert.match(imported.question, /read-only/);
});

test("delete event: a dated request on a repeating event removes only that day", () => {
  const weekly = event({ id: "c1", title: "Discrete Structures", kind: "Class", date: today, repeat: { weekdays: [0, 1, 2, 3, 4, 5, 6], until: addDays(today, 60) } });
  const one = parseEventRequest("cancel my class Discrete Structures tomorrow", state([weekly]));
  assert.deepEqual(one?.action, { type: "skip_event_occurrence", eventId: "c1", title: "Discrete Structures", date: tomorrow });
  const all = parseEventRequest("delete the class Discrete Structures", state([weekly]));
  assert.equal(all?.action?.type, "delete_event");
  if (all?.action) assert.match(all.summary, /every occurrence will be removed/);
  const byKind = parseEventRequest("cancel my class tomorrow", state([weekly]));
  assert.equal(byKind?.action?.type, "skip_event_occurrence");
});

test("model intents are re-checked the same way", () => {
  const add = eventFromIntent("add_event", { eventTitle: "Gym", eventDate: tomorrow, eventStart: "18:00", eventEnd: "19:00" }, state());
  assert.equal(add.action?.type, "add_event");
  assert.equal(eventFromIntent("add_event", { eventTitle: "Gym", eventDate: "someday", eventStart: "18:00", eventEnd: "19:00" }, state()).action, null);
  const del = eventFromIntent("delete_event", { eventTitle: "project sync" }, state([event({})]));
  assert.equal(del.action?.type, "delete_event");
});

test("chat routes event requests and keeps other commands working", async () => {
  const full = { tasks: [], availability, events: [event({})], preferences: DEFAULT_PREFERENCES, aiProfile: DEFAULT_AI_PROFILE };
  const parsed = parseRequest("delete the event called Project sync", full);
  assert.equal(parsed?.command, "propose_event");
  const workspace = { getSnapshot: () => full } as unknown as CommandWorkspace;
  const message = await runAssistantCommand(parsed!, workspace);
  assert.deepEqual(message.pendingEvent, { type: "delete_event", eventId: "e1", title: "Project sync" });
  assert.deepEqual(parseRequest("plan my week", full), { command: "generate_schedule" });
  assert.equal(parseRequest("I need a 15-minute break now", full)?.command, "request_break");
});

test("confirm runs the real call and reports its outcome", async () => {
  const calls: string[] = [];
  const workspace = {
    createEvent: async (input: CalendarEvent) => { calls.push(`create ${input.title}`); return event({ title: input.title }); },
    deleteEvent: async (id: string) => { calls.push(`delete ${id}`); },
    skipEventOccurrence: async (id: string, date: string) => { calls.push(`skip ${id} ${date}`); return event({}); },
  };
  assert.match(await confirmEventAction({ type: "add_event", input: { title: "Gym", kind: "Other", date: tomorrow, start: 1080, end: 1140, location: null, repeat: null } }, workspace), /^Added “Gym”/);
  assert.match(await confirmEventAction({ type: "delete_event", eventId: "e1", title: "Project sync" }, workspace), /^Deleted “Project sync”/);
  assert.match(await confirmEventAction({ type: "skip_event_occurrence", eventId: "c1", title: "Class", date: tomorrow }, workspace), /other occurrences are unchanged/);
  assert.deepEqual(calls, ["create Gym", "delete e1", `skip c1 ${tomorrow}`]);
  const failing = { ...workspace, deleteEvent: async () => { throw new Error("Database unavailable"); } };
  assert.match(await confirmEventAction({ type: "delete_event", eventId: "e1", title: "x" }, failing), /^Not done: Database unavailable/);
});

test("the follow-up suggested for duplicate names works when typed back", () => {
  const twins = [event({}), event({ id: "e2", date: addDays(tomorrow, 2) })];
  const ask = parseEventRequest("delete the event called Project sync", state(twins));
  assert.equal(ask?.action, null);
  const suggestion = ask && !ask.action ? ask.question.match(/e\.g\. “(.+)”/)?.[1] : undefined;
  assert.ok(suggestion);
  assert.deepEqual(parseEventRequest(suggestion!, state(twins))?.action, { type: "delete_event", eventId: "e1", title: "Project sync" });
  const quoted = parseEventRequest(`remove event "Project sync" on ${addDays(tomorrow, 2)}`, state(twins));
  assert.deepEqual(quoted?.action, { type: "delete_event", eventId: "e2", title: "Project sync" });
});
