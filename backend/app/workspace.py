"""Task, work-session, and availability routes. Ownership always comes from the authenticated user."""
from datetime import date, timedelta
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pymongo import ReturnDocument

from app.auth import get_current_user
from app.database import get_database
from app.events import event_clash

router = APIRouter(tags=['workspace'])
DEFAULT_DUE_TIME = 23 * 60 + 59  # 11:59 PM when no due time is given


class TimeWindow(BaseModel):
    """A recurring local time window when a task or flexible event may be placed. Empty weekdays = every day."""
    model_config = ConfigDict(extra='forbid')
    weekdays: list[int] = Field(default_factory=list, max_length=7)  # Monday = 0
    start: int = Field(strict=True, ge=0, le=1435, multiple_of=5)
    end: int = Field(strict=True, ge=5, le=1440, multiple_of=5)

    @field_validator('weekdays')
    @classmethod
    def valid_weekdays(cls, value):
        if any(isinstance(day, bool) or day not in range(7) for day in value) or len(set(value)) != len(value):
            raise ValueError('Choose weekdays from Monday (0) to Sunday (6), each once.')
        return sorted(value)

    @model_validator(mode='after')
    def ordered(self):
        if self.end <= self.start:
            raise ValueError('A time window must end after it starts; overnight windows are not supported.')
        return self


class TaskInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=80)
    deadline: str
    # Total estimated work. Tasks can be split into several work sessions, so allow up to 100 hours.
    minutes: int = Field(strict=True, ge=5, le=6000, multiple_of=5)
    # Work actually done. Remaining work is always minutes - completedMinutes; scheduled work is not completed work.
    completedMinutes: int | None = Field(default=None, strict=True, ge=0, le=6000)
    # Accepted for older clients: remainingMinutes sets completedMinutes = minutes - remainingMinutes.
    remainingMinutes: int | None = Field(default=None, strict=True, ge=0, le=6000)
    dueTime: int = Field(default=DEFAULT_DUE_TIME, strict=True, ge=0, le=1439)  # minutes after midnight
    priority: Literal['High', 'Medium', 'Low']
    category: Literal['Project', 'Study', 'Personal', 'Work']
    earliestStart: str | None = None  # ISO-8601 datetime; null = as soon as allowed
    allowSplit: bool = Field(default=True, strict=True)
    minSessionMinutes: int = Field(default=15, strict=True, ge=5, le=6000, multiple_of=5)
    maxSessionMinutes: int = Field(default=60, strict=True, ge=5, le=6000, multiple_of=5)
    dependsOn: list[str] = Field(default_factory=list, max_length=32)
    # "task" is focus work. "flexible_event" (gym, coffee with a friend) is placed by the scheduler in one
    # contiguous slot unless allowSplit is set, and does not count toward focus or daily work limits.
    kind: Literal['task', 'flexible_event'] = 'task'
    windows: list[TimeWindow] = Field(default_factory=list, max_length=14)

    @field_validator('title')
    @classmethod
    def title_not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('Enter a task name.')
        return value

    @field_validator('deadline')
    @classmethod
    def valid_deadline(cls, value):
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError('Use a valid YYYY-MM-DD deadline.')
        return value

    @field_validator('dependsOn')
    @classmethod
    def unique_deps(cls, value):
        cleaned = [item.strip() for item in value if item and item.strip()]
        if len(cleaned) != len(set(cleaned)):
            raise ValueError('Duplicate dependencies are not allowed.')
        return cleaned

    @model_validator(mode='after')
    def scheduling_fields(self):
        if self.completedMinutes is None:
            if self.remainingMinutes is not None and self.remainingMinutes > self.minutes:
                raise ValueError('remainingMinutes cannot exceed estimated minutes.')
            self.completedMinutes = 0 if self.remainingMinutes is None else self.minutes - self.remainingMinutes
        if self.minSessionMinutes > self.maxSessionMinutes:
            raise ValueError('minSessionMinutes cannot exceed maxSessionMinutes.')
        self.remainingMinutes = max(0, self.minutes - self.completedMinutes)
        return self


