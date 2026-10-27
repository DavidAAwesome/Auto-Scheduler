import type { ActionTarget, AIProfile, InterpretResult, PendingAction, PendingChoice, PreferenceChange, SchedulePreferences, SchedulePreview, Task, WorkSession } from "../types/models.ts";
import { DEFAULT_AI_PROFILE } from "../types/models.ts";
import type { AssistantReply, PreviewRequest, WorkspaceState } from "./workspaceStore.ts";
import type { AssistantMessage } from "./plannerAssistant.ts";
import { draftsReply } from "./planEntry.ts";
import { eventFromIntent, parseEventRequest, type EventProposal, type PendingEventAction } from "./eventCommands.ts";
import { dateInZone, longDate, minutesInZone } from "../utils/calendar.ts";
import { addDays } from "../utils/dates.ts";
import { zonedInstant } from "../utils/planning.ts";
import { busyTimeText, calendarSessions, explainText, previewText, timeRange, todayAgenda, todayText } from "../utils/schedulePreview.ts";

/** Actions the chat can run. Each one calls the same workspace method the calendar uses. */
export type AssistantCommand =
  | "generate_schedule"
  | "replan"
  | "show_plan"
  | "show_today"
  | "busy_time"
  | "explain_unscheduled"
  | "apply_schedule"
  | "cancel_schedule"
  | "add_task"
  | "delete_task"
  | "add_event"
  | "delete_event";

/** A chat request turned into validated, structured parameters for the scheduling service. */
export type ParsedRequest =
  | { command: Exclude<AssistantCommand, "add_task" | "delete_task" | "add_event" | "delete_event"> }
  | { command: "request_break"; minutes: number }
  | { command: "move_task"; taskId: string; notBefore: string; label: string }
  | { command: "update_preferences"; change: PreferenceChange; summary: string }
  | { command: "propose_event"; action: PendingEventAction; summary: string }
  /** The user's own words, read by the same parser as any plan entry (so "due Friday at noon" keeps its time). */
  | { command: "add_task"; text: string }
  /** Exact task ids; the server shows their names and session count, and deletes only after confirmation. */
  | { command: "delete_task"; taskIds: string[] }
  /** Several tasks fit the request: show a numbered list and resolve the reply against exactly that list. */
  | { command: "pick_tasks"; prompt: string; options: ActionTarget[] }
  | { command: "clarify"; question: string };

/** The subset of the workspace store the commands need; tests pass a store built on a fake transport. */
export interface CommandWorkspace {
  getSnapshot(): WorkspaceState;
  requestPreview(request: PreviewRequest): Promise<SchedulePreview>;
  applySchedulePreview(): Promise<WorkSession[]>;
  clearSchedulePreview(): void;
  /** Reads the user's words into drafts in the review panel; nothing is saved. */
  interpretPlan(text: string): Promise<InterpretResult>;
  proposeDeleteTasks(taskIds: string[]): Promise<PendingAction>;
  proposeCreateItems(): Promise<PendingAction>;
  setChoice(choice: PendingChoice | null): void;
}

export const PLAN_DAYS = 7;

const BREAK = /\b(take|need|want|give me|start|have)\b.*\bbreak\b|\bbreak\b.*\bnow\b|\d+\s*-?\s*(min|minute)s?\s+break/i;
const MOVE = /\b(move|push|postpone|shift|reschedule)\b/i;
const REPLAN = /\breplan\b|\bre-plan\b|\brepair\b|\bfix (my |the )?(plan|schedule)\b|\breschedule (my|the|this)? ?(plan|schedule|week|work)\b/i;
const EXPLAIN = /\bwhy\b|didn.?t fit|doesn.?t fit|unscheduled|not scheduled|couldn.?t (fit|schedule)|unallocated|what.*\bleft\b/i;
const TODAY = /\btoday.?s\s+(tasks?|plan|schedule|agenda)\b|\b(what|anything).*\b(today|my day)\b|\bplan for today\b|^\s*today\s*\??\s*$/i;
const SHOW_PLAN = /\b(show|see|display|view)\b.*\b(plan|schedule)\b|\bmy (plan|schedule)\b/i;
const BUSY = /\bbusy\b|my calendar|what'?s on|free time|events? (today|tomorrow|this week|next week)/i;
const GENERATE = /\bgenerate\b|\bplan (my|the|this|next)\b|\bschedule (my|the|this|next)\b|\b(make|build|create)\b.*\b(plan|schedule)\b/i;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function durationMinutes(text: string): number | null {
  const hours = text.match(/(\d+(?:\.\d+)?)\s*-?\s*(h|hr|hrs|hour|hours)\b/i);
  if (hours) return Math.round(Number(hours[1]) * 60);
  const minutes = text.match(/(\d+)\s*-?\s*(m|min|mins|minute|minutes)\b/i);
  return minutes ? Number(minutes[1]) : null;
}

