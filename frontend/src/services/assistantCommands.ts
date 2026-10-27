import type { SchedulePreview, Task, TaskInput, WorkSession } from "../types/models.ts";
import type { AssistantReply, PreviewRequest, WorkspaceState } from "./workspaceStore.ts";
import type { AssistantMessage } from "./plannerAssistant.ts";
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
  | "confirm_delete_task"
  | "add_event"
  | "delete_event";

/** A chat request turned into validated, structured parameters for the scheduling service. */
export type ParsedRequest =
  | {
    command: Exclude<
      AssistantCommand,
      "add_task" | "delete_task" | "confirm_delete_task" | "add_event" | "delete_event"  
    >;
    }
  | { command: "request_break"; minutes: number }
  | { command: "move_task"; taskId: string; notBefore: string; label: string }
  | {
      command: "add_task";
      title: string;
      deadline: string;
      duration: number;
    }
  | {
      command: "delete_task";
      taskId: string;
      title: string;
    }
  | {
    command: "confirm_delete_task";
    taskId: string;
    }
  | {
    command: "confirm_delete_task";
    taskId: string;
    title: string;
    }
  | { command: "clarify"; question: string };

/** The subset of the workspace store the commands need; tests pass a store built on a fake transport. */
export interface CommandWorkspace {
  getSnapshot(): WorkspaceState;
  requestPreview(request: PreviewRequest): Promise<SchedulePreview>;
  applySchedulePreview(): Promise<WorkSession[]>;
  clearSchedulePreview(): void;
  createTask(input: TaskInput): Promise<Task>;
  deleteTask(id: string): Promise<void>;
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

/** Deterministic interpretation for requests that must never depend on a model's guess. */
export function parseRequest(text: string, state: Pick<WorkspaceState, "tasks" | "availability">, now = new Date()): ParsedRequest | null {
  const zone = state.availability?.timeZone ?? "UTC";
  const open = state.tasks.filter(t => !t.done);
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
    // Recognize simple task creation requests without OpenAI.
  if (/^\s*(add|create)\s+(a\s+)?task\b/i.test(text)) {
   const match =
      text.match(
        /^\s*(?:add|create)\s+(?:a\s+)?task\s+called\s+(.+?),?\s+due\s+(.+?),?\s+with\s+a\s+duration\s+of\s+(\d+)\s+minutes?\.?\s*$/i
      ) ??
      text.match(
        /^\s*(?:add|create)\s+(?:a\s+)?task\s+called\s+(.+?)\s+for\s+(\d+)\s+minutes?\s+due\s+(.+?)\.?\s*$/i
      )?.map((value, index, values) =>
        index === 2 ? values[3] : index === 3 ? values[2] : value
      );

    if (!match) {
      return {
        command: "clarify",
        question:
          'Please use: Add a task called Study Networking, due October 30, 2026, with a duration of 60 minutes.'
      };
    }

    const title = match[1].trim();
    const deadlineDate = new Date(match[2].trim());
    const duration = Number(match[3]);

    if (
      !title ||
      title.length > 80 ||
      Number.isNaN(deadlineDate.getTime()) ||
      !Number.isInteger(duration) ||
      duration < 15 ||
      duration > 6000 ||
      duration % 15 !== 0
    ) {
      return {
        command: "clarify",
        question:
          "Please provide a valid task title, deadline, and duration in multiples of 15 minutes."
      };
    }

    const deadline = [
      deadlineDate.getFullYear(),
      String(deadlineDate.getMonth() + 1).padStart(2, "0"),
      String(deadlineDate.getDate()).padStart(2, "0")
    ].join("-");

    return {
      command: "add_task",
      title,
      deadline,
      duration
    };
  }
    // Recognize task deletion requests locally.
  if (/^\s*(delete|remove)\s+(the\s+|a\s+)?task\b/i.test(text)) {
    const match = text.match(
      /^\s*(?:delete|remove)\s+(?:the\s+|a\s+)?task\s+(?:called\s+)?(.+?)\.?\s*$/i
    );

    if (!match) {
      return {
        command: "clarify",
        question: 'Which task should I delete? Example: Delete the task called Study Networking.'
      };
    }

    const title = match[1].trim().replace(/\.$/, "");

    const matches = open.filter(
      task => task.title.toLowerCase() === title.toLowerCase()
    );

    if (matches.length !== 1) {
      return {
        command: "clarify",
        question: matches.length > 1
          ? `Multiple tasks are named "${title}". Please identify which one you mean.`
          : `I couldn't find an open task named "${title}".`
      };
    }

    return {
      command: "delete_task",
      taskId: matches[0].id,
      title: matches[0].title
    };
  }
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
export function requestFromIntent(answer: AssistantReply, state: Pick<WorkspaceState, "tasks">): ParsedRequest | null {
  const { intent, params } = answer;
  switch (intent) {
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
    case "delete_task":
      return {
        command: "clarify",
        question: "Task deletion requires confirmation."
  };
     case "add_task": {
      const title = params.taskTitle;
      const deadline = params.taskDeadline;
      const duration = params.taskDuration;

      if (!title || !title.trim()) {
        return {
          command: "clarify",
          question: "What should I call the task?"
        };
      }

      if (!deadline) {
        return {
          command: "clarify",
          question: "What is the deadline for this task?"
        };
      }

      if (duration == null) {
        return {
          command: "clarify",
          question: "How many minutes will this task take?"
        };
      }

      return {
        command: "add_task",
        title,
        deadline,
        duration
      };
    }

    case "delete_task":
    case "add_event":
    case "delete_event":
      return {
        command: "clarify",
        question: "This action is not available yet."
      };

    default:
      return { command: intent };
  }
}

let counter = 0;
function reply(text: string, actions: AssistantCommand[] = []): AssistantMessage {
  return { id: `cmd-${++counter}`, role: "assistant", text, actions };
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
    ? { command: request as Exclude<
        AssistantCommand,
      "add_task" | "delete_task" | "confirm_delete_task" | "add_event" | "delete_event"  
      > }
    : request;
  const state = workspace.getSnapshot();
  const zone = state.availability?.timeZone ?? "UTC";
  const today = dateInZone(zone, now);
  const endDate = addDays(today, PLAN_DAYS - 1);

  switch (req.command) {
    case "clarify":
      return reply(req.question);
    case "delete_task": {
      const task = workspace.getSnapshot().tasks.find(
      t => t.id === req.taskId && !t.done
      );

      if (!task) {
        return reply("This task no longer exists or has already been completed.");
      }

      return reply(
        `Are you sure you want to delete "${task.title}"?`,
        ["confirm_delete_task"]
      );
    
    }
    case "confirm_delete_task": {
      const task = workspace.getSnapshot().tasks.find(
        t => t.id === req.taskId && !t.done
      );

      if (!task) {
        return reply("This task no longer exists.");
      }

      try {
        await workspace.deleteTask(task.id);
        return reply(`Task "${task.title}" was deleted successfully.`);
      } catch {
        return reply("Sorry, I couldn't delete the task.");
      }
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
      const title = req.title.trim();
      const deadline = req.deadline;
      const duration = req.duration;
    
      if (!title || title.length > 80) {
        return reply("Please provide a task title between 1 and 80 characters.");
      }

  const parsedDate = new Date(`${deadline}T12:00:00Z`);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(deadline) ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== deadline
  ) {
    return reply("Please provide a valid deadline in YYYY-MM-DD format.");
  }

  if (
    !Number.isInteger(duration) ||
    duration < 15 ||
    duration > 6000 ||
    duration % 15 !== 0
  ) {
    return reply("Task duration must be between 15 and 6000 minutes, in multiples of 15.");
  }

  try {
    const task = await workspace.createTask({
      title,
      deadline,
      minutes: duration,
      completedMinutes: 0,
      dueTime: 1439,
      priority: "Medium",
      category: "Personal",
      earliestStart: null,
      allowSplit: true,
      minSessionMinutes: 15,
      maxSessionMinutes: 60,
      dependsOn: [],
    });

    return reply(`Task "${task.title}" was created successfully.`);
  } catch {
    return reply("Sorry, I couldn't create the task. Please try again.");
  }
}  
    }
return reply("This command is not supported yet.");
}
