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
    check_session,
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


def _event_busy(db, user_id: str, start_date: str, end_date: str) -> list[BusyBlock]:
    """Expand events (including repeats) into busy blocks in the planning window."""
    blocks: list[BusyBlock] = []
    day = date_cls.fromisoformat(start_date)
    last = date_cls.fromisoformat(end_date)
    events = list(db.events.find({'user_id': user_id}))
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


def _load_context(user, db, now: datetime, horizon_days: int = 7):
    tasks = list_tasks(user=user, db=db)
    availability = get_availability(user=user, db=db)
    from zoneinfo import ZoneInfo
    zone = ZoneInfo(availability.timeZone)
    local = now.astimezone(zone).date()
    start_date = local.isoformat()
    end_date = (local.fromordinal(local.toordinal() + horizon_days - 1)).isoformat()

    sessions = list(db.sessions.find({'user_id': str(user['_id'])}))
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

    busy = _event_busy(db, str(user['_id']), start_date, end_date)
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
    preview = db.schedule_previews.find_one({'_id': ObjectId(body.previewId), 'user_id': str(user['_id'])})
    if not preview:
        raise HTTPException(404, 'Preview not found.')

    if preview.get('status') == 'applied':
        # Idempotent: return already-created sessions for this preview.
        existing = list(db.sessions.find({
            'user_id': str(user['_id']),
            'preview_id': body.previewId,
        }))
        return ApplyResponse(
            previewId=body.previewId,
            status='applied',
            sessions=[session_output(doc).model_dump() for doc in existing],
        )

    now = utc_now()
    horizon = int(preview.get('horizon_days') or 7)
    tasks, availability, busy, fixed, unlocked, _, _ = _load_context(user, db, now, horizon)
    schedule = ScheduleResult(**preview['schedule'])

    # Reject stale previews: fingerprint must match current world.
    fresh = generate_schedule(tasks, availability, busy, fixed, unlocked, now, horizon)
    if fresh.inputFingerprint != preview['input_fingerprint']:
        raise HTTPException(
            409,
            'This preview is stale. Tasks, availability, events, or sessions changed. Generate a new preview.',
        )

    try:
        validate_schedule(schedule, tasks, availability, busy, fixed, now)
    except ValidationError as exc:
        raise HTTPException(status_code=409, detail=f'Preview no longer valid: {exc.message}') from exc

    user_id = str(user['_id'])
    # Replace unlocked auto sessions with proposed ones. Keep manual/locked.
    # Use ordered writes; full multi-doc transactions are not assumed for mongomock.
    db.sessions.delete_many({'user_id': user_id, 'source': 'auto', 'locked': {'$ne': True}})

    created = []
    try:
        for proposed in schedule.sessions:
            if proposed.kept:
                # Re-create kept sessions as auto (previous unlocked autos were deleted).
                pass
            data = SessionInput(
                taskId=proposed.taskId,
                date=proposed.date,
                start=proposed.start,
                end=proposed.end,
                source='auto',
                locked=False,
            )
            # Ownership + overlap checks against remaining fixed sessions and events.
            check_session(data, user, db)
            doc = session_doc(data, user)
            doc['preview_id'] = body.previewId
            doc['_id'] = db.sessions.insert_one(doc).inserted_id
            created.append(doc)
    except HTTPException:
        # Best-effort rollback of sessions created in this apply.
        if created:
            db.sessions.delete_many({'_id': {'$in': [c['_id'] for c in created]}})
        raise

    db.schedule_previews.update_one(
        {'_id': ObjectId(body.previewId), 'user_id': user_id, 'status': 'pending'},
        {'$set': {'status': 'applied', 'applied_at': now}},
    )
    return ApplyResponse(
        previewId=body.previewId,
        status='applied',
        sessions=[session_output(doc).model_dump() for doc in created],
    )


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
