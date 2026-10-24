import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWelcome,
  replyToPrompt,
} from "../src/services/plannerAssistant.ts";
import type { Availability, GeneratedPlan, Task } from "../src/types/models.ts";
import { monthGrid, shiftAnchor } from "../src/utils/plannerCalendar.ts";

const availability: Availability = {
  days: Array.from({ length: 7 }, (_, day) => ({
    day,
    enabled: true,
    periods: [{ start: 540, end: 1020 }],
  })),
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
  {
    id: "1",
    title: "Essay",
    deadline: "2026-10-06",
    minutes: 60,
    remainingMinutes: 60,
    priority: "High",
    category: "Study",
    done: false,
    ...scheduling,
  },
  {
    id: "2",
    title: "Laundry",
    deadline: "2026-10-07",
    minutes: 30,
    remainingMinutes: 30,
    priority: "Low",
    category: "Personal",
    done: false,
    ...scheduling,
  },
];

const plan: GeneratedPlan = {
  version: 1,
  generatedAt: "2026-10-05T09:00:00Z",
  startDate: "2026-10-05",
  endDate: "2026-10-11",
  timeZone: "UTC",
  source: "availability_only",
  busyIntervals: [],
  blocks: [],
  tasks: [
    {
      taskId: "1",
      title: "Essay",
      deadline: "2026-10-06",
      requestedMinutes: 60,
      scheduledMinutes: 30,
      unscheduledMinutes: 30,
      status: "partial",
      reason: null,
      message: "Only part of the work fit.",
    },
  ],
  stale: false,
  staleReasons: [],
};

test("welcome message uses account counts and avoids fake model claims", () => {
  const welcome = buildWelcome({ tasks, plan, availability });
  assert.match(welcome.text, /2 open task/);
  assert.match(welcome.text, /not a live language model|Planning helper/i);
  assert.equal(welcome.pendingAction, null);
});

test("generate plan replies require confirmation instead of mutating", () => {
  const reply = replyToPrompt("generate plan", { tasks, plan, availability }, "a1");
  assert.equal(reply.pendingAction?.type, "generate_plan");
  assert.match(reply.text, /Confirm/i);
});

test("unscheduled replies reflect plan task statuses", () => {
  const reply = replyToPrompt("show unscheduled", { tasks, plan, availability }, "a2");
  assert.match(reply.text, /Essay/);
  assert.match(reply.text, /partial/);
});

test("calendar and outlook prompts stay honest about integrations", () => {
  const none = replyToPrompt("google calendar outlook", { tasks, plan, availability }, "a3");
  assert.match(none.text, /No external calendar is connected/i);
  const connected = replyToPrompt("is google calendar connected?", {
    tasks, plan, availability,
    connections: [{ provider: "google", account: "alice@gmail.com", lastSynced: "2026-10-23T12:00:00Z", rangeStart: "2026-10-16", rangeEnd: "2026-12-18", eventCount: 12 }],
  }, "a4");
  assert.match(connected.text, /Google Calendar is connected \(alice@gmail\.com\): 12 event/);
  assert.doesNotMatch(connected.text, /Outlook is connected/);
});

test("month grid and shift helpers stay stable", () => {
  assert.equal(shiftAnchor("2026-10-06", "week", 1), "2026-10-13");
  assert.equal(shiftAnchor("2026-10-06", "month", 1), "2026-11-01");
  assert.equal(monthGrid("2026-10-06").length, 42);
});
