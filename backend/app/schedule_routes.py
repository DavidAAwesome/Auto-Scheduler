"""Authenticated schedule routes. Every caller (calendar buttons, chat, interpret) uses scheduling_service.

Previews never change saved sessions. Apply re-validates against current data, rejects stale
versions, persists atomically, and is idempotent for the same preview id.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from app.auth import get_current_user
from app.database import get_database
from app.openai_interpret import InterpretResult, interpret_request
from app.schedule_model import SavedSchedule, SchedulePreferences, SchedulePreview
from app.scheduling_service import (
    MAX_HORIZON_DAYS, apply_preview, build_preview, get_preferences, owned_preview, save_preferences, saved_schedule,
    stored_preview,
)
from app.events import EventOutput
from app.workspace import TaskOutput, get_availability, list_tasks

router = APIRouter(prefix='/schedule', tags=['schedule'])


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    horizonDays: int = Field(default=7, ge=1, le=MAX_HORIZON_DAYS)


class Move(BaseModel):
    model_config = ConfigDict(extra='forbid')
    taskId: str = Field(min_length=1, max_length=64)
    notBefore: AwareDatetime


class RepairRequest(PreviewRequest):
    moves: list[Move] = Field(default_factory=list, max_length=20)


class BreakRequest(PreviewRequest):
    minutes: int = Field(strict=True, ge=5, le=240)


class ApplyRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    previewId: str = Field(min_length=1, max_length=64)


class ApplyResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    previewId: str
    status: Literal['applied']
    duplicate: bool
    schedule: SavedSchedule
    tasks: list[TaskOutput] = []  # tasks created from drafts by this Apply
    events: list[EventOutput] = []  # events created from drafts by this Apply


class InterpretRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    message: str = Field(min_length=1, max_length=2000)
    history: list[dict] = Field(default_factory=list, max_length=12)
    autoPreview: bool = True


class InterpretResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    interpretation: InterpretResult
    preview: SchedulePreview | None = None


@router.get('', response_model=SavedSchedule)
def get_schedule(user=Depends(get_current_user), db=Depends(get_database)):
    """The authoritative saved schedule: work sessions and breaks with UTC timestamps."""
    return saved_schedule(user, db)


@router.get('/preferences', response_model=SchedulePreferences)
def read_preferences(user=Depends(get_current_user), db=Depends(get_database)):
    return get_preferences(db, user)


@router.put('/preferences', response_model=SchedulePreferences)
def write_preferences(body: SchedulePreferences, user=Depends(get_current_user), db=Depends(get_database)):
    return save_preferences(db, user, body)


@router.post('/preview', response_model=SchedulePreview)
def create_preview(body: PreviewRequest = PreviewRequest(), user=Depends(get_current_user), db=Depends(get_database)):
    """Fresh plan: replaces every unlocked automatic future session in the preview."""
    return build_preview(user, db, utc_now(), body.horizonDays, 'generate')


@router.post('/replan', response_model=SchedulePreview)
@router.post('/repair', response_model=SchedulePreview)
def repair(body: RepairRequest = RepairRequest(), user=Depends(get_current_user), db=Depends(get_database)):
    """Local repair: keeps unaffected saved sessions and moves only what no longer fits."""
    moves = {move.taskId: move.notBefore for move in body.moves}
    return build_preview(user, db, utc_now(), body.horizonDays, 'repair', moves=moves)


@router.post('/break', response_model=SchedulePreview)
def request_break(body: BreakRequest, user=Depends(get_current_user), db=Depends(get_database)):
    """Preview a protected break starting now and repair the flexible work it displaces."""
    return build_preview(user, db, utc_now(), body.horizonDays, 'break', break_minutes=body.minutes)


@router.post('/apply', response_model=ApplyResponse)
def apply(body: ApplyRequest, user=Depends(get_current_user), db=Depends(get_database)):
    return apply_preview(user, db, body.previewId, utc_now)


@router.get('/preview/{preview_id}', response_model=SchedulePreview)
def get_preview(preview_id: str, user=Depends(get_current_user), db=Depends(get_database)):
    return stored_preview(owned_preview(db, user, preview_id))


@router.post('/interpret', response_model=InterpretResponse)
def interpret(body: InterpretRequest, user=Depends(get_current_user), db=Depends(get_database)):
    """Natural language to structured preferences (OpenAI). Optionally builds a preview. Never writes tasks."""
    now = utc_now()
    tasks = list_tasks(user=user, db=db)
    availability = get_availability(user=user, db=db)
    summaries = [{
        'id': t.id, 'title': t.title, 'deadline': t.deadline, 'dueTime': t.dueTime, 'minutes': t.minutes,
        'completedMinutes': t.completedMinutes, 'remainingMinutes': t.remainingMinutes, 'priority': t.priority,
        'allowSplit': t.allowSplit, 'dependsOn': t.dependsOn,
    } for t in tasks if not t.done]
    interpretation = interpret_request(body.message, time_zone=availability.timeZone, now=now,
                                       task_summaries=summaries, history=body.history)
    preview = None
    if body.autoPreview and interpretation.runScheduler and not interpretation.needsConfirmation:
        # Preference patches are suggestions; the preview always uses the saved tasks.
        preview = build_preview(user, db, now, 7, 'repair' if interpretation.intent == 'replan' else 'generate')
    return InterpretResponse(interpretation=interpretation, preview=preview)