class TaskOutput(TaskInput):
    id: str
    done: bool


class Completion(BaseModel):
    model_config = ConfigDict(extra='forbid')
    done: bool = Field(strict=True)


TASK_DEFAULTS = {
    'dueTime': DEFAULT_DUE_TIME,
    'remainingMinutes': None,
    'completedMinutes': None,
    'earliestStart': None,
    'allowSplit': True,
    'minSessionMinutes': 15,
    'maxSessionMinutes': 60,
    'dependsOn': [],
    'kind': 'task',
    'windows': [],
}


def task_output(doc):
    # Older task documents omit newer scheduling fields; fill defaults.
    payload = {}
    for field in TaskInput.model_fields:
        if field in doc:
            payload[field] = doc[field]
        elif field in TASK_DEFAULTS:
            payload[field] = TASK_DEFAULTS[field]
        else:
            payload[field] = doc[field]
        due_time = payload.get('dueTime')

    if isinstance(due_time, str) and ':' in due_time:
        try:
            hours, minutes = map(int, due_time.split(':'))
            if not (0 <= hours <= 23 and 0 <= minutes <= 59):
                raise ValueError('Invalid time')
            payload['dueTime'] = hours * 60 + minutes
        except ValueError:
            raise ValueError(f"Invalid dueTime value: {due_time}")
    if payload.get('completedMinutes') is not None:
        payload['remainingMinutes'] = None  # always derived from completed minutes
    return TaskOutput(**payload, id=str(doc['_id']), done=doc['done'])


def bump(db, user):
    from app.schedule_version import bump_schedule_version
    bump_schedule_version(db, str(user['_id']))


def owned_task(task_id, user):
    if not ObjectId.is_valid(task_id):
        raise HTTPException(404, 'Task not found.')
    return {'_id': ObjectId(task_id), 'user_id': str(user['_id'])}


@router.get('/tasks', response_model=list[TaskOutput])
def list_tasks(user=Depends(get_current_user), db=Depends(get_database)):
    return [task_output(doc) for doc in db.tasks.find({'user_id': str(user['_id'])}).sort([('deadline', 1), ('dueTime', 1), ('_id', 1)])]


@router.post('/tasks', response_model=TaskOutput, status_code=201)
def create_task(data: TaskInput, user=Depends(get_current_user), db=Depends(get_database)):
    doc = {**data.model_dump(), 'done': False, 'user_id': str(user['_id'])}
    doc['_id'] = db.tasks.insert_one(doc).inserted_id
    bump(db, user)
    return task_output(doc)


@router.get('/tasks/{task_id}', response_model=TaskOutput)
def get_task(task_id: str, user=Depends(get_current_user), db=Depends(get_database)):
    doc = db.tasks.find_one(owned_task(task_id, user))
    if not doc:
        raise HTTPException(404, 'Task not found.')
    return task_output(doc)


@router.put('/tasks/{task_id}', response_model=TaskOutput)
def update_task(task_id: str, data: TaskInput, user=Depends(get_current_user), db=Depends(get_database)):
    doc = db.tasks.find_one_and_update(owned_task(task_id, user), {'$set': data.model_dump()}, return_document=ReturnDocument.AFTER)
    if not doc:
        raise HTTPException(404, 'Task not found.')
    bump(db, user)
    return task_output(doc)


@router.patch('/tasks/{task_id}/completion', response_model=TaskOutput)
def complete_task(task_id: str, data: Completion, user=Depends(get_current_user), db=Depends(get_database)):
    doc = db.tasks.find_one_and_update(owned_task(task_id, user), {'$set': {'done': data.done}}, return_document=ReturnDocument.AFTER)
    if not doc:
        raise HTTPException(404, 'Task not found.')
    bump(db, user)
    return task_output(doc)


