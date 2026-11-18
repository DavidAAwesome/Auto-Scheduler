import { useEffect, useRef } from "react";
import { useWorkspace } from "./useWorkspace";
import { workspaceService } from "../services/workspace";
import { activeSplitOptions } from "../utils/schedulePreview";

/** How long editing must pause before drafts are re-checked and the calendar preview is redrawn. */
const SETTLE_MS = 500;

/**
 * Keeps the calendar in step with the review cards: after an edit settles, the drafts are re-checked by the backend,
 * and once every included item is complete the plan preview is redrawn. Each set of drafts is previewed at most once,
 * so Cancel on the preview is respected and a failed preview is not retried in a loop (the card offers a button).
 */
export function useDraftAutoPreview(onError: (message: string) => void) {
  const { planDrafts, schedulePreview, splitOptions, saving, planBusy } = useWorkspace();
  const reviewed = useRef("");
  const previewed = useRef("");
  const key = planDrafts ? planDrafts.batchId + JSON.stringify(planDrafts.views.map(v => v.draft)) : "";
  const included = planDrafts?.views.filter(v => v.draft.include) ?? [];
  const ready = included.length > 0 && included.every(v => v.ready);
  // Another kind of preview (Generate, replan, a split choice) is on screen: leave it alone.
  const otherPreview = (schedulePreview !== null && schedulePreview.mode !== "plan") || activeSplitOptions(splitOptions, schedulePreview) !== null;
  useEffect(() => {
    if (!key) { reviewed.current = previewed.current = ""; return; }
    if (saving || planBusy) return;  // runs again when they clear
    const timer = setTimeout(() => {
      if (reviewed.current !== key) {
        reviewed.current = key;
        workspaceService.reviewDrafts().catch(e => onError((e as Error).message));
        return;
      }
      if (!ready || otherPreview || previewed.current === key) return;
      previewed.current = key;
      workspaceService.previewDrafts().catch(e => onError((e as Error).message));
    }, reviewed.current === key ? 0 : SETTLE_MS);
    return () => clearTimeout(timer);
  }, [key, ready, otherPreview, saving, planBusy, onError]);
}
