import { useEffect, useRef } from "react";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { longDate } from "../utils/calendar";
import { activeSplitOptions, splitOptionSessions, splitOptionSummary, splitOptionWarnings, timeRange } from "../utils/schedulePreview";

/** Picks which split of a task the calendar previews. Each option is a complete preview; the bar below applies it. */
export default function SplitOptionsPanel({ onError }: { onError: (message: string) => void }) {
  const { splitOptions, schedulePreview, previewStale, saving } = useWorkspace();
  const split = activeSplitOptions(splitOptions, schedulePreview);
  const panel = useRef<HTMLDivElement>(null);
  // The review area may be scrolled down to the drafts when new options arrive.
  useEffect(() => { panel.current?.scrollIntoView({ block: "nearest" }); }, [split]);
  if (!split || !schedulePreview) return null;
  const selected = schedulePreview.previewId;
  const recalculate = () => workspaceService.refreshSplitOptions().catch(e => onError((e as Error).message));
  return (
    <div ref={panel} className="schedule-preview-bar split-options" role="region" aria-label={`Split options for ${split.title}`}>
      <div className="schedule-preview-head">
        <strong>Ways to split {split.title}</strong>
        {previewStale && <button className="button secondary small" disabled={saving} onClick={() => void recalculate()}>Recalculate options</button>}
      </div>
      <div className="split-option-list" role="radiogroup" aria-label="Split option">
        {split.options.map(option => (
          <label key={option.id} className={`split-option ${option.preview.previewId === selected ? "selected" : ""}`}>
            <input type="radio" name="split-option" checked={option.preview.previewId === selected} disabled={saving}
              onChange={() => workspaceService.chooseSplitOption(option.id)} />
            <span className="split-option-body">
              <strong>{option.label}</strong>
              <span className="muted small">{option.description}</span>
              <span className="split-option-summary">{splitOptionSummary(option)}</span>
              <ul className="split-option-sessions">
                {splitOptionSessions(option, split.taskIds).map(s => (
                  <li key={s.id}>{split.taskIds.length > 1 && `${s.title}: `}{longDate(s.date).replace(/, \d{4}$/, "")} · {timeRange(s.start, s.end)}</li>
                ))}
              </ul>
              {splitOptionWarnings(option).map(text => <span key={text} className="form-warning small">{text}</span>)}
            </span>
          </label>
        ))}
      </div>
      {split.notes.map(note => <p key={note} className="muted small">{note}</p>)}
    </div>
  );
}
