import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPreferenceChange, confirmPreferenceChange, parseRequest, requestFromIntent, runAssistantCommand, type CommandWorkspace } from "../src/services/assistantCommands.ts";
import { createWorkspaceStore, normalizeProfile, type Requester } from "../src/services/workspaceStore.ts";
import { DEFAULT_AI_PROFILE, DEFAULT_PREFERENCES, type Availability, type PreferenceChange } from "../src/types/models.ts";

const availability: Availability = {
  days: Array.from({ length: 7 }, (_, day) => ({ day, enabled: true, periods: [{ start: 540, end: 1020 }] })),
  weekOverrides: [], timeZone: "UTC", reminders: false,
};
const state = { tasks: [], availability, preferences: DEFAULT_PREFERENCES, aiProfile: DEFAULT_AI_PROFILE };

test("stated focus length becomes a proposal, not a saved change", () => {
  const parsed = parseRequest("I work best in 25-minute blocks", state);
  assert.equal(parsed?.command, "update_preferences");
  if (parsed?.command !== "update_preferences") return;
  assert.deepEqual(parsed.change, { focusMinutes: 25 });
  assert.match(parsed.summary, /focus blocks 50 min → 25 min/);
  assert.match(parsed.summary, /Nothing changes until you press Save/);
});

test("preferred break length is a setting, but 'I need a break now' still starts a break", () => {
  const pref = parseRequest("I prefer 15 minute breaks", state);
  assert.equal(pref?.command, "update_preferences");
  if (pref?.command === "update_preferences") assert.deepEqual(pref.change, { breakMinutes: 15 });
  assert.deepEqual(parseRequest("I need a 15-minute break now", state), { command: "request_break", minutes: 15 });
});

test("daily limit, reply style and tone are understood", () => {
  const parsed = parseRequest("I can only do 3 hours a day, keep answers short and be more motivating", state);
  assert.equal(parsed?.command, "update_preferences");
  if (parsed?.command === "update_preferences") assert.deepEqual(parsed.change, { maxDailyWorkMinutes: 180, replyStyle: "concise", tone: "motivating" });
});

test("remember adds an about-me note", () => {
  const parsed = parseRequest("Remember that I have class on Tuesdays.", state);
  assert.equal(parsed?.command, "update_preferences");
  if (parsed?.command === "update_preferences") assert.deepEqual(parsed.change, { rememberNote: "I have class on Tuesdays" });
});

test("out-of-range and no-op values are questions, never silent clamps", () => {
  assert.deepEqual(parseRequest("I prefer 5 minute focus blocks", state), { command: "clarify", question: "Focus length must be 10 min to 4 hours." });
  const same = parseRequest("I prefer 50 minute focus blocks", state);
  assert.equal(same?.command, "clarify");
});

test("ordinary scheduling requests are unaffected", () => {
  assert.deepEqual(parseRequest("plan my week", state), { command: "generate_schedule" });
  assert.equal(parseRequest("what is due friday?", state), null);
});

test("model intent is re-checked against current settings before Save is offered", () => {
  const reply = (preferences: PreferenceChange | null) => ({ reply: "x", intent: "update_preferences" as const, params: { breakMinutes: null, taskId: null, notBefore: null, preferences }, provider: "openai" as const });
  const ok = requestFromIntent(reply({ focusMinutes: 30, tone: "professional" }), state);
  assert.equal(ok?.command, "update_preferences");
  assert.equal(requestFromIntent(reply({ focusMinutes: 999 }), state)?.command, "clarify");
  assert.equal(requestFromIntent(reply(null), state)?.command, "clarify");
});

test("a proposal message carries the change and no schedule buttons", async () => {
  const workspace = { getSnapshot: () => ({ ...state }) } as unknown as CommandWorkspace;
  const message = await runAssistantCommand({ command: "update_preferences", change: { focusMinutes: 25 }, summary: "s" }, workspace);
  assert.deepEqual(message.pendingChange, { focusMinutes: 25 });
  assert.deepEqual(message.actions, []);
});

test("Save reports the real outcome", async () => {
  const saved: PreferenceChange[] = [];
  const ok = await confirmPreferenceChange({ focusMinutes: 25 }, { applyPreferenceChange: async (c) => { saved.push(c); } });
  assert.deepEqual(saved, [{ focusMinutes: 25 }]);
  assert.match(ok.text, /^Saved\. New schedules will use this pacing/);
  assert.deepEqual(ok.actions, ["replan"]);
  const fail = await confirmPreferenceChange({ tone: "friendly" }, { applyPreferenceChange: async () => { throw new Error("Database unavailable"); } });
  assert.match(fail.text, /^Not saved: Database unavailable/);
});

test("checkPreferenceChange keeps only changed fields", () => {
  const result = checkPreferenceChange({ focusMinutes: 50, breakMinutes: 20 }, DEFAULT_PREFERENCES);
  assert.deepEqual(result.change, { breakMinutes: 20 });
});

test("profile is loaded with the workspace, and a failed profile request does not block it", async () => {
  const base: Requester = async <T>(path: string) => (path === "/availability" ? availability : path === "/schedule" ? { scheduleVersion: 0, timeZone: "UTC", sessions: [] } : path === "/schedule/preferences" ? DEFAULT_PREFERENCES : path === "/assistant/profile" ? { replyStyle: "concise", tone: "professional", aboutMe: "Night owl" } : []) as T;
  const store = createWorkspaceStore(base);
  store.setUser("a");
  await new Promise(r => setTimeout(r, 0));
  assert.equal(store.getSnapshot().status, "ready");
  assert.deepEqual(store.getSnapshot().aiProfile, { replyStyle: "concise", tone: "professional", aboutMe: "Night owl" });

  const failing: Requester = async <T>(path: string) => { if (path === "/assistant/profile") throw new Error("404"); return base<T>(path); };
  const other = createWorkspaceStore(failing);
  other.setUser("b");
  await new Promise(r => setTimeout(r, 0));
  assert.equal(other.getSnapshot().status, "ready");
  assert.deepEqual(other.getSnapshot().aiProfile, DEFAULT_AI_PROFILE);
  assert.deepEqual(normalizeProfile({ replyStyle: "rude" }), DEFAULT_AI_PROFILE);
});

test("confirmed changes update preferences and profile in the workspace; a tone change leaves previews valid", async () => {
  const request: Requester = async <T>(path: string, options?: RequestInit) => {
    if (path === "/assistant/preferences/apply") {
      const body = JSON.parse(String(options?.body));
      return { preferences: { ...DEFAULT_PREFERENCES, ...(body.focusMinutes ? { focusMinutes: body.focusMinutes } : {}) }, profile: { ...DEFAULT_AI_PROFILE, ...(body.tone ? { tone: body.tone } : {}) } } as T;
    }
    return (path === "/availability" ? availability : path === "/schedule" ? { scheduleVersion: 0, timeZone: "UTC", sessions: [] } : path === "/schedule/preferences" ? DEFAULT_PREFERENCES : path === "/assistant/profile" ? DEFAULT_AI_PROFILE : []) as T;
  };
  const store = createWorkspaceStore(request);
  store.setUser("a");
  await new Promise(r => setTimeout(r, 0));
  await store.applyPreferenceChange({ tone: "motivating" });
  assert.equal(store.getSnapshot().aiProfile.tone, "motivating");
  assert.equal(store.getSnapshot().previewStale, false);
  await store.applyPreferenceChange({ focusMinutes: 25 });
  assert.equal(store.getSnapshot().preferences.focusMinutes, 25);
});