@router.delete('/tasks/{task_id}', status_code=204)
def delete_task(task_id: str, user=Depends(get_current_user), db=Depends(get_database)):
    if not db.tasks.delete_one(owned_task(task_id, user)).deleted_count:
        raise HTTPException(404, 'Task not found.')
    db.sessions.delete_many({'user_id': str(user['_id']), 'task_id': task_id})
    bump(db, user)


class SessionInput(BaseModel):
    """A block of time set aside to work on a task, in local wall-clock time. A task can have many sessions."""
    model_config = ConfigDict(extra='forbid')
    taskId: str
    date: str
    start: int = Field(strict=True, ge=0, le=1435, multiple_of=5)
    end: int = Field(strict=True, ge=5, le=1440, multiple_of=5)
    # 'manual' sessions are placed by the user; 'auto' sessions come from the scheduling engine.
    source: Literal['manual', 'auto'] = 'manual'
    locked: bool = Field(default=False, strict=True)

    @field_validator('date')
    @classmethod
    def valid_date(cls, value):
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError('Use a valid YYYY-MM-DD date.')
        return value

    @model_validator(mode='after')
    def valid_range(self):
        if self.end <= self.start:
            raise ValueError('A work session must end after it starts.')
        return self


class SessionStatusInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    status: Literal['saved', 'completed', 'cancelled']


def clock(minutes):
    hours, mins = divmod(minutes, 60)
    return f"{hours % 12 or 12}:{mins:02d} {'AM' if hours < 12 else 'PM'}"


def user_zone(db, user, session=None) -> ZoneInfo:
    doc = db.availability.find_one({'user_id': str(user['_id'])}, {'timeZone': 1}, session=session)
    return ZoneInfo((doc or {}).get('timeZone') or 'Etc/GMT')


def _utc(value):
    from datetime import timezone
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def session_instants(doc, zone):
    """UTC start/end of a stored session. Older documents only have local date/start/end."""
    from app.scheduling_engine import from_abs, local_to_abs
    if doc.get('start_at') and doc.get('end_at'):
        return _utc(doc['start_at']), _utc(doc['end_at'])
    day = date.fromisoformat(doc['date'])
    return from_abs(local_to_abs(day, doc['start'], zone)), from_abs(local_to_abs(day, doc['end'], zone))


def check_session(data, user, db, zone, session_id=None):
    """Sessions must belong to the user's task, finish by the task's due time, and not overlap other sessions or events."""
    from app.scheduling_engine import from_abs, local_to_abs
    task = db.tasks.find_one(owned_task(data.taskId, user))
    if not task:
        raise HTTPException(404, 'Task not found.')
    due_time = task.get('dueTime', DEFAULT_DUE_TIME)
    # A task due at 11:59 PM may be worked on until midnight.
    if data.date > task['deadline'] or (data.date == task['deadline'] and data.end > due_time + 1):
        raise HTTPException(422, f"This session ends after the task is due ({task['deadline']} at {clock(due_time)}).")
    day = date.fromisoformat(data.date)
    start_at, end_at = from_abs(local_to_abs(day, data.start, zone)), from_abs(local_to_abs(day, data.end, zone))
    query = {'user_id': str(user['_id']), 'status': {'$ne': 'cancelled'},
             'start_at': {'$lt': end_at}, 'end_at': {'$gt': start_at}}
    if session_id:
        query['_id'] = {'$ne': session_id}
    clash = db.sessions.find_one(query)
    if clash:
        if clash.get('type') == 'break':
            raise HTTPException(409, f"This overlaps a break ({clock(clash['start'])} - {clock(clash['end'])}). Replan to move it.")
        other = db.tasks.find_one({'_id': ObjectId(clash['task_id'])}) if ObjectId.is_valid(clash.get('task_id') or '') else None
        name = f' for "{other["title"]}"' if other else ''
        raise HTTPException(409, f"This overlaps another work session{name} ({clock(clash['start'])} - {clock(clash['end'])}).")
    event = event_clash(db, str(user['_id']), data.date, data.start, data.end)
    if event:
        raise HTTPException(409, f"This overlaps your event \"{event['title']}\" ({clock(event['start'])} - {clock(event['end'])}).")
    return task, start_at, end_at


