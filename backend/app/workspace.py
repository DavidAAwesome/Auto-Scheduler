"""Sprint 1 data routes. Ownership always comes from the authenticated session."""
from datetime import date
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pymongo import ReturnDocument

from app.auth import get_current_user
from app.database import get_database

router = APIRouter(tags=['workspace'])


class TaskInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=80)
    deadline: str
    minutes: int = Field(strict=True, ge=15, le=720, multiple_of=15)
    priority: Literal['High', 'Medium', 'Low']
    category: Literal['Project', 'Study', 'Personal', 'Work']

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


class TaskOutput(TaskInput):
    id: str
    done: bool


class Completion(BaseModel):
    model_config = ConfigDict(extra='forbid')
    done: bool = Field(strict=True)


def task_output(doc):
    return TaskOutput(**{field: doc[field] for field in TaskInput.model_fields},
                      id=str(doc['_id']), done=doc['done'])


def owned_task(task_id, user):
    if not ObjectId.is_valid(task_id):
        raise HTTPException(404, 'Task not found.')
    return {'_id': ObjectId(task_id), 'user_id': str(user['_id'])}


@router.get('/tasks', response_model=list[TaskOutput])
def list_tasks(user=Depends(get_current_user), db=Depends(get_database)):
    return [task_output(doc) for doc in db.tasks.find({'user_id': str(user['_id'])}).sort([('deadline', 1), ('_id', 1)])]


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


class AvailableDay(BaseModel):
    model_config = ConfigDict(extra='forbid')
    day: int = Field(strict=True, ge=0, le=6)  # Monday = 0
    enabled: bool = Field(strict=True)
    start: int = Field(strict=True, ge=0, le=1439)
    end: int = Field(strict=True, ge=1, le=1440)

    @model_validator(mode='after')
    def valid_range(self):
        if self.end <= self.start:
            raise ValueError('End time must be later than start time; overnight ranges are not supported.')
        return self


class Availability(BaseModel):
    model_config = ConfigDict(extra='forbid')
    days: list[AvailableDay] = Field(min_length=7, max_length=7)
    timeZone: str = Field(min_length=1, max_length=100)
    reminders: bool = Field(strict=True)

    @field_validator('timeZone')
    @classmethod
    def valid_zone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError('Choose a valid IANA time zone, such as America/New_York.') from None
        return value

    @model_validator(mode='after')
    def unique_weekdays(self):
        if sorted(day.day for day in self.days) != list(range(7)):
            raise ValueError('Include each weekday exactly once.')
        self.days.sort(key=lambda day: day.day)
        return self


def default_availability():
    return Availability(days=[AvailableDay(day=day, enabled=False, start=540, end=1020) for day in range(7)], timeZone='UTC', reminders=False)


@router.get('/availability', response_model=Availability)
def get_availability(user=Depends(get_current_user), db=Depends(get_database)):
    doc = db.availability.find_one({'user_id': str(user['_id'])}, {'_id': 0, 'user_id': 0})
    return Availability(**doc) if doc else default_availability()


@router.put('/availability', response_model=Availability)
def save_availability(data: Availability, user=Depends(get_current_user), db=Depends(get_database)):
    db.availability.update_one({'user_id': str(user['_id'])}, {'$set': data.model_dump()}, upsert=True)
    return data
