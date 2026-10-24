"""The one scheduling path used by the calendar buttons, Today's Tasks and chat.

- `saved_schedule` reads the authoritative saved schedule (canonical sessions, UTC timestamps).
- `build_preview` runs the engine in generate, repair or break mode, validates the result
  independently and stores it as a proposal. It never changes saved sessions.
- `apply_preview` re-validates against current data inside a transaction, rejects stale or changed
  previews, and persists atomically. Repeated Apply of the same preview is idempotent.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date as date_cls, datetime, timedelta
from zoneinfo import ZoneInfo

from bson import ObjectId
from fastapi import HTTPException
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from app.events import occurs_on
from app.schedule_model import (
    AllocationReason, ConflictItem, DaySummary, SavedSchedule, ScheduleConflict, SchedulePreferences,
    SchedulePreview, ScheduleSession, SessionRemoval, TaskAllocation,
)
from app.schedule_version import bump_schedule_version, current_schedule_version
from app.scheduling_engine import (
    HEURISTIC_NOTE, Busy, EngineTask, Existing, Prefs, fingerprint, from_abs, local_parts, local_span,
    local_to_abs, plan_schedule, to_abs,
)
from app.scheduling_validator import EventRef, SavedRef, ValidationError, validate_preview
from app.workspace import (
    Availability, TaskOutput, default_availability, list_session_docs, session_instants, session_output, task_output,
)

MAX_HORIZON_DAYS = 21


# ---------------------------------------------------------------- preferences

def get_preferences(db, user, session=None) -> SchedulePreferences:
    doc = db.schedule_preferences.find_one({'user_id': str(user['_id'])}, {'_id': 0, 'user_id': 0}, session=session)
    return SchedulePreferences(**doc) if doc else SchedulePreferences()


def save_preferences(db, user, prefs: SchedulePreferences) -> SchedulePreferences:
    db.schedule_preferences.update_one({'user_id': str(user['_id'])}, {'$set': prefs.model_dump()}, upsert=True)
    bump_schedule_version(db, str(user['_id']))
    return prefs


# ---------------------------------------------------------------- context

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
                    'id': str(doc['_id']), 'date': day_s, 'start': doc['start'], 'end': doc['end'],
                    'title': doc.get('title', 'event'), 'kind': doc.get('kind', 'Other'),
                    'source': doc.get('source', 'manual'),
                })
        day += timedelta(days=1)
    return occurrences


@dataclass
class Context:
    user_id: str
    tasks: list[TaskOutput]
    availability: Availability
    prefs: SchedulePreferences
    zone: ZoneInfo
    events: list[Busy]
    docs: list[dict]
    existing: list[Existing]
    titles: dict[str, str]
    version: int
    start_date: str
    end_date: str


def task_due(task: TaskOutput, zone: ZoneInfo) -> int:
    end = 1440 if task.dueTime >= 1439 else task.dueTime  # 11:59 PM means work may run until midnight
    return local_to_abs(date_cls.fromisoformat(task.deadline), end, zone)


def _earliest(task: TaskOutput, zone: ZoneInfo) -> int | None:
    if not task.earliestStart:
        return None
    try:
        moment = datetime.fromisoformat(task.earliestStart.replace('Z', '+00:00'))
    except ValueError:
        return None
    return to_abs(moment if moment.tzinfo else moment.replace(tzinfo=zone))


def load_context(user, db, now: datetime, horizon_days: int = 7, session=None) -> Context:
    owner = str(user['_id'])
    tasks = [task_output(doc) for doc in db.tasks.find({'user_id': owner}, session=session)]
    saved = db.availability.find_one({'user_id': owner}, {'_id': 0, 'user_id': 0}, session=session)
    availability = Availability(**saved) if saved else default_availability()
    prefs = get_preferences(db, user, session=session)
    zone = ZoneInfo(availability.timeZone)
    today, _ = local_parts(to_abs(now), zone)
    start_date = today.isoformat()
    end_date = (today + timedelta(days=horizon_days - 1)).isoformat()
    events = []
    for item in expand_events(db, owner, (today - timedelta(days=1)).isoformat(),
                              (today + timedelta(days=horizon_days)).isoformat(), session=session):
        day = date_cls.fromisoformat(item['date'])
        events.append(Busy(f"{item['id']}:{item['date']}", item['title'],
                           local_to_abs(day, item['start'], zone), local_to_abs(day, item['end'], zone)))
    titles = {t.id: t.title for t in tasks}
    docs = list_session_docs(db, user, session=session)
    existing = []
    for doc in docs:
        start_at, end_at = session_instants(doc, zone)
        kind = doc.get('type', 'work')
        existing.append(Existing(str(doc['_id']), doc.get('task_id') if kind == 'work' else None, kind,
                                 doc.get('status', 'saved'), bool(doc.get('locked', False)), doc.get('source', 'manual'),
                                 to_abs(start_at), to_abs(end_at),
                                 'Break' if kind == 'break' else titles.get(doc.get('task_id'), 'Task')))
    return Context(owner, tasks, availability, prefs, zone, sorted(events, key=lambda b: (b.start, b.id)), docs,
                   sorted(existing, key=lambda x: (x.start, x.id)), titles,
                   current_schedule_version(db, owner, session=session), start_date, end_date)


def context_fingerprint(ctx: Context, request: dict) -> str:
    return fingerprint({
        'tasks': [t.model_dump() for t in sorted(ctx.tasks, key=lambda t: t.id)],
        'availability': ctx.availability.model_dump(),
        'prefs': ctx.prefs.model_dump(),
        'events': [(b.id, b.start, b.end, b.title) for b in ctx.events],
        'sessions': [(x.id, x.task_id, x.type, x.status, x.locked, x.source, x.start, x.end) for x in ctx.existing],
        'window': [ctx.start_date, ctx.end_date],
        'request': request,
    })


def engine_tasks(ctx: Context) -> list[EngineTask]:
    return [EngineTask(t.id, t.title, t.priority, task_due(t, ctx.zone), t.minutes, t.completedMinutes, t.allowSplit,
                       t.minSessionMinutes, t.maxSessionMinutes, _earliest(t, ctx.zone), tuple(t.dependsOn), t.done)
            for t in ctx.tasks]


def engine_prefs(prefs: SchedulePreferences) -> Prefs:
    lunch = (prefs.lunch.start, prefs.lunch.end) if prefs.lunch else None
    return Prefs(prefs.focusMinutes, prefs.breakMinutes, prefs.maxDailyWorkMinutes, lunch)


def saved_refs(ctx: Context) -> list[SavedRef]:
    return [SavedRef(x.id, x.task_id, x.type, x.status, x.locked, x.source, x.start, x.end) for x in ctx.existing]


def event_refs(ctx: Context) -> list[EventRef]:
    return [EventRef(b.title, b.start, b.end) for b in ctx.events]


# ---------------------------------------------------------------- preview

def _session_model(placed, zone, version, index: int) -> ScheduleSession:
    day, start, end = local_span(placed.start, placed.end, zone)
    return ScheduleSession(
        id=placed.id or f'proposed-{index}', taskId=placed.task_id, title=placed.title or 'Break', type=placed.type,
        status=placed.status, locked=placed.locked, source=placed.source, scheduleVersion=version,
        startAt=from_abs(placed.start), endAt=from_abs(placed.end), date=day, start=start, end=end,
        change=placed.change, reason=placed.reason)


def _existing_model(item: Existing, zone, version) -> ScheduleSession:
    day, start, end = local_span(item.start, item.end, zone)
    return ScheduleSession(id=item.id, taskId=item.task_id, title=item.title, type=item.type, status=item.status,
                           locked=item.locked, source=item.source, scheduleVersion=version,
                           startAt=from_abs(item.start), endAt=from_abs(item.end), date=day, start=start, end=end)


def run_engine(ctx: Context, now: datetime, horizon_days: int, mode: str, request: dict) -> SchedulePreview:
    now_min = to_abs(now)
    requested_break = None
    if request.get('breakMinutes'):
        requested_break = (now_min, now_min + int(request['breakMinutes']))
    result = plan_schedule(engine_tasks(ctx), ctx.availability, engine_prefs(ctx.prefs), ctx.events, ctx.existing,
                           now_min, horizon_days, 'repair' if mode in {'repair', 'break'} else 'generate',
                           requested_break, request.get('notBefore') or None)
    sessions = [_session_model(p, ctx.zone, ctx.version, i) for i, p in enumerate(result.sessions, 1)]
    removed = [SessionRemoval(session=_existing_model(r.session, ctx.zone, ctx.version), reason=r.reason,
                              newEndAt=from_abs(r.new_end) if r.new_end is not None else None)
               for r in result.removals]
    tasks = [TaskAllocation(
        taskId=a.task_id, title=a.title, priority=a.priority, dueAt=from_abs(a.due), estimatedMinutes=a.estimated,
        completedMinutes=a.completed, remainingMinutes=a.remaining, retainedMinutes=a.retained,
        inProgressMinutes=a.in_progress, newMinutes=a.new, unallocatedMinutes=a.unallocated,
        overAllocatedMinutes=a.over_allocated, atRisk=a.at_risk, slackMinutes=a.slack, status=a.status,
        reasons=[AllocationReason(code=r.code, message=r.message) for r in a.reasons]) for a in result.allocations]
    conflicts = [ScheduleConflict(code=c.code, message=c.message, items=[ConflictItem(
        kind=i['kind'], id=i.get('id'), title=i['title'],
        startAt=from_abs(i['start']) if i.get('start') is not None else None,
        endAt=from_abs(i['end']) if i.get('end') is not None else None) for i in c.items]) for c in result.conflicts]
    days: dict[str, DaySummary] = {}
    for s in sessions:
        summary = days.setdefault(s.date, DaySummary(date=s.date, workMinutes=0, newWorkMinutes=0, breakCount=0, sessionCount=0))
        minutes = int((s.endAt - s.startAt).total_seconds() // 60)
        summary.sessionCount += 1
        if s.type == 'work':
            summary.workMinutes += minutes
            if s.change == 'new':
                summary.newWorkMinutes += minutes
        else:
            summary.breakCount += 1
    first_new = next((s.date for s in sessions if s.change == 'new'), None)
    return SchedulePreview(
        previewId='', status='proposed', mode=mode, baseScheduleVersion=ctx.version, generatedAt=now,
        timeZone=ctx.availability.timeZone, windowStart=from_abs(result.window_start), windowEnd=from_abs(result.window_end),
        startDate=ctx.start_date, endDate=ctx.end_date, preferences=ctx.prefs, sessions=sessions, removed=removed,
        tasks=tasks, conflicts=conflicts, days=sorted(days.values(), key=lambda d: d.date), firstProposedDate=first_new,
        explanations=result.explanations, note=HEURISTIC_NOTE, inputFingerprint=context_fingerprint(ctx, request))


def build_preview(user, db, now: datetime, horizon_days: int = 7, mode: str = 'generate', *,
                  break_minutes: int | None = None, moves: dict[str, datetime] | None = None) -> SchedulePreview:
    if not 1 <= horizon_days <= MAX_HORIZON_DAYS:
        raise HTTPException(422, f'Plan between 1 and {MAX_HORIZON_DAYS} days.')
    ctx = load_context(user, db, now, horizon_days)
    request: dict = {}
    if break_minutes:
        request['breakMinutes'] = break_minutes
    if moves:
        open_ids = {t.id for t in ctx.tasks if not t.done}
        for task_id in moves:
            if task_id not in open_ids:
                raise HTTPException(404, 'Task not found.')
        request['notBefore'] = {task_id: to_abs(moment) for task_id, moment in sorted(moves.items())}
    preview = run_engine(ctx, now, horizon_days, mode, request)
    try:
        validate_preview(preview, tasks=ctx.tasks, availability=ctx.availability, prefs=ctx.prefs,
                         events=event_refs(ctx), saved=saved_refs(ctx), now=now)
    except ValidationError as exc:
        # The engine produced something the independent validator rejects: never show it as valid.
        raise HTTPException(500, f'The scheduler produced an invalid schedule ({exc.code}): {exc.message}') from exc
    preview_id = ObjectId()
    preview.previewId = str(preview_id)
    db.schedule_previews.insert_one({
        '_id': preview_id, 'user_id': ctx.user_id, 'status': 'proposed', 'created_at': now, 'mode': mode,
        'horizon_days': horizon_days, 'request': request, 'base_version': ctx.version,
        'input_fingerprint': preview.inputFingerprint, 'preview': preview.model_dump(mode='json'),
    })
    return preview


def owned_preview(db, user, preview_id: str, session=None) -> dict:
    if not ObjectId.is_valid(preview_id):
        raise HTTPException(404, 'Preview not found.')
    doc = db.schedule_previews.find_one({'_id': ObjectId(preview_id), 'user_id': str(user['_id'])}, session=session)
    if not doc:
        raise HTTPException(404, 'Preview not found.')
    return doc


def stored_preview(doc: dict) -> SchedulePreview:
    preview = SchedulePreview(**doc['preview'])
    preview.status = 'applied' if doc.get('status') == 'applied' else 'proposed'
    return preview


# ---------------------------------------------------------------- saved schedule / apply

def saved_schedule(user, db, session=None) -> SavedSchedule:
    owner = str(user['_id'])
    saved = db.availability.find_one({'user_id': owner}, {'timeZone': 1}, session=session) or {}
    zone_name = saved.get('timeZone') or 'Etc/GMT'
    zone = ZoneInfo(zone_name)
    titles = {str(doc['_id']): doc['title'] for doc in db.tasks.find({'user_id': owner}, {'title': 1}, session=session)}
    sessions = sorted((session_output(doc, zone, titles) for doc in list_session_docs(db, user, session=session)),
                      key=lambda s: (s.startAt, s.endAt, s.id))
    return SavedSchedule(scheduleVersion=current_schedule_version(db, owner, session=session), timeZone=zone_name,
                         sessions=sessions)


def apply_preview(user, db, preview_id: str, now_fn):
    # Ownership errors are reported even on servers that cannot run transactions.
    owned_preview(db, user, preview_id)
    with db.client.start_session() as session:
        return session.with_transaction(
            lambda txn: _apply(user, db, preview_id, now_fn(), txn),
            read_concern=ReadConcern('snapshot'), write_concern=WriteConcern('majority'))


def _apply(user, db, preview_id: str, now: datetime, txn):
    doc = owned_preview(db, user, preview_id, session=txn)
    if doc.get('status') == 'applied':
        return {'previewId': preview_id, 'status': 'applied', 'duplicate': True,
                'schedule': saved_schedule(user, db, session=txn)}
    owner = str(user['_id'])
    preview = SchedulePreview(**doc['preview'])
    if current_schedule_version(db, owner, session=txn) != doc['base_version']:
        raise HTTPException(409, 'This preview is stale: your schedule changed after it was made. Generate a new preview.')
    ctx = load_context(user, db, now, int(doc['horizon_days']), session=txn)
    if context_fingerprint(ctx, doc.get('request') or {}) != doc['input_fingerprint']:
        raise HTTPException(409, 'This preview is stale: tasks, events, availability or sessions changed. Generate a new preview.')
    try:
        validate_preview(preview, tasks=ctx.tasks, availability=ctx.availability, prefs=ctx.prefs,
                         events=event_refs(ctx), saved=saved_refs(ctx), now=now)
    except ValidationError as exc:
        raise HTTPException(409, f'This preview is no longer valid ({exc.message}) Generate a new preview.') from exc

    version = bump_schedule_version(db, owner, session=txn)
    for removal in preview.removed:
        query = {'_id': ObjectId(removal.session.id), 'user_id': owner, 'status': {'$nin': ['completed', 'cancelled']}}
        if removal.newEndAt is not None:
            _day, _start, end = local_span(to_abs(removal.session.startAt), to_abs(removal.newEndAt), ctx.zone)
            changed = db.sessions.update_one(query, {'$set': {'end_at': removal.newEndAt, 'end': end,
                                                              'schedule_version': version}}, session=txn).matched_count
        else:
            changed = db.sessions.delete_one(query, session=txn).deleted_count
        if changed != 1:
            raise HTTPException(409, 'A session this preview replaces has changed. Generate a new preview.')
    created = []
    for proposed in preview.sessions:
        if proposed.change != 'new':
            continue
        created.append({
            '_id': ObjectId(), 'user_id': owner, 'task_id': proposed.taskId, 'type': proposed.type, 'status': 'saved',
            'locked': proposed.locked, 'source': proposed.source, 'start_at': proposed.startAt, 'end_at': proposed.endAt,
            'date': proposed.date, 'start': proposed.start, 'end': proposed.end, 'schedule_version': version,
            'preview_id': preview_id,
        })
    if created:
        db.sessions.insert_many(created, session=txn)
    marked = db.schedule_previews.update_one({'_id': ObjectId(preview_id), 'user_id': owner, 'status': 'proposed'},
                                             {'$set': {'status': 'applied', 'applied_at': now, 'applied_version': version}},
                                             session=txn)
    if marked.modified_count != 1:
        raise HTTPException(409, 'This preview changed while saving. Generate a new preview.')
    return {'previewId': preview_id, 'status': 'applied', 'duplicate': False, 'schedule': saved_schedule(user, db, session=txn)}


# ---------------------------------------------------------------- grounded views for chat

def clock(minute: int) -> str:
    minute %= 1440
    return f"{(minute // 60) % 12 or 12}:{minute % 60:02d} {'AM' if minute < 720 else 'PM'}"


def schedule_snapshot(user, db, now: datetime, preview_id: str | None = None, days: int = 7) -> dict:
    """Grounding data for the assistant: the same saved sessions the calendar shows, plus a pending preview."""
    ctx = load_context(user, db, now, days)
    today = ctx.start_date
    saved = sorted((session_output(doc, ctx.zone, ctx.titles) for doc in ctx.docs), key=lambda s: (s.startAt, s.endAt, s.id))
    window = [s for s in saved if ctx.start_date <= s.date <= ctx.end_date and s.status != 'cancelled']
    preview = None
    if preview_id:
        try:
            doc = owned_preview(db, user, preview_id)
            if doc.get('status') == 'proposed':
                preview = SchedulePreview(**doc['preview'])
        except HTTPException:
            preview = None

    def describe(s: ScheduleSession) -> dict:
        return {'date': s.date, 'start': clock(s.start), 'end': clock(s.end), 'type': s.type, 'task': s.title if s.type == 'work' else None,
                'status': s.status, 'locked': s.locked, 'minutes': int((s.endAt - s.startAt).total_seconds() // 60)}

    return {
        'timeZone': ctx.availability.timeZone,
        'now': now.astimezone(ctx.zone).isoformat(timespec='minutes'),
        'today': today,
        'tasks': [{
            'id': t.id, 'title': t.title, 'priority': t.priority, 'done': t.done,
            'dueDate': t.deadline, 'dueTime': clock(1439 if t.dueTime >= 1439 else t.dueTime),
            'estimatedMinutes': t.minutes, 'completedMinutes': t.completedMinutes, 'remainingMinutes': t.remainingMinutes,
            'savedFutureWorkMinutes': sum(int((s.endAt - s.startAt).total_seconds() // 60) for s in saved
                                          if s.taskId == t.id and s.type == 'work' and s.status == 'saved' and s.endAt > now),
        } for t in ctx.tasks],
        'savedSessions': [describe(s) for s in window],
        'todaySavedSessions': [describe(s) for s in window if s.date == today],
        'pendingPreview': None if preview is None else {
            'note': 'PROPOSED, NOT SAVED. Only Apply saves it.',
            'sessions': [describe(s) for s in preview.sessions if s.change == 'new'],
            'unallocated': [{'task': a.title, 'minutes': a.unallocatedMinutes, 'reasons': [r.message for r in a.reasons]}
                            for a in preview.tasks if a.unallocatedMinutes],
            'conflicts': [c.message for c in preview.conflicts],
        },
        'events': [{'title': b.title, 'date': local_parts(b.start, ctx.zone)[0].isoformat(),
                    'start': clock(local_parts(b.start, ctx.zone)[1]), 'end': clock(local_parts(b.end, ctx.zone)[1])}
                   for b in ctx.events if ctx.start_date <= local_parts(b.start, ctx.zone)[0].isoformat() <= ctx.end_date],
        'preferences': ctx.prefs.model_dump(),
    }
