"""OpenAI-backed planning assistant. Placement stays in scheduler.generate_plan."""
from __future__ import annotations

import json
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field

from app.auth import get_current_user
from app.config import get_settings
from app.database import get_database
from app.workspace import get_availability, list_tasks

router = APIRouter(prefix='/assistant', tags=['assistant'])

SYSTEM_PROMPT = """You are AutoPlan's scheduling assistant for a student productivity app.

The product already has a deterministic scheduling engine (not you) that:
- Plans a rolling 7-day window from "now" in the user's timezone
- Orders open tasks by deadline, then priority (High > Medium > Low), then id
- Never schedules over busy intervals (classes, meetings, work sessions)
- Only uses the user's available hours (possibly multiple periods per day, plus week overrides)
- Splits long tasks into 15–60 minute focus blocks with short breaks between focus on the same day
- Marks tasks as scheduled, partial, unscheduled, overdue, or outside_window with honest reasons

Your job:
- Explain deadlines, conflicts, priorities, capacity, and why work did or did not fit
- Advise when a large task should be split into separate Task documents (different titles/deadlines) before regenerating a plan
- When the user wants a new schedule, set pendingAction to generate_plan so they can confirm — never claim you already moved their calendar
- Be concise and concrete; use the provided workspace snapshot only
- Do not invent tasks, times, or calendar events that are not in the snapshot

Respond with JSON only:
{"reply": "string shown to the user", "pendingAction": null | {"type": "generate_plan", "label": "short button label"}}
"""


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra='forbid')
    role: Literal['user', 'assistant']
    text: str = Field(min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    message: str = Field(min_length=1, max_length=2000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=12)


class PendingAction(BaseModel):
    model_config = ConfigDict(extra='forbid')
    type: Literal['generate_plan']
    label: str = Field(min_length=1, max_length=80)


class ChatResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    reply: str
    pendingAction: PendingAction | None = None
    provider: Literal['openai'] = 'openai'


def _snapshot(user, db) -> dict[str, Any]:
    tasks = list_tasks(user=user, db=db)
    availability = get_availability(user=user, db=db)
    stored = db.plans.find_one({'user_id': str(user['_id'])})
    plan = (stored or {}).get('plan')
    connections = list(db.calendar_connections.find({'user_id': str(user['_id'])}))
    open_tasks = [
        {
            'id': t.id,
            'title': t.title,
            'minutes': t.minutes,
            'deadline': t.deadline,
            'priority': t.priority,
            'done': t.done,
        }
        for t in tasks if not t.done
    ]
    plan_summary = None
    if plan:
        plan_summary = {
            'startDate': plan.get('startDate'),
            'endDate': plan.get('endDate'),
            'timeZone': plan.get('timeZone'),
            'source': plan.get('source'),
            'stale': plan.get('stale', False),
            'staleReasons': plan.get('staleReasons', []),
            'busyIntervalCount': len(plan.get('busyIntervals') or []),
            'focusBlockCount': sum(1 for b in plan.get('blocks') or [] if b.get('type') == 'focus'),
            'taskOutcomes': [
                {
                    'title': t.get('title'),
                    'status': t.get('status'),
                    'requestedMinutes': t.get('requestedMinutes'),
                    'scheduledMinutes': t.get('scheduledMinutes'),
                    'unscheduledMinutes': t.get('unscheduledMinutes'),
                    'message': t.get('message'),
                }
                for t in plan.get('tasks') or []
            ],
        }
    return {
        'timeZone': availability.timeZone,
        'availabilityDays': [
            {
                'day': d.day,
                'enabled': d.enabled,
                'periods': [{'start': p.start, 'end': p.end} for p in d.periods],
            }
            for d in availability.days
        ],
        'weekOverrideCount': len(availability.weekOverrides or []),
        'openTasks': open_tasks,
        'calendarConnections': [
            {
                'provider': c.get('provider'),
                'account': c.get('account'),
                'eventCount': c.get('event_count'),
                'lastSynced': str(c.get('last_synced') or ''),
            }
            for c in connections
        ],
        'plan': plan_summary,
        'engineNotes': (
            'Placement is done by POST /plan/generate using deadlines, priorities, '
            'availability, busy intervals, and 15–60 minute focus splits with breaks.'
        ),
    }


def _parse_model_json(raw: str) -> ChatResponse:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail='Assistant returned invalid JSON.') from exc
    reply = str(data.get('reply') or '').strip()
    if not reply:
        raise HTTPException(status_code=502, detail='Assistant returned an empty reply.')
    pending = data.get('pendingAction')
    action = None
    if isinstance(pending, dict) and pending.get('type') == 'generate_plan':
        label = str(pending.get('label') or 'Generate plan').strip()[:80] or 'Generate plan'
        action = PendingAction(type='generate_plan', label=label)
    return ChatResponse(reply=reply[:4000], pendingAction=action)


@router.post('/chat', response_model=ChatResponse)
def chat(body: ChatRequest, user=Depends(get_current_user), db=Depends(get_database)):
    settings = get_settings()
    if not settings.openai_api_key:
        raise HTTPException(
            status_code=503,
            detail='OpenAI is not configured. Set OPENAI_API_KEY in backend/.env.',
        )
    snapshot = _snapshot(user, db)
    history = [
        {'role': m.role, 'content': m.text}
        for m in body.history[-8:]
    ]
    messages = [
        {'role': 'system', 'content': SYSTEM_PROMPT},
        {
            'role': 'system',
            'content': 'Workspace snapshot (JSON):\n' + json.dumps(snapshot, separators=(',', ':')),
        },
        *history,
        {'role': 'user', 'content': body.message.strip()},
    ]
    try:
        client = OpenAI(api_key=settings.openai_api_key)
        completion = client.chat.completions.create(
            model=settings.openai_model,
            temperature=0.3,
            response_format={'type': 'json_object'},
            messages=messages,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f'OpenAI request failed: {exc}') from exc
    content = (completion.choices[0].message.content or '').strip()
    return _parse_model_json(content)
