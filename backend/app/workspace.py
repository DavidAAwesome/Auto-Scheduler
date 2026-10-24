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


class TaskInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=80)
    deadline: str
    # Total estimated work. Tasks can be split into several work sessions, so allow up to 100 hours.
    minutes: int = Field(strict=True, ge=15, le=6000, multiple_of=15)
    # Work still to schedule; defaults to minutes. Fixed/manual sessions consume from this.
    remainingMinutes: int | None = Field(default=None, strict=True, ge=0, le=6000)
    dueTime: int = Field(default=DEFAULT_DUE_TIME, strict=True, ge=0, le=1439)  # minutes after midnight
    priority: Literal['High', 'Medium', 'Low']
    category: Literal['Project', 'Study', 'Personal', 'Work']
    earliestStart: str | None = None  # ISO-8601 datetime; null = as soon as allowed
    allowSplit: bool = Field(default=True, strict=True)
    minSessionMinutes: int = Field(default=15, strict=True, ge=15, le=6000, multiple_of=15)
    maxSessionMinutes: int = Field(default=60, strict=True, ge=15, le=6000, multiple_of=15)
    dependsOn: list[str] = Field(default_factory=list, max_length=32)

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
        remaining = self.minutes if self.remainingMinutes is None else self.remainingMinutes
        if remaining > self.minutes:
            raise ValueError('remainingMinutes cannot exceed estimated minutes.')
        if remaining % 15:
            raise ValueError('remainingMinutes must be a multiple of 15.')
        if self.minSessionMinutes > self.maxSessionMinutes:
            raise ValueError('minSessionMinutes cannot exceed maxSessionMinutes.')
        if not self.allowSplit and self.minutes < self.minSessionMinutes:
            raise ValueError('Unsplit tasks need at least minSessionMinutes of work.')
        self.remainingMinutes = remaining
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
    'earliestStart': None,
    'allowSplit': True,
    'minSessionMinutes': 15,
    'maxSessionMinutes': 60,
    'dependsOn': [],
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
    if payload.get('remainingMinutes') is None:
        payload['remainingMinutes'] = payload['minutes']
    return TaskOutput(**payload, id=str(doc['_id']), done=doc['done'])


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
    return task_output(doc)


@router.patch('/tasks/{task_id}/completion', response_model=TaskOutput)
def complete_task(task_id: str, data: Completion, user=Depends(get_current_user), db=Depends(get_database)):
    doc = db.tasks.find_one_and_update(owned_task(task_id, user), {'$set': {'done': data.done}}, return_document=ReturnDocument.AFTER)
    if not doc:
        raise HTTPException(404, 'Task not found.')
    return task_output(doc)


@router.delete('/tasks/{task_id}', status_code=204)
def delete_task(task_id: str, user=Depends(get_current_user), db=Depends(get_database)):
    if not db.tasks.delete_one(owned_task(task_id, user)).deleted_count:
        raise HTTPException(404, 'Task not found.')
    db.sessions.delete_many({'user_id': str(user['_id']), 'task_id': task_id})


class SessionInput(BaseModel):
    """A block of time set aside to work on a task. A task can be split across many sessions and days."""
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


class SessionOutput(SessionInput):
    id: str


def clock(minutes):
    hours, mins = divmod(minutes, 60)
    return f"{hours % 12 or 12}:{mins:02d} {'AM' if hours < 12 else 'PM'}"


def check_session(data, user, db, session_id=None):
    """Sessions must belong to the user's task, finish by the task's due time, and not overlap each other or an event."""
    task = db.tasks.find_one(owned_task(data.taskId, user))
    if not task:
        raise HTTPException(404, 'Task not found.')
    due_time = task.get('dueTime', DEFAULT_DUE_TIME)
    # A task due at 11:59 PM may be worked on until midnight.
    if data.date > task['deadline'] or (data.date == task['deadline'] and data.end > due_time + 1):
        raise HTTPException(422, f"This session ends after the task is due ({task['deadline']} at {clock(due_time)}).")
    query = {'user_id': str(user['_id']), 'date': data.date, 'start': {'$lt': data.end}, 'end': {'$gt': data.start}}
    if session_id:
        query['_id'] = {'$ne': session_id}
    clash = db.sessions.find_one(query)
    if clash:
        other = db.tasks.find_one({'_id': ObjectId(clash['task_id'])}) if ObjectId.is_valid(clash['task_id']) else None
        name = f' for "{other["title"]}"' if other else ''
        raise HTTPException(409, f"This overlaps another work session{name} ({clock(clash['start'])} - {clock(clash['end'])}).")
    event = event_clash(db, str(user['_id']), data.date, data.start, data.end)
    if event:
        raise HTTPException(409, f"This overlaps your event \"{event['title']}\" ({clock(event['start'])} - {clock(event['end'])}).")


def session_doc(data, user):
    fields = data.model_dump()
    return {'user_id': str(user['_id']), 'task_id': fields.pop('taskId'), **fields}


def session_output(doc):
    return SessionOutput(taskId=doc['task_id'], date=doc['date'], start=doc['start'], end=doc['end'],
                         source=doc.get('source', 'manual'), locked=bool(doc.get('locked', False)),
                         id=str(doc['_id']))


def owned_session(session_id, user):
    if not ObjectId.is_valid(session_id):
        raise HTTPException(404, 'Work session not found.')
    return {'_id': ObjectId(session_id), 'user_id': str(user['_id'])}


@router.get('/sessions', response_model=list[SessionOutput])
def list_sessions(user=Depends(get_current_user), db=Depends(get_database)):
    return [session_output(doc) for doc in db.sessions.find({'user_id': str(user['_id'])}).sort([('date', 1), ('start', 1)])]


@router.post('/sessions', response_model=SessionOutput, status_code=201)
def create_session(data: SessionInput, user=Depends(get_current_user), db=Depends(get_database)):
    check_session(data, user, db)
    doc = session_doc(data, user)
    doc['_id'] = db.sessions.insert_one(doc).inserted_id
    return session_output(doc)


@router.put('/sessions/{session_id}', response_model=SessionOutput)
def update_session(session_id: str, data: SessionInput, user=Depends(get_current_user), db=Depends(get_database)):
    query = owned_session(session_id, user)
    if not db.sessions.find_one(query):
        raise HTTPException(404, 'Work session not found.')
    check_session(data, user, db, query['_id'])
    doc = db.sessions.find_one_and_update(query, {'$set': session_doc(data, user)}, return_document=ReturnDocument.AFTER)
    return session_output(doc)


@router.delete('/sessions/{session_id}', status_code=204)
def delete_session(session_id: str, user=Depends(get_current_user), db=Depends(get_database)):
    if not db.sessions.delete_one(owned_session(session_id, user)).deleted_count:
        raise HTTPException(404, 'Work session not found.')


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


@router.get('/availability', response_model=Availability)
def get_availability(user=Depends(get_current_user), db=Depends(get_database)):
    doc = db.availability.find_one({'user_id': str(user['_id'])}, {'_id': 0, 'user_id': 0})
    return Availability(**doc) if doc else default_availability()


@router.put('/availability', response_model=Availability)
def save_availability(data: Availability, user=Depends(get_current_user), db=Depends(get_database)):
    db.availability.update_one({'user_id': str(user['_id'])}, {'$set': data.model_dump()}, upsert=True)
    return data
