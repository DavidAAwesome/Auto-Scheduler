"""Authenticated schedule preview / apply / interpret / replan endpoints.

Preview never mutates saved sessions. Apply re-validates against current data,
rejects stale fingerprints, and is idempotent for the same preview id.
"""
from __future__ import annotations

from datetime import date as date_cls, datetime, timedelta, timezone
from typing import Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from app.auth import get_current_user
from app.database import get_database
from app.events import occurs_on
from app.openai_interpret import InterpretResult, interpret_request
from app.scheduling_engine import (
    BusyBlock,
    FixedSession,
    ScheduleResult,
    generate_schedule,
)
from app.scheduling_validator import ValidationError, validate_schedule
from app.workspace import (
    SessionInput,
    Availability,
    default_availability,
    task_output,
    get_availability,
    list_tasks,
    session_doc,
    session_output,
)

router = APIRouter(prefix='/schedule', tags=['schedule'])


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    horizonDays: int = Field(default=7, ge=1, le=21)


class PreviewResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    previewId: str
    status: Literal['pending'] = 'pending'
    schedule: ScheduleResult


class ApplyRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    previewId: str = Field(min_length=1, max_length=64)


class ApplyResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    previewId: str
    status: Literal['applied']
    sessions: list[dict]


class InterpretRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    message: str = Field(min_length=1, max_length=2000)
    history: list[dict] = Field(default_factory=list, max_length=12)
    autoPreview: bool = True


class InterpretResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    interpretation: InterpretResult
    preview: PreviewResponse | None = None


def _event_busy(db, user_id: str, start_date: str, end_date: str, session=None) -> list[BusyBlock]:
    """Expand events (including repeats) into busy blocks in the planning window."""
    blocks: list[BusyBlock] = []
    day = date_cls.fromisoformat(start_date)
    last = date_cls.fromisoformat(end_date)
    events = list(db.events.find({'user_id': user_id}, session=session))
    while day <= last:
        day_s = day.isoformat()
        for doc in events:
            if occurs_on(doc, day_s):
                blocks.append(BusyBlock(
                    date=day_s, start=doc['start'], end=doc['end'],
                    label=doc.get('title', 'event'),
                ))
        day += timedelta(days=1)
    return blocks


def _load_context(user, db, now: datetime, horizon_days: int = 7, session=None):
    owner = {'user_id': str(user['_id'])}
    tasks = [task_output(doc) for doc in db.tasks.find(owner, session=session)]
    saved = db.availability.find_one(owner, {'_id': 0, 'user_id': 0}, session=session)
    availability = Availability(**saved) if saved else default_availability()
    from zoneinfo import ZoneInfo
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

    busy = _event_busy(db, str(user['_id']), start_date, end_date, session=session)
    return tasks, availability, busy, fixed, unlocked, start_date, end_date


def _build_preview(user, db, now: datetime, horizon_days: int = 7) -> PreviewResponse:
    tasks, availability, busy, fixed, unlocked, _, _ = _load_context(user, db, now, horizon_days)
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


@router.post('/preview', response_model=PreviewResponse)
def create_preview(body: PreviewRequest = PreviewRequest(), user=Depends(get_current_user),
                   db=Depends(get_database)):
    return _build_preview(user, db, utc_now(), body.horizonDays)


@router.post('/replan', response_model=PreviewResponse)
def replan(body: PreviewRequest = PreviewRequest(), user=Depends(get_current_user),
           db=Depends(get_database)):
    """Same as preview: regenerate after tasks/availability changed. Does not apply."""
    return _build_preview(user, db, utc_now(), body.horizonDays)


@router.post('/apply', response_model=ApplyResponse)
def apply_preview(body: ApplyRequest, user=Depends(get_current_user), db=Depends(get_database)):
    if not ObjectId.is_valid(body.previewId):
        raise HTTPException(404, 'Preview not found.')
    # Preserve ownership errors even on servers that cannot run transactions.
    if not db.schedule_previews.find_one({'_id': ObjectId(body.previewId), 'user_id': str(user['_id'])}):
        raise HTTPException(404, 'Preview not found.')
    # One MongoClient/database for task CRUD and every operation in this transaction.
    # No non-transactional fallback: partial schedule replacement loses user data.
    with db.client.start_session() as session:
        return session.with_transaction(
            lambda transaction: _apply_transaction(body, user, db, transaction),
            read_concern=ReadConcern('snapshot'), write_concern=WriteConcern('majority'),
        )


