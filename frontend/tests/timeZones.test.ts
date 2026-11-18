import { test } from "node:test";
import assert from "node:assert/strict";
import { accountTimeZone, accountToday, browserTimeZone, normalizeTimeZone, timeZoneChoices, timeZoneLabel } from "../src/utils/timeZones.ts";
import { parseEventRequest } from "../src/services/eventCommands.ts";
import { createWorkspaceStore, type Requester } from "../src/services/workspaceStore.ts";
import { dateInZone, minutesInZone } from "../src/utils/calendar.ts";
import type { Availability } from "../src/types/models.ts";

const week = Array.from({ length: 7 }, (_, day) => ({ day, enabled: true, periods: [{ start: 540, end: 1020 }] }));
const saved = (timeZone: string): Availability => ({ days: week, weekOverrides: [], timeZone, reminders: false });

test("friendly labels over IANA ids", () => {
  assert.equal(timeZoneLabel("America/New_York"), "New York — Eastern Time");
  assert.equal(timeZoneLabel("America/Los_Angeles"), "Los Angeles — Pacific Time");
  assert.equal(timeZoneLabel("UTC"), "GMT — Greenwich Mean Time");
  assert.equal(normalizeTimeZone("UTC"), "Etc/GMT");
});

test("each time zone is offered once (no duplicate option keys)", () => {
  const { common, all } = timeZoneChoices();
  const values = [...common, ...all].map(z => z.value);
  assert.equal(new Set(values).size, values.length);
  assert.ok(common.some(z => z.value === "America/New_York" && z.label === "New York — Eastern Time"));
});

test("the saved zone wins over the device; the device is only the default", () => {
  assert.equal(accountTimeZone(saved("Asia/Tokyo")), "Asia/Tokyo");
  assert.equal(accountTimeZone(null), browserTimeZone());
});

test("today near midnight follows the account zone, not the device", () => {
  const now = new Date("2026-10-28T03:30:00Z"); // 11:30 PM Oct 27 in New York, 12:30 PM Oct 28 in Tokyo
  assert.equal(accountToday(saved("America/New_York"), now), "2026-10-27");
  assert.equal(accountToday(saved("Asia/Tokyo"), now), "2026-10-28");
});

test("daylight saving transitions use real offsets, not fixed ones", () => {
  // New York springs forward at 2 AM on 8 Mar 2026 and falls back at 2 AM on 1 Nov 2026.
  assert.equal(dateInZone("America/New_York", new Date("2026-03-08T04:59:00Z")), "2026-03-07"); // 11:59 PM EST
  assert.equal(minutesInZone("America/New_York", new Date("2026-03-08T07:00:00Z")), 3 * 60); // 3 AM EDT
  assert.equal(minutesInZone("America/New_York", new Date("2026-11-01T05:30:00Z")), 60 + 30); // 1:30 AM EDT
  assert.equal(minutesInZone("America/New_York", new Date("2026-11-01T06:30:00Z")), 60 + 30); // 1:30 AM EST, again
});

test("“tomorrow at 3 PM” is read in the saved zone", () => {
  const now = new Date("2026-10-28T03:30:00Z");
  const inNewYork = parseEventRequest("add a meeting called Sync tomorrow at 3pm", { events: [], availability: saved("America/New_York") }, now);
  const inTokyo = parseEventRequest("add a meeting called Sync tomorrow at 3pm", { events: [], availability: saved("Asia/Tokyo") }, now);
  assert.ok(inNewYork?.action?.type === "add_event" && inTokyo?.action?.type === "add_event");
  if (inNewYork?.action?.type !== "add_event" || inTokyo?.action?.type !== "add_event") return;
  assert.equal(inNewYork.action.input.date, "2026-10-28");
  assert.equal(inTokyo.action.input.date, "2026-10-29");
  assert.equal(inNewYork.action.input.start, 15 * 60);
});

function fakeApi(availability: Availability & { saved?: boolean }) {
  const puts: Availability[] = [];
  const request: Requester = async <T,>(path: string, options?: RequestInit) => {
    if (path === "/availability" && options?.method === "PUT") {
      const body = JSON.parse(String(options.body)) as Availability;
      puts.push(body);
      return body as T;
    }
    const replies: Record<string, unknown> = {
      "/tasks": [], "/schedule": { scheduleVersion: 0, timeZone: availability.timeZone, sessions: [] }, "/events": [],
      "/calendar/connections": [], "/availability": availability, "/schedule/preferences": null, "/assistant/profile": {}, "/actions": [],
    };
    return replies[path] as T;
  };
  return { request, puts };
}

async function loaded(store: ReturnType<typeof createWorkspaceStore>) {
  for (let i = 0; i < 50 && store.getSnapshot().status !== "ready"; i++) await new Promise(r => setTimeout(r, 1));
  return store.getSnapshot();
}

test("an account without a saved zone saves the device zone once", async () => {
  const { request, puts } = fakeApi({ ...saved("Etc/GMT"), saved: false });
  const store = createWorkspaceStore(request, () => "America/Chicago");
  store.setUser("u1");
  const state = await loaded(store);
  assert.equal(state.availability?.timeZone, "America/Chicago");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].timeZone, "America/Chicago");
});

test("a saved zone is restored as-is, whatever the device says", async () => {
  const { request, puts } = fakeApi({ ...saved("America/New_York"), saved: true });
  const store = createWorkspaceStore(request, () => "Asia/Tokyo");
  store.setUser("u1");
  const state = await loaded(store);
  assert.equal(state.availability?.timeZone, "America/New_York");
  assert.equal(puts.length, 0);
});
