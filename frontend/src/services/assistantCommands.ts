import type { SchedulePreview, WorkSession } from "../types/models.ts";
import type { WorkspaceState } from "./workspaceStore.ts";
import type { AssistantMessage } from "./plannerAssistant.ts";
import { dateInZone, longDate } from "../utils/calendar.ts";
import { addDays } from "../utils/dates.ts";
import { busyTimeText, groupByDate, previewText, timeRange } from "../utils/schedulePreview.ts";

/** Actions the chat can run. Each one calls the same workspace method the calendar buttons use. */
export type AssistantCommand = "generate_schedule" | "show_plan" | "busy_time" | "apply_schedule" | "cancel_schedule";

/** The subset of the workspace store the commands need; tests pass a store built on a fake transport. */
export interface CommandWorkspace {
  getSnapshot(): WorkspaceState;
  previewSchedule(horizonDays?: number): Promise<SchedulePreview>;
  applySchedulePreview(): Promise<WorkSession[]>;
  clearSchedulePreview(): void;
}

export const PLAN_DAYS = 7;

const SHOW_PLAN = /\b(show|see|display|view)\b.*\b(plan|schedule)\b|\bmy (plan|schedule)\b|didn.?t fit|unscheduled|what.*\bleft\b/i;
const BUSY = /\bbusy\b|my calendar|what'?s on|free time|events? (today|tomorrow|this week|next week)/i;
const GENERATE = /\bgenerate\b|\breplan\b|re-plan|\bplan (my|the|this|next)\b|\bschedule (my|the|this|next)\b|\b(make|build|create)\b.*\b(plan|schedule)\b/i;

/** Deterministic routing for requests that must never depend on a model's guess. */
export function commandFor(text: string): AssistantCommand | null {
  if (SHOW_PLAN.test(text)) return "show_plan";
  if (BUSY.test(text)) return "busy_time";
  if (GENERATE.test(text)) return "generate_schedule";
  return null;
}

let counter = 0;
function reply(text: string, actions: AssistantCommand[] = []): AssistantMessage {
  return { id: `cmd-${++counter}`, role: "assistant", text, actions };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/** Runs one command and returns the chat message that reports its real outcome. */
export async function runAssistantCommand(command: AssistantCommand, workspace: CommandWorkspace, now = new Date()): Promise<AssistantMessage> {
  const state = workspace.getSnapshot();
  const zone = state.availability?.timeZone ?? "UTC";
  const today = dateInZone(zone, now);
  const endDate = addDays(today, PLAN_DAYS - 1);

  switch (command) {
    case "generate_schedule": {
      try {
        const preview = await workspace.previewSchedule(PLAN_DAYS);
        return reply(previewText(preview.schedule), preview.schedule.sessions.length ? ["apply_schedule", "cancel_schedule"] : ["cancel_schedule"]);
      } catch (error) {
        return reply(`I couldn’t build a schedule: ${errorText(error)} Nothing was saved.`, ["generate_schedule"]);
      }
    }
    case "apply_schedule": {
      if (!state.schedulePreview) return reply("There is no proposed schedule to apply. Say “plan my week” to build one.", ["generate_schedule"]);
      try {
        const saved = await workspace.applySchedulePreview();
        return reply(`Saved ${saved.length} session(s) to your calendar, replacing the previous scheduled sessions. They will still be there after a refresh.`);
      } catch (error) {
        const stillPending = workspace.getSnapshot().schedulePreview !== null;
        return reply(`Not saved: ${errorText(error)}`, stillPending ? ["apply_schedule", "cancel_schedule"] : ["generate_schedule"]);
      }
    }
    case "cancel_schedule":
      workspace.clearSchedulePreview();
      return reply("Proposed schedule discarded. Nothing was changed.");
    case "show_plan": {
      if (state.schedulePreview) return reply(previewText(state.schedulePreview.schedule), ["apply_schedule", "cancel_schedule"]);
      const upcoming = state.sessions.filter(session => session.date >= today && session.date <= endDate);
      if (!upcoming.length) {
        return reply("There is no proposed schedule and no saved work sessions for the next 7 days.", ["generate_schedule"]);
      }
      const titles = new Map(state.tasks.map(task => [task.id, task.title]));
      const lines = [`Saved work sessions, next ${PLAN_DAYS} days (${upcoming.length}). Nothing is pending.`];
      for (const [date, sessions] of groupByDate(upcoming)) {
        lines.push(longDate(date));
        for (const session of sessions) {
          const by = session.source === "auto" ? "scheduler" : "you";
          lines.push(`• ${timeRange(session.start, session.end)} ${titles.get(session.taskId) ?? "Task"} (placed by ${by})`);
        }
      }
      return reply(lines.join("\n"));
    }
    case "busy_time":
      return reply(busyTimeText(state.events, state.sessions, state.tasks, today, PLAN_DAYS, state.connections.length > 0));
  }
}
