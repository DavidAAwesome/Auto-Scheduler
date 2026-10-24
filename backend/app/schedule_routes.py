"""Authenticated schedule preview / apply / interpret / replan endpoints.

Preview never mutates saved sessions. Apply re-validates against current data,
rejects stale fingerprints, and is idempotent for the same preview id.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from app.auth import get_current_user
from app.database import get_database
from app.openai_interpret import InterpretResult, interpret_request
from app.scheduling_engine import ScheduleResult, generate_schedule
from app.scheduling_service import PreviewResponse, build_preview, load_context
from app.scheduling_validator import ValidationError, validate_schedule
from app.workspace import (
    SessionInput,
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


@router.post('/preview', response_model=PreviewResponse)
def create_preview(body: PreviewRequest = PreviewRequest(), user=Depends(get_current_user),
                   db=Depends(get_database)):
    return build_preview(user, db, utc_now(), body.horizonDays)


@router.post('/replan', response_model=PreviewResponse)
def replan(body: PreviewRequest = PreviewRequest(), user=Depends(get_current_user),
           db=Depends(get_database)):
    """Same as preview: regenerate after tasks/availability changed. Does not apply."""
    return build_preview(user, db, utc_now(), body.horizonDays)


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
    tasks, availability, busy, fixed, unlocked, _, _ = load_context(user, db, now, horizon, session)
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
        preview = build_preview(user, db, now)
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
