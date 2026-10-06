"""Protected persistence boundary for plans; calendar adapters supply busy instants."""
from datetime import datetime, timezone
from hashlib import sha256
import json
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pymongo.errors import DuplicateKeyError

from app.auth import get_current_user
from app.database import get_database
from app.scheduler import BusyInterval, Plan, generate_plan
from app.workspace import get_availability, list_tasks

router = APIRouter(prefix='/plan', tags=['plan'])


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    # Required: providers must never convert a failed fetch into an empty list.
    busyIntervals: list[BusyInterval] = Field(max_length=5000)
    source: Literal['provided', 'availability_only']

    @model_validator(mode='after')
    def honest_source(self):
        if self.source == 'availability_only' and self.busyIntervals:
            raise ValueError('Use provided source when supplying calendar intervals.')
        return self


def utc_now():
    return datetime.now(timezone.utc)


def fingerprint(tasks, availability):
    # Reminder preferences do not affect scheduling.
    data = {'tasks': [t.model_dump() for t in sorted(tasks, key=lambda t: t.id)],
            'days': [day.model_dump() for day in availability.days], 'timeZone': availability.timeZone}
    return sha256(json.dumps(data, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def read_inputs(user, db):
    return list_tasks(user=user, db=db), get_availability(user=user, db=db)


def mark_stale(plan, stored_fingerprint, tasks, availability, now):
    reasons = []
    if stored_fingerprint != fingerprint(tasks, availability):
        reasons.append('Tasks or availability changed. Generate a new plan when ready.')
    from zoneinfo import ZoneInfo
    if now.astimezone(ZoneInfo(plan.timeZone)).date().isoformat() != plan.startDate:
        reasons.append('This plan was generated for an earlier day. Generate a new plan when ready.')
    return plan.model_copy(update={'stale': bool(reasons), 'staleReasons': reasons})


@router.get('', response_model=Plan | None)
def current_plan(user=Depends(get_current_user), db=Depends(get_database)):
    stored = db.plans.find_one({'user_id': str(user['_id'])})
    if not stored:
        return None
    tasks, availability = read_inputs(user, db)
    return mark_stale(Plan(**stored['plan']), stored['input_fingerprint'], tasks, availability, utc_now())


@router.post('/generate', response_model=Plan)
def create_plan(data: GenerateRequest, user=Depends(get_current_user), db=Depends(get_database)):
    tasks, availability = read_inputs(user, db)
    now = utc_now()
    plan = generate_plan(tasks, availability, data.busyIntervals, now, data.source)
    input_fingerprint = fingerprint(tasks, availability)
    document = {'user_id': str(user['_id']), 'input_fingerprint': input_fingerprint,
                'plan': plan.model_dump(mode='python')}
    # One atomic snapshot per user: repeated requests replace, never append.
    try:
        db.plans.replace_one({'user_id': document['user_id']}, document, upsert=True)
    except DuplicateKeyError:
        # Concurrent first generation: the unique owner index selects one record.
        db.plans.replace_one({'user_id': document['user_id']}, document)
    latest_tasks, latest_availability = read_inputs(user, db)
    return mark_stale(plan, input_fingerprint, latest_tasks, latest_availability, now)
