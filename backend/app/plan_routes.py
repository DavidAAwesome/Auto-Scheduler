"""Plan entry: text or an image → editable drafts → “Can this fit?” → calendar preview → Apply.

Interpretation (/plan/interpret, /plan/clarify) only produces drafts. Review (/plan/review) applies
business rules. /plan/feasibility and /plan/preview run the shared scheduling service; neither changes
saved tasks, events or sessions (a preview stores only its own proposal record). Saving happens in
POST /schedule/apply, which creates the drafts' tasks and events and their sessions in one transaction.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.auth import get_current_user
from app.config import get_settings
from app.database import get_database
from app.feasibility import FeasibilityResult, check_feasibility
from app.plan_drafts import DraftView, PlanDraft, review_all, review_draft
from app.plan_extraction import ImageInput, apply_answer, decode_image, extract_with_model, new_batch_id, parse_text
from app.schedule_model import SchedulePreview
from app.scheduling_service import MAX_HORIZON_DAYS, build_preview
from app.workspace import get_availability

router = APIRouter(prefix='/plan', tags=['plan'])


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class InterpretRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    text: str = Field(default='', max_length=8000)
    image: ImageInput | None = None
    batchId: str = Field(default='batch', max_length=64)


class InterpretResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    batchId: str
    provider: Literal['openai', 'local']
    drafts: list[DraftView]
    notes: list[str]
    now: datetime
    timeZone: str


class DraftsRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    drafts: list[PlanDraft] = Field(max_length=40)
    horizonDays: int = Field(default=7, ge=1, le=MAX_HORIZON_DAYS)
    batchId: str = Field(default='batch', max_length=64)


class ClarifyRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    draft: PlanDraft
    field: str = Field(max_length=40)
    answer: str = Field(min_length=1, max_length=200)
    otherDraftIds: list[str] = Field(default_factory=list, max_length=40)


def _zone(user, db) -> ZoneInfo:
    return ZoneInfo(get_availability(user=user, db=db).timeZone)


def _task_ids(user, db) -> dict[str, str]:
    return {str(doc['_id']): doc['title'] for doc in db.tasks.find({'user_id': str(user['_id']), 'done': False},
                                                                   {'title': 1})}


def _ready(body: DraftsRequest, user, db, now) -> list[PlanDraft]:
    """Drafts with blocking questions never reach the scheduler."""
    try:
        views = review_all(body.drafts, now, _zone(user, db), set(_task_ids(user, db)))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    blocked = [v for v in views if v.draft.include and not v.ready]
    if blocked:
        first = next(i for i in blocked[0].issues if i.blocking)
        raise HTTPException(422, f'Answer the open questions first: {first.question}')
    if not any(d.include for d in body.drafts):
        raise HTTPException(422, 'Select at least one item.')
    return body.drafts


@router.post('/interpret', response_model=InterpretResponse)
def interpret(body: InterpretRequest, user=Depends(get_current_user), db=Depends(get_database)):
    """Text and/or an image → drafts for review. Saves nothing. On provider failure the client keeps the input."""
    now = utc_now()
    zone = _zone(user, db)
    if not body.text.strip() and body.image is None:
        raise HTTPException(422, 'Type your tasks and events, or attach an image.')
    image = (body.image.mediaType.lower(), decode_image(body.image)) if body.image else None
    titles = _task_ids(user, db)
    notes: list[str] = []
    if get_settings().openai_api_key:
        drafts, notes = extract_with_model(body.text, image, now, zone, list(titles.values()))
        provider = 'openai'
    elif image:
        # Developer setup (OPENAI_API_KEY) stays out of the product message.
        raise HTTPException(503, 'Reading images isn’t available right now. Your image was kept; you can type the items instead.')
    else:
        drafts = parse_text(body.text, now, zone, {title: tid for tid, title in titles.items()})
        provider = 'local'
        notes.append('Read with AutoPlan’s built-in parser (no AI key set). Check each item.')
    if not drafts:
        notes.append('No tasks or events were found. Try one item per line, such as “Essay, 2 hours, due Friday”.')
    views = review_all(drafts, now, zone, set(titles))
    return InterpretResponse(batchId=new_batch_id(body.batchId), provider=provider, drafts=views, notes=notes,
                             now=now, timeZone=str(zone))


@router.post('/review', response_model=list[DraftView])
def review(body: DraftsRequest, user=Depends(get_current_user), db=Depends(get_database)):
    try:
        return review_all(body.drafts, utc_now(), _zone(user, db), set(_task_ids(user, db)))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post('/clarify', response_model=DraftView)
def clarify(body: ClarifyRequest, user=Depends(get_current_user), db=Depends(get_database)):
    """A focused answer updates the same draft; the result is reviewed again."""
    now, zone = utc_now(), _zone(user, db)
    try:
        updated = apply_answer(body.draft, body.field, body.answer, now, zone)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    known = set(body.otherDraftIds) | {updated.id} | set(_task_ids(user, db))
    return review_draft(updated, now, zone, known)


@router.post('/feasibility', response_model=FeasibilityResult)
def feasibility(body: DraftsRequest, user=Depends(get_current_user), db=Depends(get_database)):
    """“Can this fit?” Reads only; nothing is saved, not even a proposal."""
    now = utc_now()
    return check_feasibility(user, db, now, _ready(body, user, db, now), body.horizonDays)


@router.post('/preview', response_model=SchedulePreview)
def preview(body: DraftsRequest, user=Depends(get_current_user), db=Depends(get_database)):
    """The complete calendar preview with the drafts added. Apply it with POST /schedule/apply."""
    now = utc_now()
    drafts = _ready(body, user, db, now)
    return build_preview(user, db, now, body.horizonDays, 'plan', drafts=drafts, batch_id=new_batch_id(body.batchId))