def _apply_transaction(body, user, db, session):
    owner = {'_id': ObjectId(body.previewId), 'user_id': str(user['_id'])}
    preview = db.schedule_previews.find_one(owner, session=session)
    if not preview:
        raise HTTPException(404, 'Preview not found.')
    if preview.get('status') == 'applied':
        existing = list(db.sessions.find({
            'user_id': str(user['_id']), 'preview_id': body.previewId,
        }, session=session))
        return ApplyResponse(previewId=body.previewId, status='applied',
                             sessions=[session_output(doc).model_dump() for doc in existing])

    now = utc_now()
    horizon = int(preview.get('horizon_days') or 7)
    tasks, availability, busy, fixed, unlocked, _, _ = _load_context(user, db, now, horizon, session)
    schedule = ScheduleResult(**preview['schedule'])
    fresh = generate_schedule(tasks, availability, busy, fixed, unlocked, now, horizon)
    if fresh.inputFingerprint != preview['input_fingerprint']:
        raise HTTPException(409, 'This preview is stale. Tasks, availability, events, or sessions changed. Generate a new preview.')
    try:
        validate_schedule(schedule, tasks, availability, busy, fixed, now)
    except ValidationError as exc:
        raise HTTPException(409, f'Preview no longer valid: {exc.message}') from exc

    # Validate every document before deleting anything. The validator above checks
    # task ownership, deadlines, and overlaps against this transaction's snapshot.
    created = []
    for proposed in schedule.sessions:
        data = SessionInput(taskId=proposed.taskId, date=proposed.date,
                            start=proposed.start, end=proposed.end, source='auto', locked=False)
        created.append({**session_doc(data, user), '_id': ObjectId(), 'preview_id': body.previewId})
    # Serialize concurrent Apply requests for the same owner (including empty plans).
    db.users.update_one({'_id': user['_id']}, {'$inc': {'schedule_revision': 1}}, session=session)
    db.sessions.delete_many({'user_id': str(user['_id']), 'source': 'auto', 'locked': {'$ne': True}}, session=session)
    if created:
        db.sessions.insert_many(created, session=session)
    updated = db.schedule_previews.update_one(
        {**owner, 'status': 'pending'}, {'$set': {'status': 'applied', 'applied_at': now}}, session=session)
    if updated.modified_count != 1:
        raise HTTPException(409, 'Preview changed. Generate a new preview.')
    return ApplyResponse(previewId=body.previewId, status='applied',
                         sessions=[session_output(doc).model_dump() for doc in created])


@router.post('/interpret', response_model=InterpretResponse)
def interpret(body: InterpretRequest, user=Depends(get_current_user), db=Depends(get_database)):
    """NL → structured preferences (OpenAI). Optionally builds a schedule preview. Never writes tasks."""
    now = utc_now()
    tasks = list_tasks(user=user, db=db)
    availability = get_availability(user=user, db=db)
    summaries = [
        {
            'id': t.id,
            'title': t.title,
            'deadline': t.deadline,
            'dueTime': t.dueTime,
            'minutes': t.minutes,
            'remainingMinutes': t.remainingMinutes,
            'priority': t.priority,
            'allowSplit': t.allowSplit,
            'dependsOn': t.dependsOn,
        }
        for t in tasks if not t.done
    ]
    interpretation = interpret_request(
        body.message,
        time_zone=availability.timeZone,
        now=now,
        task_summaries=summaries,
        history=body.history,
    )
    preview = None
    if body.autoPreview and interpretation.runScheduler and not interpretation.needsConfirmation:
        # Preferences are suggestions only — engine uses current saved tasks unless FE applies patches.
        preview = _build_preview(user, db, now)
    return InterpretResponse(interpretation=interpretation, preview=preview)


@router.get('/preview/{preview_id}', response_model=PreviewResponse)
def get_preview(preview_id: str, user=Depends(get_current_user), db=Depends(get_database)):
    if not ObjectId.is_valid(preview_id):
        raise HTTPException(404, 'Preview not found.')
    preview = db.schedule_previews.find_one({'_id': ObjectId(preview_id), 'user_id': str(user['_id'])})
    if not preview:
        raise HTTPException(404, 'Preview not found.')
    return PreviewResponse(
        previewId=preview_id,
        status='pending' if preview.get('status') != 'applied' else 'pending',
        schedule=ScheduleResult(**preview['schedule']),
    )
