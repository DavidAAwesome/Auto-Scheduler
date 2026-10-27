import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWelcome, replyToPrompt } from "../src/services/plannerAssistant.ts";
import type { Availability, CalendarConnection, Task, WorkSession } from "../src/types/models.ts";
import { dateInZone } from "../src/utils/calendar.ts";

const availability: Availability = {
  days: Array.from({ length: 7 }, (_, day) => ({ day, enabled: true, periods: [{ start: 540, end: 1020 }] })),
  weekOverrides: [],
  timeZone: "UTC",
  reminders: false,
};

const scheduling = {
  dueTime: 1439,
  earliestStart: null as string | null,
  allowSplit: true,
  minSessionMinutes: 15,
  maxSessionMinutes: 60,
  dependsOn: [] as string[],
};
const tasks: Task[] = [
  { id: "1", title: "Essay", deadline: "2026-10-06", minutes: 60, completedMinutes: 0, remainingMinutes: 60, priority: "High", category: "Study", done: false, ...scheduling },
  { id: "2", title: "Laundry", deadline: "2026-10-07", minutes: 30, completedMinutes: 0, remainingMinutes: 30, priority: "Low", category: "Personal", done: false, ...scheduling },
];
const sessions: WorkSession[] = [{
  id: "s1", taskId: "1", title: "Essay", type: "work", status: "saved", locked: false, source: "manual", scheduleVersion: 1,
  startAt: "2026-10-05T10:00:00Z", endAt: "2026-10-05T11:00:00Z", date: "2026-10-05", start: 600, end: 660,
}];

test("welcome message uses account counts and the real schedule state", () => {
  const welcome = buildWelcome({ tasks, sessions, availability, schedulePreview: null });
  assert.match(welcome.text, /2 open task/);
  assert.match(welcome.text, /1 work session\(s\) are saved/);
  assert.match(welcome.text, /preview until you Apply/);
  assert.equal(welcome.actions, undefined);
});

test("welcome says so when no schedule exists", () => {
  const welcome = buildWelcome({ tasks, sessions: [], availability, schedulePreview: null });
  assert.match(welcome.text, /No schedule exists yet/);
});

test("local helper answers today's sessions from stored data", () => {
  const today = dateInZone("UTC");
  const reply = replyToPrompt("today", { tasks, sessions: [{ ...sessions[0], date: today }], availability, schedulePreview: null }, "a1");
  assert.match(reply.text, /10 AM–11 AM Essay \(1h\)/);
  assert.match(reply.text, /Overdue: Essay|Next due: Essay/, "deadlines are reported separately from work times");
});

test("calendar prompts stay honest about integrations", () => {
  const none = replyToPrompt("google calendar outlook", { tasks, sessions, availability, schedulePreview: null }, "a3");
  assert.match(none.text, /No external calendar is connected/i);
  const connections: CalendarConnection[] = [{ provider: "google", account: "alice@gmail.com", lastSynced: "2026-10-23T12:00:00Z", rangeStart: "2026-10-16", rangeEnd: "2026-12-18", eventCount: 12 }];
  const connected = replyToPrompt("is google calendar connected?", { tasks, sessions, availability, schedulePreview: null, connections }, "a4");
  assert.match(connected.text, /Google Calendar is connected \(alice@gmail\.com\): 12 event/);
  assert.doesNotMatch(connected.text, /Outlook is connected/);
});