/** The open task the text names (longest matching title wins), or null. */
function namedTask(text: string, tasks: Task[]) {
  const lower = text.toLowerCase();
  return tasks.filter(t => !t.done && lower.includes(t.title.toLowerCase())).sort((a, b) => b.title.length - a.title.length)[0] ?? null;
}

/** Local start time a move request refers to, as a UTC instant, or null when no target is given. */
function moveTarget(text: string, zone: string, now: Date): { at: string; label: string } | null {
  const today = dateInZone(zone, now);
  const lower = text.toLowerCase();
  const at = (date: string, minute: number, label: string) => ({ at: zonedInstant(date, minute, zone), label });
  if (/\btomorrow\b/.test(lower)) return at(addDays(today, 1), 0, "tomorrow");
  if (/\bnext week\b/.test(lower)) {
    const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    return at(addDays(today, 7 - weekday), 0, "next week");
  }
  if (/\b(this )?evening|tonight\b/.test(lower)) return at(today, 17 * 60, "this evening");
  if (/\b(this )?afternoon\b/.test(lower)) return at(today, 12 * 60, "this afternoon");
  if (/\blater( today)?\b/.test(lower)) return at(today, Math.min(1439, minutesInZone(zone, now) + 60), "later today");
  const day = WEEKDAYS.findIndex(name => lower.includes(name));
  if (day >= 0) {
    const current = new Date(`${today}T12:00:00Z`).getUTCDay();
    const ahead = ((day - current + 7) % 7) || 7;
    return at(addDays(today, ahead), 0, WEEKDAYS[day][0].toUpperCase() + WEEKDAYS[day].slice(1));
  }
  return null;
}

// ---------------------------------------------------------------- personalization

/** Same limits as the backend (SchedulePreferences), so a confirmed change is never rejected on save. */
export const PREFERENCE_LIMITS = { focusMinutes: [10, 240], breakMinutes: [5, 120], maxDailyWorkMinutes: [15, 1440] } as const;
const NOTE_MAX = 150;
/** Words that mark a lasting preference rather than a one-time request ("I need a break now"). */
const PREF_CUE = /\b(i (prefer|like|work best|focus best|study best)|work best|focus best|set my|change my|make my|from now on|always|by default|usually|i can only|no more than|at most)\b/i;
const REMEMBER = /^\s*(please\s+)?remember\s+(that\s+)?(.+?)\s*\.?\s*$/i;

