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
    start: 540,
    end: 1020,
  })),
  timeZone: "UTC",
  reminders: false,
};

const tasks: Task[] = [
  {
    id: "1",
    title: "Essay",
    deadline: "2026-10-06",
    minutes: 60,
    priority: "High",
    category: "Study",
    done: false,
  },
  {
    id: "2",
    title: "Laundry",
    deadline: "2026-10-07",
    minutes: 30,
    priority: "Low",
    category: "Personal",
    done: false,
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
  const reply = replyToPrompt("google calendar outlook", {
    tasks,
    plan,
    availability,
  }, "a3");
  assert.match(reply.text, /not connected/i);
  assert.match(reply.text, /Outlook is not available/i);
});

test("month grid and shift helpers stay stable", () => {
  assert.equal(shiftAnchor("2026-10-06", "week", 1), "2026-10-13");
  assert.equal(shiftAnchor("2026-10-06", "month", 1), "2026-11-01");
  assert.equal(monthGrid("2026-10-06").length, 42);
});
