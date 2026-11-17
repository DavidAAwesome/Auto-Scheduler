// Natural-language regressions: each case is a real chat message that used to be misread.
import test from "node:test";
import assert from "node:assert/strict";
import { parseRequest, requestFromIntent } from "../src/services/assistantCommands.ts";
import { parseDate, parseEventRequest } from "../src/services/eventCommands.ts";
import { ACKNOWLEDGEMENT, draftsReply, emptyDraft } from "../src/services/planEntry.ts";
import { zonedInstant } from "../src/utils/planning.ts";
import type { Task, WorkSession } from "../src/types/models.ts";

const ZONE = "America/New_York";
const NOW = new Date("2026-11-12T15:00:00Z"); // Thursday 10:00 AM in New York
const essay = { id: "t1", title: "Essay", done: false, deadline: "2026-11-14" } as Task;
const lab = { id: "t2", title: "Lab report", done: false, deadline: "2026-11-16" } as Task;
const sync = { id: "e1", title: "Project sync", date: "2026-11-13", start: 900, end: 960, kind: "Meeting", repeat: null, skipDates: [], source: "manual" };
const state = {
  tasks: [essay, lab], availability: { timeZone: ZONE }, events: [sync],
  preferences: { focusMinutes: 50, breakMinutes: 10, maxDailyWorkMinutes: 360 }, aiProfile: { replyStyle: "balanced", tone: "friendly", aboutMe: "" },
} as never;
const ask = (text: string, extra: object = {}) => parseRequest(text, { ...(state as object), ...extra } as never, NOW);

test("next <weekday> is the day in the following week, never tomorrow", () => {
  assert.equal(parseDate("next friday", "2026-11-12"), "2026-11-20");
  assert.equal(parseDate("friday", "2026-11-12"), "2026-11-13");
  assert.equal(parseDate("next monday", "2026-11-14"), "2026-11-16"); // Saturday → the coming Monday starts next week
  const event = parseEventRequest("add a meeting next friday at 10am", state, NOW);
  assert.equal(event?.action?.type === "add_event" && event.action.input.date, "2026-11-20");
  assert.match(event && "summary" in event ? event.summary : "", /“next Friday” means Fri, Nov 20, 2026/);
  const move = ask("push essay to next friday", { tasks: [{ ...essay, deadline: "2026-11-27" }, lab] });
  assert.equal(move?.command === "move_task" && move.notBefore, zonedInstant("2026-11-20", 0, ZONE));
});

test("weekly events from 'every <weekday>' repeat and keep a real title", () => {
  const event = parseEventRequest("add a class every Mon and Wed 2-3:15pm", state, NOW);
  assert.ok(event?.action?.type === "add_event");
  if (event?.action?.type !== "add_event") return;
  assert.equal(event.action.input.title, "Class");
  assert.deepEqual(event.action.input.repeat?.weekdays, [0, 2]);
  assert.match(event.summary, /Repeats every Monday and Wednesday/);
  assert.match(event.summary, /I assumed it repeats for 15 weeks/);
});

test("noon is a time in chat events", () => {
  const event = parseEventRequest("add a lunch with Sam tomorrow at noon", state, NOW);
  assert.ok(event?.action?.type === "add_event");
  if (event?.action?.type === "add_event") assert.deepEqual([event.action.input.title, event.action.input.start], ["Lunch with Sam", 720]);
});

test("moves keep the clock time and relative shifts", () => {
  assert.deepEqual(ask("move essay to 3pm tomorrow"), { command: "move_task", taskId: "t1", notBefore: zonedInstant("2026-11-13", 900, ZONE), label: "Essay to tomorrow at 3 PM" });
  assert.deepEqual(ask("move essay to 3pm"), { command: "move_task", taskId: "t1", notBefore: zonedInstant("2026-11-12", 900, ZONE), label: "Essay to today at 3 PM" });
  const sessions = [{ taskId: "t1", type: "work", status: "saved", startAt: "2026-11-13T19:00:00Z" }] as WorkSession[];
  const pushed = ask("push the essay back a day", { sessions });
  assert.equal(pushed?.command === "move_task" && pushed.notBefore, "2026-11-14T19:00:00.000Z");
});