const minutesLabel = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} min`);

function preferenceNumbers(text: string): PreferenceChange {
  const change: PreferenceChange = {};
  const brk = text.match(/(\d+)\s*-?\s*(?:m|min|mins|minute|minutes)\s+breaks?\b/i) ?? text.match(/\bbreaks?\b[^\d]{0,20}(\d+)\s*-?\s*(?:m|min|mins|minute|minutes)\b/i);
  if (brk) change.breakMinutes = Number(brk[1]);
  const focus = text.match(/(\d+)\s*-?\s*(?:m|min|mins|minute|minutes)\s+(?:of\s+)?(?:focus|focused|work|study)?\s*(?:blocks?|sessions?|sprints?|chunks?|stretches?|focus)\b/i)
    ?? text.match(/\b(?:focus|work|study)\s*(?:blocks?|sessions?|length)?\b[^\d]{0,20}(\d+)\s*-?\s*(?:m|min|mins|minute|minutes)\b/i);
  if (focus && !/breaks?/i.test(focus[0])) change.focusMinutes = Number(focus[1]);
  const daily = text.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:h|hr|hrs|hour|hours)\b[^.]{0,25}\b(?:a|per|each)\s+day\b/i);
  if (daily) change.maxDailyWorkMinutes = Math.round(Number(daily[1]) * 60);
  if (/\b(short(er)?|brief(er)?|concise)\b.{0,20}\b(answers?|repl(y|ies)|responses?|messages?)\b|\bkeep (it|them|answers|replies) (short|brief)\b/i.test(text)) change.replyStyle = "concise";
  else if (/\b(more detail(ed)?|detailed|longer)\b.{0,20}\b(answers?|repl(y|ies)|responses?|explanations?)\b|\bexplain more\b/i.test(text)) change.replyStyle = "detailed";
  if (/\b(be|sound) (more )?professional\b/i.test(text)) change.tone = "professional";
  else if (/\b(motivate|motivating|encourage|encouraging|push) me\b|\bbe (more )?(motivating|encouraging)\b/i.test(text)) change.tone = "motivating";
  else if (/\bbe (more )?(friendly|casual)\b/i.test(text)) change.tone = "friendly";
  return change;
}

/**
 * Checks a proposed change against limits and current values. Out-of-range numbers are reported, never
 * clamped, so the user only confirms numbers they asked for. Values that already match are dropped.
 */
export function checkPreferenceChange(change: PreferenceChange | null | undefined, prefs: SchedulePreferences, profile: AIProfile = DEFAULT_AI_PROFILE):
  { change: PreferenceChange; summary: string } | { change: null; summary: string } {
  if (!change) return { change: null, summary: "Which preference should I change? For example: “I work best in 25-minute blocks”." };
  const cleaned: PreferenceChange = {};
  const problems: string[] = [];
  const labels = { focusMinutes: "Focus length", breakMinutes: "Break length", maxDailyWorkMinutes: "Daily task work" } as const;
  for (const key of Object.keys(PREFERENCE_LIMITS) as (keyof typeof PREFERENCE_LIMITS)[]) {
    const value = change[key];
    if (value == null) continue;
    const [low, high] = PREFERENCE_LIMITS[key];
    if (!Number.isInteger(value) || value < low || value > high) problems.push(`${labels[key]} must be ${minutesLabel(low)} to ${minutesLabel(high)}.`);
    else if (value !== prefs[key]) cleaned[key] = value;
  }
  if (change.replyStyle && change.replyStyle !== profile.replyStyle) cleaned.replyStyle = change.replyStyle;
  if (change.tone && change.tone !== profile.tone) cleaned.tone = change.tone;
  const note = (change.rememberNote ?? "").trim();
  if (note) {
    if (note.length > NOTE_MAX) problems.push(`That note is too long to remember; keep it under ${NOTE_MAX} characters.`);
    else if (!profile.aboutMe.toLowerCase().includes(note.toLowerCase())) cleaned.rememberNote = note;
  }
  if (problems.length) return { change: null, summary: problems.join(" ") };
  const parts: string[] = [];
  if (cleaned.focusMinutes != null) parts.push(`focus blocks ${minutesLabel(prefs.focusMinutes)} → ${minutesLabel(cleaned.focusMinutes)}`);
  if (cleaned.breakMinutes != null) parts.push(`breaks ${minutesLabel(prefs.breakMinutes)} → ${minutesLabel(cleaned.breakMinutes)}`);
  if (cleaned.maxDailyWorkMinutes != null) parts.push(`task work per day ${minutesLabel(prefs.maxDailyWorkMinutes)} → ${minutesLabel(cleaned.maxDailyWorkMinutes)}`);
  if (cleaned.replyStyle) parts.push(`reply style ${profile.replyStyle} → ${cleaned.replyStyle}`);
  if (cleaned.tone) parts.push(`tone ${profile.tone} → ${cleaned.tone}`);
  if (cleaned.rememberNote) parts.push(`remember “${cleaned.rememberNote}”`);
  if (!parts.length) return { change: null, summary: "That already matches your current settings, so there is nothing to change." };
  const pacing = cleaned.focusMinutes != null || cleaned.breakMinutes != null || cleaned.maxDailyWorkMinutes != null;
  return {
    change: cleaned,
    summary: `I can update your preferences: ${parts.join("; ")}. Nothing changes until you press Save.${pacing ? " After saving, generate or repair your schedule to use the new pacing." : ""}`,
  };
}

/** A lasting preference stated in plain words ("I work best in 25-minute blocks", "remember I have class Tuesdays"), or null. */
export function parsePreference(text: string, state: Pick<WorkspaceState, "preferences" | "aiProfile">): ParsedRequest | null {
  const remember = text.match(REMEMBER);
  let change: PreferenceChange;
  if (remember) change = { rememberNote: remember[3].replace(/^i\b/i, "I") };
  else if (PREF_CUE.test(text)) {
    change = preferenceNumbers(text);
    if (!Object.keys(change).length) return null;
  } else return null;
  const checked = checkPreferenceChange(change, state.preferences, state.aiProfile ?? DEFAULT_AI_PROFILE);
  return checked.change ? { command: "update_preferences", change: checked.change, summary: checked.summary } : { command: "clarify", question: checked.summary };
}

/** Deterministic interpretation for requests that must never depend on a model's guess. */
function fromEventProposal(proposal: EventProposal): ParsedRequest {
  return proposal.action ? { command: "propose_event", action: proposal.action, summary: proposal.summary } : { command: "clarify", question: proposal.question };
}

/** Which task(s) a delete request means. An exact name picks one; anything else shows a numbered list. */
export function deleteRequest(name: string, tasks: Task[]): ParsedRequest {
  const open = tasks.filter(t => !t.done);
  const label = (t: Task) => ({ id: t.id, title: t.title, detail: `due ${t.deadline}` });
  if (!open.length) return { command: "clarify", question: "You have no open tasks to delete." };
  const wanted = name.replace(/^["“']|["”']$/g, "").trim().toLowerCase();
  const exact = open.filter(t => t.title.trim().toLowerCase() === wanted);
  if (wanted && exact.length === 1) return { command: "delete_task", taskIds: [exact[0].id] };
  const close = wanted ? open.filter(t => t.title.toLowerCase().includes(wanted) || wanted.includes(t.title.toLowerCase())) : open;
  if (close.length === 1 && !exact.length) return { command: "pick_tasks", prompt: `Did you mean this task? Reply 1 to choose it.`, options: [label(close[0])] };
  if (!close.length) return { command: "pick_tasks", prompt: `I couldn’t find a task named “${name}”. Which one should I delete?`, options: open.slice(0, 12).map(label) };
  return { command: "pick_tasks", prompt: exact.length > 1 ? `Several tasks are named “${name}”. Which one?` : "Which task should I delete?", options: close.slice(0, 12).map(label) };
}

export function parseRequest(text: string, state: Pick<WorkspaceState, "tasks" | "availability"> & Partial<Pick<WorkspaceState, "preferences" | "aiProfile" | "events">>, now = new Date()): ParsedRequest | null {
  const zone = state.availability?.timeZone ?? "UTC";
  const open = state.tasks.filter(t => !t.done);
  // Checked first so "I prefer 15-minute breaks" is a setting, not a break starting now.
  if (state.preferences) {
    const preference = parsePreference(text, { preferences: state.preferences, aiProfile: state.aiProfile ?? DEFAULT_AI_PROFILE });
    if (preference) return preference;
  }
  // "Add a meeting tomorrow 3-4pm" / "Delete the event called Project sync": confirmed before anything changes.
  if (state.events) {
    const event = parseEventRequest(text, { events: state.events, availability: state.availability });
    if (event) return fromEventProposal(event);
  }
  if (BREAK.test(text)) {
    const minutes = durationMinutes(text);
    if (minutes === null) return { command: "clarify", question: "How long a break do you need? For example: “I need a 15-minute break now.”" };
    if (minutes < 5 || minutes > 240) return { command: "clarify", question: "Breaks can be 5 minutes to 4 hours. How long should this one be?" };
    if (/\b(at \d|tomorrow|later|tonight|this (afternoon|evening))\b/i.test(text) && !/\bnow\b/i.test(text)) {
      return { command: "clarify", question: "I can start a protected break right now. For a break later, add an event at that time and replan. Start one now?" };
    }
    return { command: "request_break", minutes };
  }
  if (REPLAN.test(text) && !namedTask(text, open)) return { command: "replan" };
  if (MOVE.test(text)) {
    const task = namedTask(text, open) ?? (open.length === 1 ? open[0] : null);
    if (!task) {
      const names = open.slice(0, 5).map(t => `“${t.title}”`).join(", ");
      return { command: "clarify", question: open.length ? `Which task should I move? ${names}` : "You have no open tasks to move." };
    }
    const target = moveTarget(text, zone, now);
    if (!target) return { command: "clarify", question: `When should “${task.title}” start instead? For example “tomorrow” or “this afternoon”.` };
    return { command: "move_task", taskId: task.id, notBefore: target.at, label: `${task.title} to ${target.label}` };
  }
  // "Add a task called Essay, due Friday at noon, 90 minutes": read by the plan-entry parser, then confirmed.
  if (/^\s*(?:please\s+)?(?:add|create)\s+(?:a\s+|an\s+)?(?:new\s+)?tasks?\b/i.test(text)) {
    const rest = text.replace(/^\s*(?:please\s+)?(?:add|create)\s+(?:a\s+|an\s+)?(?:new\s+)?tasks?\s*(?:called|named|:)?\s*/i, "")
      .replace(/,?\s*with a duration of\s+/i, ", ");
    if (!rest.trim()) return { command: "clarify", question: "What is the task? For example: “Add a task: Essay, 90 minutes, due Friday at noon.”" };
    return { command: "add_task", text: rest };
  }
  // "Delete the task called Essay", "remove task essay", "delete a task": exact ids, or a numbered list to pick from.
  const del = text.match(/^\s*(?:please\s+)?(?:delete|remove)\s+(?:the\s+|a\s+|my\s+)?tasks?\b\s*(?:called\s+|named\s+)?(.*?)[.!]?\s*$/i);
  if (del) return deleteRequest(del[1].trim(), state.tasks);
  if (EXPLAIN.test(text)) return { command: "explain_unscheduled" };
  if (TODAY.test(text)) return { command: "show_today" };
  if (SHOW_PLAN.test(text)) return { command: "show_plan" };
  if (BUSY.test(text)) return { command: "busy_time" };
  if (GENERATE.test(text)) return { command: "generate_schedule" };
  return null;
}

/** Older name kept for callers that only need the command. */
export function commandFor(text: string, state: Pick<WorkspaceState, "tasks" | "availability"> = { tasks: [], availability: null }) {
  return parseRequest(text, state)?.command ?? null;
}

/**
 * Turns the model's structured intent into a request the scheduling service runs. Parameters the model gave are
 * checked against the workspace; anything missing or invalid becomes one focused question instead of a guess.
 */
export function requestFromIntent(answer: AssistantReply, state: Pick<WorkspaceState, "tasks"> & Partial<Pick<WorkspaceState, "preferences" | "aiProfile" | "events" | "availability">>, userText = ""): ParsedRequest | null {
  const { intent, params } = answer;
  switch (intent) {
    case "update_preferences": {
      // The server already checked it; check again against what this browser shows before offering Save.
      if (!state.preferences) return params.preferences ? { command: "update_preferences", change: params.preferences, summary: answer.reply } : { command: "clarify", question: answer.reply };
      const checked = checkPreferenceChange(params.preferences, state.preferences, state.aiProfile ?? DEFAULT_AI_PROFILE);
      return checked.change ? { command: "update_preferences", change: checked.change, summary: checked.summary } : { command: "clarify", question: checked.summary };
    }
    case "none":
      return null;
    case "clarify":
      return { command: "clarify", question: answer.reply };
    case "request_break": {
      const minutes = params.breakMinutes;
      if (!minutes || minutes < 5 || minutes > 240) return { command: "clarify", question: "How long a break do you need? For example: “I need a 15-minute break now.”" };
      return { command: "request_break", minutes };
    }
    case "move_task": {
      const task = state.tasks.find(t => t.id === params.taskId && !t.done);
      if (!task) return { command: "clarify", question: "Which task should I move?" };
      if (!params.notBefore || Number.isNaN(Date.parse(params.notBefore))) return { command: "clarify", question: `When should “${task.title}” start instead?` };
      return { command: "move_task", taskId: task.id, notBefore: params.notBefore, label: task.title };
    }
    case "delete_task": {
      // Confirmation is a real pending action with buttons, never a sentence the model has to remember.
      const task = state.tasks.find(t => t.id === params.taskId && !t.done);
      return task ? { command: "delete_task", taskIds: [task.id] } : deleteRequest(params.taskTitle ?? "", state.tasks);
    }
    case "add_task":
      // The model only recognised the request; the user's words go through the plan-entry parser.
      return userText ? { command: "add_task", text: userText.replace(/^\s*(?:please\s+)?(?:add|create)\s+(?:a\s+|an\s+)?(?:new\s+)?tasks?\s*(?:called|named|:)?\s*/i, "") } : { command: "clarify", question: answer.reply };

    case "add_event":
    case "delete_event":
      return fromEventProposal(eventFromIntent(intent, params, { events: state.events ?? [], availability: state.availability ?? null }));

    default:
      return { command: intent };
  }
}

let counter = 0;
function reply(text: string, actions: AssistantCommand[] = [], pendingChange?: PreferenceChange, pendingEvent?: PendingEventAction): AssistantMessage {
  return { id: `cmd-${++counter}`, role: "assistant", text, actions, ...(pendingChange ? { pendingChange } : {}), ...(pendingEvent ? { pendingEvent } : {}) };
}

/** Saves a preference change the user confirmed with the Save button, and reports the real outcome. */
export async function confirmPreferenceChange(change: PreferenceChange, workspace: { applyPreferenceChange(change: PreferenceChange): Promise<unknown> }): Promise<AssistantMessage> {
  try {
    await workspace.applyPreferenceChange(change);
    const pacing = change.focusMinutes != null || change.breakMinutes != null || change.maxDailyWorkMinutes != null;
    return reply(pacing
      ? "Saved. New schedules will use this pacing. Your current saved sessions did not move; repair your schedule to apply it."
      : "Saved. I’ll answer that way from now on. You can change this any time in Settings → AI personalization.",
      pacing ? ["replan"] : []);
  } catch (error) {
    return reply(`Not saved: ${errorText(error)} Nothing was changed.`);
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

function previewActions(preview: SchedulePreview): AssistantCommand[] {
  const changes = preview.sessions.some(s => s.change === "new") || preview.removed.length > 0;
  return changes ? ["apply_schedule", "cancel_schedule"] : ["cancel_schedule"];
}

async function preview(workspace: CommandWorkspace, request: PreviewRequest, intro = "") {
  try {
    const result = await workspace.requestPreview(request);
    return reply(`${intro}${previewText(result)}`, previewActions(result));
  } catch (error) {
    return reply(`I couldn’t build a preview: ${errorText(error)} Nothing was changed or saved.`, ["generate_schedule"]);
  }
}

/** Runs one request and returns the chat message that reports its real outcome. */
export async function runAssistantCommand(request: ParsedRequest | AssistantCommand, workspace: CommandWorkspace, now = new Date()): Promise<AssistantMessage> {
  const req: ParsedRequest =
  typeof request === "string"
    ? { command: request as Exclude<AssistantCommand, "add_task" | "delete_task" | "add_event" | "delete_event"> }
    : request;
  const state = workspace.getSnapshot();
  const zone = state.availability?.timeZone ?? "UTC";
  const today = dateInZone(zone, now);
  const endDate = addDays(today, PLAN_DAYS - 1);

  switch (req.command) {
    case "clarify":
      return reply(req.question);
    case "update_preferences":
      return reply(req.summary, [], req.change);
    case "propose_event":
      return reply(req.summary, [], undefined, req.action);
    case "delete_task":
      try {
        const action = await workspace.proposeDeleteTasks(req.taskIds);
        return { ...reply(`${action.summary} Nothing is deleted until you press Delete.`), actionId: action.id };
      } catch (error) {
        return reply(`I couldn’t prepare that deletion: ${errorText(error)} Nothing was deleted.`);
      }
    case "pick_tasks": {
      workspace.setChoice({ id: `choice-${++counter}`, purpose: "delete_tasks", prompt: req.prompt, options: req.options });
      const lines = req.options.map((o, i) => `${i + 1}. ${o.title}${o.detail ? ` (${o.detail})` : ""}`);
      return reply(`${req.prompt}\n${lines.join("\n")}\nReply with a number, or several like “1 and 3”. Nothing is deleted yet.`);
    }
    case "generate_schedule":
      return preview(workspace, { kind: "generate", horizonDays: PLAN_DAYS });
    case "replan":
      return preview(workspace, { kind: "repair", horizonDays: PLAN_DAYS }, "Repairing your saved plan; unaffected sessions stay where they are.\n");
    case "move_task":
      return preview(workspace, { kind: "repair", horizonDays: PLAN_DAYS, moves: [{ taskId: req.taskId, notBefore: req.notBefore }] }, `Moving ${req.label}.\n`);
    case "request_break": {
      try {
        const result = await workspace.requestPreview({ kind: "break", minutes: req.minutes });
        const brk = result.sessions.find(s => s.type === "break" && s.locked && s.change === "new");
        const conflict = result.conflicts.find(c => c.code === "break_conflict" || c.code === "break_shortened");
        const displaced = result.removed.some(r => r.session.type === "work");
        const head = brk
          ? `Proposed protected break ${timeRange(brk.start, brk.end)}.${conflict ? ` ${conflict.message}` : ""}${displaced ? " Flexible work it displaced is replanned below." : " No work had to move."}\n`
          : `No break was added: ${conflict?.message ?? "there is no free time right now."}\n`;
        return reply(`${head}${previewText(result)}`, brk ? previewActions(result) : ["cancel_schedule"]);
      } catch (error) {
        return reply(`I couldn’t plan a break: ${errorText(error)} Nothing was changed.`);
      }
    }
    case "apply_schedule": {
      if (!state.schedulePreview) return reply("There is no proposed schedule to apply. Say “plan my week” to build one.", ["generate_schedule"]);
      try {
        const saved = await workspace.applySchedulePreview();
        const upcoming = saved.filter(s => s.status === "saved" && new Date(s.endAt) > now);
        const breaks = upcoming.filter(s => s.type === "break").length;
        return reply(`Saved. Your schedule now has ${upcoming.length - breaks} upcoming work session(s) and ${breaks} break(s). They will still be there after a refresh.`, ["show_today"]);
      } catch (error) {
        const stillPending = workspace.getSnapshot().schedulePreview !== null;
        return reply(`Not saved: ${errorText(error)}`, stillPending ? ["apply_schedule", "cancel_schedule"] : ["generate_schedule"]);
      }
    }
    case "cancel_schedule":
      workspace.clearSchedulePreview();
      return reply("Proposal discarded. Nothing was changed.");
    case "show_today":
      return reply(todayText(todayAgenda(state, today), today, zone, state.tasks), state.schedulePreview ? ["apply_schedule", "cancel_schedule"] : []);
    case "explain_unscheduled":
      return reply(explainText(state.schedulePreview, state.tasks, state.sessions, now), state.schedulePreview ? [] : ["generate_schedule"]);
    case "show_plan": {
      if (state.schedulePreview) return reply(previewText(state.schedulePreview), previewActions(state.schedulePreview));
      const upcoming = calendarSessions(state.sessions, null)
        .map(item => item.session)
        .filter(s => s.date >= today && s.date <= endDate && s.status === "saved");
      if (!upcoming.length) return reply("There is no proposed schedule and no saved sessions for the next 7 days.", ["generate_schedule"]);
      const lines = [`Saved schedule, next ${PLAN_DAYS} days. Nothing is pending.`];
      let day = "";
      for (const s of upcoming) {
        if (s.date !== day) lines.push(longDate((day = s.date)));
        lines.push(`• ${timeRange(s.start, s.end)} ${s.type === "break" ? "Break" : `${s.title}${s.source === "auto" ? "" : " (placed by you)"}`}`);
      }
      return reply(lines.join("\n"));
    }
    case "busy_time":
      return reply(busyTimeText(state.events, state.sessions, state.tasks, today, PLAN_DAYS, state.connections.length > 0));
    
    case "add_task": {
      try {
        const result = await workspace.interpretPlan(req.text);
        const text = draftsReply(result.drafts, result.provider, result.notes);
        const selected = result.drafts.filter(v => v.draft.include);
        if (!selected.length || selected.some(v => !v.ready)) return reply(text);
        const action = await workspace.proposeCreateItems();
        return { ...reply(`${text}\nConfirm to save ${selected.length === 1 ? "it" : "them"} as ${selected.length === 1 ? "a task" : "tasks"} now (not scheduled yet), or Edit them in the review panel.`), actionId: action.id };
      } catch (error) {
        return reply(`I couldn’t read that task: ${errorText(error)} Nothing was saved.`);
      }
    }
  }
return reply("This command is not supported yet.");
}
