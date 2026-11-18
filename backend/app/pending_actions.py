"""Pending actions: a change the user must confirm, stored as structured state rather than chat text.

Chat (or the review panel) asks the server to *propose* an action. The proposal is validated, given exact
targets with readable names, and stored with status `awaiting_confirmation` and a `version`. Nothing is
changed until the user presses the action's button (or types "confirm" when exactly one is pending), which
calls `/actions/{id}/confirm` with that id and version:

- the action must belong to the caller (otherwise 404, exactly as if it did not exist);
- the version must match, and for deletions the schedule must not have changed since the proposal (409);
- the status moves `awaiting_confirmation`/`failed` → `processing` in one atomic update, so a double click
  or a second tab cannot run it twice; a repeat confirm of a finished action returns it with
  `duplicate: true` and changes nothing;
- the change and the `succeeded` status are written in one transaction. On error the action becomes
  `failed` with the reason and can be confirmed again (both operations are safe to retry).

Cancel moves an open action to `cancelled` and changes nothing else.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from pymongo import ReturnDocument
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from app.auth import get_current_user
from app.database import get_database
from app.events import EventOutput
from app.plan_drafts import PlanDraft, draft_task, review_all, summary
from app.schedule_version import bump_schedule_version, current_schedule_version
from app.scheduling_service import _create_drafts
from app.workspace import TaskOutput, get_availability

router = APIRouter(prefix='/actions', tags=['actions'])
ActionType = Literal['delete_tasks', 'create_items']
ActionStatus = Literal['awaiting_confirmation', 'processing', 'succeeded', 'cancelled', 'failed']
OPEN = ['awaiting_confirmation', 'failed']


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class ActionTarget(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str
    title: str
    detail: str | None = None


class PendingAction(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str
    type: ActionType
    status: ActionStatus
    version: int
    summary: str
    targets: list[ActionTarget]
    sessionCount: int = 0
    error: str | None = None
    createdAt: datetime


class ActionResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: PendingAction
    duplicate: bool = False
    deletedTaskIds: list[str] = []
    tasks: list[TaskOutput] = []
    events: list[EventOutput] = []
    scheduleVersion: int | None = None


class DeleteTasksRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    taskIds: list[str] = Field(min_length=1, max_length=20)


class CreateItemsRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    drafts: list[PlanDraft] = Field(min_length=1, max_length=40)
    batchId: str = Field(min_length=1, max_length=64)


class ConfirmRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int


def transactional(db, fn):
    """Runs fn(session) in a MongoDB transaction (a replica set is required, as for schedule Apply)."""
    with db.client.start_session() as session:
        return session.with_transaction(fn, read_concern=ReadConcern('snapshot'), write_concern=WriteConcern('majority'))


def action_output(doc) -> PendingAction:
    return PendingAction(id=str(doc['_id']), type=doc['type'], status=doc['status'], version=doc['version'],
                         summary=doc['summary'], targets=doc['targets'], sessionCount=doc.get('session_count', 0),
                         error=doc.get('error'), createdAt=doc['created_at'])


def owned_action(db, user, action_id: str, session=None) -> dict:
    doc = db.pending_actions.find_one({'_id': ObjectId(action_id), 'user_id': str(user['_id'])}, session=session) \
        if ObjectId.is_valid(action_id) else None
    if not doc:
        raise HTTPException(404, 'That action was not found. It may belong to another account or have expired.')
    return doc


def _quote(titles: list[str]) -> str:
    quoted = [f'“{t}”' for t in titles]
    return quoted[0] if len(quoted) == 1 else ', '.join(quoted[:-1]) + f' and {quoted[-1]}'


def propose_delete(db, user, task_ids: list[str], now: datetime) -> PendingAction:
    owner = str(user['_id'])
    if len(set(task_ids)) != len(task_ids):
        raise HTTPException(422, 'Each task can be listed once.')
    docs = list(db.tasks.find({'_id': {'$in': [ObjectId(t) for t in task_ids if ObjectId.is_valid(t)]}, 'user_id': owner}))
    if len(docs) != len(task_ids):
        raise HTTPException(404, 'One of these tasks was not found. Refresh and choose again.')
    order = {t: i for i, t in enumerate(task_ids)}
    docs.sort(key=lambda d: order[str(d['_id'])])
    counts = {str(d['_id']): db.sessions.count_documents({'user_id': owner, 'task_id': str(d['_id'])}) for d in docs}
    sessions = sum(counts.values())
    titles = [d['title'] for d in docs]
    text = (f'Delete {_quote(titles)}? This also removes {sessions} scheduled session{"s" if sessions != 1 else ""} '
            f'for {"it" if len(docs) == 1 else "them"}. Completed work on {"it" if len(docs) == 1 else "them"} is lost too.')
    doc = {'user_id': owner, 'type': 'delete_tasks', 'status': 'awaiting_confirmation',
           # Any change to tasks or sessions bumps the schedule version, which makes this proposal stale.
           'version': current_schedule_version(db, owner), 'summary': text,
           'targets': [{'id': str(d['_id']), 'title': d['title'],
                        'detail': f'{counts[str(d["_id"])]} session{"s" if counts[str(d["_id"])] != 1 else ""}'} for d in docs],
           'session_count': sessions, 'payload': {'taskIds': task_ids}, 'created_at': now, 'updated_at': now}
    doc['_id'] = db.pending_actions.insert_one(doc).inserted_id
    return action_output(doc)


def propose_create(db, user, drafts: list[PlanDraft], batch_id: str, now: datetime) -> PendingAction:
    from zoneinfo import ZoneInfo
    owner = str(user['_id'])
    saved = {str(d['_id']) for d in db.tasks.find({'user_id': owner, 'done': False}, {'_id': 1})}
    try:
        views = review_all(drafts, now, ZoneInfo(get_availability(user=user, db=db).timeZone), saved)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    selected = [v for v in views if v.draft.include]
    if not selected:
        raise HTTPException(422, 'Select at least one item to save.')
    blocked = [v for v in selected if not v.ready]
    if blocked:
        issue = next(i for i in blocked[0].issues if i.blocking)
        raise HTTPException(422, f'“{blocked[0].draft.title or "An item"}” still needs an answer: {issue.question}')
    chosen = [v.draft for v in selected]
    text = f'Save {len(chosen)} item{"s" if len(chosen) != 1 else ""} without scheduling them yet?'
    doc = {'user_id': owner, 'type': 'create_items', 'status': 'awaiting_confirmation', 'version': 1, 'summary': text,
           'targets': [{'id': d.id, 'title': d.title or 'Untitled', 'detail': summary(d)} for d in chosen],
           'session_count': 0, 'payload': {'drafts': [d.model_dump() for d in chosen], 'batchId': batch_id},
           'created_at': now, 'updated_at': now}
    doc['_id'] = db.pending_actions.insert_one(doc).inserted_id
    return action_output(doc)


def _execute(db, user, doc: dict, now: datetime, txn) -> dict:
    owner = str(user['_id'])
    result: dict = {}
    if doc['type'] == 'delete_tasks':
        if current_schedule_version(db, owner, session=txn) != doc['version']:
            raise HTTPException(409, 'Your tasks or schedule changed after this was proposed, so nothing was deleted. '
                                'Ask again to see the current list.')
        ids = doc['payload']['taskIds']
        deleted = db.tasks.delete_many({'_id': {'$in': [ObjectId(t) for t in ids]}, 'user_id': owner}, session=txn)
        if deleted.deleted_count != len(ids):
            raise HTTPException(409, 'A task in this list no longer exists, so nothing was deleted. Ask again.')
        db.sessions.delete_many({'user_id': owner, 'task_id': {'$in': ids}}, session=txn)
        result = {'deletedTaskIds': ids, 'scheduleVersion': bump_schedule_version(db, owner, session=txn)}
    else:
        drafts = [PlanDraft(**d) for d in doc['payload']['drafts']]
        ids = {d.id for d in drafts}
        tasks = [draft_task(d, ids) for d in drafts if d.kind != 'fixed_event']
        _ids, created_tasks, created_events = _create_drafts(db, owner, drafts, doc['payload']['batchId'], tasks, txn)
        result = {'tasks': created_tasks, 'events': created_events,
                  'scheduleVersion': bump_schedule_version(db, owner, session=txn)}
    marked = db.pending_actions.update_one({'_id': doc['_id'], 'status': 'processing'},
                                           {'$set': {'status': 'succeeded', 'updated_at': now, 'error': None}}, session=txn)
    if marked.modified_count != 1:
        raise HTTPException(409, 'This action changed while it was running. Nothing was saved.')
    return result


def confirm_action(db, user, action_id: str, version: int, now: datetime) -> ActionResult:
    doc = owned_action(db, user, action_id)
    if doc['status'] == 'succeeded':
        return ActionResult(action=action_output(doc), duplicate=True)
    if doc['status'] == 'cancelled':
        raise HTTPException(409, 'This action was cancelled, so nothing was changed. Ask again if you still want it.')
    if doc['version'] != version:
        raise HTTPException(409, 'This confirmation is out of date. Nothing was changed; ask again.')
    claimed = db.pending_actions.find_one_and_update(
        {'_id': doc['_id'], 'user_id': str(user['_id']), 'status': {'$in': OPEN}, 'version': version},
        {'$set': {'status': 'processing', 'updated_at': now}}, return_document=ReturnDocument.AFTER)
    if not claimed:
        current = owned_action(db, user, action_id)
        if current['status'] == 'succeeded':
            return ActionResult(action=action_output(current), duplicate=True)
        raise HTTPException(409, 'This action is already being processed. Wait a moment, then check the result.')
    try:
        result = transactional(db, lambda txn: _execute(db, user, claimed, now, txn))
    except Exception as exc:
        message = exc.detail if isinstance(exc, HTTPException) else 'The database could not complete it. Nothing was changed.'
        db.pending_actions.update_one({'_id': claimed['_id'], 'status': 'processing'},
                                      {'$set': {'status': 'failed', 'error': message, 'updated_at': now}})
        raise
    return ActionResult(action=action_output(owned_action(db, user, action_id)), **result)


def cancel_action(db, user, action_id: str, now: datetime) -> PendingAction:
    doc = owned_action(db, user, action_id)
    if doc['status'] in ('succeeded', 'processing'):
        raise HTTPException(409, 'This action has already run or is running, so it cannot be cancelled.')
    db.pending_actions.update_one({'_id': doc['_id'], 'status': {'$in': OPEN}},
                                  {'$set': {'status': 'cancelled', 'updated_at': now}})
    return action_output(owned_action(db, user, action_id))


@router.get('', response_model=list[PendingAction])
def list_open(user=Depends(get_current_user), db=Depends(get_database)):
    """Open actions, so a refresh still shows what is waiting for confirmation."""
    docs = db.pending_actions.find({'user_id': str(user['_id']), 'status': {'$in': OPEN}}).sort('created_at', 1)
    return [action_output(d) for d in docs]


@router.post('/delete-tasks', response_model=PendingAction, status_code=201)
def delete_tasks(body: DeleteTasksRequest, user=Depends(get_current_user), db=Depends(get_database)):
    return propose_delete(db, user, body.taskIds, utc_now())


@router.post('/create-items', response_model=PendingAction, status_code=201)
def create_items(body: CreateItemsRequest, user=Depends(get_current_user), db=Depends(get_database)):
    return propose_create(db, user, body.drafts, body.batchId, utc_now())


@router.post('/{action_id}/confirm', response_model=ActionResult)
def confirm(action_id: str, body: ConfirmRequest, user=Depends(get_current_user), db=Depends(get_database)):
    return confirm_action(db, user, action_id, body.version, utc_now())


@router.post('/{action_id}/cancel', response_model=PendingAction)
def cancel(action_id: str, user=Depends(get_current_user), db=Depends(get_database)):
    return cancel_action(db, user, action_id, utc_now())
