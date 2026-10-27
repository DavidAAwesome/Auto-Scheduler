import type { ActionTarget, PendingAction, PendingActionType, PendingChoice, SchedulePreview } from "../types/models.ts";

/** Typed confirmation and cancellation. Only whole short replies count, so "yes I want to plan" is not a confirm. */
export const CONFIRM = /^\s*(?:confirm|confirmed|yes|yep|yeah|y|ok|okay|do it|go ahead|yes,? (?:please|do it|confirm))\s*[.!]*\s*$/i;
export const CANCEL = /^\s*(?:cancel|no|nope|never ?mind|stop|don'?t)\s*[.!]*\s*$/i;

export const BUTTONS: Record<PendingActionType, { confirm: (a: PendingAction) => string; other: string }> = {
  delete_tasks: { confirm: a => (a.targets.length === 1 ? "Delete task" : `Delete ${a.targets.length} tasks`), other: "Cancel" },
  create_items: { confirm: () => "Confirm tasks", other: "Edit" },
  apply_schedule: { confirm: () => "Apply schedule", other: "Cancel" },
};

const open = (a: PendingAction) => a.status === "awaiting_confirmation" || a.status === "failed";

/** The schedule preview, as a pending action of the same shape (its id/version are the preview id and base version). */
export function previewAction(preview: SchedulePreview | null, saving = false): PendingAction | null {
  if (!preview) return null;
  return {
    id: preview.previewId, type: "apply_schedule", status: saving ? "processing" : "awaiting_confirmation", version: preview.baseScheduleVersion,
    summary: `Apply the proposed schedule (${preview.startDate} to ${preview.endDate})`, targets: [], sessionCount: preview.sessions.filter(s => s.change === "new").length,
    error: null, createdAt: preview.generatedAt,
  };
}

/** Everything that is waiting for the user's yes: stored actions plus the schedule preview. */
export function openActions(state: { pendingActions: PendingAction[]; schedulePreview: SchedulePreview | null; previewStale?: boolean; saving?: boolean }) {
  const preview = state.previewStale ? null : previewAction(state.schedulePreview, state.saving);
  return [...state.pendingActions.filter(open), ...(preview ? [preview] : [])];
}

/** "1", "2 and 3", "1, 3" → zero-based indexes into the list shown, or an error when one is out of range. */
export function parseSelection(text: string, count: number): { indexes: number[] } | { error: string } | null {
  if (!/^\s*(?:#?\d+\s*(?:,|and|&|\s)\s*)*#?\d+\s*[.!]?\s*$/i.test(text)) return null;
  const numbers = [...new Set((text.match(/\d+/g) ?? []).map(Number))];
  const bad = numbers.filter(n => n < 1 || n > count);
  if (bad.length) return { error: `Choose a number from 1 to ${count}.` };
  return { indexes: numbers.map(n => n - 1) };
}

/** The options of a choice picked by the user, in the order shown. */
export function chosen(choice: PendingChoice, indexes: number[]): ActionTarget[] {
  return indexes.map(i => choice.options[i]);
}

/** What a typed "confirm" means: the one open action, a question listing several, or nothing to confirm. */
export function resolveConfirm<T extends { id: string; summary: string }>(candidates: T[]):
  { kind: "one"; target: T } | { kind: "several"; options: ActionTarget[] } | { kind: "none" } {
  if (candidates.length === 1) return { kind: "one", target: candidates[0] };
  if (!candidates.length) return { kind: "none" };
  return { kind: "several", options: candidates.map(c => ({ id: c.id, title: c.summary })) };
}