test("scheduling one task at a time is a preferred start, not a new week plan", () => {
  const request = ask("schedule my essay for tomorrow at 3pm");
  assert.equal(request?.command, "move_task");
  assert.equal(request?.command === "move_task" && request.notBefore, zonedInstant("2026-11-13", 900, ZONE));
  assert.deepEqual(ask("plan my week"), { command: "generate_schedule" });
  assert.equal(ask("Plan my week but keep Friday free")?.command, "clarify");
  assert.equal(ask("Plan the party for Saturday"), null);
});

test("a break for later never starts now; habits are not break requests", () => {
  const later = ask("I'll take a 20 minute break after class");
  assert.equal(later?.command, "clarify");
  assert.match(later && "question" in later ? later.question : "", /only start a protected break right now/);
  assert.equal(ask("I usually take a break around noon"), null);
  assert.deepEqual(ask("I need a half hour break"), { command: "request_break", minutes: 30 });
  assert.deepEqual(ask("I need a 1h30 break"), { command: "request_break", minutes: 90 });
});

test("generic words reach the assistant instead of canned reports", () => {
  for (const text of ["Why is it so hard to focus?", "Is my schedule too packed this week?", "what's on your mind", "I need to shift my focus to studying", "Can you move on to the next thing?"]) {
    assert.equal(ask(text), null, text);
  }
  assert.deepEqual(ask("What didn't fit?"), { command: "explain_unscheduled" });
  assert.deepEqual(ask("Busy time"), { command: "busy_time" });
  assert.deepEqual(ask("show my plan"), { command: "show_plan" });
});

