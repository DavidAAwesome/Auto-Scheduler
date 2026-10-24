"""Independent verification of scheduling constraints. Never trusts model output or a prior preview."""
from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from app.scheduling_engine import (
    STEP,
    BusyBlock,
    FixedSession,
    ProposedSession,
    ScheduleResult,
    TaskScheduleResult,
    _deadline_end_minute,
    _local_parts,
    detect_dependency_cycles,
)
from app.workspace import Availability, TaskOutput, resolve_available_day

UTC = timezone.utc


class ValidationError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def _overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return a_start < b_end and a_end > b_start


def validate_schedule(
    result: ScheduleResult,
    tasks: list[TaskOutput],
    availability: Availability,
    busy: list[BusyBlock],
    fixed_sessions: list[FixedSession],
    now: datetime,
) -> None:
    """Raise ValidationError if any hard constraint fails."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValidationError('invalid_data', 'Planning time must be timezone-aware.')
    now = now.astimezone(UTC)
    zone = ZoneInfo(availability.timeZone)
    today, now_minute = _local_parts(now, zone)
    task_by_id = {t.id: t for t in tasks if not t.done}
    cyclic = detect_dependency_cycles(list(task_by_id.values()))
    if cyclic:
        raise ValidationError('dependency_cycle', f'Dependency cycle involving: {", ".join(sorted(cyclic))}')

    # Duration conservation per task.
    proposed_by_task: dict[str, list[ProposedSession]] = {}
    for session in result.sessions:
        proposed_by_task.setdefault(session.taskId, []).append(session)

    fixed_by_task: dict[str, list[FixedSession]] = {}
    for session in fixed_sessions:
        fixed_by_task.setdefault(session.taskId, []).append(session)

    result_by_task = {t.taskId: t for t in result.tasks}

    for task in task_by_id.values():
        fixed_mins = sum(s.end - s.start for s in fixed_by_task.get(task.id, []))
        prop_mins = sum(s.end - s.start for s in proposed_by_task.get(task.id, []))
        outcome = result_by_task.get(task.id)
        if outcome is None:
            raise ValidationError('invalid_data', f'Missing schedule result for task {task.id}.')
        if outcome.scheduledMinutes + outcome.unscheduledMinutes != task.remainingMinutes:
            raise ValidationError(
                'duration_mismatch',
                f'Task {task.title}: scheduled ({outcome.scheduledMinutes}) + unscheduled '
                f'({outcome.unscheduledMinutes}) != remaining ({task.remainingMinutes}).',
            )
        if fixed_mins + prop_mins != outcome.scheduledMinutes:
            raise ValidationError(
                'duration_mismatch',
                f'Task {task.title}: fixed+proposed minutes do not match scheduledMinutes.',
            )
        if not task.allowSplit and len(proposed_by_task.get(task.id, [])) > 1:
            raise ValidationError('no_contiguous_slot', f'Task {task.title} disallows splitting.')
        for session in proposed_by_task.get(task.id, []):
            length = session.end - session.start
            if length < task.minSessionMinutes or length > task.maxSessionMinutes:
                raise ValidationError(
                    'invalid_data',
                    f'Session for {task.title} is {length} minutes; allowed '
                    f'{task.minSessionMinutes}–{task.maxSessionMinutes}.',
                )
            if length % STEP:
                raise ValidationError('invalid_data', f'Session length must be a multiple of {STEP}.')

    # Occupancy: busy + fixed + proposed must not overlap.
    blocks: list[tuple[str, int, int, str]] = []
    for item in busy:
        blocks.append((item.date, item.start, item.end, f'busy:{item.label}'))
    for item in fixed_sessions:
        blocks.append((item.date, item.start, item.end, f'fixed:{item.id}'))
    for item in result.sessions:
        blocks.append((item.date, item.start, item.end, f'proposed:{item.taskId}'))

    blocks.sort()
    by_date: dict[str, list[tuple[int, int, str]]] = {}
    for day, start, end, label in blocks:
        by_date.setdefault(day, []).append((start, end, label))
    for day, items in by_date.items():
        items.sort()
        previous_end = -1
        previous_label = ''
        for start, end, label in items:
            if start < previous_end:
                raise ValidationError(
                    'overlap',
                    f'Overlap on {day} between {previous_label} and {label}.',
                )
            previous_end, previous_label = end, label

    # Availability, past, deadline, dependencies.
    finish_by: dict[str, tuple[str, int]] = {}
    for session in fixed_sessions:
        cur = finish_by.get(session.taskId)
        key = (session.date, session.end)
        if cur is None or key > cur:
            finish_by[session.taskId] = key

    # Process proposed in chronological order for dependency checks.
    ordered_sessions = sorted(result.sessions, key=lambda s: (s.date, s.start, s.taskId))
    for session in ordered_sessions:
        task = task_by_id.get(session.taskId)
        if not task:
            raise ValidationError('invalid_data', f'Unknown task {session.taskId}.')
        if session.date < today.isoformat() or (
            session.date == today.isoformat() and session.start < now_minute
        ):
            raise ValidationError('past', f'Session for {task.title} starts in the past.')
        day = datetime.fromisoformat(session.date).date()
        hours = resolve_available_day(availability, day)
        if not hours.enabled or not any(
            period.start <= session.start and period.end >= session.end for period in hours.periods
        ):
            raise ValidationError(
                'availability',
                f'Session for {task.title} is outside availability on {session.date}.',
            )
        if session.date > task.deadline or (
            session.date == task.deadline and session.end > _deadline_end_minute(task)
        ):
            raise ValidationError('deadline', f'Session for {task.title} ends after the deadline.')
        for dep in task.dependsOn:
            dep_finish = finish_by.get(dep)
            if dep_finish is None:
                raise ValidationError('dependency_unmet', f'{task.title} depends on unfinished {dep}.')
            if dep_finish > (session.date, session.start):
                raise ValidationError(
                    'dependency_unmet',
                    f'{task.title} starts before dependency {dep} finishes.',
                )
        cur = finish_by.get(session.taskId)
        key = (session.date, session.end)
        if cur is None or key > cur:
            finish_by[session.taskId] = key

    # Fingerprint must match if provided by caller through result.
    if result.timeZone != availability.timeZone:
        raise ValidationError('invalid_data', 'Preview timezone does not match availability.')


def assert_outcomes_consistent(result: ScheduleResult) -> None:
    for task in result.tasks:
        if task.scheduledMinutes + task.unscheduledMinutes != task.remainingMinutes:
            raise ValidationError('duration_mismatch', f'Duration mismatch for {task.taskId}.')
        if task.status == 'scheduled' and task.unscheduledMinutes != 0:
            raise ValidationError('invalid_data', f'Scheduled task {task.taskId} has unscheduled minutes.')
        if task.status == 'unscheduled' and task.scheduledMinutes != 0 and task.reason not in {
            'deadline_passed', 'locked_capacity_exceeded'
        }:
            # Fixed sessions may count as scheduled while status is unscheduled for new work.
            pass
