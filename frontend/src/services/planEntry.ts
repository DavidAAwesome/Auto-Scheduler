import type { DraftView, PlanDraft } from "../types/models.ts";
import { clock12 } from "../utils/calendar.ts";

/** Same limits as the backend (plan_extraction.MAX_IMAGE_BYTES / IMAGE_SIGNATURES). */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function emptyDraft(id: string, patch: Partial<PlanDraft> = {}): PlanDraft {
  return {
    id, kind: "task", title: null, minutes: null, deadline: null, dueTime: null, earliestStart: null, priority: "Medium",
    category: "Study", allowSplit: null, minSessionMinutes: null, maxSessionMinutes: null, date: null, start: null, end: null,
    eventKind: "Other", location: null, repeat: null, windows: [], dependsOn: [], sourceText: null, ambiguous: [],
    unreadable: [], assumed: [], include: true, ...patch,
  };
}

const DURATION = /\b\d+(?:\.\d+)?\s*(?:h|hrs?|hours?|m|mins?|minutes?)\b|\b(?:half an hour|an hour)\b/i;
const WHEN = /\b(?:due|by|deadline|today|tomorrow|tonight|mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}(?::\d{2})?\s*[-–]\s*\d{1,2}(?::\d{2})?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d/i;
const CLOCK = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}(?::\d{2})?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}\b|\bnoon\b/i;
const DAY = /\b(?:today|tomorrow|tonight|(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?s?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|every (?:week)?day|weekdays|daily|(?:on )?the \d{1,2}(?:st|nd|rd|th)|\d{1,2}\/\d{1,2})\b/i;
// "Doctor appt next Tuesday at 2:30", "Call mom at noon": an appointment word with a clock time is an event to add.
const AT_CLOCK = /\bat\s+(?:\d{1,2}(?::\d{2})?(?!\s*(?:%|percent|hours?|hrs?|mins?|minutes?)\b)|noon|midnight)\b/i;
const APPOINTMENT = /\b(?:meeting|appt|appointment|dentist|doctor|call|lunch|dinner|breakfast|coffee|interview|class|lecture|practice|session|party|standup|stand-up|sync|club)\b/i;
const SETTINGS_TALK = /\b(focus|breaks?|limit|max(?:imum)?|daily|per day|a day|blocks?|prefer(?:ence)?s?|usually|always|set|change|worked|spent|took|ago|i'?m|i am|i was|feel(?:ing)?|tired|later|earlier|sooner|move|push|delay)\b/i;
const ADD = /^\s*(?:please\s+)?(?:add|create|schedule|plan|put|remind me to|i (?:need|have) to)\b/i;
const QUESTION = /\?\s*$|^\s*(?:what|when|why|how|which|who|show|can you explain|explain)\b/i;

/**
 * True when a chat message describes tasks or events to add (rather than asking a question): several
 * lines, or one line with a length or time plus a date, or an explicit "add …".
 */
export function looksLikePlanEntry(text: string) {
  const trimmed = text.trim();
  if (!trimmed || QUESTION.test(trimmed)) return false;
  const lines = trimmed.split(/\n|;/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) return lines.filter(l => DURATION.test(l) || WHEN.test(l)).length >= 1;
  // "Soccer practice Sat and Sun 9-10am": a day and a clock time read as an event, even without "add".
  const eventLike = ((CLOCK.test(trimmed) || AT_CLOCK.test(trimmed)) && DAY.test(trimmed))
    || (APPOINTMENT.test(trimmed) && (CLOCK.test(trimmed) || AT_CLOCK.test(trimmed)) && !SETTINGS_TALK.test(trimmed));
  // "Essay draft 2 hours in one sitting, then proofread 30 min": work with a length is new work to review, even with
  // no day yet (the review asks for the deadline). Settings talk ("set focus blocks to 45 minutes") is not.
  const workWithLength = DURATION.test(trimmed) && !SETTINGS_TALK.test(trimmed);
  return (ADD.test(trimmed) && (DURATION.test(trimmed) || WHEN.test(trimmed))) || (DURATION.test(trimmed) && WHEN.test(trimmed)) || eventLike || workWithLength;
}

/** One line per draft for chat: what was read, with deadlines kept apart from fixed times. */
export function draftLine(d: PlanDraft) {
  const name = d.title ?? "Untitled";
  if (d.kind === "fixed_event") {
    const times = d.start != null && d.end != null ? `${clock12(d.start)}–${clock12(d.end % 1440)}` : "time ?";
    if (d.repeat) return `${name}: weekly event (${times}), ${d.repeat.startDate ?? "start ?"} to ${d.repeat.until ?? "end ?"}`;
    return `${name}: fixed event, ${d.date ?? "date ?"} ${times}`;
  }
  const due = d.deadline ? `due ${d.deadline}${d.dueTime != null ? ` ${clock12(d.dueTime)}` : ""}` : "no deadline yet";
  // A preferred start is when work may begin; it is shown apart from the deadline so the two are never confused.
  const from = d.earliestStart && d.kind === "task" ? `, work starts no earlier than ${d.earliestStart.slice(0, 10)}${d.earliestStart.slice(11, 16) !== "00:00" ? ` ${clock12(Number(d.earliestStart.slice(11, 13)) * 60 + Number(d.earliestStart.slice(14, 16)))}` : ""}` : "";
  return `${name}: ${d.kind === "flexible_event" ? "flexible event" : "task"}, ${d.minutes ?? "?"} min, ${due}${from}, ${d.priority}`;
}

/** Chat reply after reading drafts. It never says anything was saved: nothing is, until Apply. */
export function draftsReply(views: DraftView[], provider: string, notes: string[] = []) {
  if (!views.length) return notes.join(" ") || "I couldn’t find any tasks or events in that. Try one per line, like “Essay, 2 hours, due Friday”.";
  const lines = [`I read ${views.length} item${views.length === 1 ? "" : "s"}${provider === "openai" ? " (AI)" : provider === "local" ? " (built-in parser)" : ""}. Nothing is saved yet; they’re in the review panel above the calendar:`];
  for (const v of views) lines.push(`• ${draftLine(v.draft)}${v.ready ? "" : " — needs an answer"}`);
  const open = views.flatMap(v => v.issues.filter(i => i.blocking).map(i => i.question));
  // Assumptions that change the plan (a date read from "next Friday", a due time from "morning") are stated, briefly.
  const assumed = views.flatMap(v => v.issues.filter(i => !i.blocking && i.field !== "priority").map(i => i.question)).slice(0, 2);
  lines.push(...assumed.map(a => `Note: ${a}`));
  if (open.length) lines.push(`First question: ${open[0]} (Answer here or in the panel.)`);
  else lines.push("Use “Can this fit?” or “Preview on calendar”, then Apply to save.");
  lines.push(...notes);
  return lines.join("\n");
}

/** Short replies that acknowledge rather than answer ("thanks", "ok wait"), so they never overwrite a draft field. */
export const ACKNOWLEDGEMENT = /^\s*(ok(ay)?|k|thanks?( you)?|thx|ty|cool|great|nice|got it|sure|wait|hold on|one sec(ond)?|hmm+|never ?mind)([\s,]+(wait|thanks|then|cool|sure|ok(ay)?))?[\s!.]*$/i;

/** The first open question across the drafts, so a plain chat reply can answer it. */
export function firstOpenQuestion(views: DraftView[]) {
  for (const v of views) {
    if (!v.draft.include) continue;
    const issue = v.issues.find(i => i.blocking);
    if (issue) return { draftId: v.draft.id, field: issue.field, question: issue.question };
  }
  return null;
}

export async function readImage(file: File): Promise<{ mediaType: string; dataBase64: string; name: string }> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("Choose a JPG, PNG or WebP image.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Choose an image of 5 MB or less.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mediaType: file.type, dataBase64: btoa(binary), name: file.name };
}