def session_doc(data, user, start_at, end_at, version):
    fields = data.model_dump()
    return {'user_id': str(user['_id']), 'task_id': fields.pop('taskId'), 'type': 'work', 'status': 'saved',
            'start_at': start_at, 'end_at': end_at, 'schedule_version': version, **fields}


def session_output(doc, zone, titles=None):
    """The canonical schedule session (see app.schedule_model.ScheduleSession)."""
    from app.schedule_model import ScheduleSession
    from app.scheduling_engine import local_span, to_abs
    start_at, end_at = session_instants(doc, zone)
    day, start, end = local_span(to_abs(start_at), to_abs(end_at), zone)
    kind = doc.get('type', 'work')
    task_id = doc.get('task_id') if kind == 'work' else None
    title = 'Break' if kind == 'break' else (titles or {}).get(task_id, doc.get('title') or 'Task')
    return ScheduleSession(id=str(doc['_id']), taskId=task_id, title=title, type=kind,
                           status=doc.get('status', 'saved'), locked=bool(doc.get('locked', False)),
                           source=doc.get('source', 'manual'), scheduleVersion=int(doc.get('schedule_version', 0)),
                           startAt=start_at, endAt=end_at, date=day, start=start, end=end)


def task_titles(db, user, session=None):
    return {str(doc['_id']): doc['title'] for doc in db.tasks.find({'user_id': str(user['_id'])}, {'title': 1}, session=session)}


def owned_session(session_id, user):
    if not ObjectId.is_valid(session_id):
        raise HTTPException(404, 'Work session not found.')
    return {'_id': ObjectId(session_id), 'user_id': str(user['_id'])}


SESSION_QUERY = {'$or': [{'start_at': {'$exists': True}}, {'date': {'$exists': True}}]}  # excludes legacy token documents


def list_session_docs(db, user, session=None):
    return list(db.sessions.find({'user_id': str(user['_id']), **SESSION_QUERY}, session=session))


@router.get('/sessions')
def list_sessions(user=Depends(get_current_user), db=Depends(get_database)):
    zone, titles = user_zone(db, user), task_titles(db, user)
    sessions = [session_output(doc, zone, titles) for doc in list_session_docs(db, user)]
    return sorted(sessions, key=lambda s: (s.startAt, s.endAt, s.id))


@router.post('/sessions', status_code=201)
def create_session(data: SessionInput, user=Depends(get_current_user), db=Depends(get_database)):
    from app.schedule_version import bump_schedule_version
    zone = user_zone(db, user)
    task, start_at, end_at = check_session(data, user, db, zone)
    version = bump_schedule_version(db, str(user['_id']))
    doc = session_doc(data, user, start_at, end_at, version)
    doc['_id'] = db.sessions.insert_one(doc).inserted_id
    return session_output(doc, zone, {data.taskId: task['title']})


@router.put('/sessions/{session_id}')
def update_session(session_id: str, data: SessionInput, user=Depends(get_current_user), db=Depends(get_database)):
    from app.schedule_version import bump_schedule_version
    query = owned_session(session_id, user)
    existing = db.sessions.find_one(query)
    if not existing:
        raise HTTPException(404, 'Work session not found.')
    if existing.get('type') == 'break':
        raise HTTPException(409, 'Breaks are managed by the scheduler. Request or replan breaks instead.')
    zone = user_zone(db, user)
    task, start_at, end_at = check_session(data, user, db, zone, query['_id'])
    version = bump_schedule_version(db, str(user['_id']))
    doc = db.sessions.find_one_and_update(query, {'$set': session_doc(data, user, start_at, end_at, version)},
                                          return_document=ReturnDocument.AFTER)
    return session_output(doc, zone, {data.taskId: task['title']})


