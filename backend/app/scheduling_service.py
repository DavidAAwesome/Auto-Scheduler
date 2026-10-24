"""Single scheduling path shared by the Generate Schedule button, chat, and interpret.

Every caller gets the same structured preview. Nothing here writes sessions: a preview
is stored as pending and only Apply (in schedule_routes) persists its sessions.
"""
from __future__ import annotations

from datetime import date as date_cls, datetime, timedelta
from zoneinfo import ZoneInfo

from bson import ObjectId
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict

from app.events import occurs_on
from app.scheduling_engine import BusyBlock, FixedSession, ScheduleResult, generate_schedule
from app.scheduling_validator import ValidationError, validate_schedule
from app.workspace import Availability, default_availability, task_output


class PreviewResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    previewId: str
    status: str = 'pending'
    schedule: ScheduleResult


def expand_events(db, user_id: str, start_date: str, end_date: str, session=None) -> list[dict]:
    """The user's events (repeats expanded) that happen between two local dates, inclusive."""
    occurrences: list[dict] = []
    day = date_cls.fromisoformat(start_date)
    last = date_cls.fromisoformat(end_date)
    events = list(db.events.find({'user_id': user_id}, session=session))
    while day <= last:
        day_s = day.isoformat()
        for doc in events:
            if occurs_on(doc, day_s):
                occurrences.append({
                    'date': day_s, 'start': doc['start'], 'end': doc['end'],
                    'title': doc.get('title', 'event'), 'kind': doc.get('kind', 'Other'),
                    'source': doc.get('source', 'manual'),
                })
        day += timedelta(days=1)
    return occurrences


def event_busy(db, user_id: str, start_date: str, end_date: str, session=None) -> list[BusyBlock]:
    return [
        BusyBlock(date=o['date'], start=o['start'], end=o['end'], label=o['title'])
        for o in expand_events(db, user_id, start_date, end_date, session=session)
    ]


def load_context(user, db, now: datetime, horizon_days: int = 7, session=None):
    owner = {'user_id': str(user['_id'])}
    tasks = [task_output(doc) for doc in db.tasks.find(owner, session=session)]
    saved = db.availability.find_one(owner, {'_id': 0, 'user_id': 0}, session=session)
    availability = Availability(**saved) if saved else default_availability()
    zone = ZoneInfo(availability.timeZone)
    local = now.astimezone(zone).date()
    start_date = local.isoformat()
    end_date = (local.fromordinal(local.toordinal() + horizon_days - 1)).isoformat()

    sessions = list(db.sessions.find({'user_id': str(user['_id'])}, session=session))
    fixed: list[FixedSession] = []
    unlocked: list[FixedSession] = []
    for doc in sessions:
        item = FixedSession(
            id=str(doc['_id']),
            taskId=doc['task_id'],
            date=doc['date'],
            start=doc['start'],
            end=doc['end'],
            locked=bool(doc.get('locked', False)),
            source=doc.get('source', 'manual'),
        )
        if item.locked or item.source == 'manual':
            fixed.append(item)
        else:
            unlocked.append(item)

    busy = event_busy(db, str(user['_id']), start_date, end_date, session=session)
    return tasks, availability, busy, fixed, unlocked, start_date, end_date


def build_preview(user, db, now: datetime, horizon_days: int = 7) -> PreviewResponse:
    tasks, availability, busy, fixed, unlocked, _, _ = load_context(user, db, now, horizon_days)
    schedule = generate_schedule(tasks, availability, busy, fixed, unlocked, now, horizon_days)
    try:
        validate_schedule(schedule, tasks, availability, busy, fixed, now)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=f'Schedule failed validation: {exc.message}') from exc

    preview_id = str(ObjectId())
    db.schedule_previews.insert_one({
        '_id': ObjectId(preview_id),
        'user_id': str(user['_id']),
        'status': 'pending',
        'created_at': now,
        'input_fingerprint': schedule.inputFingerprint,
        'horizon_days': horizon_days,
        'schedule': schedule.model_dump(mode='python'),
    })
    return PreviewResponse(previewId=preview_id, schedule=schedule)
