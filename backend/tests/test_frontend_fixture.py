"""Keeps the frontend's acceptance fixture identical to what the real engine and API return.

Run with UPDATE_FIXTURES=1 to rewrite it after an intended change to the engine or response shape.
"""
import json
import os
from pathlib import Path

from schedule_fixtures import ACCEPTANCE, acceptance_tasks, rows, setup_user

FIXTURE = Path(__file__).resolve().parents[2] / 'frontend' / 'tests' / 'fixtures' / 'acceptance.json'


def shape(payload):
    preview = payload['preview']
    return [(s['taskId'] is None, s['title'], s['type'], s['startAt'], s['endAt'], s['change']) for s in preview['sessions']]


def test_frontend_acceptance_fixture_matches_api(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    payload = {
        'tasks': client.get('/tasks').json(),
        'availability': client.get('/availability').json(),
        'preferences': client.get('/schedule/preferences').json(),
        'schedule': client.get('/schedule').json(),
        'preview': client.post('/schedule/preview', json={'horizonDays': 1}).json(),
    }
    assert rows(payload['preview']['sessions']) == ACCEPTANCE
    if os.getenv('UPDATE_FIXTURES'):
        FIXTURE.write_text(json.dumps(payload, indent=2) + '\n')
    assert shape(json.loads(FIXTURE.read_text())) == shape(payload)


PLAN_FIXTURE = FIXTURE.with_name('plan.json')
PLAN_TEXT = """Lab report 90 min due tomorrow high priority
Advisor meeting today 11-11:30am
Gym 30 min sometime today, low priority"""


def plan_shape(payload):
    preview = payload['preview']
    return ([(v['draft']['kind'], v['draft']['title'], v['ready']) for v in payload['interpret']['drafts']],
            [(s['taskId'], s['type'], s['startAt'], s['endAt']) for s in preview['sessions']],
            [(e['title'], e['startAt'], e['endAt']) for e in preview['proposedEvents']],
            payload['feasibility']['status'])


def test_frontend_plan_fixture_matches_api(environment, monkeypatch):
    """Real responses for the bulk-message demo, replayed by frontend/tests/planEntry.test.ts."""
    client, _ = environment
    setup_user(client, monkeypatch)
    interpret = client.post('/plan/interpret', json={'text': PLAN_TEXT, 'batchId': 'batch-1'}).json()
    drafts = [v['draft'] for v in interpret['drafts']]
    body = {'drafts': drafts, 'horizonDays': 1, 'batchId': 'batch-1'}
    payload = {
        'tasks': client.get('/tasks').json(),
        'availability': client.get('/availability').json(),
        'preferences': client.get('/schedule/preferences').json(),
        'schedule': client.get('/schedule').json(),
        'interpret': interpret,
        'review': client.post('/plan/review', json=body).json(),
        'feasibility': client.post('/plan/feasibility', json=body).json(),
        'preview': client.post('/plan/preview', json=body).json(),
    }
    assert payload['feasibility']['status'] == 'fits_without_moving'
    if os.getenv('UPDATE_FIXTURES') or not PLAN_FIXTURE.exists():
        PLAN_FIXTURE.write_text(json.dumps(payload, indent=2) + '\n')
    assert plan_shape(json.loads(PLAN_FIXTURE.read_text())) == plan_shape(payload)
