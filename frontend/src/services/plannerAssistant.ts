import type { CalendarConnection, CalendarEvent, Availability, PreferenceChange, SchedulePreview, Task, WorkSession } from "../types/models.ts";
import type { AssistantCommand } from "./assistantCommands.ts";
import type { PendingEventAction } from "./eventCommands.ts";
import { formatDate } from "../utils/dates.ts";
import { dateInZone } from "../utils/calendar.ts";
import { todayAgenda, todayText } from "../utils/schedulePreview.ts";

export type AssistantMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  /** Buttons under the message; each runs a real command against the workspace. */
  actions?: AssistantCommand[];
  /** A preference change waiting for the user to press Save or Not now. */
  pendingChange?: PreferenceChange;
  /** An event to add or delete, waiting for the user to confirm. */
  pendingEvent?: PendingEventAction;
};

export type AssistantContext = {
  /** Connected Google Calendar / Outlook accounts (their events are imported as busy time). */
  connections?: CalendarConnection[];
  tasks: Task[];
  sessions: WorkSession[];
  events?: CalendarEvent[];
  availability: Availability | null;
  schedulePreview: SchedulePreview | null;
};

const PROVIDER = { google: "Google Calendar", outlook: "Outlook" } as const;

/** Honest one-line status of external calendars. */
export function calendarStatus(context: AssistantContext) {
  const connections = context.connections ?? [];
  if (!connections.length) {
    return "No external calendar is connected. Connect Google Calendar or Outlook from the ☰ menu → Calendars to import your events as busy time.";
  }
  return connections
    .map((c) => `${PROVIDER[c.provider]} is connected (${c.account}): ${c.eventCount} event(s) imported, last synced ${new Date(c.lastSynced).toLocaleString()}. Sync again from Calendars to pick up changes.`)
    .join(" ");
}

function openTasks(tasks: Task[]) {
  return tasks.filter((task) => !task.done);
}

/** What exists right now: a proposal awaiting review, saved sessions, or nothing. */
export function scheduleStatus(context: AssistantContext) {
  if (context.schedulePreview) return "A proposed schedule is waiting for your review. It is not saved yet.";
  const work = context.sessions.filter((s) => s.type === "work" && s.status === "saved").length;
  if (work) return `${work} work session(s) are saved.`;
  return "No schedule exists yet.";
}

export function buildWelcome(context: AssistantContext): AssistantMessage {
  const zone = context.availability?.timeZone ?? "your saved timezone";
  const open = openTasks(context.tasks).length;
  return {
    id: "welcome",
    role: "assistant",
    text: `Planning helper using your AutoPlan account data (${zone}). You have ${open} open task(s). ${scheduleStatus(context)} Ask about your tasks or busy time, or say “plan my week”. A new schedule is a preview until you Apply it.`,
  };
}

/** Local answers used when OpenAI is not configured. Schedule and busy-time requests are handled by assistantCommands. */
export function replyToPrompt(prompt: string, context: AssistantContext, id: string): AssistantMessage {
  const text = prompt.trim().toLowerCase();
  const zone = context.availability?.timeZone ?? "UTC";
  const today = dateInZone(zone);
  const open = openTasks(context.tasks);

  if (!text) {
    return { id, role: "assistant", text: "Ask about today’s tasks, busy time, or say “plan my week”." };
  }

  if (/today|due today/.test(text)) {
    // Same agenda as the calendar and sidebar: saved and proposed sessions and breaks, with deadlines kept separate.
    const state = { tasks: context.tasks, sessions: context.sessions, events: context.events ?? [], schedulePreview: context.schedulePreview };
    return { id, role: "assistant", text: todayText(todayAgenda(state, today), today, zone, context.tasks) };
  }

  if (/google|calendar|outlook/.test(text)) {
    return { id, role: "assistant", text: calendarStatus(context) };
  }

  if (/task|deadline|open|list/.test(text)) {
    if (!open.length) {
      return { id, role: "assistant", text: "You have no open tasks. Add one from the Tasks panel to start planning." };
    }
    const lines = open
      .slice()
      .sort((a, b) => a.deadline.localeCompare(b.deadline))
      .slice(0, 8)
      .map((task) => `• ${task.title} · due ${formatDate(task.deadline)} · ${task.minutes} min · ${task.priority}`);
    return { id, role: "assistant", text: `${open.length} open task(s):\n${lines.join("\n")}${open.length > 8 ? "\n…" : ""}` };
  }

  if (/help|what can/.test(text)) {
    return {
      id,
      role: "assistant",
      text: "Try: “today”, “list tasks”, “busy time”, “show my plan”, or “plan my week”. With OPENAI_API_KEY set on the API, other questions use GPT; schedules still come from AutoPlan’s engine.",
    };
  }

  return {
    id,
    role: "assistant",
    text: `${scheduleStatus(context)}\n\nI did not match a specific request. Try “today”, “list tasks”, “busy time”, or “plan my week”.`,
  };
}
