import type { Availability, CalendarConnection, GeneratedPlan, Task } from "../types/models.ts";
import { formatDate } from "../utils/dates.ts";
import { dateInZone } from "../utils/calendar.ts";

export type AssistantMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  pendingAction?: PendingAction | null;
};

export type PendingAction =
  | { type: "generate_plan"; label: string }
  | { type: "generate_schedule"; label: string }
  | { type: "none"; label: string };

export type AssistantContext = {
  /** Connected Google Calendar / Outlook accounts (their events are imported as busy time). */
  connections?: CalendarConnection[];
  tasks: Task[];
  plan: GeneratedPlan | null;
  availability: Availability | null;
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

function summarizePlan(plan: GeneratedPlan | null) {
  if (!plan) return "No saved plan yet. You can generate one after confirming.";
  const focus = plan.blocks.filter((block) => block.type === "focus").length;
  const unscheduled = plan.tasks.filter((task) =>
    ["unscheduled", "partial", "overdue", "outside_window"].includes(task.status),
  );
  const parts = [
    `Saved plan covers ${plan.startDate} – ${plan.endDate} in ${plan.timeZone}.`,
    `${focus} focus blocks · source: ${plan.source === "provided" ? "busy-time snapshot" : "availability only"}.`,
  ];
  if (plan.stale) {
    parts.push(`Needs review: ${plan.staleReasons.join(" ")}`);
  }
  if (unscheduled.length) {
    parts.push(
      `${unscheduled.length} task(s) need attention: ${unscheduled
        .slice(0, 5)
        .map((task) => `${task.title} (${task.status.replaceAll("_", " ")})`)
        .join("; ")}${unscheduled.length > 5 ? "…" : ""}.`,
    );
  } else if (plan.tasks.length) {
    parts.push("All planned tasks are fully scheduled.");
  }
  return parts.join(" ");
}

export function buildWelcome(context: AssistantContext): AssistantMessage {
  const zone = context.availability?.timeZone ?? "your saved timezone";
  const open = openTasks(context.tasks).length;
  return {
    id: "welcome",
    role: "assistant",
    text: `Planning helper using your AutoPlan account data (${zone}). You have ${open} open task(s). ${summarizePlan(context.plan)} Ask about tasks, unscheduled work, busy time, or request a new plan — schedule changes always need your confirmation.`,
    pendingAction: null,
  };
}

export function replyToPrompt(
  prompt: string,
  context: AssistantContext,
  id: string,
): AssistantMessage {
  const text = prompt.trim().toLowerCase();
  const zone = context.availability?.timeZone ?? "UTC";
  const today = dateInZone(zone);
  const open = openTasks(context.tasks);

  if (!text) {
    return {
      id,
      role: "assistant",
      text: "Ask about today’s tasks, unscheduled items, busy time, or say “generate plan”.",
      pendingAction: null,
    };
  }

  if (/generate|replace|make (a )?plan|plan my week/.test(text)) {
    const label = context.plan ? "Replace saved plan" : "Generate plan";
    return {
      id,
      role: "assistant",
      text: context.plan
        ? `I can replace your saved plan (${context.plan.startDate} – ${context.plan.endDate}). It plans around your events (including any imported from connected calendars) and work sessions. Confirm to continue.`
        : "I can generate a 7-day plan from your open tasks and available hours, around your events (including any imported from connected calendars) and work sessions. Confirm to continue.",
      pendingAction: { type: "generate_plan", label },
    };
  }

  if (/unscheduled|conflict|partial|overdue|outside/.test(text)) {
    if (!context.plan) {
      return {
        id,
        role: "assistant",
        text: "There is no saved plan yet, so there are no scheduled/unscheduled statuses to inspect. Generate a plan when you are ready.",
        pendingAction: { type: "generate_plan", label: "Generate plan" },
      };
    }
    const problem = context.plan.tasks.filter((task) => task.status !== "scheduled");
    if (!problem.length) {
      return {
        id,
        role: "assistant",
        text: "No unscheduled, partial, overdue, or outside-window tasks in the saved plan. Busy intervals (if any) were already subtracted when the plan was generated.",
        pendingAction: null,
      };
    }
    return {
      id,
      role: "assistant",
      text: problem
        .map(
          (task) =>
            `• ${task.title}: ${task.status.replaceAll("_", " ")} — ${task.message}`,
        )
        .join("\n"),
      pendingAction: context.plan.stale
        ? { type: "generate_plan", label: "Replace plan after review" }
        : null,
    };
  }

  if (/today|due today/.test(text)) {
    const dueToday = open.filter((task) => task.deadline === today);
    const blocksToday =
      context.plan?.blocks.filter((block) => {
        const startDay = dateInZone(zone, new Date(block.start));
        return startDay === today && block.type === "focus";
      }) ?? [];
    if (!dueToday.length && !blocksToday.length) {
      return {
        id,
        role: "assistant",
        text: `No open deadlines or focus blocks for ${formatDate(today)} (${zone}).`,
        pendingAction: null,
      };
    }
    const lines = [
      ...dueToday.map(
        (task) =>
          `Deadline today: ${task.title} (${task.minutes} min, ${task.priority})`,
      ),
      ...blocksToday.map((block) => `Focus block: ${block.title}`),
    ];
    return { id, role: "assistant", text: lines.join("\n"), pendingAction: null };
  }

  if (/busy|google|calendar|outlook/.test(text)) {
    return {
      id,
      role: "assistant",
      text:
        calendarStatus(context) +
        (context.plan?.source === "provided"
          ? ` The saved plan was generated around ${context.plan.busyIntervals.length} busy interval(s).`
          : ""),
      pendingAction: null,
    };
  }

  if (/task|deadline|open|list/.test(text)) {
    if (!open.length) {
      return {
        id,
        role: "assistant",
        text: "You have no open tasks. Add one from the Tasks panel to start planning.",
        pendingAction: null,
      };
    }
    const lines = open
      .slice()
      .sort((a, b) => a.deadline.localeCompare(b.deadline))
      .slice(0, 8)
      .map(
        (task) =>
          `• ${task.title} · due ${formatDate(task.deadline)} · ${task.minutes} min · ${task.priority}`,
      );
    return {
      id,
      role: "assistant",
      text: `${open.length} open task(s):\n${lines.join("\n")}${open.length > 8 ? "\n…" : ""}`,
      pendingAction: null,
    };
  }

  if (/help|what can/.test(text)) {
    return {
      id,
      role: "assistant",
      text: "Try: “today”, “unscheduled”, “list tasks”, “google calendar”, or “generate plan”. With OPENAI_API_KEY set on the API, the chat uses GPT; schedule placement still uses AutoPlan’s engine.",
      pendingAction: null,
    };
  }

  return {
    id,
    role: "assistant",
    text: `${summarizePlan(context.plan)}\n\nI did not match a specific request. Try “today”, “unscheduled”, “list tasks”, or “generate plan”.`,
    pendingAction: null,
  };
}
