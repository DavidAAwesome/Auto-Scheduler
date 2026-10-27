"""Editable drafts: the structured form of tasks and events before they are saved.

Text, images and the review panel all produce `PlanDraft`s. `review_draft` applies business rules and
returns focused questions for anything missing or ambiguous; a draft with a blocking issue never
reaches the scheduler. `draft_task` / `draft_event` turn a ready draft into the same shapes the
scheduler uses for saved tasks and events (ids prefixed `draft:`), so drafts are scheduled, validated
and previewed by the exact same code as saved data. Nothing here touches the database.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.events import MAX_REPEAT_DAYS, EventInput, Repeat
from app.workspace import DEFAULT_DUE_TIME, TaskOutput, TimeWindow

DRAFT_PREFIX = 'draft:'
DraftKind = Literal['task', 'fixed_event', 'flexible_event']
EventKind = Literal['Class', 'Meeting', 'Appointment', 'Social', 'Other']
FIELD_LABELS = {
    'title': 'name', 'minutes': 'length', 'deadline': 'deadline', 'dueTime': 'due time', 'date': 'date',
    'start': 'start time', 'end': 'end time', 'repeat.until': 'last date', 'repeat.startDate': 'first date',
    'repeat.weekdays': 'weekdays', 'priority': 'priority', 'earliestStart': 'earliest start', 'location': 'location',
}
WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']


class DraftRepeat(BaseModel):
    """Weekly recurrence exactly as stated. `startDate`/`until` stay empty until the user gives them."""
    model_config = ConfigDict(extra='forbid')
    weekdays: list[int] = Field(default_factory=list, max_length=7)  # Monday = 0
    startDate: str | None = None
    until: str | None = None


class PlanDraft(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(min_length=1, max_length=40, pattern=r'^[A-Za-z0-9_-]+$')
    kind: DraftKind = 'task'
    title: str | None = Field(default=None, max_length=80)
    minutes: int | None = Field(default=None, ge=5, le=6000)  # work for tasks, duration for flexible events
    deadline: str | None = None  # YYYY-MM-DD; when it is DUE, not when it is done
    dueTime: int | None = Field(default=None, ge=0, le=1439)
    earliestStart: str | None = None  # ISO-8601; local time when no offset
    priority: Literal['High', 'Medium', 'Low'] = 'Medium'
    category: Literal['Project', 'Study', 'Personal', 'Work'] = 'Study'
    allowSplit: bool | None = None  # None: tasks split, flexible events stay in one block
    minSessionMinutes: int | None = Field(default=None, ge=5, le=6000)
    maxSessionMinutes: int | None = Field(default=None, ge=5, le=6000)
    date: str | None = None  # fixed event (first) date
    start: int | None = Field(default=None, ge=0, le=1440)
    end: int | None = Field(default=None, ge=0, le=1440)
    eventKind: EventKind = 'Other'
    location: str | None = Field(default=None, max_length=120)
    repeat: DraftRepeat | None = None
    windows: list[TimeWindow] = Field(default_factory=list, max_length=14)
    dependsOn: list[str] = Field(default_factory=list, max_length=16)  # draft ids or saved task ids
    sourceText: str | None = Field(default=None, max_length=400)  # original wording, for review
    ambiguous: list[str] = Field(default_factory=list, max_length=20)  # fields the extractor could not settle
    unreadable: list[str] = Field(default_factory=list, max_length=20)
    assumed: list[str] = Field(default_factory=list, max_length=20)  # defaults filled in, shown to the user
    include: bool = True

    @field_validator('title', 'location')
    @classmethod
    def strip(cls, value):
        return (value or '').strip() or None


class DraftIssue(BaseModel):
    model_config = ConfigDict(extra='forbid')
    field: str
    code: Literal['missing', 'ambiguous', 'unreadable', 'invalid', 'warning']
    question: str
    blocking: bool = True


class DraftView(BaseModel):
    model_config = ConfigDict(extra='forbid')
    draft: PlanDraft
    issues: list[DraftIssue]
    ready: bool


def _iso(value: str | None) -> date | None:
    if not value:
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.isoformat() == value else None


def clock(minute: int) -> str:
    minute %= 1440
    return f"{(minute // 60) % 12 or 12}:{minute % 60:02d} {'AM' if minute < 720 else 'PM'}"


def parse_local_instant(value: str | None, zone: ZoneInfo) -> datetime | None:
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=zone)


def review_draft(draft: PlanDraft, now: datetime, zone: ZoneInfo, known_ids: set[str] | None = None) -> DraftView:
    """Business rules for one draft. Blocking issues are questions the user must answer first."""
    issues: list[DraftIssue] = []
    name = draft.title or 'this item'
    today = now.astimezone(zone).date()

    def ask(field: str, question: str, code='missing', blocking=True):
        if not any(i.field == field for i in issues):
            issues.append(DraftIssue(field=field, code=code, question=question, blocking=blocking))

    for field in draft.unreadable:
        ask(field, f'The {FIELD_LABELS.get(field, field)} of "{name}" could not be read. What is it?', 'unreadable')
    for field in draft.ambiguous:
        if field in {'start', 'end'}:
            value = draft.start if field == 'start' else draft.end
            shown = f'{(value // 60) % 12 or 12}:{value % 60:02d}' if value is not None else 'the time'
            ask(field, f'Is the {FIELD_LABELS[field]} of "{name}" ({shown}) AM or PM?', 'ambiguous')
        else:
            ask(field, f'Please confirm the {FIELD_LABELS.get(field, field)} of "{name}".', 'ambiguous')
    if not draft.title:
        ask('title', 'What should this item be called?')

    if draft.kind in {'task', 'flexible_event'}:
        if draft.minutes is None:
            ask('minutes', f'How long will "{name}" take?' if draft.kind == 'task' else f'How long is "{name}"?')
        elif draft.minutes % 5:
            ask('minutes', f'Lengths use 5-minute steps; how long is "{name}"?', 'invalid')
        deadline = _iso(draft.deadline)
        if draft.deadline and deadline is None:
            ask('deadline', f'The deadline of "{name}" is not a valid date. When is it due?', 'invalid')
        elif deadline is None:
            ask('deadline', f'When is "{name}" due?' if draft.kind == 'task'
                else f'By when should "{name}" happen? (Give the last day it can take place.)')
        elif deadline < today:
            ask('deadline', f'"{name}" was due {deadline.isoformat()}, which has passed. Nothing new can be planned '
                'before it; change the deadline or keep it to see it reported.', 'warning', blocking=False)
        earliest = parse_local_instant(draft.earliestStart, zone)
        if draft.earliestStart and earliest is None:
            ask('earliestStart', f'When may "{name}" start at the earliest?', 'invalid')
        elif earliest and deadline and earliest.astimezone(zone).date() > deadline:
            ask('earliestStart', f'"{name}" may not start until after it is due. Which date is wrong?', 'invalid')
        if draft.minSessionMinutes and draft.maxSessionMinutes and draft.minSessionMinutes > draft.maxSessionMinutes:
            ask('minSessionMinutes', f'The shortest session of "{name}" is longer than its longest session.', 'invalid')
        if draft.repeat:
            ask('repeat', f'Repeating flexible work is not supported yet. Add one "{name}" per week, or make it a fixed '
                'event with a time.', 'invalid')
    else:  # fixed event
        repeat = draft.repeat
        if repeat and not repeat.weekdays:
            ask('repeat.weekdays', f'Which weekdays does "{name}" repeat on?')
        first = _iso((repeat.startDate if repeat else None) or draft.date)
        if repeat:
            if not (repeat.startDate or draft.date):
                ask('repeat.startDate', f'"{name}" repeats weekly. On what date does it start (for example the first '
                    'day of the semester)?')
            if not repeat.until:
                ask('repeat.until', f'"{name}" repeats weekly. What is the last date it happens (for example the '
                    'end of the semester)?')
            elif _iso(repeat.until) is None:
                ask('repeat.until', f'The last date of "{name}" is not a valid date. When does it end?', 'invalid')
            elif first and _iso(repeat.until) < first:
                ask('repeat.until', f'"{name}" ends before it starts. What is the last date?', 'invalid')
            elif first and _iso(repeat.until) > first + timedelta(days=MAX_REPEAT_DAYS):
                ask('repeat.until', f'Repeating events can run for up to one year. What is the last date of "{name}"?',
                    'invalid')
        elif first is None:
            ask('date', f'On what date is "{name}"?' if not draft.date else f'The date of "{name}" is not valid. Which date?')
        if draft.start is None:
            ask('start', f'What time does "{name}" start?')
        if draft.end is None:
            ask('end', f'What time does "{name}" end?')
        if draft.start is not None and draft.end is not None:
            if draft.end <= draft.start:
                ask('end', f'"{name}" ends at or before it starts. What is the end time?', 'invalid')
            elif draft.start % 5 or draft.end % 5:
                ask('start', f'Event times use 5-minute steps; what are the times of "{name}"?', 'invalid')
            elif draft.start >= 1440:
                ask('start', f'What time does "{name}" start?', 'invalid')
    for dep in draft.dependsOn:
        if known_ids is not None and dep not in known_ids:
            ask('dependsOn', f'"{name}" depends on an item that is not selected or saved. Remove the link or select that '
                'item too.', 'invalid')
    if 'priority' in draft.assumed:
        ask('priority', f'Priority of "{name}" was not stated, so it is Medium. Change it if needed.', 'warning', False)
    ready = not any(i.blocking for i in issues)
    return DraftView(draft=draft, issues=issues, ready=ready)


def review_all(drafts: list[PlanDraft], now: datetime, zone: ZoneInfo, saved_task_ids: set[str]) -> list[DraftView]:
    ids = [d.id for d in drafts]
    if len(ids) != len(set(ids)):
        raise ValueError('Draft ids must be unique.')
    # A selected item may only depend on selected items (or saved tasks): unselected drafts are not saved.
    selected = {d.id for d in drafts if d.include} | saved_task_ids
    known = set(ids) | saved_task_ids
    return [review_draft(d, now, zone, selected if d.include else known) for d in drafts]


# ---------------------------------------------------------------- conversion for the scheduler

def draft_task_id(draft_id: str) -> str:
    return DRAFT_PREFIX + draft_id


def draft_task(draft: PlanDraft, all_draft_ids: set[str]) -> TaskOutput:
    """A ready task / flexible-event draft as a TaskOutput with id `draft:<id>` (never stored as-is)."""
    flexible_event = draft.kind == 'flexible_event'
    split = draft.allowSplit if draft.allowSplit is not None else not flexible_event
    minutes = draft.minutes or 5
    min_session = draft.minSessionMinutes or min(15, minutes)
    max_session = draft.maxSessionMinutes or (minutes if (flexible_event or not split) else max(min_session, 60))
    return TaskOutput(
        id=draft_task_id(draft.id), done=False, title=draft.title or 'Untitled', deadline=draft.deadline,
        dueTime=DEFAULT_DUE_TIME if draft.dueTime is None else draft.dueTime, minutes=minutes, completedMinutes=0,
        priority=draft.priority, category=draft.category if not flexible_event else 'Personal',
        earliestStart=draft.earliestStart, allowSplit=split,
        minSessionMinutes=min(min_session, max_session), maxSessionMinutes=max(min_session, max_session),
        dependsOn=[draft_task_id(d) if d in all_draft_ids else d for d in draft.dependsOn],
        kind='flexible_event' if flexible_event else 'task', windows=draft.windows)


def draft_event(draft: PlanDraft) -> EventInput:
    repeat = draft.repeat
    first = (repeat.startDate if repeat and repeat.startDate else None) or draft.date
    if repeat:
        # The first stored date is the first real occurrence, so the series starts where the user said.
        day = date.fromisoformat(first)
        while day.weekday() not in repeat.weekdays:
            day += timedelta(days=1)
        first = day.isoformat()
    return EventInput(title=draft.title, kind=draft.eventKind, date=first, start=draft.start, end=draft.end,
                      location=draft.location,
                      repeat=Repeat(weekdays=repeat.weekdays, until=repeat.until) if repeat else None)


def draft_event_doc(draft: PlanDraft) -> dict:
    """The event as a stored-document-like dict, for occurrence expansion (`occurs_on`)."""
    event = draft_event(draft)
    return {'_id': draft_task_id(draft.id), **event.model_dump(), 'skipDates': [], 'source': 'manual'}


def summary(draft: PlanDraft) -> str:
    """One line for chat and review: what the draft says, with deadlines kept apart from times."""
    name = draft.title or 'Untitled'
    if draft.kind == 'fixed_event':
        when = draft.date or (draft.repeat.startDate if draft.repeat else None) or '?'
        times = f'{clock(draft.start)}–{clock(draft.end)}' if draft.start is not None and draft.end is not None else 'time ?'
        if draft.repeat:
            days = ', '.join(WEEKDAY_NAMES[d] for d in draft.repeat.weekdays) or '?'
            return f'{name}: fixed, every {days} {times}, {when} to {draft.repeat.until or "?"}'
        return f'{name}: fixed, {when} {times}'
    kind = 'flexible event' if draft.kind == 'flexible_event' else 'task'
    due = f'due {draft.deadline}' + (f' {clock(draft.dueTime)}' if draft.dueTime is not None else '') if draft.deadline else 'no deadline yet'
    return f'{name}: {kind}, {draft.minutes or "?"} min, {due}, {draft.priority} priority'


_SAFE_ID = re.compile(r'[^A-Za-z0-9_-]')


def safe_id(value: str, fallback: str) -> str:
    cleaned = _SAFE_ID.sub('-', value)[:40].strip('-')
    return cleaned or fallback