@router.patch('/sessions/{session_id}/status')
def set_session_status(session_id: str, data: SessionStatusInput, user=Depends(get_current_user), db=Depends(get_database)):
    """Mark a work session completed (its minutes count as completed work), reopen it, or cancel it."""
    from app.schedule_version import bump_schedule_version
    query = owned_session(session_id, user)
    existing = db.sessions.find_one(query)
    if not existing:
        raise HTTPException(404, 'Work session not found.')
    zone = user_zone(db, user)
    before = existing.get('status', 'saved')
    if before == data.status:
        return session_output(existing, zone, task_titles(db, user))
    if existing.get('type') == 'break' and data.status == 'completed':
        raise HTTPException(422, 'Breaks do not count as completed work.')
    start_at, end_at = session_instants(existing, zone)
    minutes = int((end_at - start_at).total_seconds() // 60)
    # Only one request may perform this transition; the status filter makes a retry a no-op.
    doc = db.sessions.find_one_and_update({**query, 'status': {'$in': [before]} if 'status' in existing else {'$exists': False}},
                                          {'$set': {'status': data.status}}, return_document=ReturnDocument.AFTER)
    if not doc:
        raise HTTPException(409, 'This session changed. Refresh and try again.')
    delta = (minutes if data.status == 'completed' else 0) - (minutes if before == 'completed' else 0)
    if delta and existing.get('task_id') and ObjectId.is_valid(existing['task_id']):
        task = db.tasks.find_one(owned_task(existing['task_id'], user))
        if task:
            completed = task.get('completedMinutes')
            if completed is None:
                completed = task['minutes'] - (task.get('remainingMinutes') if task.get('remainingMinutes') is not None else task['minutes'])
            db.tasks.update_one(owned_task(existing['task_id'], user),
                                {'$set': {'completedMinutes': max(0, min(6000, completed + delta))}})
    bump_schedule_version(db, str(user['_id']))
    return session_output(doc, zone, task_titles(db, user))


@router.delete('/sessions/{session_id}', status_code=204)
def delete_session(session_id: str, user=Depends(get_current_user), db=Depends(get_database)):
    from app.schedule_version import bump_schedule_version
    if not db.sessions.delete_one(owned_session(session_id, user)).deleted_count:
        raise HTTPException(404, 'Work session not found.')
    bump_schedule_version(db, str(user['_id']))


class TimePeriod(BaseModel):
    model_config = ConfigDict(extra='forbid')
    start: int = Field(strict=True, ge=0, le=1439)
    end: int = Field(strict=True, ge=1, le=1440)

    @model_validator(mode='after')
    def valid_range(self):
        if self.end <= self.start:
            raise ValueError('Each period end must be later than its start; overnight ranges are not supported.')
        return self


class AvailableDay(BaseModel):
    model_config = ConfigDict(extra='forbid')
    day: int = Field(strict=True, ge=0, le=6)  # Monday = 0
    enabled: bool = Field(strict=True)
    periods: list[TimePeriod] = Field(default_factory=list)

    @model_validator(mode='before')
    @classmethod
    def migrate_legacy_window(cls, data):
        if not isinstance(data, dict):
            return data
        payload = dict(data)
        if 'periods' not in payload and 'start' in payload and 'end' in payload:
            payload['periods'] = [{'start': payload.pop('start'), 'end': payload.pop('end')}]
        else:
            payload.pop('start', None)
            payload.pop('end', None)
        return payload

    @model_validator(mode='after')
    def valid_periods(self):
        if not self.enabled:
            return self
        if not self.periods:
            raise ValueError('Enabled days need at least one available period.')
        ordered = sorted(self.periods, key=lambda period: (period.start, period.end))
        previous_end = -1
        for period in ordered:
            if period.start < previous_end:
                raise ValueError('Available periods on the same day cannot overlap.')
            previous_end = period.end
        self.periods = ordered
        return self


class WeekOverride(BaseModel):
    model_config = ConfigDict(extra='forbid')
    weekStart: str  # Monday YYYY-MM-DD
    days: list[AvailableDay] = Field(min_length=7, max_length=7)

    @field_validator('weekStart')
    @classmethod
    def monday_date(cls, value):
        try:
            parsed = date.fromisoformat(value)
        except ValueError as error:
            raise ValueError('Week start must be a YYYY-MM-DD date.') from error
        if parsed.weekday() != 0:
            raise ValueError('Week start must be a Monday.')
        return value

    @model_validator(mode='after')
    def unique_weekdays(self):
        if sorted(day.day for day in self.days) != list(range(7)):
            raise ValueError('Include each weekday exactly once in a week override.')
        self.days.sort(key=lambda day: day.day)
        return self


class Availability(BaseModel):
    model_config = ConfigDict(extra='forbid')
    days: list[AvailableDay] = Field(min_length=7, max_length=7)
    weekOverrides: list[WeekOverride] = Field(default_factory=list)
    timeZone: str = Field(min_length=1, max_length=100)
    reminders: bool = Field(strict=True)

    @field_validator('timeZone')
    @classmethod
    def valid_zone(cls, value):
        aliases = {'GMT': 'Etc/GMT', 'UTC': 'Etc/GMT', 'Etc/UTC': 'Etc/GMT'}
        value = aliases.get(value.strip(), value.strip())
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError('Choose a valid IANA time zone, such as America/New_York or GMT.') from None
        return value

    @model_validator(mode='before')
    @classmethod
    def ignore_saved_flag(cls, value):
        # `saved` is read-only output (see AvailabilityView); clients may send back what they loaded.
        if isinstance(value, dict) and 'saved' in value and 'saved' not in cls.model_fields:
            value = {key: item for key, item in value.items() if key != 'saved'}
        return value

    @model_validator(mode='after')
    def unique_weekdays(self):
        if sorted(day.day for day in self.days) != list(range(7)):
            raise ValueError('Include each weekday exactly once.')
        self.days.sort(key=lambda day: day.day)
        starts = [week.weekStart for week in self.weekOverrides]
        if len(starts) != len(set(starts)):
            raise ValueError('Each week override must use a unique Monday.')
        self.weekOverrides.sort(key=lambda week: week.weekStart)
        return self


class AvailabilityView(Availability):
    """`saved` is false until the user (or the app, from the browser's timezone) first saves availability."""
    saved: bool = True


def default_availability():
    return Availability(
        days=[AvailableDay(day=day, enabled=False, periods=[TimePeriod(start=540, end=1020)]) for day in range(7)],
        weekOverrides=[],
        timeZone='Etc/GMT',
        reminders=False,
    )


def resolve_available_day(availability: Availability, day: date) -> AvailableDay:
    monday = (day - timedelta(days=day.weekday())).isoformat()
    for week in availability.weekOverrides:
        if week.weekStart == monday:
            return next(row for row in week.days if row.day == day.weekday())
    return next(row for row in availability.days if row.day == day.weekday())


@router.get('/availability', response_model=AvailabilityView)
def get_availability(user=Depends(get_current_user), db=Depends(get_database)):
    doc = db.availability.find_one({'user_id': str(user['_id'])}, {'_id': 0, 'user_id': 0})
    if doc:
        return AvailabilityView(**doc)
    return AvailabilityView(**default_availability().model_dump(), saved=False)


@router.put('/availability', response_model=AvailabilityView)
def save_availability(data: Availability, user=Depends(get_current_user), db=Depends(get_database)):
    """The saved timezone is the account's only timezone. Changing it keeps events at the same real time."""
    from datetime import datetime, timezone
    from app.timezone_change import preserve_event_times
    user_id = str(user['_id'])
    previous = db.availability.find_one({'user_id': user_id}, {'timeZone': 1})
    if previous and previous.get('timeZone') and previous['timeZone'] != data.timeZone:
        today = datetime.now(timezone.utc).astimezone(ZoneInfo(previous['timeZone'])).date()
        preserve_event_times(db, user_id, previous['timeZone'], data.timeZone, today)
    db.availability.update_one({'user_id': user_id}, {'$set': data.model_dump()}, upsert=True)
    bump(db, user)
    return AvailabilityView(**data.model_dump())
