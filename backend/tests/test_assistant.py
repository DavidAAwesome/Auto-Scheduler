"""Chat grounding and the shared scheduling path. OpenAI is replaced by a fake client; no live calls."""
import json
from datetime import datetime, timezone
from types import SimpleNamespace

from app import assistant, schedule_routes
from app.config import get_settings
from firebase_tokens import sign_in
from test_schedule_api import _setup

NOW = datetime(2026, 10, 5, 12, tzinfo=timezone.utc)


class FakeResponses:
    def __init__(self, captured, reply, intent):
        self.captured = captured
        self.reply = reply
        self.intent = intent

    def parse(self, **kwargs):
        self.captured.append(kwargs)
        parsed = assistant.ChatResponseModel(reply=self.reply, intent=self.intent)
        return SimpleNamespace(output=[], output_parsed=parsed)


def _fake_openai(monkeypatch, reply='You have dinner at 7 PM.', intent='busy_time'):
    captured = []

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.responses = FakeResponses(captured, reply, intent)

    monkeypatch.setenv('OPENAI_API_KEY', 'test-key')
    get_settings.cache_clear()
    monkeypatch.setattr(assistant, 'OpenAI', FakeOpenAI)
    return captured


def _snapshot_from(captured):
    snapshot_message = captured[0]['input'][1]['content']
    return json.loads(snapshot_message.split('\n', 1)[1])


def test_chat_snapshot_contains_real_events_and_saved_sessions(environment, monkeypatch):
    client, _ = environment
    monkeypatch.setattr(schedule_routes, 'utc_now', lambda: NOW)
    monkeypatch.setattr(assistant, 'datetime', _FixedDatetime)
    task = _setup(client, monkeypatch, allow_split=True)
    client.post('/sessions', json={'taskId': task['id'], 'date': '2026-10-05', 'start': 18 * 60, 'end': 18 * 60 + 60})
    captured = _fake_openai(monkeypatch)

    response = client.post('/assistant/chat', json={'message': 'What is busy on Monday?'})

    assert response.status_code == 200, response.text
    assert response.json()['intent'] == 'busy_time'
    snapshot = _snapshot_from(captured)
    assert snapshot['events'] == [{
        'date': '2026-10-05', 'start': 19 * 60, 'end': 20 * 60, 'title': 'Dinner',
        'kind': 'Other', 'source': 'manual',
    }]
    assert snapshot['sessions'] == [{
        'taskTitle': 'Essay', 'date': '2026-10-05', 'start': 18 * 60, 'end': 19 * 60,
        'source': 'manual', 'locked': False,
    }]


def test_chat_response_never_carries_a_schedule_or_preview(environment, monkeypatch):
    client, db = environment
    monkeypatch.setattr(schedule_routes, 'utc_now', lambda: NOW)
    monkeypatch.setattr(assistant, 'datetime', _FixedDatetime)
    _setup(client, monkeypatch)
    _fake_openai(monkeypatch, reply='Building your preview now.', intent='generate_schedule')

    response = client.post('/assistant/chat', json={'message': 'plan my week'})

    assert response.status_code == 200
    assert set(response.json()) == {'reply', 'intent', 'provider'}
    assert response.json()['intent'] == 'generate_schedule'
    assert db.schedule_previews.count_documents({}) == 0
    assert client.get('/sessions').json() == []


def test_chat_without_key_is_503_and_writes_nothing(environment, monkeypatch):
    client, db = environment
    monkeypatch.setenv('OPENAI_API_KEY', '')
    get_settings.cache_clear()
    sign_in(client, uid='chat-user', email='chat@example.com', name='Chat')
    response = client.post('/assistant/chat', json={'message': 'plan my week'})
    assert response.status_code == 503
    assert db.schedule_previews.count_documents({}) == 0


def test_button_and_chat_previews_come_from_the_same_service(environment, monkeypatch):
    client, _ = environment
    monkeypatch.setattr(schedule_routes, 'utc_now', lambda: NOW)
    _setup(client, monkeypatch)
    button = client.post('/schedule/preview', json={}).json()
    from app.openai_interpret import InterpretResult
    monkeypatch.setattr(schedule_routes, 'interpret_request', lambda message, **kw: InterpretResult(
        intent='generate_schedule', reply='Preview ready.', runScheduler=True))
    chat = client.post('/schedule/interpret', json={'message': 'plan my week'}).json()['preview']
    assert chat['schedule'] == button['schedule']


class _FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW
