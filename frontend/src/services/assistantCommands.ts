import type { ActionTarget, AIProfile, InterpretResult, PendingAction, PendingChoice, PreferenceChange, SchedulePreferences, SchedulePreview, SplitOptions, Task, WorkSession } from "../types/models.ts";
import { DEFAULT_AI_PROFILE } from "../types/models.ts";
import type { AssistantReply, PreviewRequest, WorkspaceState } from "./workspaceStore.ts";
import type { AssistantMessage } from "./plannerAssistant.ts";
import { draftsReply, looksLikePlanEntry } from "./planEntry.ts";
import { eventFromIntent, nextWeekday, parseDate, parseEventRequest, parseTimes, type EventProposal, type PendingEventAction } from "./eventCommands.ts";
import { clock12, dateInZone, longDate, minutesInZone } from "../utils/calendar.ts";
import { addDays } from "../utils/dates.ts";
import { zonedInstant } from "../utils/planning.ts";
import { busyDayText, busyTimeText, calendarSessions, explainText, previewText, splitOptionsText, timeRange, todayAgenda, todayText } from "../utils/schedulePreview.ts";
import { accountTimeZone } from "../utils/timeZones.ts";

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
  /** "What do I have on Saturday?" / "Is Friday at 3pm free?": that day's busy time, read from the calendar. */
  | { command: "busy_day"; date: string; at: number | null }
  | { command: "move_task"; taskId: string; notBefore: string; label: string }
  /** Compare ways to divide saved tasks, or the task drafts under review. */
  | { command: "split_options"; target: string[] | "drafts" }
  | { command: "update_preferences"; change: PreferenceChange; summary: string }
  | { command: "propose_event"; action: PendingEventAction; summary: string }
  /** The user's own words, read by the same parser as any plan entry (so "due Friday at noon" keeps its time). */
  | { command: "add_task"; text: string }
  /** Exact task ids; the server shows their names and session count, and deletes only after confirmation. */
  | { command: "delete_task"; taskIds: string[] }
  /** Saved breaks; the server lists them and deletes only after confirmation. */
  | { command: "delete_breaks" }
  /** Several tasks fit the request: show a numbered list and resolve the reply against exactly that list. */
  | { command: "pick_tasks"; prompt: string; options: ActionTarget[] }
  | { command: "clarify"; question: string };

/** The subset of the workspace store the commands need; tests pass a store built on a fake transport. */
export interface CommandWorkspace {
  getSnapshot(): WorkspaceState;
  requestPreview(request: PreviewRequest): Promise<SchedulePreview>;
  requestSplitOptions(taskIds: string[]): Promise<SplitOptions>;
  previewDraftSplitOptions(): Promise<SplitOptions>;
  applySchedulePreview(): Promise<WorkSession[]>;
  clearSchedulePreview(): void;
  /** Reads the user's words into drafts in the review panel; nothing is saved. */
  interpretPlan(text: string): Promise<InterpretResult>;
  proposeDeleteTasks(taskIds: string[]): Promise<PendingAction>;
  proposeDeleteBreaks(): Promise<PendingAction>;
  proposeCreateItems(): Promise<PendingAction>;
  setChoice(choice: PendingChoice | null): void;
}

export const PLAN_DAYS = 7;

