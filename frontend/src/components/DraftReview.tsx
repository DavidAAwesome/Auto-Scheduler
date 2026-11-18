import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { dayLabel, draftOutcome, draftSummary, kindPatch, needsMoreOptions, shortHint, tooShortToSplit } from "../services/planEntry";
import { calendarViewStore, draftLinkStore, useDraftLink } from "../services/uiState";
import { duration } from "../utils/taskDisplay";
import type { DraftIssue, DraftKind, DraftView, EventKind, FitOption, PlanDraft, Priority } from "../types/models";
import { clock12 } from "../utils/calendar";
import Icon from "./Icon";

const KIND_LABEL: Record<DraftKind, string> = { task: "Task", fixed_event: "Event", flexible_event: "Flexible" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const toTime = (m: number | null) => (m == null ? "" : `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
const fromTime = (value: string) => {
  if (!value) return null;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};

/** One short line under a row: what blocks it, and the buttons needed when a value only has to be confirmed. */
function RowHint({ view, issue, fit, onError, onShow }: { view: DraftView; issue?: DraftIssue; fit?: DraftIssue; onError: (message: string) => void; onShow?: () => void }) {
  const { draft: d } = view;
  const act = (action: () => unknown) => Promise.resolve().then(action).catch(e => onError((e as Error).message));
  const choose = (option: FitOption) => act(() => {
    if (option.id === "schedule_what_fits") return workspaceService.previewDrafts();
    if (Object.keys(option.patch).length) return workspaceService.updateDraft(d.id, option.patch);
    document.querySelector<HTMLInputElement>(`#draft-${d.id} input[type=date]`)?.focus();
  });
  const accept = (field: string) => workspaceService.updateDraft(d.id, { ambiguous: d.ambiguous.filter(f => f !== field) });
  if (!issue && !fit) return null;
  return (
    <p className="draft-hint" role="status">
      {onShow && issue?.code !== "ambiguous" ? <button type="button" className="draft-link is-blocking" onClick={onShow}>{shortHint(issue!)}</button> : <span>{issue ? shortHint(issue) : fit!.question}</span>}
      {issue?.code === "ambiguous" && (issue.field === "start" || issue.field === "end"
        ? ["AM", "PM"].map(half => <button key={half} type="button" className="draft-link" onClick={() => void act(() => workspaceService.clarifyDraft(d.id, issue.field, half))}>{half}</button>)
        : <button type="button" className="draft-link" onClick={() => accept(issue.field)}>Looks right</button>)}
      {!issue && fit?.options?.map(option => <button key={option.id} type="button" className="draft-link" onClick={() => void choose(option)}>{option.label}</button>)}
    </p>
  );
}

