import type { CalendarEvent, CalendarEventInput, EventKind } from "../types/models.ts";
import type { WorkspaceState } from "./workspaceStore.ts";
import { clock12, dateInZone, longDate, weekdayIndex } from "../utils/calendar.ts";
import { addDays, validDate } from "../utils/dates.ts";
import { eventClash, occursOn } from "../utils/events.ts";
import { accountTimeZone } from "../utils/timeZones.ts";

/**
 * Add and delete calendar events from chat. Nothing is saved or deleted until the user presses the
 * confirm button; the confirmation shows exactly what will happen (title, date, times, repeats).
 */

/** An event change waiting for the user to confirm in chat. */
export type PendingEventAction =
  | { type: "add_event"; input: CalendarEventInput }
  | { type: "delete_event"; eventId: string; title: string }
  | { type: "skip_event_occurrence"; eventId: string; title: string; date: string };

export type EventProposal = { action: PendingEventAction; summary: string } | { action: null; question: string };

type EventState = Pick<WorkspaceState, "events" | "availability">;

const WEEKDAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const EVENT_WORD = "(?:event|meeting|class|lecture|appointment|appt|lunch|dinner|party|call)";
const ADD = new RegExp(`^\\s*(?:please\\s+)?(?:add|create|schedule|put|book|make)\\s+(?:an?\\s+|my\\s+|the\\s+)?(?:new\\s+)?${EVENT_WORD}s?\\b`, "i");
const DELETE = new RegExp(`^\\s*(?:please\\s+)?(?:delete|remove|cancel)\\s+(?:the\\s+|my\\s+|an?\\s+)?${EVENT_WORD}s?\\b`, "i");
const TIME = "(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?";
const ADD_EXAMPLE = "For example: “Add a meeting called Project sync tomorrow from 3pm to 4pm.”";

export const ADD_EVENT_HELP = `I need a title, a day and a time to add an event. ${ADD_EXAMPLE}`;

function kindFrom(text: string): EventKind {
  const lower = text.toLowerCase();
  if (/\b(class|lecture|lab|seminar)\b/.test(lower)) return "Class";
  if (/\b(meeting|call|sync|standup)\b/.test(lower)) return "Meeting";
  if (/\b(appointment|appt|doctor|dentist)\b/.test(lower)) return "Appointment";
  if (/\b(lunch|dinner|party|birthday|hangout)\b/.test(lower)) return "Social";
  return "Other";
}

function capitalize(text: string) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

const timeLabel = (minutes: number) => (minutes >= 1440 ? "midnight" : clock12(minutes));

/** One clock time in minutes after midnight, or null. `meridiem` is used when the text has no am/pm. */
function toMinutes(hourText: string, minuteText: string | undefined, ampm: string | undefined, meridiem?: "am" | "pm"): number | null {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (!Number.isInteger(hour) || hour > 24 || minute > 59) return null;
  const marker = ampm?.replace(/\./g, "").toLowerCase() as "am" | "pm" | undefined;
  const half = marker ?? meridiem;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    if (half === "am" && hour === 12) hour = 0;
    if (half === "pm" && hour !== 12) hour += 12;
  }
  return hour * 60 + minute;
}

/** No am/pm given: 8-11 read as morning, 12-7 as afternoon/evening, which is how people usually mean them. */
function guessMeridiem(hour: number): "am" | "pm" {
  return hour >= 8 && hour <= 11 ? "am" : "pm";
}

/** Start and end in minutes, from "from 3 to 4pm", "3-4:30pm", "at 2pm for 90 minutes" or "at 10am" (1 hour). */
export function parseTimes(raw: string): { start: number; end: number; assumed: string[] } | null {
  const assumed: string[] = [];
  const text = stripDates(raw);
  const range = text.match(new RegExp(`(?:\\bfrom\\s+|\\bat\\s+|\\b)${TIME}\\s*(?:-|–|to|until|till)\\s*${TIME}`, "i"));
  if (range) {
    const [, h1, m1, a1, h2, m2, a2] = range;
    let endHalf = a2?.replace(/\./g, "").toLowerCase() as "am" | "pm" | undefined;
    if (!endHalf && !a1) {
      endHalf = guessMeridiem(Number(h2));
      assumed.push("am/pm");
    }
    const end = toMinutes(h2, m2, a2, endHalf);
    // "3-4pm": the start shares the end's half of the day unless that would put it after the end.
    let start = toMinutes(h1, m1, a1, a1 ? undefined : endHalf);
    if (start !== null && end !== null && !a1 && start >= end && endHalf === "pm") start = toMinutes(h1, m1, "am");
    if (start === null || end === null) return null;
    return { start, end: end === 0 ? 1440 : end, assumed };
  }
  const single = text.match(new RegExp(`\\b(?:at|@)\\s*${TIME}`, "i")) ?? text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i);
  if (!single) return null;
  const [, h, m, a] = single;
  if (!a) assumed.push("am/pm");
  const start = toMinutes(h, m, a, a ? undefined : guessMeridiem(Number(h)));
  if (start === null) return null;
  const length = text.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/i);
  let minutes = 60;
  if (length) minutes = Math.round(Number(length[1]) * (/^h/i.test(length[2]) ? 60 : 1));
  else assumed.push("1 hour long");
  return { start, end: start + minutes, assumed };
}