test("events are never mistaken for tasks in a move", () => {
  const moved = ask("move my meeting to 4pm");
  assert.equal(moved?.command, "clarify");
  assert.match(moved && "question" in moved ? moved.question : "", /can't move events from chat/);
});

test("the model's add_task details survive a clarifying question", () => {
  const reply = { reply: "Got it.", intent: "add_task", params: { taskTitle: "Essay", taskDeadline: "2026-11-13", taskDuration: 120 } } as never;
  assert.deepEqual(requestFromIntent(reply, state, "Friday"), { command: "add_task", text: "Essay, 120 minutes, due 2026-11-13" });
});

test("the model's move reply says where the task goes", () => {
  const reply = { reply: "ok", intent: "move_task", params: { taskId: "t1", notBefore: "2026-11-13T15:00:00-05:00" } } as never;
  const request = requestFromIntent(reply, state, "", NOW);
  assert.equal(request?.command === "move_task" && request.label, "Essay to tomorrow at 3 PM");
});

test("acknowledgements are not answers to an open draft question", () => {
  for (const text of ["thanks", "ok wait", "Okay!", "got it"]) assert.ok(ACKNOWLEDGEMENT.test(text), text);
  for (const text of ["ok 5pm", "Friday", "PM"]) assert.ok(!ACKNOWLEDGEMENT.test(text), text);
});

test("draft replies state assumptions and keep a preferred start apart from the deadline", () => {
  const draft = emptyDraft("d1", { title: "Work on essay", minutes: 120, deadline: "2026-11-13", earliestStart: "2026-11-13T15:00:00" });
  const text = draftsReply([{ draft, ready: true, issues: [
    { field: "deadline", code: "ambiguous", question: 'I read the deadline of "Work on essay" as Fri, Nov 13. Change it if you meant another day.', blocking: false },
    { field: "priority", code: "warning", question: "Priority was not stated", blocking: false },
  ] }], "local");
  assert.match(text, /due 2026-11-13, work starts no earlier than 2026-11-13 3 PM/);
  assert.match(text, /Note: I read the deadline of "Work on essay" as Fri, Nov 13/);
  assert.doesNotMatch(text, /Priority was not stated/);
});

test("a day and a clock time read as events, one per named day, never a model-picked day", async () => {
  const { looksLikePlanEntry } = await import("../src/services/planEntry.ts");
  assert.equal(looksLikePlanEntry("Soccer practice Sat and Sun 9-10am"), true);
  assert.equal(looksLikePlanEntry("Dentist tomorrow 3pm"), true);
  assert.equal(looksLikePlanEntry("What do I have tomorrow at 3pm?"), false);
  assert.equal(looksLikePlanEntry("I usually take a break around noon"), false);
  const add = (eventDate: string, text: string) => requestFromIntent({ reply: "ok", intent: "add_event",
    params: { eventTitle: "Soccer practice", eventDate, eventStart: "09:00", eventEnd: "10:00" } } as never, state, text, NOW);
  // The model once picked Thursday for "Sat and Sun": two named days are never one event on a third.
  const both = add("2026-11-19", "Soccer practice Sat and Sun 9-10am");
  assert.equal(both?.command, "clarify");
  assert.match(both && "question" in both ? both.question : "", /each of Saturday and Sunday/);
  const wrong = add("2026-11-19", "Soccer practice Saturday 9-10am");
  assert.match(wrong && "question" in wrong ? wrong.question : "", /you said Saturday/);
  assert.notEqual(add("2026-11-21", "Soccer practice Saturday 9-10am")?.command, "clarify");
});

test("work with a length goes to review, not to a new week plan", async () => {
  const { looksLikePlanEntry } = await import("../src/services/planEntry.ts");
  const text = "Essay draft 2 hours in one sitting, then proofread 30 min after Essay draft";
  assert.equal(ask(text), null);
  assert.equal(looksLikePlanEntry(text), true);
  assert.equal(looksLikePlanEntry("Read chapter 4, 45 min"), true);
  for (const chat of ["I worked 2 hours on lab report", "I can work 3 hours a day", "I'm so tired after 3 hours of class", "How long is 2 hours?"]) {
    assert.equal(looksLikePlanEntry(chat), false, chat);
  }
});

test("a move that can't finish before the deadline is refused with the reason", () => {
  // Lab report is due Mon Nov 16 at 11:59 PM; on Thu Nov 12 "tomorrow at 3pm" is fine, "next Tuesday" is not.
  const fine = ask("schedule my lab report for tomorrow at 3pm", { tasks: [{ ...lab, dueTime: 1439, remainingMinutes: 90 }] });
  assert.equal(fine?.command, "move_task");
  const late = ask("push the lab report to next tuesday", { tasks: [{ ...lab, dueTime: 1439, remainingMinutes: 90 }] });
  assert.equal(late?.command, "clarify");
  assert.match(late && "question" in late ? late.question : "", /is due Mon, Nov 16, 2026 at 11:59 PM, so its work can't start after that\. Nothing was changed/);
  // The model's move is checked the same way.
  const model = requestFromIntent({ reply: "ok", intent: "move_task", params: { taskId: "t2", notBefore: "2026-11-17T20:00:00Z" } } as never,
    { ...(state as object), tasks: [{ ...lab, dueTime: 1439, remainingMinutes: 90 }] } as never, "", NOW);
  assert.equal(model?.command, "clarify");
});

test("deadline and length edits get a straight answer, not a move or an offer", () => {
  const edit = ask("change the essay deadline to Monday");
  assert.equal(edit?.command, "clarify");
  assert.match(edit && "question" in edit ? edit.question : "", /can't change “Essay”'s deadline or length from chat/);
});

test("questions about one day are answered from the calendar", async () => {
  const { busyDayText } = await import("../src/utils/schedulePreview.ts");
  // Thu Nov 12: "Saturday" is Nov 14, "Friday" Nov 13 (Project sync 3-4 PM).
  assert.deepEqual(ask("What do I have on Saturday?"), { command: "busy_day", date: "2026-11-14", at: null });
  assert.deepEqual(ask("Is Friday at 3pm free?"), { command: "busy_day", date: "2026-11-13", at: 900 });
  assert.deepEqual(ask("Am I free tomorrow?"), { command: "busy_day", date: "2026-11-13", at: null });
  assert.equal(ask("Why is it so hard to focus?"), null);
  const events = [sync] as never;
  assert.match(busyDayText(events, [], [], "2026-11-13", 900), /Fri, Nov 13, 2026 at 3 PM is busy: Project sync \(3 PM–4 PM\)/);
  assert.match(busyDayText(events, [], [], "2026-11-13", 600), /at 10 AM is free/);
  assert.match(busyDayText(events, [], [], "2026-11-14", null), /Sat, Nov 14, 2026 is free/);
});