function MoreOptions({ view, others, red }: { view: DraftView; others: DraftView[]; red: (field: string) => string }) {
  const d = view.draft;
  const set = (patch: Partial<PlanDraft>) => workspaceService.updateDraft(d.id, patch);
  const tooShort = d.minutes != null && tooShortToSplit(d.minutes, d.minSessionMinutes);
  const canSplit = !tooShort && (d.allowSplit ?? d.kind === "task");
  if (d.kind === "fixed_event") {
    const weekly = (on: boolean) => set({ repeat: on ? { weekdays: d.date ? [(new Date(`${d.date}T12:00:00Z`).getUTCDay() + 6) % 7] : [], startDate: d.date, until: null } : null, ...(on ? { date: null } : { date: d.repeat?.startDate ?? null }) });
    return (
      <div className="draft-more">
        <label>Start<input type="time" step={300} className={red("start")} value={toTime(d.start)} onChange={e => set({ start: fromTime(e.target.value) })} /></label>
        <label>End<input type="time" step={300} className={red("end")} value={toTime(d.end)} onChange={e => set({ end: fromTime(e.target.value) })} /></label>
        <label>Place<input value={d.location ?? ""} maxLength={120} onChange={e => set({ location: e.target.value || null })} /></label>
        <label>Type
          <select value={d.eventKind} onChange={e => set({ eventKind: e.target.value as EventKind })}>
            {["Class", "Meeting", "Appointment", "Social", "Other"].map(k => <option key={k}>{k}</option>)}
          </select>
        </label>
        <label className="draft-check"><input type="checkbox" checked={!!d.repeat} onChange={e => weekly(e.target.checked)} /> Weekly</label>
        {d.repeat && (
          <>
            <div className={`draft-weekdays ${red("repeat.weekdays")}`} role="group" aria-label="Repeats on">
              {WEEKDAYS.map((name, i) => (
                <button key={name} type="button" className={`chip ${d.repeat!.weekdays.includes(i) ? "on" : ""}`} aria-pressed={d.repeat!.weekdays.includes(i)}
                  onClick={() => set({ repeat: { ...d.repeat!, weekdays: d.repeat!.weekdays.includes(i) ? d.repeat!.weekdays.filter(x => x !== i) : [...d.repeat!.weekdays, i].sort() } })}>{name}</button>
              ))}
            </div>
            <label>First date<input type="date" className={red("repeat.startDate")} value={d.repeat.startDate ?? ""} onChange={e => set({ repeat: { ...d.repeat!, startDate: e.target.value || null } })} /></label>
            <label>Last date<input type="date" className={red("repeat.until")} value={d.repeat.until ?? ""} onChange={e => set({ repeat: { ...d.repeat!, until: e.target.value || null } })} /></label>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="draft-more">
      <label>Due time<input type="time" step={300} className={red("dueTime")} value={toTime(d.dueTime)} onChange={e => set({ dueTime: fromTime(e.target.value) })} /></label>
      <label>Not before<input type="datetime-local" step={300} className={red("earliestStart")} value={(d.earliestStart ?? "").slice(0, 16)} onChange={e => set({ earliestStart: e.target.value ? `${e.target.value}:00` : null })} /></label>
      <label className="draft-check" title={tooShort ? "Too short to split: it needs at least two sessions of the shortest length" : undefined}>
        <input type="checkbox" checked={canSplit} disabled={tooShort} onChange={e => set({ allowSplit: e.target.checked })} /> Can split
      </label>
      {canSplit && (
        <>
          <label>Shortest session<input type="number" min={5} step={5} max={6000} placeholder="15" className={red("minSessionMinutes")} value={d.minSessionMinutes ?? ""} onChange={e => set({ minSessionMinutes: e.target.value ? Number(e.target.value) : null })} /></label>
          <label>Longest session<input type="number" min={5} step={5} max={6000} placeholder="60" value={d.maxSessionMinutes ?? ""} onChange={e => set({ maxSessionMinutes: e.target.value ? Number(e.target.value) : null })} /></label>
        </>
      )}
      {d.windows.length > 0 && (
        <span className="draft-meta">Preferred times: {d.windows.map(w => `${w.weekdays.length ? w.weekdays.map(i => WEEKDAYS[i]).join("/") + " " : ""}${clock12(w.start)}–${clock12(w.end)}`).join(", ")}
          <button type="button" className="draft-link" onClick={() => set({ windows: [] })}>Remove</button>
        </span>
      )}
      {d.dependsOn.length > 0 && (
        <span className="draft-meta">After {d.dependsOn.map(id => others.find(o => o.draft.id === id)?.draft.title ?? "a saved task").join(", ")}
          <button type="button" className="draft-link" onClick={() => set({ dependsOn: [] })}>Remove</button>
        </span>
      )}
    </div>
  );
}


/** The preview's result for one card: where the work landed, or what didn't fit and the fixes offered. */
function CardOutcome({ view, onError }: { view: DraftView; onError: (message: string) => void }) {
  const { schedulePreview, previewStale } = useWorkspace();
  const outcome = draftOutcome(view.draft.id, schedulePreview);
  if (!outcome || !view.draft.include || previewStale) return null;
  const show = () => { if (outcome.firstDate) calendarViewStore.set({ ...calendarViewStore.get(), anchor: outcome.firstDate }); };
  const choose = (choice: string) => {
    if (choice === "raise_focus_limit") { window.location.assign("#/settings"); return; }
    try {
      workspaceService.updateDraft(view.draft.id, choice === "allow_split" ? { allowSplit: true } : { kind: "flexible_event", allowSplit: false });
    } catch (e) { onError((e as Error).message); }
  };
  const placed = view.draft.kind === "fixed_event"
    ? outcome.eventDates.length ? `On the calendar${outcome.eventDates.length > 1 ? ` · ${outcome.eventDates.length}×` : ""}` : null
    : outcome.sessions ? `${outcome.sessions} session${outcome.sessions === 1 ? "" : "s"} · ${duration(outcome.minutes)}` : null;
  return (
    <div className={`card-outcome ${outcome.unscheduled || outcome.choices.length ? "warn" : "ok"}`}>
      {placed && (
        <button type="button" className="card-outcome-line" onClick={show} title="Show on the calendar">
          <Icon name="calendar" size={13} /> {placed}{outcome.firstDate ? ` · ${dayLabel(outcome.firstDate)}` : ""}
        </button>
      )}
      {outcome.unscheduled > 0 && <p className="card-outcome-line"><Icon name="alert" size={13} /> {duration(outcome.unscheduled)} won’t fit before it’s due</p>}
      {(outcome.unscheduled > 0 || outcome.choices.length > 0) && outcome.reasons.slice(0, 2).map(r => <p key={r} className="card-outcome-reason">{r}</p>)}
      {outcome.choices.length > 0 && (
        <div className="card-outcome-choices">
          {outcome.choices.map(c => <button key={c.id} type="button" className="chip" onClick={() => choose(c.id)}>{c.label}</button>)}
        </div>
      )}
    </div>
  );
}

/** One item as a card: a summary line to scan, the full editor only when opened. Hovering lights its calendar blocks. */
function DraftCard({ view, others }: { view: DraftView; others: DraftView[] }) {
  const d = view.draft;
  const link = useDraftLink();
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const card = useRef<HTMLLIElement>(null);
  const set = (patch: Partial<PlanDraft>) => workspaceService.updateDraft(d.id, patch);
  const fixed = d.kind === "fixed_event";
  const blocking = view.issues.filter(i => i.blocking);
  const fit = view.issues.find(i => i.code === "wont_fit") ?? view.issues.find(i => i.code === "past");
  const red = (field: string) => (blocking.some(i => i.field === field) ? "is-blocking" : "");
  const needed = needsMoreOptions(view);
  // Opened from a calendar block: this card stays expanded until it is closed or another one is opened.
  const focused = link.focus === d.id;
  useEffect(() => {
    if (focused) requestAnimationFrame(() => card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, [focused]);
  // A card that needs a fix opens itself, so the red field is visible without hunting for it.
  const expanded = open || focused || (blocking.length > 0 && d.include);
  const toggle = () => {
    if (focused) draftLinkStore.set({ ...draftLinkStore.get(), focus: null });
    setOpen(!expanded);
  };
  const hover = (on: boolean) => draftLinkStore.set({ ...draftLinkStore.get(), hover: on ? d.id : null });
  return (
    <li ref={card} id={`draft-${d.id}`} aria-label={d.title ?? "Untitled item"}
      className={`draft-card kind-${d.kind} ${d.include ? "" : "skipped"} ${blocking.length ? "needs-fix" : ""} ${link.hover === d.id ? "linked" : ""}`}
      onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)} onFocus={() => hover(true)} onBlur={() => hover(false)}>
      <div className="draft-card-head">
        <input type="checkbox" className="draft-tick" aria-label={`Include ${d.title ?? "this item"}`} checked={d.include} onChange={e => set({ include: e.target.checked })} />
        <button type="button" className="draft-card-toggle" aria-expanded={expanded} onClick={toggle}>
          <span className="draft-card-title">
            <span className={`draft-kind kind-${d.kind}`}>{KIND_LABEL[d.kind]}</span>
            <strong>{d.title ?? "Untitled"}</strong>
            {blocking.length > 0 && <Icon name="alert" size={14} />}
          </span>
          <span className="draft-card-summary">{draftSummary(d)}</span>
        </button>
        <button className="icon-button ghost small" aria-label={`Remove ${d.title ?? "item"}`} title="Remove" onClick={() => workspaceService.removeDraft(d.id)}><Icon name="close" size={15} /></button>
      </div>
      <RowHint view={view} issue={blocking[0]} fit={fit} onError={setError} onShow={needed && !more ? () => { setOpen(true); setMore(true); } : undefined} />
      <CardOutcome view={view} onError={setError} />
      {expanded && (
        <div className="draft-card-body">
          <label className="draft-field wide">Name
            <input className={`draft-title ${red("title")}`} value={d.title ?? ""} placeholder="Name" maxLength={80} onChange={e => set({ title: e.target.value || null })} />
          </label>
          <label className="draft-field">Kind
            <select value={d.kind} onChange={e => set(kindPatch(e.target.value as DraftKind))}>
              {(Object.keys(KIND_LABEL) as DraftKind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </label>
          {fixed ? (
            !d.repeat && (
              <label className="draft-field date">Date
                <input type="date" className={red("date") || (fit ? "is-blocking" : "")} value={d.date ?? ""} onChange={e => set({ date: e.target.value || null })} />
              </label>
            )
          ) : (
            <>
              <label className="draft-field">Length
                <span className="draft-minutes"><input type="number" min={5} step={5} max={6000} className={red("minutes")} value={d.minutes ?? ""} onChange={e => set({ minutes: e.target.value ? Number(e.target.value) : null })} /><span>min</span></span>
              </label>
              <label className="draft-field date">Due date
                <input type="date" className={red("deadline") || (fit ? "is-blocking" : "")} value={d.deadline ?? ""} onChange={e => set({ deadline: e.target.value || null })} />
              </label>
              <label className="draft-field">Priority
                <select className={`priority-${d.priority.toLowerCase()}`} value={d.priority} onChange={e => set({ priority: e.target.value as Priority })}>
                  {["High", "Medium", "Low"].map(p => <option key={p}>{p}</option>)}
                </select>
              </label>
            </>
          )}
          {fixed || more
            ? <MoreOptions view={view} others={others} red={red} />
            : <button type="button" className={`draft-link draft-more-link ${needed ? "is-blocking" : ""}`} onClick={() => setMore(true)}>Due time, splitting and more</button>}
        </div>
      )}
      {error && <p role="alert" className="draft-hint">{error}</p>}
    </li>
  );
}

/**
 * Items read from chat or an image, as cards in the right-hand panel beside the calendar. The calendar previews
 * them on its own as soon as every included item is complete (see useDraftAutoPreview); nothing is saved until Apply.
 */
export default function DraftReview() {
  const { planDrafts, planBusy, saving, schedulePreview, previewStale } = useWorkspace();
  const [error, setError] = useState("");
  if (!planDrafts) return <p className="review-empty muted">Items you describe in the chat appear here to check before anything is saved.</p>;
  const views = planDrafts.views;
  const included = views.filter(v => v.draft.include);
  const blocked = included.filter(v => !v.ready);
  const planPreview = schedulePreview?.mode === "plan";
  const status = blocked.length
    ? `Fix ${blocked.length} item${blocked.length === 1 ? "" : "s"} to see ${included.length === 1 ? "it" : "them"} on the calendar`
    : !included.length ? "Tick an item to preview it"
    : planBusy || (planPreview && previewStale) ? "Updating the calendar preview…"
    : planPreview ? "Shown on the calendar as dashed blocks. Apply below the calendar saves them."
    : "Not previewed";
  async function preview() {
    setError("");
    try { await workspaceService.previewDrafts(); } catch (e) { setError((e as Error).message); }
  }
  return (
    <section className="draft-review" aria-label="Review new items">
      <header className="draft-review-head">
        <strong>{views.length} new item{views.length === 1 ? "" : "s"}</strong>
        <span className="muted small">not saved yet</span>
      </header>
      <p className={`draft-review-status ${blocked.length ? "needs-fix" : ""}`} role="status" aria-live="polite">{status}</p>
      <ol className="draft-cards">
        {views.map(v => <DraftCard key={v.draft.id} view={v} others={views} />)}
      </ol>
      {error && <p role="alert" className="draft-hint">{error}</p>}
      <div className="draft-actions">
        {!planPreview && !blocked.length && included.length > 0 && (
          <button className="button small" disabled={planBusy || saving} onClick={() => void preview()}>Preview on calendar</button>
        )}
        <button type="button" className="draft-link" disabled={planBusy || saving} onClick={() => workspaceService.clearDrafts()}>Discard all</button>
      </div>
    </section>
  );
}