/** The local date a phrase refers to (today, tomorrow, Friday, Oct 30, 10/30, 2026-10-30), or null. */
export function parseDate(text: string, today: string): string | null {
  const lower = text.toLowerCase();
  const iso = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return validDate(iso[1]) ? iso[1] : null;
  if (/\btoday\b|\btonight\b/.test(lower)) return today;
  if (/\btomorrow\b/.test(lower)) return addDays(today, 1);
  const year = Number(today.slice(0, 4));
  const pick = (month: number, day: number, explicitYear?: number) => {
    const make = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (explicitYear) return validDate(make(explicitYear)) ? make(explicitYear) : null;
    const candidate = make(year);
    if (!validDate(candidate)) return null;
    return candidate < today ? make(year + 1) : candidate;
  };
  const named = lower.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/);
  if (named) return pick(MONTHS.indexOf(named[1].slice(0, 3)) + 1, Number(named[2]), named[3] ? Number(named[3]) : undefined);
  const slash = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/);
  if (slash) return pick(Number(slash[1]), Number(slash[2]), slash[3] ? Number(slash[3]) : undefined);
  const day = WEEKDAY_NAMES.findIndex(name => new RegExp(`\\b${name}\\b|\\b${name.slice(0, 3)}\\b`).test(lower));
  if (day >= 0) {
    const ahead = (day - weekdayIndex(today) + 7) % 7;
    const next = /\bnext\s+\w+day\b/.test(lower) && ahead === 0 ? 7 : ahead;
    return addDays(today, next);
  }
  return null;
}

/** Removes calendar dates so "2026-10-30" or "10/30" is never read as a time range. */
function stripDates(text: string) {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(\/\d{4})?\b/g, " ")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?(,?\s*\d{4})?\b/gi, " ");
}

