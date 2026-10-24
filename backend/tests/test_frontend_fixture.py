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
