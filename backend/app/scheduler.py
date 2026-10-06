"""Deterministic, vendor-independent seven-day scheduler; no I/O or wall clock reads."""
from datetime import datetime, time, timedelta, timezone
from hashlib import sha256
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime, BaseModel, ConfigDict, model_validator

from app.workspace import Availability, TaskOutput

UTC = timezone.utc
STEP = timedelta(minutes=15)
PRIORITIES = {'High': 0, 'Medium': 1, 'Low': 2}


class BusyInterval(BaseModel):
    model_config = ConfigDict(extra='forbid')
    start: AwareDatetime
    end: AwareDatetime

    @model_validator(mode='after')
    def ordered(self):
        self.start = self.start.astimezone(UTC)
        self.end = self.end.astimezone(UTC)
        if self.end <= self.start:
            raise ValueError('Busy interval end must be later than start.')
        return self


class PlanBlock(BaseModel):
    id: str
    taskId: str | None
    title: str
    type: Literal['focus', 'break']
    start: AwareDatetime
    end: AwareDatetime


class TaskResult(BaseModel):
    taskId: str
    title: str
    deadline: str
    requestedMinutes: int
    scheduledMinutes: int
    unscheduledMinutes: int
    status: Literal['scheduled', 'partial', 'unscheduled', 'overdue', 'outside_window']
    reason: str | None
    message: str


class Plan(BaseModel):
    version: Literal[1] = 1
    generatedAt: AwareDatetime
    startDate: str
    endDate: str  # Inclusive local date, not an instant.
    timeZone: str
    source: Literal['provided', 'availability_only']
    busyIntervals: list[BusyInterval]
    blocks: list[PlanBlock]
    tasks: list[TaskResult]
    stale: bool = False
    staleReasons: list[str] = []


def merge_busy(intervals: list[BusyInterval]) -> list[BusyInterval]:
    merged = []
    for interval in sorted(intervals, key=lambda b: (b.start, b.end)):
        if merged and interval.start <= merged[-1].end:
            merged[-1] = BusyInterval(start=merged[-1].start, end=max(merged[-1].end, interval.end))
        else:
            merged.append(interval.model_copy())
    return merged


def unique_instant(local: datetime, zone: ZoneInfo) -> datetime | None:
    """Reject nonexistent and repeated wall times instead of guessing a DST fold."""
    instants = set()
    for fold in (0, 1):
        candidate = local.replace(tzinfo=zone, fold=fold).astimezone(UTC)
        if candidate.astimezone(zone).replace(tzinfo=None) == local:
            instants.add(candidate)
    return next(iter(instants)) if len(instants) == 1 else None


def free_slots(day, hours, zone, now, busy):
    if not hours.enabled:
        return []
    midnight = datetime.combine(day, time())
    slots = []
    # Availability may start/end off-grid. Keep only full local quarter-hours.
    for minute in range(((hours.start + 14) // 15) * 15, hours.end - 14, 15):
        start = unique_instant(midnight + timedelta(minutes=minute), zone)
        end = unique_instant(midnight + timedelta(minutes=minute + 15), zone)
        if start is None or end is None or end - start != STEP or start < now:
            continue
        if any(start < block.end and end > block.start for block in busy):
            continue
        slots.append(start)
    return slots


def block(kind, task, start, end):
    task_id = task.id if task else None
    identity = f'{kind}|{task_id}|{start.isoformat()}|{end.isoformat()}'
    return PlanBlock(id=sha256(identity.encode()).hexdigest()[:24], taskId=task_id,
                     title=task.title if task else 'Short break', type=kind, start=start, end=end)


def generate_plan(tasks: list[TaskOutput], availability: Availability,
                  busy_intervals: list[BusyInterval], now: datetime,
                  source: Literal['provided', 'availability_only'] = 'provided') -> Plan:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError('Planning time must be timezone-aware.')
    if source == 'availability_only' and busy_intervals:
        raise ValueError('Availability-only plans cannot contain calendar intervals.')
    now = now.astimezone(UTC)
    zone = ZoneInfo(availability.timeZone)
    first = now.astimezone(zone).date()
    last = first + timedelta(days=6)
    busy = merge_busy(busy_intervals)
    days = []
    for offset in range(7):
        day = first + timedelta(days=offset)
        hours = next(row for row in availability.days if row.day == day.weekday())
        days.append({'date': day, 'slots': free_slots(day, hours, zone, now, busy), 'cursor': 0, 'has_focus': False})
    blocks = []
    results = []
    ordered = sorted((task for task in tasks if not task.done),
                     key=lambda task: (task.deadline, PRIORITIES[task.priority], task.id))
    for task in ordered:
        remaining = task.minutes
        reason = None
        if task.deadline < first.isoformat():
            status, reason = 'overdue', 'deadline_passed'
            message = 'Deadline has already passed; no work was placed late.'
        elif task.deadline > last.isoformat():
            status, reason = 'outside_window', 'outside_planning_window'
            message = 'Outside this seven-day planning window; not attempted.'
        else:
            for day in days:
                if day['date'].isoformat() > task.deadline or remaining == 0:
                    break
                slots = day['slots']
                cursor = day['cursor']
                while remaining:
                    # A break is a real free slot, never a busy event or overnight
                    # gap. Commit it only together with the next focus block.
                    focus_index = cursor + int(day['has_focus'])
                    if focus_index >= len(slots):
                        break
                    count = 1
                    limit = min(4, remaining // 15)
                    while count < limit and focus_index + count < len(slots):
                        if slots[focus_index + count] != slots[focus_index] + STEP * count:
                            break
                        count += 1
                    if day['has_focus']:
                        blocks.append(block('break', None, slots[cursor], slots[cursor] + STEP))
                    start = slots[focus_index]
                    blocks.append(block('focus', task, start, start + STEP * count))
                    remaining -= count * 15
                    cursor = focus_index + count
                    day['cursor'] = cursor
                    day['has_focus'] = True
            scheduled = task.minutes - remaining
            status = 'scheduled' if remaining == 0 else 'partial' if scheduled else 'unscheduled'
            if remaining:
                eligible_slots = sum(len(day['slots']) for day in days if day['date'].isoformat() <= task.deadline)
                reason = 'no_free_availability' if eligible_slots == 0 else 'insufficient_capacity'
                message = (f'{task.minutes} requested; {scheduled} scheduled; {remaining} minutes could not fit '
                           'before the deadline under these scheduling rules. '
                           + ('No full future 15-minute free slots are available.' if eligible_slots == 0 else
                              'Free time, earlier-ranked tasks, and required breaks limit capacity.'))
            else:
                message = f'All {task.minutes} minutes scheduled before the deadline.'
        results.append(TaskResult(taskId=task.id, title=task.title, deadline=task.deadline,
                                  requestedMinutes=task.minutes, scheduledMinutes=task.minutes - remaining,
                                  unscheduledMinutes=remaining, status=status, reason=reason, message=message))
    return Plan(generatedAt=now, startDate=first.isoformat(), endDate=last.isoformat(),
                timeZone=availability.timeZone, source=source, busyIntervals=busy,
                blocks=sorted(blocks, key=lambda b: (b.start, b.end, b.id)), tasks=results)
