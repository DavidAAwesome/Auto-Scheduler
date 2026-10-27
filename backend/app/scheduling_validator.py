"""Independent verification of a schedule preview against current data.

It re-derives every rule from the inputs instead of trusting the engine's bookkeeping, and runs
both when a preview is generated and again inside the Apply transaction. Problems that involve
only fixed items (events, locked or manual work) are conflicts to report, not validation errors;
anything involving new or kept flexible sessions is an error.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from app.schedule_model import SchedulePreferences, SchedulePreview
from app.scheduling_engine import CONTEXT_LOOKBACK, local_parts, local_to_abs, subtract, to_abs
from app.workspace import Availability, TaskOutput, resolve_available_day


class ValidationError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass(frozen=True)
class SavedRef:
    id: str
    task_id: str | None
    type: str
    status: str
    locked: bool
    source: str
    start: int
    end: int


@dataclass(frozen=True)
class EventRef:
    title: str
    start: int
    end: int


def _due(task: TaskOutput, zone: ZoneInfo) -> int:
    end = 1440 if task.dueTime >= 1439 else task.dueTime
    return local_to_abs(date.fromisoformat(task.deadline), end, zone)


def _rest_gap(start: int, end: int, events: list[tuple[int, int]], minutes: int) -> bool:
    return end - start >= minutes and any(e - s >= minutes for s, e in subtract([(start, end)], events))


def validate_preview(preview: SchedulePreview, *, tasks: list[TaskOutput], availability: Availability,
                     prefs: SchedulePreferences, events: list[EventRef], saved: list[SavedRef],
                     now: datetime) -> None:
    """Raise ValidationError when the preview breaks a hard rule under the given (current) data."""
    zone = ZoneInfo(availability.timeZone)
    if preview.timeZone != availability.timeZone:
        raise ValidationError('stale', 'Your timezone changed after this preview was made.')
    now_min = to_abs(now)
    window_start, window_end = to_abs(preview.windowStart), to_abs(preview.windowEnd)
    task_by_id = {t.id: t for t in tasks}
    open_ids = {t.id for t in tasks if not t.done}
    saved_by_id = {s.id: s for s in saved}

    items = []  # (start, end, label, checked, type, task_id)
    for session in preview.sessions:
        start, end = to_abs(session.startAt), to_abs(session.endAt)
        if end <= start:
            raise ValidationError('zero_length', f'"{session.title}" has no duration.')
        if session.type == 'work' and (session.taskId is None or session.taskId not in task_by_id):
            raise ValidationError('ownership', 'A work session refers to a task that is not yours.')
        if session.type == 'break' and session.taskId is not None:
            raise ValidationError('invalid_data', 'A break cannot belong to a task.')
        checked = session.change in {'new', 'kept'}
        if session.change in {'retained', 'kept', 'truncated'}:
            original = saved_by_id.get(session.id)
            if original is None or original.status != 'saved':
                raise ValidationError('stale', f'Saved session "{session.title}" changed or is no longer yours.')
            same_start = original.start == start
            same_end = original.end == end if session.change != 'truncated' else end <= original.end
            if not (same_start and same_end):
                raise ValidationError('stale', f'Saved session "{session.title}" was moved after this preview was made.')
        if checked and start < now_min:
            raise ValidationError('past', f'"{session.title}" would start in the past. Generate a new preview.')
        if session.change == 'new' and (start < window_start or end > window_end):
            raise ValidationError('window', f'"{session.title}" is outside the planning window.')
        items.append((start, end, session.title, checked, session.type, session.taskId))
    for removal in preview.removed:
        original = saved_by_id.get(removal.session.id)
        if original is None or original.status != 'saved':
            raise ValidationError('stale', 'A session this preview replaces has changed. Generate a new preview.')
        if (original.start, original.end) != (to_abs(removal.session.startAt), to_abs(removal.session.endAt)):
            raise ValidationError('stale', 'A session this preview replaces was moved. Generate a new preview.')

    # Lunch (protected rest) for each local day in the window.
    lunch = []
    if prefs.lunch:
        day, _ = local_parts(window_start, zone)
        last, _ = local_parts(window_end - 1, zone)
        while day <= last:
            lunch.append((local_to_abs(day, prefs.lunch.start, zone), local_to_abs(day, prefs.lunch.end, zone)))
            day += timedelta(days=1)

    # 1. No overlaps among sessions, events and lunch.
    timeline = [(s, e, label, checked, kind) for s, e, label, checked, kind, _ in items]
    timeline += [(ev.start, ev.end, ev.title, False, 'event') for ev in events]
    timeline += [(s, e, 'Lunch', False, 'lunch') for s, e in lunch]
    timeline.sort(key=lambda x: (x[0], x[1]))
    for i, a in enumerate(timeline):
        for b in timeline[i + 1:]:
            if b[0] >= a[1]:
                break
            if {a[4], b[4]} <= {'break', 'lunch'}:
                continue  # two rest intervals may coincide
            if a[3] or b[3]:
                raise ValidationError('overlap', f'"{a[2]}" overlaps "{b[2]}".')

    # 2. Availability, deadlines, earliest start and dependencies for checked work.
    work = [(s, e, tid, checked) for s, e, _label, checked, kind, tid in items if kind == 'work']
    ends_by_task: dict[str, int] = {}
    for s, e, tid, _ in work:
        ends_by_task[tid] = max(ends_by_task.get(tid, e), e)
    for s, e, tid, checked in work:
        if not checked:
            continue
        task = task_by_id[tid]
        if tid not in open_ids:
            raise ValidationError('task_closed', f'"{task.title}" is complete; it needs no more work.')
        day, _ = local_parts(s, zone)
        hours = resolve_available_day(availability, day)
        periods = [(local_to_abs(day, p.start, zone), local_to_abs(day, p.end, zone)) for p in hours.periods] if hours.enabled else []
        if not any(ps <= s and e <= pe for ps, pe in periods):
            raise ValidationError('availability', f'Work on "{task.title}" is outside your available hours.')
        if e > _due(task, zone):
            raise ValidationError('deadline', f'Work on "{task.title}" ends after its deadline.')
        if task.earliestStart:
            earliest = datetime.fromisoformat(task.earliestStart.replace('Z', '+00:00'))
            earliest = earliest if earliest.tzinfo else earliest.replace(tzinfo=zone)
            if s < to_abs(earliest):
                raise ValidationError('earliest_start', f'Work on "{task.title}" starts before it may begin.')
        for dep in task.dependsOn:
            dep_task = task_by_id.get(dep)
            if dep_task is None or dep_task.done:
                continue
            if dep not in ends_by_task or ends_by_task[dep] > s:
                raise ValidationError('dependency', f'"{task.title}" starts before "{dep_task.title}" is finished.')

    # 3. Daily limit and continuous-work limit (with recent past work as context).
    context = [(r.start, r.end, r.task_id, False) for r in saved
               if r.type == 'work' and r.status in {'saved', 'completed'} and now_min - CONTEXT_LOOKBACK < r.end <= now_min
               and r.id not in {x.id for x in preview.sessions}]
    all_work = sorted(work + context)
    daily: dict[date, list[int]] = {}
    for s, e, _tid, checked in work:
        day, _ = local_parts(s, zone)
        total, flag = daily.get(day, [0, 0])
        daily[day] = [total + e - s, flag or checked]
    for r in saved:
        if r.type == 'work' and r.status == 'completed' and r.id not in {x.id for x in preview.sessions}:
            day, _ = local_parts(r.start, zone)
            if day in daily:
                daily[day][0] += r.end - r.start
    for day, (total, flag) in daily.items():
        if flag and total > prefs.maxDailyWorkMinutes:
            raise ValidationError('daily_limit', f'{day.isoformat()} has {total} minutes of task work; the limit is '
                                  f'{prefs.maxDailyWorkMinutes}.')
    busy = sorted((ev.start, ev.end) for ev in events)
    rests = [(s, e) for s, e, _l, _c, kind, _t in items if kind == 'break'] + lunch
    runs: list[list] = []  # start, end, total, checked
    for s, e, _tid, checked in all_work:
        if runs and not _rest_gap(runs[-1][1], s, busy, prefs.breakMinutes):
            runs[-1][1] = max(runs[-1][1], e)
            runs[-1][2] += e - s
            runs[-1][3] = runs[-1][3] or checked
        else:
            runs.append([s, e, e - s, checked])
    for run in runs:
        if run[3] and run[2] > prefs.focusMinutes:
            raise ValidationError('focus_limit', f'{run[2]} minutes of continuous work exceeds the '
                                  f'{prefs.focusMinutes}-minute focus limit.')
    for a, b in zip(runs, runs[1:]):
        if not (a[3] or b[3]) or a[2] + b[2] <= prefs.focusMinutes or b[0] <= now_min:
            continue
        if local_parts(a[1], zone)[0] != local_parts(b[0], zone)[0]:
            continue
        if not any(s >= a[1] and e <= b[0] and e - s >= prefs.breakMinutes for s, e in rests):
            raise ValidationError('missing_break', 'A required break is missing before work continues.')

    # 4. Duration conservation per open task.
    allocation_by_task = {a.taskId: a for a in preview.tasks}
    if set(allocation_by_task) != open_ids:
        raise ValidationError('stale', 'Your tasks changed after this preview was made.')
    for tid in open_ids:
        task, alloc = task_by_id[tid], allocation_by_task[tid]
        remaining = max(0, task.minutes - task.completedMinutes)
        retained = sum(to_abs(x.endAt) - to_abs(x.startAt) for x in preview.sessions
                       if x.taskId == tid and x.type == 'work' and x.change in {'retained', 'truncated', 'kept'})
        new = sum(to_abs(x.endAt) - to_abs(x.startAt) for x in preview.sessions
                  if x.taskId == tid and x.type == 'work' and x.change == 'new')
        if alloc.remainingMinutes != remaining:
            raise ValidationError('stale', f'"{task.title}" has a different remaining workload now.')
        if (alloc.retainedMinutes, alloc.newMinutes) != (retained, new):
            raise ValidationError('duration_mismatch', f'"{task.title}" session minutes do not match its totals.')
        if alloc.unallocatedMinutes < 0 or alloc.overAllocatedMinutes < 0:
            raise ValidationError('duration_mismatch', f'"{task.title}" has negative totals.')
        if retained + new + alloc.unallocatedMinutes != remaining + alloc.overAllocatedMinutes:
            raise ValidationError('duration_mismatch', f'"{task.title}": retained + new + unallocated minutes do not '
                                  'equal the remaining workload.')
        if alloc.overAllocatedMinutes and (new or alloc.unallocatedMinutes):
            raise ValidationError('duration_mismatch', f'"{task.title}" is over-allocated but still received new work.')
