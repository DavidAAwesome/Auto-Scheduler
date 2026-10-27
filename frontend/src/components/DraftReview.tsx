import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import type { DraftIssue, DraftKind, DraftView, EventKind, FeasibilityResult, FitStatus, PlanDraft, Priority } from "../types/models";
import { clock12 } from "../utils/calendar";
import Icon from "./Icon";

const KIND_LABEL: Record<DraftKind, string> = { task: "Task", fixed_event: "Fixed event", flexible_event: "Flexible event" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STATUS_LABEL: Record<FitStatus, string> = {
  fits_without_moving: "Fits without moving anything",
  fits_after_changes: "Fits after moving some saved work",
  no_plan_found: "No plan found within the search limits",
  proven_infeasible: "Cannot fit under your current rules",
};
/** Questions answered in a short phrase ("PM", "Dec 12"); others are edited in the fields above. */
const ANSWERABLE = new Set(["title", "minutes", "deadline", "dueTime", "date", "start", "end", "repeat.until", "repeat.startDate", "repeat.weekdays", "priority", "earliestStart", "location"]);

const toTime = (m: number | null) => (m == null ? "" : `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
const fromTime = (value: string) => {
  if (!value) return null;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};

function IssueRow({ draftId, issue, busy }: { draftId: string; issue: DraftIssue; busy: boolean }) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const canAnswer = issue.blocking && ANSWERABLE.has(issue.field);
  async function submit() {
    if (!answer.trim()) return;
    setError("");
    try {
      await workspaceService.clarifyDraft(draftId, issue.field, answer);
      setAnswer("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <li className={`draft-issue ${issue.blocking ? "blocking" : "warning"}`}>
      <span>{issue.question}</span>
      {canAnswer && (
        <form className="draft-answer" onSubmit={e => { e.preventDefault(); void submit(); }}>
          <input value={answer} onChange={e => setAnswer(e.target.value)} placeholder={issue.field === "start" || issue.field === "end" ? "AM or PM" : "Your answer"} aria-label={`Answer: ${issue.question}`} maxLength={200} />
          <button className="button small secondary" disabled={busy || !answer.trim()}>Answer</button>
        </form>
      )}
      {error && <small role="alert" className="form-error">{error}</small>}
    </li>
  );
}

function DraftCard({ view, index, others, busy }: { view: DraftView; index: number; others: DraftView[]; busy: boolean }) {
  const d = view.draft;
  const set = (patch: Partial<PlanDraft>) => workspaceService.updateDraft(d.id, patch);
  const fixed = d.kind === "fixed_event";
  const uncertain = (field: string) => (d.ambiguous.includes(field) || d.unreadable.includes(field) ? "uncertain" : "");
  return (
    <li className={`draft-card ${view.ready ? "ready" : "needs-answer"} ${d.include ? "" : "skipped"}`} aria-label={`Item ${index + 1}: ${d.title ?? "untitled"}`}>
      <div className="draft-row">
        <label className="draft-include" title="Include this item">
          <input type="checkbox" checked={d.include} onChange={e => set({ include: e.target.checked })} />
        </label>
        <input className={`draft-title ${uncertain("title")}`} value={d.title ?? ""} placeholder="Name" maxLength={80} aria-label="Name" onChange={e => set({ title: e.target.value || null })} />
        <select value={d.kind} aria-label="Kind" onChange={e => set({ kind: e.target.value as DraftKind, ...(e.target.value === "fixed_event" ? {} : { repeat: null }) })}>
          {(Object.keys(KIND_LABEL) as DraftKind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <button className="icon-button ghost small" aria-label={`Remove ${d.title ?? "item"}`} onClick={() => workspaceService.removeDraft(d.id)}><Icon name="close" size={15} /></button>
      </div>
      {d.sourceText && <p className="draft-source" title="Original wording">“{d.sourceText}”</p>}
      <div className="draft-fields">
        {fixed ? (
          <>
            {!d.repeat && <label>Date<input type="date" className={uncertain("date")} value={d.date ?? ""} onChange={e => set({ date: e.target.value || null })} /></label>}
            <label>Start<input type="time" step={300} className={uncertain("start")} value={toTime(d.start)} onChange={e => set({ start: fromTime(e.target.value), ambiguous: d.ambiguous.filter(f => f !== "start") })} /></label>
            <label>End<input type="time" step={300} className={uncertain("end")} value={toTime(d.end)} onChange={e => set({ end: fromTime(e.target.value), ambiguous: d.ambiguous.filter(f => f !== "end") })} /></label>
            <label>Type
              <select value={d.eventKind} onChange={e => set({ eventKind: e.target.value as EventKind })}>
                {["Class", "Meeting", "Appointment", "Social", "Other"].map(k => <option key={k}>{k}</option>)}
              </select>
            </label>
            <label className="draft-check"><input type="checkbox" checked={!!d.repeat} onChange={e => set({ repeat: e.target.checked ? { weekdays: d.date ? [(new Date(`${d.date}T12:00:00Z`).getUTCDay() + 6) % 7] : [], startDate: d.date, until: null } : null })} /> Weekly</label>
            {d.repeat && (
              <>
                <div className="draft-weekdays" role="group" aria-label="Repeats on">
                  {WEEKDAYS.map((name, i) => (
                    <button key={name} type="button" className={`chip ${d.repeat!.weekdays.includes(i) ? "on" : ""}`} aria-pressed={d.repeat!.weekdays.includes(i)}
                      onClick={() => set({ repeat: { ...d.repeat!, weekdays: d.repeat!.weekdays.includes(i) ? d.repeat!.weekdays.filter(x => x !== i) : [...d.repeat!.weekdays, i].sort() } })}>{name}</button>
                  ))}
                </div>
                <label>First date<input type="date" className={uncertain("repeat.startDate")} value={d.repeat.startDate ?? ""} onChange={e => set({ repeat: { ...d.repeat!, startDate: e.target.value || null } })} /></label>
                <label>Last date<input type="date" className={uncertain("repeat.until")} value={d.repeat.until ?? ""} onChange={e => set({ repeat: { ...d.repeat!, until: e.target.value || null } })} /></label>
              </>
            )}
          </>
        ) : (
          <>
            <label>Minutes<input type="number" min={5} step={5} max={6000} className={uncertain("minutes")} value={d.minutes ?? ""} onChange={e => set({ minutes: e.target.value ? Number(e.target.value) : null })} /></label>
            <label>{d.kind === "task" ? "Due" : "By"}<input type="date" className={uncertain("deadline")} value={d.deadline ?? ""} onChange={e => set({ deadline: e.target.value || null })} /></label>
            <label>at<input type="time" step={300} value={toTime(d.dueTime)} onChange={e => set({ dueTime: fromTime(e.target.value) })} /></label>
            <label>Priority
              <select value={d.priority} onChange={e => set({ priority: e.target.value as Priority, assumed: d.assumed.filter(f => f !== "priority") })}>
                {["High", "Medium", "Low"].map(p => <option key={p}>{p}</option>)}
              </select>
            </label>
            <label className="draft-check" title={d.kind === "flexible_event" ? "Flexible events stay in one block unless you allow splitting" : "Allow the work to be split into sessions"}>
              <input type="checkbox" checked={d.allowSplit ?? d.kind === "task"} onChange={e => set({ allowSplit: e.target.checked })} /> Can split
            </label>
            {d.dependsOn.length > 0 && <span className="draft-meta">After {d.dependsOn.map(id => others.find(o => o.draft.id === id)?.draft.title ?? "a saved task").join(", ")}</span>}
            {d.windows.length > 0 && <span className="draft-meta">Only {d.windows.map(w => `${w.weekdays.length ? w.weekdays.map(i => WEEKDAYS[i]).join("/") + " " : ""}${clock12(w.start)}–${clock12(w.end)}`).join(", ")}</span>}
          </>
        )}
      </div>
      {view.issues.length > 0 && <ul className="draft-issues">{view.issues.map(issue => <IssueRow key={issue.field} draftId={d.id} issue={issue} busy={busy} />)}</ul>}
    </li>
  );
}

function FitReport({ result, busy, onAlternative }: { result: FeasibilityResult; busy: boolean; onAlternative: (id: string) => void }) {
  return (
    <section className={`fit-report status-${result.status}`} aria-label="Can this fit?" aria-live="polite">
      <strong>{STATUS_LABEL[result.status]}</strong> <span>{result.summary}</span>
      <ul>
        {result.items.map(item => (
          <li key={item.draftId}>
            {item.title}: {item.status === "fits" ? "fits" : item.status === "fixed" ? "fixed time, no conflict"
              : item.status === "fixed_conflict" ? "conflicts with another fixed commitment"
                : `${item.unscheduledMinutes} of ${item.neededMinutes} min not placed`}
            {item.causes.map(c => <div key={c.code} className="muted small">{c.proven ? "Proven: " : "Not proven: "}{c.message}</div>)}
          </li>
        ))}
      </ul>
      {result.displaced.length > 0 && (
        <p className="small">Moves saved work: {result.displaced.map(d => `${d.title} (${d.priority}, ${d.movedSessions} session${d.movedSessions === 1 ? "" : "s"} moved${d.unscheduledMinutesAfter > d.unscheduledMinutesBefore ? `, ${d.unscheduledMinutesAfter} min left unscheduled; the task is kept` : ""})`).join("; ")}.</p>
      )}
      {result.alternatives.length > 0 && (
        <div className="fit-alternatives">
          {result.alternatives.map(a => <button key={a.id} className="chip" disabled={busy} onClick={() => onAlternative(a.id)}>{a.label}</button>)}
        </div>
      )}
      <p className="muted small">{result.searchLimits} Nothing was saved.</p>
    </section>
  );
}

/** Editable review of items read from chat or an image. Nothing is saved until a preview of them is applied. */
export default function DraftReview() {
  const { planDrafts, feasibility, planBusy, saving, schedulePreview, previewStale } = useWorkspace();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(true);
  const lastReviewed = useRef("");
  const busy = planBusy || saving;
  const key = JSON.stringify(planDrafts?.views.map(v => v.draft) ?? []);
  // Edits are re-checked by the backend shortly after typing stops.
  useEffect(() => {
    if (!planDrafts || key === lastReviewed.current) return;
    const timer = setTimeout(() => {
      lastReviewed.current = key;
      workspaceService.reviewDrafts().catch(e => setError((e as Error).message));
    }, 500);
    return () => clearTimeout(timer);
  }, [key, planDrafts]);
  if (!planDrafts) return null;
  const views = planDrafts.views;
  const included = views.filter(v => v.draft.include);
  const blocked = included.filter(v => !v.ready);
  async function run(action: () => Promise<unknown>) {
    setError("");
    try { await action(); } catch (e) { setError((e as Error).message); }
  }
  function alternative(id: string) {
    const alt = feasibility?.alternatives.find(a => a.id === id);
    if (!alt) return;
    if (alt.draftId) workspaceService.updateDraft(alt.draftId, alt.patch);
    if (alt.horizonDays) workspaceService.setPlanHorizon(alt.horizonDays);
    void run(() => workspaceService.reviewDrafts().then(() => workspaceService.previewDrafts()));
  }
  const planPreview = schedulePreview?.mode === "plan";
  return (
    <section className="draft-review" aria-label="Review new items">
      <header className="draft-review-head">
        <button className="draft-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={16} />
          <strong>Review {views.length} new item{views.length === 1 ? "" : "s"}</strong>
          <span className="muted small"> · draft, not saved{blocked.length ? ` · ${blocked.length} need${blocked.length === 1 ? "s" : ""} an answer` : ""}</span>
        </button>
        <span className="muted small">{planDrafts.provider === "openai" ? "Read by AI" : planDrafts.provider === "local" ? "Read by AutoPlan’s parser" : "From chat"}</span>
      </header>
      {open && (
        <>
          {planDrafts.notes.map(note => <p key={note} className="muted small">{note}</p>)}
          <ol className="draft-list">{views.map((v, i) => <DraftCard key={v.draft.id} view={v} index={i} others={views} busy={busy} />)}</ol>
          {feasibility && <FitReport result={feasibility} busy={busy} onAlternative={alternative} />}
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="draft-actions">
            <label className="small">Plan
              <select value={planDrafts.horizonDays} onChange={e => workspaceService.setPlanHorizon(Number(e.target.value))}>
                {[7, 14, 21].map(n => <option key={n} value={n}>{n} days</option>)}
              </select>
            </label>
            <button className="button small secondary" disabled={busy || !included.length || blocked.length > 0} onClick={() => void run(() => workspaceService.checkFit())}>
              {planBusy ? "Checking…" : "Can this fit?"}
            </button>
            <button className="button small" disabled={busy || !included.length || blocked.length > 0} onClick={() => void run(() => workspaceService.previewDrafts())}>
              {planPreview && previewStale ? "Preview again" : "Preview on calendar"}
            </button>
            <button className="button small ghost" disabled={busy} onClick={() => workspaceService.clearDrafts()}>Discard</button>
          </div>
          {blocked.length > 0 && <p className="muted small">Answer the highlighted questions to check or preview. Unticked items are left out.</p>}
        </>
      )}
    </section>
  );
}
