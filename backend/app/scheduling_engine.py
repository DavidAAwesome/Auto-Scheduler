"""Deterministic scheduling heuristic.

Hard constraints (must hold for every proposed session):
- No overlap with calendar events, locked/manual sessions, or other proposed sessions
- Inside user availability
- Not in the past
- Finish by the task deadline/dueTime
- Dependencies complete before dependent work starts
- Unsplit tasks need one contiguous block; split tasks respect min/max session size
- scheduledMinutes + unscheduledMinutes == remaining workload after fixed sessions
- Never silently drop or shorten work

Preferences (heuristic only — failure here is not a proof of mathematical infeasibility):
- Order by dependency readiness, then deadline/dueTime urgency, then priority, then task id
- Prefer fewer splits and larger legal sessions (up to maxSessionMinutes)
- Prefer earlier start times
- Prefer keeping existing unlocked auto sessions that still fit (stable replanning)

Identical inputs produce identical outputs (stable sort keys, deterministic packing).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from hashlib import sha256
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field

from app.workspace import Availability, TaskOutput, resolve_available_day

UTC = timezone.utc
STEP = 15
PRIORITIES = {'High': 0, 'Medium': 1, 'Low': 2}

ReasonCode = Literal[
    'scheduled',
    'partial',
    'insufficient_availability',
    'no_contiguous_slot',
    'remainder_below_min_session',
    'deadline_passed',
    'dependency_cycle',
    'dependency_unmet',
    'invalid_data',
    'outside_planning_window',
    'locked_capacity_exceeded',
]


class FixedSession(BaseModel):
    """Existing sessions that must not move (locked or manual)."""
    model_config = ConfigDict(extra='forbid')
    id: str
    taskId: str
    date: str
    start: int
    end: int
    locked: bool = False
    source: Literal['manual', 'auto'] = 'manual'


class BusyBlock(BaseModel):
    model_config = ConfigDict(extra='forbid')
    date: str
    start: int
    end: int
    label: str = 'busy'


class ProposedSession(BaseModel):
    model_config = ConfigDict(extra='forbid')
    taskId: str
    title: str
    date: str
    start: int
    end: int
    source: Literal['auto'] = 'auto'
    locked: bool = False
    kept: bool = False  # True when an existing unlocked auto session was retained


class TaskScheduleResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    taskId: str
    title: str
    remainingMinutes: int
    scheduledMinutes: int
    unscheduledMinutes: int
    status: Literal['scheduled', 'partial', 'unscheduled']
    reason: ReasonCode
    message: str


class ScheduleResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: Literal[1] = 1
    generatedAt: datetime
    startDate: str
    endDate: str
    timeZone: str
    sessions: list[ProposedSession]
    tasks: list[TaskScheduleResult]
    explanations: list[str] = Field(default_factory=list)
    inputFingerprint: str


@dataclass
class _Interval:
    date: str
    start: int
    end: int

    @property
    def length(self) -> int:
        return self.end - self.start


def _local_parts(now: datetime, zone: ZoneInfo) -> tuple[date, int]:
    local = now.astimezone(zone)
    return local.date(), local.hour * 60 + local.minute


def _unique_instant(local: datetime, zone: ZoneInfo) -> datetime | None:
    """Reject nonexistent / ambiguous DST wall times instead of guessing."""
    instants = set()
    for fold in (0, 1):
        candidate = local.replace(tzinfo=zone, fold=fold).astimezone(UTC)
        if candidate.astimezone(zone).replace(tzinfo=None) == local:
            instants.add(candidate)
    return next(iter(instants)) if len(instants) == 1 else None


def _deadline_end_minute(task: TaskOutput) -> int:
    # dueTime 1439 means work may run through midnight (end <= 1440).
    return min(1440, task.dueTime + 1)


def detect_dependency_cycles(tasks: list[TaskOutput]) -> set[str]:
    ids = {t.id for t in tasks}
    graph = {t.id: [d for d in t.dependsOn if d in ids] for t in tasks}
    state: dict[str, int] = {}  # 0=unseen, 1=stack, 2=done
    cyclic: set[str] = set()

    def visit(node: str):
        state[node] = 1
        for nxt in graph.get(node, []):
            if state.get(nxt, 0) == 1:
                cyclic.add(node)
                cyclic.add(nxt)
            elif state.get(nxt, 0) == 0:
                visit(nxt)
                if nxt in cyclic:
                    cyclic.add(node)
        state[node] = 2

    for task_id in sorted(graph):
        if state.get(task_id, 0) == 0:
            visit(task_id)
    return cyclic


def input_fingerprint(tasks: list[TaskOutput], availability: Availability,
                      busy: list[BusyBlock], fixed: list[FixedSession],
                      start_date: str, end_date: str) -> str:
    payload = {
        'tasks': [t.model_dump() for t in sorted(tasks, key=lambda x: x.id)],
        'availability': availability.model_dump(),
        'busy': [b.model_dump() for b in sorted(busy, key=lambda x: (x.date, x.start, x.end, x.label))],
        'fixed': [f.model_dump() for f in sorted(fixed, key=lambda x: x.id)],
        'startDate': start_date,
        'endDate': end_date,
    }
    import json
    return sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()


def _merge(intervals: list[_Interval]) -> list[_Interval]:
    if not intervals:
        return []
    ordered = sorted(intervals, key=lambda i: (i.date, i.start, i.end))
    out = [ordered[0]]
    for item in ordered[1:]:
        last = out[-1]
        if item.date == last.date and item.start <= last.end:
            out[-1] = _Interval(last.date, last.start, max(last.end, item.end))
        else:
            out.append(item)
    return out


def _subtract(free: list[_Interval], blocked: list[_Interval]) -> list[_Interval]:
    result = []
    for slot in free:
        pieces = [slot]
        for block in blocked:
            if block.date != slot.date:
                continue
            next_pieces = []
            for piece in pieces:
                if block.end <= piece.start or block.start >= piece.end:
                    next_pieces.append(piece)
                    continue
                if block.start > piece.start:
                    next_pieces.append(_Interval(piece.date, piece.start, block.start))
                if block.end < piece.end:
                    next_pieces.append(_Interval(piece.date, block.end, piece.end))
            pieces = next_pieces
        result.extend(pieces)
    return [p for p in result if p.length >= STEP]


def _availability_slots(availability: Availability, day: date, zone: ZoneInfo,
                        now: datetime) -> list[_Interval]:
    hours = resolve_available_day(availability, day)
    if not hours.enabled:
        return []
    today, now_minute = _local_parts(now, zone)
    slots = []
    for period in hours.periods:
        start = ((period.start + STEP - 1) // STEP) * STEP
        end = (period.end // STEP) * STEP
        if day == today:
            start = max(start, ((now_minute + STEP - 1) // STEP) * STEP)
        if end - start < STEP:
            continue
        # Drop windows that land on nonexistent DST times.
        midnight = datetime.combine(day, time())
        check_start = _unique_instant(midnight + timedelta(minutes=start), zone)
        check_end = _unique_instant(midnight + timedelta(minutes=end), zone)
        if check_start is None or check_end is None:
            continue
        slots.append(_Interval(day.isoformat(), start, end))
    return slots


def _clip_to_deadline(slot: _Interval, task: TaskOutput) -> _Interval | None:
    if slot.date > task.deadline:
        return None
    end = slot.end
    if slot.date == task.deadline:
        end = min(end, _deadline_end_minute(task))
    if end - slot.start < STEP:
        return None
    return _Interval(slot.date, slot.start, end)


def _pack_sessions(slots: list[_Interval], remaining: int, allow_split: bool,
                   min_session: int, max_session: int) -> tuple[list[_Interval], int, ReasonCode | None]:
    """Return placed intervals, leftover minutes, and optional reason for leftover."""
    if remaining <= 0:
        return [], 0, None
    if not allow_split:
        for slot in slots:
            if slot.length >= remaining:
                return [_Interval(slot.date, slot.start, slot.start + remaining)], 0, None
        return [], remaining, 'no_contiguous_slot'

    placed: list[_Interval] = []
    left = remaining
    for slot in slots:
        cursor = slot.start
        while left > 0 and cursor + min_session <= slot.end:
            take = min(max_session, left, slot.end - cursor)
            take = (take // STEP) * STEP
            if take < min_session:
                break
            # Avoid leaving a final remainder smaller than min_session when another chunk fits.
            leftover_after = left - take
            if 0 < leftover_after < min_session:
                needed = leftover_after
                # Prefer shrinking this chunk if we can still meet min_session and absorb remainder.
                if take - needed >= min_session and take - needed + needed == left:
                    take = left  # schedule all remaining in this contiguous slot if it fits
                    if cursor + take > slot.end:
                        take = (take // STEP) * STEP
                        if take < min_session:
                            break
                else:
                    # Cannot legally place the remainder in this slot; stop packing here.
                    break
            take = min(take, slot.end - cursor)
            take = (take // STEP) * STEP
            if take < min_session:
                break
            if take > left:
                take = (left // STEP) * STEP
                if take < min_session:
                    break
            placed.append(_Interval(slot.date, cursor, cursor + take))
            left -= take
            cursor += take
        if left == 0:
            break

    if left == 0:
        return placed, 0, None
    if left < min_session:
        return placed, left, 'remainder_below_min_session'
    if not placed:
        return [], left, 'insufficient_availability'
    return placed, left, 'insufficient_availability'


def generate_schedule(
    tasks: list[TaskOutput],
    availability: Availability,
    busy: list[BusyBlock],
    fixed_sessions: list[FixedSession],
    unlocked_auto: list[FixedSession],
    now: datetime,
    horizon_days: int = 7,
) -> ScheduleResult:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError('Planning time must be timezone-aware.')
    now = now.astimezone(UTC)
    zone = ZoneInfo(availability.timeZone)
    first, _ = _local_parts(now, zone)
    last = first + timedelta(days=horizon_days - 1)
    start_date, end_date = first.isoformat(), last.isoformat()

    open_tasks = [t for t in tasks if not t.done]
    cyclic = detect_dependency_cycles(open_tasks)
    explanations: list[str] = []
    results: list[TaskScheduleResult] = []
    proposed: list[ProposedSession] = []

    fixed_by_task: dict[str, list[FixedSession]] = {}
    for session in fixed_sessions:
        fixed_by_task.setdefault(session.taskId, []).append(session)

    # Occupied time: busy events + all fixed sessions.
    occupied = _merge([
        *[_Interval(b.date, b.start, b.end) for b in busy],
        *[_Interval(s.date, s.start, s.end) for s in fixed_sessions],
    ])

    # Candidate keepers: unlocked auto sessions that still look legal.
    keepers_by_task: dict[str, list[FixedSession]] = {}
    for session in sorted(unlocked_auto, key=lambda s: (s.date, s.start, s.id)):
        keepers_by_task.setdefault(session.taskId, []).append(session)

    # Dependency completion ends (date, end-minute) after scheduling each task.
    finish_by: dict[str, tuple[str, int]] = {}
    for task_id, sessions in fixed_by_task.items():
        if sessions:
            last_s = max(sessions, key=lambda s: (s.date, s.end))
            finish_by[task_id] = (last_s.date, last_s.end)

    # Build free slots once per day, then subtract occupied dynamically as we place.
    day_slots: dict[str, list[_Interval]] = {}
    for offset in range(horizon_days):
        day = first + timedelta(days=offset)
        day_slots[day.isoformat()] = _availability_slots(availability, day, zone, now)

    scheduled_ids: set[str] = set()
    pending = {t.id: t for t in open_tasks}
    # Kahn-like loop with stable ordering among ready tasks.
    while pending:
        ready = []
        for task in pending.values():
            if task.id in cyclic:
                continue
            deps = [d for d in task.dependsOn if d in pending or d in scheduled_ids or d in {x.id for x in open_tasks}]
            unmet = [d for d in task.dependsOn if d in pending]
            if unmet:
                continue
            if any(d in cyclic for d in task.dependsOn):
                continue
            ready.append(task)
        if not ready:
            # Remaining tasks are cyclic or waiting on cyclic deps.
            for task in sorted(pending.values(), key=lambda t: t.id):
                reason: ReasonCode = 'dependency_cycle' if task.id in cyclic or any(d in cyclic for d in task.dependsOn) else 'dependency_unmet'
                results.append(TaskScheduleResult(
                    taskId=task.id, title=task.title, remainingMinutes=task.remainingMinutes,
                    scheduledMinutes=0, unscheduledMinutes=task.remainingMinutes,
                    status='unscheduled', reason=reason,
                    message='Dependency cycle detected.' if reason == 'dependency_cycle' else
                    'A dependency could not be scheduled first.',
                ))
                explanations.append(f'{task.title}: {reason}')
            break

        ready.sort(key=lambda t: (t.deadline, t.dueTime, PRIORITIES[t.priority], t.id))
        task = ready[0]
        del pending[task.id]

        remaining = task.remainingMinutes
        if remaining <= 0 or remaining % STEP or task.minSessionMinutes > task.maxSessionMinutes:
            results.append(TaskScheduleResult(
                taskId=task.id, title=task.title, remainingMinutes=remaining,
                scheduledMinutes=0, unscheduledMinutes=max(0, remaining),
                status='unscheduled', reason='invalid_data',
                message='Task duration or session limits are invalid.',
            ))
            continue

        fixed = fixed_by_task.get(task.id, [])
        fixed_minutes = sum(s.end - s.start for s in fixed)
        if fixed_minutes > remaining:
            results.append(TaskScheduleResult(
                taskId=task.id, title=task.title, remainingMinutes=remaining,
                scheduledMinutes=0, unscheduledMinutes=remaining,
                status='unscheduled', reason='locked_capacity_exceeded',
                message='Fixed sessions already exceed remaining workload.',
            ))
            continue
        to_place = remaining - fixed_minutes

        if task.deadline < start_date:
            results.append(TaskScheduleResult(
                taskId=task.id, title=task.title, remainingMinutes=remaining,
                scheduledMinutes=fixed_minutes, unscheduledMinutes=to_place,
                status='unscheduled' if to_place else 'scheduled',
                reason='deadline_passed',
                message='Deadline has already passed; no new work was placed late.',
            ))
            if fixed:
                finish_by[task.id] = max(((s.date, s.end) for s in fixed), default=(task.deadline, 0))
            scheduled_ids.add(task.id)
            continue

        if task.deadline > end_date and to_place:
            # Still try within window; leftover marked outside_planning_window if nothing fits.
            pass

        # Earliest start from deps / earliestStart.
        earliest_date, earliest_minute = start_date, 0
        today, now_minute = _local_parts(now, zone)
        if earliest_date == today.isoformat():
            earliest_minute = now_minute
        for dep in task.dependsOn:
            if dep in finish_by:
                d_date, d_end = finish_by[dep]
                if (d_date, d_end) > (earliest_date, earliest_minute):
                    earliest_date, earliest_minute = d_date, d_end
            elif dep not in {t.id for t in tasks}:
                results.append(TaskScheduleResult(
                    taskId=task.id, title=task.title, remainingMinutes=remaining,
                    scheduledMinutes=fixed_minutes, unscheduledMinutes=to_place,
                    status='unscheduled', reason='dependency_unmet',
                    message=f'Missing dependency {dep}.',
                ))
                to_place = -1
                break
        if to_place < 0:
            continue

        if task.earliestStart:
            try:
                es = datetime.fromisoformat(task.earliestStart.replace('Z', '+00:00'))
                if es.tzinfo is None:
                    es = es.replace(tzinfo=zone)
                es_local = es.astimezone(zone)
                es_date, es_min = es_local.date().isoformat(), es_local.hour * 60 + es_local.minute
                if (es_date, es_min) > (earliest_date, earliest_minute):
                    earliest_date, earliest_minute = es_date, es_min
            except ValueError:
                results.append(TaskScheduleResult(
                    taskId=task.id, title=task.title, remainingMinutes=remaining,
                    scheduledMinutes=0, unscheduledMinutes=remaining,
                    status='unscheduled', reason='invalid_data',
                    message='earliestStart must be an ISO-8601 datetime.',
                ))
                continue

        # Prefer keeping unlocked auto sessions that still fit.
        kept: list[ProposedSession] = []
        kept_minutes = 0
        if to_place and task.allowSplit:
            for session in keepers_by_task.get(task.id, []):
                length = session.end - session.start
                if kept_minutes + length > to_place:
                    continue
                if session.date < earliest_date or (session.date == earliest_date and session.start < earliest_minute):
                    continue
                if session.date > task.deadline or (session.date == task.deadline and session.end > _deadline_end_minute(task)):
                    continue
                # Must still be free against occupied (not overlapping other fixed/busy).
                conflict = any(
                    o.date == session.date and o.start < session.end and o.end > session.start
                    for o in occupied
                )
                if conflict:
                    continue
                avail = day_slots.get(session.date, [])
                if not any(a.start <= session.start and a.end >= session.end for a in avail):
                    continue
                kept.append(ProposedSession(
                    taskId=task.id, title=task.title, date=session.date,
                    start=session.start, end=session.end, kept=True,
                ))
                kept_minutes += length
                occupied = _merge([*occupied, _Interval(session.date, session.start, session.end)])

        need = to_place - kept_minutes
        placed_intervals: list[_Interval] = []
        leftover = need
        reason: ReasonCode = 'scheduled'

        if need > 0:
            free: list[_Interval] = []
            for offset in range(horizon_days):
                day = (first + timedelta(days=offset)).isoformat()
                if day < earliest_date or day > task.deadline:
                    continue
                raw = _subtract(day_slots.get(day, []), [o for o in occupied if o.date == day])
                for slot in raw:
                    clipped = _clip_to_deadline(slot, task)
                    if not clipped:
                        continue
                    if day == earliest_date and clipped.start < earliest_minute:
                        clipped = _Interval(clipped.date, max(clipped.start, ((earliest_minute + STEP - 1) // STEP) * STEP), clipped.end)
                        if clipped.length < STEP:
                            continue
                    free.append(clipped)
            free.sort(key=lambda s: (s.date, s.start, s.end))
            placed_intervals, leftover, pack_reason = _pack_sessions(
                free, need, task.allowSplit, task.minSessionMinutes, task.maxSessionMinutes,
            )
            reason = pack_reason or 'scheduled'
            for interval in placed_intervals:
                occupied = _merge([*occupied, interval])

        scheduled_new = kept_minutes + sum(i.length for i in placed_intervals)
        total_scheduled = fixed_minutes + scheduled_new
        unscheduled = remaining - total_scheduled
        if unscheduled < 0:
            raise RuntimeError('Duration conservation violated.')
        if unscheduled and reason == 'scheduled':
            reason = 'insufficient_availability'
        if task.deadline > end_date and unscheduled and not placed_intervals and not kept:
            reason = 'outside_planning_window'

        for item in kept:
            proposed.append(item)
        for interval in placed_intervals:
            proposed.append(ProposedSession(
                taskId=task.id, title=task.title, date=interval.date,
                start=interval.start, end=interval.end,
            ))

        status: Literal['scheduled', 'partial', 'unscheduled']
        if unscheduled == 0:
            status = 'scheduled'
            reason = 'scheduled'
        elif total_scheduled == 0:
            status = 'unscheduled'
        else:
            status = 'partial'

        messages = {
            'scheduled': f'All {remaining} remaining minutes are covered (including fixed sessions).',
            'insufficient_availability': f'{total_scheduled} of {remaining} minutes placed; not enough free availability before the deadline under these rules.',
            'no_contiguous_slot': f'No single free block of {need} minutes fits (splitting disabled).',
            'remainder_below_min_session': f'{unscheduled} minute(s) left below min session size ({task.minSessionMinutes}); not silently dropped.',
            'deadline_passed': 'Deadline has already passed.',
            'outside_planning_window': 'Deadline is outside the planning window; not fully attempted.',
            'dependency_cycle': 'Dependency cycle detected.',
            'dependency_unmet': 'Dependencies are not satisfied.',
            'invalid_data': 'Invalid scheduling fields.',
            'locked_capacity_exceeded': 'Fixed sessions exceed remaining workload.',
            'partial': f'{total_scheduled} of {remaining} minutes placed.',
        }
        results.append(TaskScheduleResult(
            taskId=task.id, title=task.title, remainingMinutes=remaining,
            scheduledMinutes=total_scheduled, unscheduledMinutes=unscheduled,
            status=status, reason=reason,
            message=messages.get(reason, messages['partial']),
        ))
        if unscheduled:
            explanations.append(f'{task.title}: {reason} — {unscheduled} min unscheduled')

        all_ends = [(s.date, s.end) for s in fixed] + [(p.date, p.end) for p in proposed if p.taskId == task.id]
        if all_ends:
            finish_by[task.id] = max(all_ends)
        scheduled_ids.add(task.id)

    proposed.sort(key=lambda s: (s.date, s.start, s.taskId))
    results.sort(key=lambda t: t.taskId)
    fingerprint = input_fingerprint(open_tasks, availability, busy, fixed_sessions, start_date, end_date)
    return ScheduleResult(
        generatedAt=now,
        startDate=start_date,
        endDate=end_date,
        timeZone=availability.timeZone,
        sessions=proposed,
        tasks=results,
        explanations=explanations,
        inputFingerprint=fingerprint,
    )
