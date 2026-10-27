"""“Can this fit?” for reviewed drafts. Reads data only: nothing is stored, not even a proposal.

The engine runs three times against the same snapshot, in repair mode so saved work stays put unless
it must move:
1. saved data alone (baseline: what each saved task already gets),
2. with the drafts, displacement off (does it fit in unused capacity?),
3. with the drafts, bounded displacement on (does it fit if lower-priority flexible work moves?).
Both draft runs are checked by the independent validator, like any preview.

Only these are reported as proven impossible, because each follows from the inputs alone, whatever
any other work does: a deadline that has passed, an earliest start at or after the deadline, a
dependency cycle, a one-piece task longer than the focus or daily limit (incompatible settings),
more work than all free time in the item's window (an upper bound that ignores every flexible
session), no free block long enough for a one-piece item, or a fixed draft event overlapping
another fixed commitment. Anything else the heuristic could not place is "no plan found within the
search limits", which is not proof.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.plan_drafts import DRAFT_PREFIX, PlanDraft
from app.schedule_model import SchedulePreview
from app.scheduling_engine import (
    MAX_REPAIR_ATTEMPTS, MAX_REPAIR_ATTEMPTS_PER_TASK, _Planner, local_parts, merge, subtract, to_abs,
)
from app.scheduling_service import (
    engine_prefs, engine_tasks, event_refs, load_context, run_engine, saved_refs,
)
from app.scheduling_validator import ValidationError, validate_preview

FitStatus = Literal['fits_without_moving', 'fits_after_changes', 'no_plan_found', 'proven_infeasible']
PROVEN = {'deadline_passed', 'invalid_time_window', 'dependency_cycle', 'unsplit_exceeds_focus_limit',
          'unsplit_exceeds_daily_limit', 'insufficient_capacity', 'no_contiguous_interval', 'fixed_conflict'}


class Cause(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: str
    message: str
    proven: bool


class ItemFit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    draftId: str
    title: str
    kind: str
    status: Literal['fits', 'partial', 'unscheduled', 'fixed', 'fixed_conflict']
    neededMinutes: int
    scheduledMinutes: int
    unscheduledMinutes: int
    causes: list[Cause]


class Displaced(BaseModel):
    model_config = ConfigDict(extra='forbid')
    taskId: str
    title: str
    priority: str
    movedSessions: int
    unscheduledMinutesBefore: int
    unscheduledMinutesAfter: int


class Alternative(BaseModel):
    """A different input to preview. Never applied by the check itself."""
    model_config = ConfigDict(extra='forbid')
    id: str
    label: str
    draftId: str | None = None
    patch: dict = {}
    horizonDays: int | None = None


class FeasibilityResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    status: FitStatus
    summary: str
    items: list[ItemFit]
    displaced: list[Displaced]
    alternatives: list[Alternative]
    horizonDays: int
    windowStart: datetime
    windowEnd: datetime
    searchLimits: str
    savedDataChanged: Literal[False] = False


def _validated(preview: SchedulePreview, ctx, now):
    try:
        validate_preview(preview, tasks=ctx.tasks, availability=ctx.availability, prefs=ctx.prefs,
                         events=event_refs(ctx), saved=saved_refs(ctx), now=now)
    except ValidationError as exc:
        raise RuntimeError(f'The scheduler produced an invalid plan ({exc.code}): {exc.message}') from exc
    return preview


def _proofs(ctx, now: datetime, horizon: int, drafts: list[PlanDraft], full: SchedulePreview) -> dict[str, list[Cause]]:
    """Proven causes per draft id, from the inputs alone (see module docstring)."""
    tasks = engine_tasks(ctx)
    prefs = engine_prefs(ctx.prefs)
    planner = _Planner(tasks, ctx.availability, prefs, ctx.zone, ctx.events, ctx.existing, to_abs(now), horizon,
                       'repair', None, None)
    fixed = merge([*planner.events, *planner.rest_items, *[(w.start, w.end) for w in [*planner.work, *planner.flex]]])
    out: dict[str, list[Cause]] = {}
    by_id = {t.id: t for t in tasks}
    allocations = {a.taskId: a for a in full.tasks}
    for draft in drafts:
        causes: list[Cause] = []
        tid = DRAFT_PREFIX + draft.id
        if draft.kind == 'fixed_event':
            clashes = [c for c in full.conflicts if c.code == 'fixed_overlap'
                       and any((i.id or '').startswith(tid + ':') for i in c.items)]
            for c in clashes:
                causes.append(Cause(code='fixed_conflict', message=c.message + ' AutoPlan never moves fixed events '
                                    'without your permission.', proven=True))
            out[draft.id] = causes
            continue
        task, alloc = by_id[tid], allocations[tid]
        for reason in alloc.reasons:
            if reason.code in PROVEN:
                causes.append(Cause(code=reason.code, message=reason.message, proven=reason.code != 'insufficient_capacity'))
        if alloc.unallocatedMinutes and task.due > planner.now and task.due <= planner.window_end:
            lo = max(planner.start, task.earliest or planner.start)
            window = [(max(s, lo), min(e, task.due)) for s, e in planner.allowed(task) if min(e, task.due) > max(s, lo)]
            free = subtract(window, fixed)
            if task.is_work:
                per_day: dict = {}
                for s, e in free:
                    day = local_parts(s, ctx.zone)[0]
                    per_day[day] = per_day.get(day, 0) + e - s
                fixed_daily: dict = {}
                for w in planner.work:
                    if w.fixed and w.counts_daily:
                        day = local_parts(w.start, ctx.zone)[0]
                        fixed_daily[day] = fixed_daily.get(day, 0) + w.end - w.start
                bound = sum(max(0, min(m, prefs.max_daily - fixed_daily.get(d, 0))) for d, m in per_day.items())
            else:
                bound = sum(e - s for s, e in free)
            longest = max((e - s for s, e in free), default=0)
            causes = [c for c in causes if c.code != 'insufficient_capacity']
            if task.remaining > bound:
                causes.append(Cause(code='insufficient_capacity', proven=True, message=(
                    f'Even with no other flexible work, only {bound} minutes are free in its window before the '
                    f'deadline, and it needs {task.remaining}.')))
            elif not task.allow_split and longest < task.remaining:
                causes.append(Cause(code='no_contiguous_interval', proven=True, message=(
                    f'It needs one uninterrupted block of {task.remaining} minutes; the longest free block before the '
                    f'deadline is {longest} minutes.')))
        out[draft.id] = causes
    return out


def check_feasibility(user, db, now: datetime, drafts: list[PlanDraft], horizon: int) -> FeasibilityResult:
    included = [d for d in drafts if d.include]
    base_ctx = load_context(user, db, now, horizon)
    ctx = load_context(user, db, now, horizon, drafts=included)
    request = {'drafts': [d.model_dump() for d in included]}
    base = run_engine(base_ctx, now, horizon, 'repair', {}, displace=False)
    calm = _validated(run_engine(ctx, now, horizon, 'plan', request, displace=False), ctx, now)
    full = _validated(run_engine(ctx, now, horizon, 'plan', request, displace=True), ctx, now)
    proofs = _proofs(ctx, now, horizon, included, full)
    limits = (f'Planning horizon: {horizon} days ({full.startDate} to {full.endDate}, {full.timeZone}). Search: '
              f'earliest-fit in priority order plus at most {MAX_REPAIR_ATTEMPTS} local repairs '
              f'({MAX_REPAIR_ATTEMPTS_PER_TASK} per task).')

    def fits_all(preview: SchedulePreview) -> bool:
        allocations = {a.taskId: a for a in preview.tasks}
        return all(allocations[DRAFT_PREFIX + d.id].unallocatedMinutes == 0 for d in included if d.kind != 'fixed_event')

    base_short = {a.taskId: a.unallocatedMinutes for a in base.tasks}
    fixed_conflict = any(c.code == 'fixed_conflict' for causes in proofs.values() for c in causes)
    moved_calm = [r for r in calm.removed if r.session.type == 'work']
    hurt_calm = [a for a in calm.tasks if a.taskId in base_short and a.unallocatedMinutes > base_short[a.taskId]]

    items = []
    full_alloc = {a.taskId: a for a in full.tasks}
    for d in included:
        causes = proofs.get(d.id, [])
        if d.kind == 'fixed_event':
            items.append(ItemFit(draftId=d.id, title=d.title or 'Untitled', kind=d.kind,
                                 status='fixed_conflict' if causes else 'fixed', neededMinutes=0, scheduledMinutes=0,
                                 unscheduledMinutes=0, causes=causes))
            continue
        a = full_alloc[DRAFT_PREFIX + d.id]
        if a.unallocatedMinutes and not causes:
            causes = [Cause(code=r.code, message=r.message, proven=False) for r in a.reasons] or [
                Cause(code='no_plan_found', message='No place was found within the search limits.', proven=False)]
        status = 'fits' if not a.unallocatedMinutes else ('partial' if a.newMinutes else 'unscheduled')
        items.append(ItemFit(draftId=d.id, title=a.title, kind=d.kind, status=status, neededMinutes=a.remainingMinutes,
                             scheduledMinutes=a.newMinutes, unscheduledMinutes=a.unallocatedMinutes, causes=causes))

    displaced = []
    for a in full.tasks:
        if a.taskId.startswith(DRAFT_PREFIX):
            continue
        moved = sum(1 for r in full.removed if r.session.taskId == a.taskId and r.session.type == 'work')
        before, after = base_short.get(a.taskId, 0), a.unallocatedMinutes
        if moved or after > before:
            displaced.append(Displaced(taskId=a.taskId, title=a.title, priority=a.priority, movedSessions=moved,
                                       unscheduledMinutesBefore=before, unscheduledMinutesAfter=after))

    if fits_all(calm) and not moved_calm and not hurt_calm and not fixed_conflict:
        status: FitStatus = 'fits_without_moving'
        summary = 'Everything fits in your free time without moving any saved work.'
        displaced = []
    elif fits_all(full) and not fixed_conflict:
        status = 'fits_after_changes'
        moving = f'{len(displaced)} saved task moves' if len(displaced) == 1 else f'{len(displaced)} saved tasks move'
        summary = (f'Everything fits if {moving}. '
                   'Lower-priority work keeps its task; any minutes it loses are listed.')
    elif any(c.proven for i in items for c in i.causes):
        status = 'proven_infeasible'
        summary = 'Some items cannot fit under your current rules, whatever else moves. The reasons are listed.'
    else:
        status = 'no_plan_found'
        summary = ('No plan that fits everything was found within the search limits. That is not proof that none exists.')

    alternatives: list[Alternative] = []
    for item, d in zip(items, included):
        codes = {c.code for c in item.causes}
        if d.kind != 'fixed_event' and codes & {'unsplit_exceeds_focus_limit', 'no_contiguous_slot', 'no_contiguous_interval',
                                                'unsplit_exceeds_daily_limit'} and d.allowSplit is not True:
            alternatives.append(Alternative(id=f'split-{d.id}', label=f'Preview with "{item.title}" split into sessions',
                                            draftId=d.id, patch={'allowSplit': True}))
        if 'beyond_planning_window' in codes and horizon < 21:
            alternatives.append(Alternative(id='horizon-21', label='Preview with a 21-day planning window', horizonDays=21))
        if item.unscheduledMinutes and d.priority != 'High' and not any(c.proven for c in item.causes):
            alternatives.append(Alternative(id=f'priority-{d.id}', label=f'Preview with "{item.title}" as High priority',
                                            draftId=d.id, patch={'priority': 'High'}))
    unique = {a.id: a for a in alternatives}
    return FeasibilityResult(status=status, summary=summary, items=items, displaced=displaced,
                             alternatives=list(unique.values()), horizonDays=horizon, windowStart=full.windowStart,
                             windowEnd=full.windowEnd, searchLimits=limits)