/** Strips date/time phrases so what remains can be used as (or to find) a title. */
function stripWhen(text: string) {
  return text
    .replace(new RegExp(`\\b(?:from|at|@)?\\s*${TIME}\\s*(?:-|–|to|until|till)\\s*${TIME}`, "gi"), " ")
    .replace(new RegExp(`\\b(?:at|@)\\s*${TIME}`, "gi"), " ")
    .replace(/\bfor\s+\d+(?:\.\d+)?\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/gi, " ")
    .replace(/\b(on\s+)?(next\s+)?(today|tonight|tomorrow|this\s+\w+|(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?)\b/gi, " ")
    .replace(/\b(on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?(,?\s*\d{4})?\b/gi, " ")
    .replace(/\b(on\s+)?\d{4}-\d{2}-\d{2}\b|\b(on\s+)?\d{1,2}\/\d{1,2}(\/\d{4})?\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.-]+|[\s,.-]+$/g, "");
}

function titleFrom(text: string): string | null {
  const quoted = text.match(/["“']([^"”']{1,80})["”']/);
  if (quoted) return quoted[1].trim();
  const called = text.match(/\b(?:called|named|titled)\s+(.+)$/i);
  if (called) return stripWhen(called[1]) || null;
  // "add a meeting with Prof Smith tomorrow at 3" -> "Meeting with Prof Smith"
  const rest = text.replace(ADD, "").trim();
  const keyword = text.match(new RegExp(`${EVENT_WORD}`, "i"))?.[0] ?? "";
  const cleaned = stripWhen(rest);
  if (cleaned && /^(with|for|about|at)\b/i.test(cleaned)) return capitalize(`${keyword.toLowerCase() === "event" ? "Event" : keyword.toLowerCase()} ${cleaned}`);
  if (cleaned) return capitalize(cleaned);
  return keyword && keyword.toLowerCase() !== "event" ? capitalize(keyword.toLowerCase()) : null;
}

/** Checks a new event and builds the confirmation text. */
export function proposeAddEvent(input: CalendarEventInput, state: EventState, assumed: string[] = []): EventProposal {
  const title = input.title.trim();
  if (!title) return { action: null, question: `What should the event be called? ${ADD_EXAMPLE}` };
  if (title.length > 80) return { action: null, question: "Event names can be up to 80 characters. What should I call it?" };
  if (!validDate(input.date)) return { action: null, question: `Which day is it on? ${ADD_EXAMPLE}` };
  if (!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.start < 0 || input.end > 1440) {
    return { action: null, question: `What time does it start and end? ${ADD_EXAMPLE}` };
  }
  if (input.end <= input.start) return { action: null, question: "The event must end after it starts. What are the start and end times?" };
  if (input.start % 5 || input.end % 5) return { action: null, question: "Events use 5-minute steps (e.g. 3:05, 3:10). What times should I use?" };
  const zone = accountTimeZone(state.availability);
  const today = dateInZone(zone);
  const clean: CalendarEventInput = { ...input, title, location: input.location?.trim() || null, repeat: input.repeat ?? null };
  const clash = eventClash(state.events, clean.date, clean.start, clean.end);
  const notes: string[] = [];
  if (clean.date < today) notes.push("That date is in the past.");
  if (clash) notes.push(`It overlaps “${clash.title}” (${timeLabel(clash.start)}–${timeLabel(clash.end)}).`);
  if (assumed.length) notes.push(`I assumed ${assumed.join(" and ")}; say so if that's wrong.`);
  return {
    action: { type: "add_event", input: clean },
    summary: `Add this event to your calendar?\n• ${clean.title} (${clean.kind})\n• ${longDate(clean.date)}, ${timeLabel(clean.start)}–${timeLabel(clean.end)}`
      + `${notes.length ? `\n${notes.join(" ")}` : ""}\nNothing is saved until you press Add event. Work sessions won't be planned on top of it.`,
  };
}

/** Finds the event a delete request means and builds the confirmation text. */
export function proposeDeleteEvent(title: string, date: string | null, state: EventState): EventProposal {
  const wanted = title.trim().toLowerCase();
  if (!wanted) return { action: null, question: "Which event should I delete? For example: “Delete the event called Project sync.”" };
  const byTitle = (match: (e: CalendarEvent) => boolean) => state.events.filter(e => match(e) && (!date || occursOn(e, date)));
  let matches = byTitle(e => e.title.toLowerCase() === wanted);
  if (!matches.length) matches = byTitle(e => e.title.toLowerCase().includes(wanted));
  if (!matches.length) {
    const names = [...new Set(state.events.filter(e => e.source === "manual").map(e => `“${e.title}”`))].slice(0, 5).join(", ");
    return { action: null, question: `I couldn't find an event called “${title.trim()}”${date ? ` on ${longDate(date)}` : ""}.${names ? ` Your events include ${names}.` : ""}` };
  }
  const editable = matches.filter(e => e.source === "manual");
  if (!editable.length) {
    const source = matches[0].source === "google" ? "Google Calendar" : "Outlook";
    return { action: null, question: `“${matches[0].title}” was imported from ${source}, so it's read-only here. Delete it in ${source}, then sync again from Calendars.` };
  }
  if (editable.length > 1) {
    const list = editable.slice(0, 4).map(e => `“${e.title}” on ${longDate(e.date)} at ${timeLabel(e.start)}`).join("; ");
    return { action: null, question: `More than one event matches: ${list}. Which one? Add its date, e.g. “delete the meeting called ${editable[0].title} on ${longDate(editable[0].date)}”.` };
  }
  const event = editable[0];
  const when = `${timeLabel(event.start)}–${timeLabel(event.end)}`;
  if (event.repeat && date) {
    return {
      action: { type: "skip_event_occurrence", eventId: event.id, title: event.title, date },
      summary: `Remove “${event.title}” on ${longDate(date)} (${when}) only? It repeats weekly; the other occurrences stay. Nothing changes until you press Delete event.`,
    };
  }
  return {
    action: { type: "delete_event", eventId: event.id, title: event.title },
    summary: event.repeat
      ? `Delete “${event.title}” (${when})? It repeats weekly until ${longDate(event.repeat.until)}, and every occurrence will be removed. To remove just one day, include the date. Nothing changes until you press Delete event.`
      : `Delete “${event.title}” on ${longDate(event.date)} (${when})? Nothing changes until you press Delete event.`,
  };
}

/** Plain-language add/delete event requests, or null when the text isn't one. */
export function parseEventRequest(text: string, state: EventState, now = new Date()): EventProposal | null {
  const zone = accountTimeZone(state.availability);
  const today = dateInZone(zone, now);
  if (DELETE.test(text)) {
    const rest = text.replace(DELETE, "").replace(/^\s*(?:called|named|titled)\s+/i, "").trim();
    const quoted = rest.match(/["“']([^"”']{1,80})["”']/)?.[1];
    const date = parseDate(rest, today);
    const title = quoted ?? stripWhen(rest);
    if (!title) {
      // "cancel my class tomorrow": use the keyword itself when it names a kind of event.
      const keyword = text.match(new RegExp(EVENT_WORD, "i"))?.[0].toLowerCase();
      if (keyword && keyword !== "event" && date) {
        const kind = kindFrom(keyword);
        const onDay = state.events.filter(e => e.kind === kind && occursOn(e, date));
        if (onDay.length === 1) return proposeDeleteEvent(onDay[0].title, date, state);
      }
      return { action: null, question: "Which event should I delete? For example: “Delete the event called Project sync.”" };
    }
    return proposeDeleteEvent(title, date, state);
  }
  if (ADD.test(text)) {
    const title = titleFrom(text);
    const date = parseDate(text, today);
    const times = parseTimes(text);
    if (!title) return { action: null, question: `What should the event be called? ${ADD_EXAMPLE}` };
    if (!date) return { action: null, question: `Which day is “${title}” on? ${ADD_EXAMPLE}` };
    if (!times) return { action: null, question: `What time is “${title}”? ${ADD_EXAMPLE}` };
    const repeat = /\b(every|each)\s+week\b|\bweekly\b/i.test(text)
      ? { weekdays: [weekdayIndex(date)], until: addDays(date, 7 * 15) }
      : null;
    const input: CalendarEventInput = { title, kind: kindFrom(text), date, start: times.start, end: times.end, location: null, repeat };
    const proposal = proposeAddEvent(input, state, times.assumed);
    if (proposal.action && repeat) proposal.summary = proposal.summary.replace("\n• ", `\n• Repeats every ${WEEKDAY_NAMES[weekdayIndex(date)][0].toUpperCase()}${WEEKDAY_NAMES[weekdayIndex(date)].slice(1)} until ${longDate(repeat.until)}\n• `);
    return proposal;
  }
  return null;
}

/** "HH:MM" or "3pm" from the model, in minutes after midnight. */
function clockFromModel(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(new RegExp(`^${TIME}$`, "i"));
  if (!match) return null;
  return toMinutes(match[1], match[2], match[3]);
}

/** The model's add_event / delete_event intent, checked against this workspace before anything is offered. */
export function eventFromIntent(
  intent: "add_event" | "delete_event",
  params: { eventId?: string | null; eventTitle?: string | null; eventDate?: string | null; eventStart?: string | null; eventEnd?: string | null },
  state: EventState,
): EventProposal {
  if (intent === "delete_event") {
    const byId = params.eventId ? state.events.find(e => e.id === params.eventId) : undefined;
    const date = params.eventDate && validDate(params.eventDate) ? params.eventDate : null;
    return proposeDeleteEvent(byId?.title ?? params.eventTitle ?? "", date, state);
  }
  const start = clockFromModel(params.eventStart);
  const endRaw = clockFromModel(params.eventEnd);
  const end = endRaw === 0 ? 1440 : endRaw;
  if (!params.eventTitle?.trim()) return { action: null, question: `What should the event be called? ${ADD_EXAMPLE}` };
  if (!params.eventDate || !validDate(params.eventDate)) return { action: null, question: `Which day is “${params.eventTitle.trim()}” on?` };
  if (start === null || end === null) return { action: null, question: `What time does “${params.eventTitle.trim()}” start and end?` };
  return proposeAddEvent({ title: params.eventTitle, kind: kindFrom(params.eventTitle), date: params.eventDate, start, end, location: null, repeat: null }, state);
}

export interface EventWorkspace {
  createEvent(input: CalendarEventInput): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
  skipEventOccurrence(id: string, date: string): Promise<CalendarEvent>;
}

/** Runs a confirmed event action and returns the real outcome as text. */
export async function confirmEventAction(action: PendingEventAction, workspace: EventWorkspace): Promise<string> {
  const failed = (error: unknown) => `Not done: ${error instanceof Error ? error.message : "something went wrong."} Nothing was changed.`;
  try {
    if (action.type === "add_event") {
      const saved = await workspace.createEvent(action.input);
      return `Added “${saved.title}” on ${longDate(saved.date)}, ${timeLabel(saved.start)}–${timeLabel(saved.end)}. It's on your calendar now; generate or repair your schedule so work moves around it.`;
    }
    if (action.type === "skip_event_occurrence") {
      await workspace.skipEventOccurrence(action.eventId, action.date);
      return `Removed “${action.title}” on ${longDate(action.date)}. The other occurrences are unchanged.`;
    }
    await workspace.deleteEvent(action.eventId);
    return `Deleted “${action.title}”. That time is free again; repair your schedule to use it.`;
  } catch (error) {
    return failed(error);
  }
}

export function confirmLabel(action: PendingEventAction) {
  return action.type === "add_event" ? "Add event" : "Delete event";
}
