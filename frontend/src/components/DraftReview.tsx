import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { kindPatch, needsMoreOptions, shortHint, tooShortToSplit, visibleRows } from "../services/planEntry";
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

function DraftRow({ view, others }: { view: DraftView; others: DraftView[] }) {
  const d = view.draft;
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<PlanDraft>) => workspaceService.updateDraft(d.id, patch);
  const fixed = d.kind === "fixed_event";
  const blocking = view.issues.filter(i => i.blocking);
  const fit = view.issues.find(i => i.code === "wont_fit");
  const red = (field: string) => (blocking.some(i => i.field === field) ? "is-blocking" : "");
  const needed = needsMoreOptions(view);  // the field to fix is behind "More options": its row cell and link turn red
  const eventTime = d.start != null && d.end != null ? `${clock12(d.start)}–${clock12(d.end % 1440)}` : "Set time";
  return (
    <li id={`draft-${d.id}`} className={`draft-item ${d.include ? "" : "skipped"}`} aria-label={d.title ?? "Untitled item"}>
      <div className="draft-line">
        <input type="checkbox" className="draft-tick" aria-label={`Include ${d.title ?? "this item"}`} checked={d.include} onChange={e => set({ include: e.target.checked })} />
        <input className={`draft-title ${red("title")}`} value={d.title ?? ""} placeholder="Name" maxLength={80} aria-label="Name" onChange={e => set({ title: e.target.value || null })} />
        <select className="draft-chip" value={d.kind} aria-label="Kind" onChange={e => set(kindPatch(e.target.value as DraftKind))}>
          {(Object.keys(KIND_LABEL) as DraftKind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        {fixed
          ? <button type="button" className={`draft-value ${red("start") || red("end")}`} onClick={() => setMore(true)}>{eventTime}</button>
          : <label className="draft-minutes"><input type="number" min={5} step={5} max={6000} className={red("minutes")} aria-label="Minutes" value={d.minutes ?? ""} onChange={e => set({ minutes: e.target.value ? Number(e.target.value) : null })} /><span>min</span></label>}
        {fixed && d.repeat
          ? <button type="button" className={`draft-value ${red("repeat.weekdays") || red("repeat.startDate") || red("repeat.until")}`} onClick={() => setMore(true)}>{d.repeat.weekdays.map(i => WEEKDAYS[i]).join(", ") || "Set days"}</button>
          : <input type="date" className={`draft-date ${fixed ? red("date") : red("deadline") || (fit ? "is-blocking" : "")}`} aria-label={fixed ? "Date" : "Due date"} value={(fixed ? d.date : d.deadline) ?? ""} onChange={e => set(fixed ? { date: e.target.value || null } : { deadline: e.target.value || null })} />}
        {fixed
          ? <span className="draft-chip-space" />
          : <select className={`draft-chip priority-${d.priority.toLowerCase()}`} value={d.priority} aria-label="Priority" onChange={e => set({ priority: e.target.value as Priority })}>
              {["High", "Medium", "Low"].map(p => <option key={p}>{p}</option>)}
            </select>}
        <button type="button" className={`draft-link draft-more-link ${needed && !more ? "is-blocking" : ""}`} aria-expanded={more} onClick={() => setMore(!more)}>{more ? "Fewer options" : "More options"}</button>
        <button className="icon-button ghost small" aria-label={`Remove ${d.title ?? "item"}`} onClick={() => workspaceService.removeDraft(d.id)}><Icon name="close" size={15} /></button>
        <RowHint view={view} issue={blocking[0]} fit={fit} onError={setError} onShow={needed && !more ? () => setMore(true) : undefined} />
      </div>
      {error && <p role="alert" className="draft-hint">{error}</p>}
      {more && <MoreOptions view={view} others={others} red={red} />}
    </li>
  );
}

/** Items read from chat or an image, one row each. Nothing is saved until a preview of them is applied. */
export default function DraftReview() {
  const { planDrafts, planBusy, saving, schedulePreview, previewStale } = useWorkspace();
  const [error, setError] = useState("");
  // Open by default. A preview needs the calendar, so the rows step aside for it until the header is pressed.
  const [choice, setChoice] = useState<{ previewId: string | null; open: boolean } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const lastReviewed = useRef("");
  const panel = useRef<HTMLElement>(null);
  const busy = planBusy || saving;
  const key = JSON.stringify(planDrafts?.views.map(v => v.draft) ?? []);
  const planPreview = schedulePreview?.mode === "plan";
  const previewId = planPreview ? schedulePreview.previewId : null;
  const open = choice?.previewId === previewId ? choice.open : !planPreview;
  const setOpen = (value: boolean) => setChoice({ previewId, open: value });
  // "Edit" in the chat opens the panel at the first item.
  useEffect(() => {
    const show = () => {
      setChoice(current => ({ previewId: current?.previewId ?? null, open: true }));
      requestAnimationFrame(() => {
        panel.current?.scrollIntoView({ block: "start", behavior: "smooth" });
        panel.current?.querySelector<HTMLInputElement>(".draft-title")?.focus({ preventScroll: true });
      });
    };
    window.addEventListener("autoplan:review-drafts", show);
    return () => window.removeEventListener("autoplan:review-drafts", show);
  }, []);
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
  const { rows, hidden } = visibleRows(views, showAll);
  async function preview() {
    setError("");
    try { await workspaceService.previewDrafts(); } catch (e) { setError((e as Error).message); }
  }
  return (
    <section ref={panel} className="draft-review" aria-label="Review new items">
      <button className="draft-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={16} />
        <strong>{views.length} new item{views.length === 1 ? "" : "s"}</strong>
        <span className="muted small">not saved{blocked.length ? ` · ${blocked.length} need${blocked.length === 1 ? "s" : ""} a fix` : ""}</span>
      </button>
      {open && (
        <>
          <ol className="draft-list">
            {rows.map(v => <DraftRow key={v.draft.id} view={v} others={views} />)}
            {hidden > 0 && <li><button type="button" className="draft-link" onClick={() => setShowAll(true)}>+{hidden} more</button></li>}
          </ol>
          {error && <p role="alert" className="draft-hint">{error}</p>}
          <div className="draft-actions">
            <button className="button small" disabled={busy || !included.length || blocked.length > 0} title={blocked.length ? "Fix the red fields first" : undefined} onClick={() => void preview()}>
              {planPreview && previewStale ? "Preview again" : "Preview on calendar"}
            </button>
            <button type="button" className="draft-link" disabled={busy} onClick={() => workspaceService.clearDrafts()}>Discard</button>
          </div>
        </>
      )}
    </section>
  );
}
