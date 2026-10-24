"""API tests for schedule preview/apply/interpret. OpenAI is mocked — no live calls."""
from datetime import datetime, timezone

from fastapi import HTTPException

from app import schedule_routes
from app.openai_interpret import InterpretResult
from firebase_tokens import sign_in, sign_out

NOW = datetime(2026, 10, 5, 12, tzinfo=timezone.utc)


def _setup(client, monkeypatch, allow_split=True):
    monkeypatch.setattr(schedule_routes, 'utc_now', lambda: NOW)
    sign_in(client, uid='sched-user', email='sched@example.com', name='Sched')
    availability = client.get('/availability').json()
    availability['timeZone'] = 'UTC'
    availability['days'][0] = {
        'day': 0, 'enabled': True,
        'periods': [{'start': 18 * 60, 'end': 21 * 60}],
    }
    for day in availability['days'][1:]:
        day['enabled'] = False
    client.put('/availability', json=availability)
    task = client.post('/tasks', json={
        'title': 'Essay', 'deadline': '2026-10-05', 'minutes': 120,
        'dueTime': 21 * 60, 'priority': 'High', 'category': 'Study',
        'allowSplit': allow_split, 'minSessionMinutes': 60, 'maxSessionMinutes': 60,
    }).json()
    client.post('/events', json={
        'title': 'Dinner', 'kind': 'Other', 'date': '2026-10-05',
        'start': 19 * 60, 'end': 20 * 60, 'location': None, 'repeat': None,
    })
    return task


def test_preview_split_scenario_and_apply_idempotent(environment, monkeypatch):
    client, db = environment
    task = _setup(client, monkeypatch, allow_split=True)
    preview = client.post('/schedule/preview', json={'horizonDays': 1}).json()
    sessions = preview['schedule']['sessions']
    assert [(s['start'], s['end']) for s in sessions] == [(18 * 60, 19 * 60), (20 * 60, 21 * 60)]
    assert preview['schedule']['tasks'][0]['status'] == 'scheduled'
    # Preview must not create sessions yet.
    assert client.get('/sessions').json() == []

    applied = client.post('/schedule/apply', json={'previewId': preview['previewId']}).json()
    assert applied['status'] == 'applied'
    assert len(applied['sessions']) == 2
    saved = client.get('/sessions').json()
    assert len(saved) == 2
    assert all(s['source'] == 'auto' for s in saved)
    assert all(s['taskId'] == task['id'] for s in saved)

    # Repeated apply is idempotent.
    again = client.post('/schedule/apply', json={'previewId': preview['previewId']}).json()
    assert again['status'] == 'applied'
    assert len(client.get('/sessions').json()) == 2


def test_preview_unsplit_no_contiguous(environment, monkeypatch):
    client, _ = environment
    _setup(client, monkeypatch, allow_split=False)
    preview = client.post('/schedule/preview', json={'horizonDays': 1}).json()
    assert preview['schedule']['sessions'] == []
    assert preview['schedule']['tasks'][0]['reason'] == 'no_contiguous_slot'


def test_stale_preview_rejected(environment, monkeypatch):
    client, _ = environment
    task = _setup(client, monkeypatch)
    preview = client.post('/schedule/preview', json={'horizonDays': 1}).json()
    client.put(f"/tasks/{task['id']}", json={
        'title': 'Essay changed', 'deadline': '2026-10-05', 'minutes': 120,
        'dueTime': 21 * 60, 'priority': 'High', 'category': 'Study',
        'allowSplit': True, 'minSessionMinutes': 60, 'maxSessionMinutes': 60,
    })
    response = client.post('/schedule/apply', json={'previewId': preview['previewId']})
    assert response.status_code == 409
    assert 'stale' in response.json()['detail'].lower()


def test_cross_user_cannot_apply_foreign_preview(environment, monkeypatch):
    client, _ = environment
    _setup(client, monkeypatch)
    preview = client.post('/schedule/preview', json={'horizonDays': 1}).json()
    sign_out(client)
    sign_in(client, uid='other-sched', email='other@example.com', name='Other')
    assert client.post('/schedule/apply', json={'previewId': preview['previewId']}).status_code == 404
    assert client.get(f"/schedule/preview/{preview['previewId']}").status_code == 404


def test_openai_failure_structured_scheduling_still_works(environment, monkeypatch):
    client, _ = environment
    _setup(client, monkeypatch)

    def boom(*args, **kwargs):
        raise HTTPException(status_code=502, detail='OpenAI request failed')

    monkeypatch.setattr(schedule_routes, 'interpret_request', boom)
    assert client.post('/schedule/interpret', json={'message': 'plan my week'}).status_code == 502
    # Engine path independent of OpenAI:
    preview = client.post('/schedule/preview', json={'horizonDays': 1})
    assert preview.status_code == 200
    assert preview.json()['schedule']['tasks'][0]['scheduledMinutes'] == 120


def test_interpret_mocked_can_return_preview(environment, monkeypatch):
    client, _ = environment
    _setup(client, monkeypatch)

    def fake_interpret(message, **kwargs):
        return InterpretResult(
            intent='generate_schedule',
            reply='I can generate a schedule preview for confirmation.',
            needsConfirmation=False,
            clarificationQuestions=[],
            preferences=[],
            runScheduler=True,
        )

    monkeypatch.setattr(schedule_routes, 'interpret_request', fake_interpret)
    response = client.post('/schedule/interpret', json={'message': 'Schedule my essay around dinner'})
    assert response.status_code == 200
    body = response.json()
    assert body['interpretation']['runScheduler'] is True
    assert body['preview'] is not None
    assert len(body['preview']['schedule']['sessions']) == 2


def test_replan_endpoint(environment, monkeypatch):
    client, _ = environment
    _setup(client, monkeypatch)
    assert client.post('/schedule/replan', json={'horizonDays': 1}).status_code == 200