const BREAK = /\b(take|need|want|give me|start|have)\b.*\bbreak\b|\bbreak\b.*\bnow\b|\d+\s*-?\s*(min|minute)s?\s+break/i;
/** A break described for some other time ("after class", "at 3pm") is not a break starting now. */
const BREAK_LATER = /\b(at \d|at noon|\d\s*(am|pm)|tomorrow|later|tonight|this (afternoon|evening)|after|before|when|once|until|in \d+ (min|minute|hour)s?)\b/i;
/** Habits ("I usually take a break around noon") are preferences or chat, not a request for a break now. */
const HABIT = /\b(usually|always|normally|often|sometimes|every day|daily|tend to|like to)\b/i;
const EDIT_TASK = /\b(change|move|push|extend|set|update|edit|make)\b.*\b(deadline|due date|due time)\b|\b(deadline|due date)\b.*\b(to|until|be)\b\s+\w|\b(change|edit|update|set)\b.*\b(duration|length|estimate)\b/i;
const DAY_QUESTION = /^\s*(?:what(?:'?s| is| do i have| have i got| am i doing)|anything|am i (?:free|busy)|is\b.*\b(?:free|busy|open|available)\b|do i have anything)\b.*\b(?:today|tomorrow|tonight|(?:next |this )?(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun))\b|^\s*(?:is|am i)\b.*\b(?:free|busy|open|available)\b/i;
const DONE_QUESTION = /^\s*(?:did i (?:finish|complete|do|submit)|have i (?:finished|completed|done|submitted)|is (?:my |the )?.+\b(?:done|finished|complete|completed)\b)/i;
const WHAT_FIRST = /\b(?:what|which)(?: task)? (?:should|do) i (?:work on|do|start(?: with)?|tackle|focus on)(?: first| next| now)\b|\bwhat(?:'?s| is) (?:first|next|my next task|most urgent)\b|\bwhere (?:should|do) i start\b/i;
const TASKS_LEFT = /\bhow many (?:open |more )?tasks\b|\bwhat tasks (?:do i have )?(?:are )?(?:left|remaining|open)\b|\b(?:list|show) (?:my )?(?:open |remaining )?tasks\b/i;
const PRIORITY_RANK: Record<string, number> = { High: 0, Medium: 1, Low: 2 };

function minutesText(minutes: number) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
}

/** By deadline, then priority; a task never comes before a task it depends on. */
export function orderedTasks(tasks: Task[]): Task[] {
  const key = (t: Task) => `${t.deadline} ${String(t.dueTime).padStart(4, "0")} ${PRIORITY_RANK[t.priority] ?? 1}`;
  const pending = [...tasks].sort((a, b) => key(a).localeCompare(key(b)));
  const ids = new Set(tasks.map(t => t.id));
  const placed: Task[] = [];
  while (pending.length) {
    const i = pending.findIndex(t => t.dependsOn.every(d => !ids.has(d) || placed.some(p => p.id === d)));
    placed.push(...pending.splice(i < 0 ? 0 : i, 1)); // a dependency loop falls back to deadline order
  }
  return placed;
}
// "What's the weather tomorrow?" names a day but isn't about the calendar.
const NOT_CALENDAR = /\b(weather|forecast|rain|snow|temperature|news|score|game on tv)\b/i;
const MOVE = /\b(move|push|postpone|shift|reschedule|delay)\b/i;
const REPLAN = /\breplan\b|\bre-plan\b|\brepair\b|\bfix (my |the )?(plan|schedule)\b|\breschedule (my|the|this)? ?(plan|schedule|week|work)\b/i;
const EXPLAIN = /\bwhy\b.*\b(fit|scheduled|planned|placed|unscheduled|left out|missing)\b|didn.?t fit|doesn.?t fit|unscheduled|not scheduled|couldn.?t (fit|schedule)|unallocated|what.*\bleft\b.*\b(schedule|plan|fit)\b/i;
const TODAY = /\btoday.?s\s+(tasks?|plan|schedule|agenda)\b|\b(what|anything).*\b(today|my day)\b|\bplan for today\b|^\s*today\s*\??\s*$/i;
const SHOW_PLAN = /\b(show|see|display|view)\b.*\b(plan|schedule)\b|^\s*(what'?s|what is)?\s*my (plan|schedule)\s*\??\s*$/i;
const BUSY = /^\s*busy( time)?\s*\??\s*$|\b(when|am) i (busy|free)\b|\bbusy (time|today|tomorrow|this week|next week)\b|\bmy calendar\b|what'?s on (my|the) (calendar|schedule)|what'?s on (today|tomorrow)|\bfree time\b|events? (today|tomorrow|this week|next week)/i;
const GENERATE = /\bgenerate\b|\b(plan|schedule) (my|the|this|next) (week|days?|schedule|plan|tasks|work)\b|^\s*(plan|schedule) my\b|\b(make|build|create)\b.*\b(plan|schedule)\b/i;
/** Extra conditions on a whole-week plan that chat cannot apply ("but keep Friday free"). */
const PLAN_CONDITION = /\b(but|except|without|only|keep\b.*\bfree|leave\b.*\bfree|not on|no work on|avoid)\b/i;
/** Asking for a task at a chosen time: "schedule my essay for tomorrow at 3pm", "do Asm Friday afternoon". */
const SCHEDULE_TASK = /\b(schedule|plan|do|work on|start|put)\b/i;
const EVENT_WORDS = /\b(meeting|class|lecture|appointment|appt|event|lunch|dinner|call|party)\b/i;
const SPLIT_VERB = String.raw`(?:split|splitting|divide|dividing|spread|spreading|break(?:ing)? (?:\w+ )?up)`;
const SPLIT_NOUN = "(?:ways?|options?|alternatives?|choices?)";
const SPLIT_OPTIONS = new RegExp([
  String.raw`\b${SPLIT_NOUN}\b.*\b${SPLIT_VERB}\b`,
  String.raw`\b${SPLIT_VERB}\b.*\b${SPLIT_NOUN}\b`,
  String.raw`\bhow (?:should|can|could|would|do|to)\b.*\b${SPLIT_VERB}\b`,
  String.raw`^\s*(?:please\s+|can you\s+|could you\s+)?${SPLIT_VERB}\s+(?:them|it|these|those|this|that|my tasks?|the tasks?)\b`,
].join("|"), "i");
const DELETE_BREAKS = /\b(?:delete|remove|clear|cancel|drop|get rid of)\b.*\bbreaks?\b/i;
const TRAILING_REQUEST = /(?:[,;.\n]\s*|\s+(?:and|then)\s+)((?:(?:and|then|also|please)\s+)*(?:show|give|compare|list|what|how|can you|could you|split|divide|break)\b[^,;\n]*)[.!?]?\s*$/i;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function durationMinutes(text: string): number | null {
  const compact = text.match(/(\d+)\s*h\s*(\d{1,2})\b/i); // "1h30"
  if (compact) return Number(compact[1]) * 60 + Number(compact[2]);
  if (/\bhalf (an )?hour\b/i.test(text)) return 30;
  if (/\b(an|one) hour and a half\b|\bhour and a half\b/i.test(text)) return 90;
  const hours = text.match(/(\d+(?:\.\d+)?)\s*-?\s*(h|hr|hrs|hour|hours)\b/i);
  if (hours) return Math.round(Number(hours[1]) * 60);
  if (/\b(an|one) hour\b/i.test(text)) return 60;
  const minutes = text.match(/(\d+)\s*-?\s*(m|min|mins|minute|minutes)\b/i);
  return minutes ? Number(minutes[1]) : null;
}

/** The open task the text names (longest matching title wins), or null. */
function namedTask(text: string, tasks: Task[]) {
  const lower = text.toLowerCase();
  return tasks.filter(t => !t.done && lower.includes(t.title.toLowerCase())).sort((a, b) => b.title.length - a.title.length)[0] ?? null;
}

/** The task's next saved work session that has not started yet, if any. */
function nextSession(task: Task, sessions: WorkSession[] | undefined, now: Date) {
  return (sessions ?? []).filter(s => s.taskId === task.id && s.type === "work" && s.status === "saved" && new Date(s.startAt) > now)
    .sort((a, b) => a.startAt.localeCompare(b.startAt))[0] ?? null;
}

/**
 * A move that can't finish before the task is due is refused with the reason, instead of a preview that quietly
 * unschedules the task ("schedule my lab report for tomorrow" when it is due tonight).
 */
function deadlineBlocks(task: Task, notBefore: string, zone: string, now: Date): ParsedRequest | null {
  if (!task.deadline) return null;
  const due = new Date(zonedInstant(task.deadline, Math.min(task.dueTime ?? 1439, 1439) + 1, zone)).getTime();
  const start = Math.max(Date.parse(notBefore), now.getTime());
  const needed = Math.max(0, task.remainingMinutes ?? task.minutes ?? 0) * 60_000;
  if (start + needed <= due) return null;
  const today = dateInZone(zone, now);
  const dueText = `${dayWord(task.deadline, today)} at ${clock12(Math.min(task.dueTime ?? 1439, 1439))}`;
  const why = start >= due ? "so its work can't start after that" : `and its ${task.remainingMinutes} minutes of work wouldn't finish by then`;
  return { command: "clarify", question: `“${task.title}” is due ${dueText}, ${why}. Nothing was changed. To work on it later, change its deadline in the task list first, or pick an earlier time.` };
}

/** How a local date reads in a reply: "today", "tomorrow" or "Fri, Nov 20, 2026". */
function dayWord(date: string, today: string) {
  return date === today ? "today" : date === addDays(today, 1) ? "tomorrow" : longDate(date);
}

/**
 * The earliest start a move request asks for, as a UTC instant, or null when no target is given.
 * Reads a day and a clock time together ("3pm tomorrow", "next Friday at 10"), relative shifts
 * ("back a day", "2 hours later"), and parts of the day. `assumed` says what was filled in.
 */
export function moveTarget(text: string, zone: string, now: Date, task?: Task, sessions?: WorkSession[]): { at: string; label: string; assumed?: string } | null {
  const today = dateInZone(zone, now);
  const lower = text.toLowerCase();
  const at = (date: string, minute: number, label: string, assumed?: string) => ({ at: zonedInstant(date, minute, zone), label, ...(assumed ? { assumed } : {}) });

  // "push it back a day", "2 hours later": relative to the task's next saved session (or now).
  const shift = lower.match(/\b(?:back|forward|later|by)\b.*?\b(a|an|one|two|three|\d+)\s+(day|days|hour|hours)\b|\b(a|an|one|two|three|\d+)\s+(day|days|hour|hours)\s+(later|back)\b/);
  if (shift) {
    const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3 };
    const raw = shift[1] ?? shift[3];
    const amount = words[raw] ?? Number(raw);
    const unit = (shift[2] ?? shift[4]).startsWith("day") ? 24 * 60 : 60;
    const session = task ? nextSession(task, sessions, now) : null;
    const base = session ? new Date(session.startAt) : now;
    const moved = new Date(base.getTime() + amount * unit * 60_000);
    const label = `${dayWord(dateInZone(zone, moved), today)} at ${clock12(minutesInZone(zone, moved))}`;
    return { at: moved.toISOString(), label, ...(session ? {} : { assumed: "it has no upcoming session, so I counted from now" }) };
  }

  // A clock time, with or without a day.
  const clock = /\d\s*(am|pm|a\.m\.|p\.m\.)|\b(at|@)\s*\d|\bnoon\b|\bmidnight\b/i.test(text) ? parseTimes(text) : null;
  const named = parseDate(text, today);
  if (clock) {
    const minute = clock.start % 1440;
    let date = named;
    let assumed: string | undefined;
    if (!date) {
      date = minute > minutesInZone(zone, now) ? today : addDays(today, 1);
      if (date !== today) assumed = `${clock12(minute)} has passed today`;
    }
    if (clock.assumed.includes("am/pm")) assumed = [assumed, `I read it as ${clock12(minute)}`].filter(Boolean).join("; ");
    if (nextWeekday(text)) assumed = [assumed, `“next” means the week after this one`].filter(Boolean).join("; ");
    return at(date, minute, `${dayWord(date, today)} at ${clock12(minute)}`, assumed);
  }

  if (/\btomorrow\b/.test(lower)) {
    const evening = /\b(evening|night)\b/.test(lower) ? 17 * 60 : /\bafternoon\b/.test(lower) ? 12 * 60 : /\bmorning\b/.test(lower) ? 8 * 60 : 0;
    return at(addDays(today, 1), evening, evening ? `tomorrow ${evening === 17 * 60 ? "evening" : evening === 12 * 60 ? "afternoon" : "morning"}` : "tomorrow");
  }
  if (/\bnext week\b/.test(lower)) {
    const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    return at(addDays(today, 7 - weekday), 0, "next week");
  }
  if (/\b(this )?evening\b|\btonight\b/.test(lower)) return at(today, 17 * 60, "this evening");
  if (/\b(this )?afternoon\b/.test(lower)) return at(today, 12 * 60, "this afternoon");
  if (/\blater( today)?\b/.test(lower)) return at(today, Math.min(1439, minutesInZone(zone, now) + 60), "later today");
  if (named && named !== today) {
    const label = nextWeekday(text) ? longDate(named) : WEEKDAYS.some(name => lower.includes(name)) ? WEEKDAYS[(new Date(`${named}T12:00:00Z`).getUTCDay())].replace(/^./, c => c.toUpperCase()) : longDate(named);
    return at(named, 0, label, nextWeekday(text) ? `“next” means the week after this one` : undefined);
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
  const daily = text.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:h|hr|hrs|hour|hours)\b[^.]{0,25}(?:\b(?:a|per|each)\s+|\/\s*)day\b/i);
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
  if (!close.length) {
    // "remove task gym" when Gym is already done: say that, rather than "couldn't find".
    const finished = tasks.find(t => t.done && t.title.trim().toLowerCase() === wanted);
    const prompt = finished ? `“${finished.title}” is already done, so it isn’t in your open tasks. Did you mean one of these?` : `I couldn’t find a task named “${name}”. Which one should I delete?`;
    return { command: "pick_tasks", prompt, options: open.slice(0, 12).map(label) };
  }
  return { command: "pick_tasks", prompt: exact.length > 1 ? `Several tasks are named “${name}”. Which one?` : "Which task should I delete?", options: close.slice(0, 12).map(label) };
}

/** Separates a trailing "show me ways to split them" from the items before it, so it is not read as part of an item. */
export function splitFromEntry(text: string) {
  const match = text.match(TRAILING_REQUEST);
  if (!match || !SPLIT_OPTIONS.test(match[1])) return { entry: text, wantsSplit: false };
  return { entry: text.slice(0, match.index).trim(), wantsSplit: true };
}

/** What a request to compare splits refers to: tasks it names, else the drafts under review, else the open tasks. */
function splitRequest(text: string, state: Pick<WorkspaceState, "tasks"> & Partial<Pick<WorkspaceState, "planDrafts">>, taskId?: string | null): ParsedRequest {
  const lower = text.toLowerCase();
  const mentions = (title: string | null) => !!title && lower.includes(title.toLowerCase());
  const drafts = (state.planDrafts?.views ?? []).filter(v => v.draft.include && v.draft.kind === "task");
  const open = state.tasks.filter(t => !t.done && t.allowSplit && t.kind !== "flexible_event" && t.remainingMinutes > 0);
  const named = open.filter(t => t.id === taskId || mentions(t.title));
  if (drafts.some(v => mentions(v.draft.title)) || (!named.length && drafts.length)) return { command: "split_options", target: "drafts" };
  if (named.length) return { command: "split_options", target: named.map(t => t.id) };
  if (!open.length) return { command: "clarify", question: "You have no open tasks to split. Add one with its length and deadline first." };
  if (open.length === 1) return { command: "split_options", target: [open[0].id] };
  if (/\b(it|this|that)\b/i.test(text)) return { command: "clarify", question: `Which task should I split? ${open.slice(0, 5).map(t => `“${t.title}”`).join(", ")}` };
  return { command: "split_options", target: open.map(t => t.id) };
}

export function parseRequest(text: string, state: Pick<WorkspaceState, "tasks" | "availability"> & Partial<Pick<WorkspaceState, "preferences" | "aiProfile" | "events" | "sessions" | "planDrafts">>, now = new Date()): ParsedRequest | null {
  const zone = accountTimeZone(state.availability);
  const open = state.tasks.filter(t => !t.done);
  // Checked first so "I prefer 15-minute breaks" is a setting, not a break starting now.
  if (state.preferences) {
    const preference = parsePreference(text, { preferences: state.preferences, aiProfile: state.aiProfile ?? DEFAULT_AI_PROFILE });
    if (preference) return preference;
  }
  if (DELETE_BREAKS.test(text)) return { command: "delete_breaks" };
  // "Add a meeting tomorrow 3-4pm" / "Delete the event called Project sync": confirmed before anything changes.
  if (state.events) {
    const event = parseEventRequest(text, { events: state.events, availability: state.availability });
    if (event) return fromEventProposal(event);
  }
  // Before BREAK and MOVE, and before the chat treats the message as an answer to an open draft question.
  if (SPLIT_OPTIONS.test(text) && !looksLikePlanEntry(text)) return splitRequest(text, state);
  if (BREAK.test(text) && !(HABIT.test(text) && !/\bnow\b/i.test(text))) {
    const minutes = durationMinutes(text);
    const later = BREAK_LATER.test(text) && !/\bnow\b/i.test(text);
    if (later) {
      return { command: "clarify", question: `I can only start a protected break right now. For a break ${/\bafter\b/i.test(text) ? "after that" : "later"}, add an event at that time and repair your schedule. To start one now, say “${minutes ?? 15}-minute break now”.` };
    }
    if (minutes === null) return { command: "clarify", question: "How long a break do you need? For example: “I need a 15-minute break now.”" };
    if (minutes < 5 || minutes > 240) return { command: "clarify", question: "Breaks can be 5 minutes to 4 hours. How long should this one be?" };
    return { command: "request_break", minutes };
  }
  // "Change the essay deadline to Monday": chat can't edit a task, and must not pretend to (or move it instead).
  if (EDIT_TASK.test(text)) {
    const task = namedTask(text, open);
    return { command: "clarify", question: `I can't change ${task ? `“${task.title}”'s` : "a task's"} deadline or length from chat yet. Open it in the task list to edit it; then say “plan my week” to fit it in.` };
  }
  if (REPLAN.test(text) && !namedTask(text, open)) return { command: "replan" };
  if (MOVE.test(text)) {
    const task = namedTask(text, open);
    const target = moveTarget(text, zone, now, task ?? undefined, state.sessions);
    if (!task) {
      // Events are fixed: chat can't move them, and a meeting is never mistaken for a task.
      const event = (state.events ?? []).find(e => text.toLowerCase().includes(e.title.toLowerCase()));
      if (event || EVENT_WORDS.test(text)) {
        return { command: "clarify", question: `I can't move ${event ? `“${event.title}”` : "events"} from chat yet. Events stay where you put them: change it on the calendar, or delete it and add it again at the new time.` };
      }
      // "shift my focus", "move on": not a move unless it names a target or refers to a task.
      if (!target && !/\b(it|this|that|task)\b/i.test(text)) return null;
      const names = open.slice(0, 5).map(t => `“${t.title}”`).join(", ");
      return { command: "clarify", question: open.length ? `Which task should I move? ${names}` : "You have no open tasks to move." };
    }
    if (!target) return { command: "clarify", question: `When should “${task.title}” start instead? For example “tomorrow at 3pm” or “this afternoon”.` };
    const blocked = deadlineBlocks(task, target.at, zone, now);
    if (blocked) return blocked;
    return { command: "move_task", taskId: task.id, notBefore: target.at, label: `${task.title} to ${target.label}${target.assumed ? ` (${target.assumed})` : ""}` };
  }
  // "Schedule my essay for tomorrow at 3pm": a preferred start for one task, not a new week plan.
  if (SCHEDULE_TASK.test(text)) {
    const task = namedTask(text, open);
    const target = task ? moveTarget(text, zone, now, task, state.sessions) : null;
    if (task && target) return deadlineBlocks(task, target.at, zone, now) ?? { command: "move_task", taskId: task.id, notBefore: target.at, label: `${task.title} to ${target.label}${target.assumed ? ` (${target.assumed})` : ""}` };
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
  // "Did I finish the gym task?": answered from the task list (the model mixed up a done task and an event).
  if (DONE_QUESTION.test(text)) {
    const lower = text.toLowerCase();
    const task = state.tasks.filter(t => lower.includes(t.title.toLowerCase())).sort((a, b) => b.title.length - a.title.length)[0];
    if (task) {
      return { command: "clarify", question: task.done
        ? `Yes, “${task.title}” is marked done.`
        : `Not yet: “${task.title}” is still open${task.deadline ? `, due ${task.deadline}` : ""}. Mark it done in the task list when you finish.` };
    }
  }
  // "What should I work on first?" / "How many tasks do I have left?": counted and ordered from the task list
  // (the model got the counts and remaining minutes wrong).
  if (WHAT_FIRST.test(text) || (TASKS_LEFT.test(text) && !/\b(today|tonight|tomorrow)\b/i.test(text))) {
    const today = dateInZone(zone, now);
    const tasks = orderedTasks(open.filter(t => (t.kind ?? "task") === "task"));
    if (!tasks.length) return { command: "clarify", question: "You have no open tasks. Nice work!" };
    const line = (t: Task, i: number) => {
      const after = t.dependsOn.map(id => open.find(o => o.id === id)?.title).filter(Boolean);
      return `${i + 1}. ${t.title}: due ${dayWord(t.deadline, today)} at ${clock12(t.dueTime >= 1439 ? 1439 : t.dueTime)}, ${minutesText(t.remainingMinutes)} left${after.length ? ` (after ${after.join(", ")})` : ""}`;
    };
    const lines = tasks.map(line).join("\n");
    const late = tasks.filter(t => t.deadline < today);
    const lateNote = late.length ? `\n${late.map(t => `“${t.title}”`).join(", ")} ${late.length === 1 ? "is" : "are"} past due.` : "";
    return { command: "clarify", question: WHAT_FIRST.test(text)
      ? `Start with “${tasks[0].title}”. In order of deadline:\n${lines}${lateNote}`
      : `You have ${tasks.length} open task${tasks.length === 1 ? "" : "s"}:\n${lines}${lateNote}` };
  }
  if (EXPLAIN.test(text)) return { command: "explain_unscheduled" };
  if (TODAY.test(text) && !NOT_CALENDAR.test(text)) return { command: "show_today" };
  if (SHOW_PLAN.test(text)) return { command: "show_plan" };
  // A question about one named day is answered from the calendar, not by the model (it mislabels weekdays).
  if (DAY_QUESTION.test(text) && !/\b(due|deadline)\b/i.test(text) && !NOT_CALENDAR.test(text)) {
    const today = dateInZone(zone, now);
    const date = parseDate(text, today);
    if (date) {
      const times = parseTimes(text);
      return { command: "busy_day", date, at: times ? times.start : null };
    }
  }
  if (BUSY.test(text)) return { command: "busy_time" };
  if (GENERATE.test(text)) {
    if (PLAN_CONDITION.test(text)) {
      return { command: "clarify", question: "I can plan the week, but I can't apply that condition from chat yet. Block the time first (add an event, or turn the day off in Availability), then say “plan my week”. Or say “plan my week” to plan without it." };
    }
    return { command: "generate_schedule" };
  }
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
export function requestFromIntent(answer: AssistantReply, state: Pick<WorkspaceState, "tasks"> & Partial<Pick<WorkspaceState, "preferences" | "aiProfile" | "events" | "availability" | "planDrafts">>, userText = "", now = new Date()): ParsedRequest | null {
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
    case "split_options":
      return splitRequest(userText, state, params.taskId);
    case "delete_breaks":
      return { command: "delete_breaks" };
    case "move_task": {
      const task = state.tasks.find(t => t.id === params.taskId && !t.done);
      if (!task) return { command: "clarify", question: "Which task should I move?" };
      if (!params.notBefore || Number.isNaN(Date.parse(params.notBefore))) return { command: "clarify", question: `When should “${task.title}” start instead?` };
      const zone = accountTimeZone(state.availability ?? null);
      const when = new Date(params.notBefore);
      const day = dateInZone(zone, when);
      const today = dateInZone(zone, now);
      const blocked = deadlineBlocks(task, params.notBefore, zone, now);
      if (blocked) return blocked;
      return { command: "move_task", taskId: task.id, notBefore: params.notBefore, label: `${task.title} to ${dayWord(day, today)} at ${clock12(minutesInZone(zone, when))}` };
    }
    case "delete_task": {
      // Confirmation is a real pending action with buttons, never a sentence the model has to remember.
      const task = state.tasks.find(t => t.id === params.taskId && !t.done);
      return task ? { command: "delete_task", taskIds: [task.id] } : deleteRequest(params.taskTitle ?? "", state.tasks);
    }
    case "add_task": {
      // The model may have gathered the details over several turns ("Essay, 2 hours" … "Friday"): use them.
      const title = params.taskTitle?.trim();
      if (title) {
        const parts = [title, params.taskDuration ? `${params.taskDuration} minutes` : "", params.taskDeadline ? `due ${params.taskDeadline}` : ""];
        return { command: "add_task", text: parts.filter(Boolean).join(", ") };
      }
      // Otherwise the user's own words go through the plan-entry parser.
      return userText ? { command: "add_task", text: userText.replace(/^\s*(?:please\s+)?(?:add|create)\s+(?:a\s+|an\s+)?(?:new\s+)?tasks?\s*(?:called|named|:)?\s*/i, "") } : { command: "clarify", question: answer.reply };
    }

    case "add_event":
    case "delete_event":
      return fromEventProposal(eventFromIntent(intent, params, { events: state.events ?? [], availability: state.availability ?? null }, userText, now));

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
  const zone = accountTimeZone(state.availability);
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
      return preview(workspace, { kind: "repair", horizonDays: PLAN_DAYS, moves: [{ taskId: req.taskId, notBefore: req.notBefore }] }, `Moving ${req.label}. Its work starts no earlier than that; the deadline doesn't change.\n`);
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
        const upcoming = saved.filter(s => s.status === "saved" && s.type === "work" && new Date(s.endAt) > now);
        return reply(`Saved. Your schedule now has ${upcoming.length} upcoming work session(s). They will still be there after a refresh.`, ["show_today"]);
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
      const upcoming = calendarSessions(state.sessions, null, { preferences: state.preferences, events: state.events, tasks: state.tasks })
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
    case "busy_day":
      return reply(busyDayText(state.events, state.sessions, state.tasks, req.date, req.at));
    
    case "delete_breaks": {
      if (!state.sessions.some(s => s.type === "break" && s.status === "saved")) {
        return reply("You have no saved breaks to delete. The short breaks between work sessions aren’t saved: AutoPlan draws them from your sessions, and they go away with the work around them.");
      }
      try {
        const action = await workspace.proposeDeleteBreaks();
        return { ...reply(`${action.summary} Nothing is deleted until you confirm.`), actionId: action.id };
      } catch (error) {
        return reply(`I couldn’t do that: ${errorText(error)}`);
      }
    }
    case "split_options": {
      try {
        const split = req.target === "drafts" ? await workspace.previewDraftSplitOptions() : await workspace.requestSplitOptions(req.target);
        return reply(splitOptionsText(split), ["apply_schedule", "cancel_schedule"]);
      } catch (error) {
        if (/too short to split/.test(errorText(error))) return reply(errorText(error)); // an answer, not a failure
        return reply(`I couldn’t build split options: ${errorText(error)} Nothing was changed.`);
      }
    }
    case "add_task": {
      try {
        const result = await workspace.interpretPlan(req.text);
        const text = draftsReply(result.drafts, result.provider, result.notes);
        const selected = result.drafts.filter(v => v.draft.include);
        if (!selected.length || selected.some(v => !v.ready)) return reply(text);
        const action = await workspace.proposeCreateItems();
        // Confirming saves everything ticked in the panel, not only what this message added, so say exactly that.
        const names = action.targets.map(t => `“${t.title}”`).join(", ");
        const what = action.targets.length === 1 ? names : `all ${action.targets.length} items under review (${names})`;
        return { ...reply(`${text}\nConfirm to save ${what} now (not scheduled yet), or Edit in the review panel.`), actionId: action.id };
      } catch (error) {
        return reply(`I couldn’t read that task: ${errorText(error)} Nothing was saved.`);
      }
    }
  }
return reply("This command is not supported yet.");
}
