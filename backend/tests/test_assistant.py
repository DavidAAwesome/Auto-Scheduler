"""Chat grounding: the assistant reads the same schedule as the calendar. OpenAI is a fake client; no live calls."""
import json
from types import SimpleNamespace

from app import assistant
from app.config import get_settings
from firebase_tokens import sign_in
from schedule_fixtures import ACCEPTANCE, TODAY, TOMORROW, acceptance_tasks, add_event, setup_user


class FakeResponses:
    def __init__(self, captured, reply, intent, params):
        self.captured, self.reply, self.intent, self.params = captured, reply, intent, params

    def parse(self, **kwargs):
        self.captured.append(kwargs)
        parsed = assistant.ChatResponseModel(reply=self.reply, intent=self.intent,
                                             params=assistant.IntentParams(**self.params))
        return SimpleNamespace(output=[], output_parsed=parsed)


def fake_openai(monkeypatch, reply='Here is your day.', intent='none', **params):
    captured = []

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.responses = FakeResponses(captured, reply, intent, params)

    monkeypatch.setenv('OPENAI_API_KEY', 'test-key')
    get_settings.cache_clear()
    monkeypatch.setattr(assistant, 'OpenAI', FakeOpenAI)
    return captured


def snapshot_from(captured):
    return json.loads(captured[0]['input'][1]['content'].split('\n', 1)[1])


def as_rows(items):
    def hhmm(text):
        clock, half = text.split()
        hour, minute = map(int, clock.split(':'))
        return (hour % 12 + (12 if half == 'PM' else 0)) * 60 + minute
    return [(s['date'], f"{hhmm(s['start']) // 60:02d}:{hhmm(s['start']) % 60:02d}-{hhmm(s['end']) // 60:02d}:"
             f"{hhmm(s['end']) % 60:02d}", s['type'], s['task'] or 'Break') for s in items]


def test_todays_tasks_in_chat_match_the_calendar_preview_then_the_saved_schedule(transaction_environment, monkeypatch):
    client, _ = transaction_environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    proposal = client.post('/schedule/preview', json={'horizonDays': 1}).json()
    captured = fake_openai(monkeypatch)

    assert client.post('/assistant/chat', json={'message': "Today's tasks", 'previewId': proposal['previewId']}).status_code == 200
    snapshot = snapshot_from(captured)
    assert snapshot['today'] == TODAY
    assert snapshot['todaySavedSessions'] == []
    assert snapshot['pendingPreview']['note'].startswith('PROPOSED, NOT SAVED')
    assert as_rows(snapshot['pendingPreview']['sessions']) == ACCEPTANCE
    # Deadlines are reported as deadlines, separately from when work happens.
    assert {t['title']: t['dueDate'] for t in snapshot['tasks']} == {'Asm': TOMORROW, 'Test revision': TOMORROW}

    assert client.post('/schedule/apply', json={'previewId': proposal['previewId']}).status_code == 200
    captured.clear()
    client.post('/assistant/chat', json={'message': "Today's tasks"})
    snapshot = snapshot_from(captured)
    assert as_rows(snapshot['todaySavedSessions']) == ACCEPTANCE
    assert {s['status'] for s in snapshot['todaySavedSessions']} == {'saved'}
    assert snapshot['pendingPreview'] is None
    assert 'DEADLINE' in captured[0]['input'][0]['content']


def test_events_are_in_the_snapshot(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    add_event(client, 'Dinner', 19 * 60, 20 * 60)
    captured = fake_openai(monkeypatch, intent='busy_time')
    response = client.post('/assistant/chat', json={'message': 'What is busy today?'})
    assert response.json()['intent'] == 'busy_time'
    assert snapshot_from(captured)['events'] == [{'title': 'Dinner', 'date': TODAY, 'start': '7:00 PM', 'end': '8:00 PM'}]


def test_chat_never_generates_or_saves_by_itself(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    fake_openai(monkeypatch, reply='I scheduled everything!', intent='generate_schedule')
    response = client.post('/assistant/chat', json={'message': 'plan my week'})
    assert response.status_code == 200
    assert response.json()['intent'] == 'generate_schedule'
    assert db.schedule_previews.count_documents({}) == 0
    assert client.get('/schedule').json()['sessions'] == []


def test_change_intents_are_validated_before_the_client_acts(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    asm, _ = acceptance_tasks(client)
    fake_openai(monkeypatch, intent='request_break', breakMinutes=None)
    assert client.post('/assistant/chat', json={'message': 'I need a break'}).json()['intent'] == 'clarify'
    fake_openai(monkeypatch, intent='request_break', breakMinutes=30)
    body = client.post('/assistant/chat', json={'message': 'I need a 30-minute break now'}).json()
    assert (body['intent'], body['params']['breakMinutes']) == ('request_break', 30)
    fake_openai(monkeypatch, intent='move_task', taskId='not-a-real-task', notBefore='2026-10-27T09:00:00-04:00')
    body = client.post('/assistant/chat', json={'message': 'move it'}).json()
    assert body['intent'] == 'clarify' and 'Which task' in body['reply']
    fake_openai(monkeypatch, intent='move_task', taskId=asm['id'], notBefore='2026-10-27T09:00:00-04:00')
    body = client.post('/assistant/chat', json={'message': 'move Asm to tomorrow'}).json()
    assert body['intent'] == 'move_task' and body['params']['taskId'] == asm['id']


def test_chat_without_key_is_503_and_writes_nothing(environment, monkeypatch):
    client, db = environment
    monkeypatch.setenv('OPENAI_API_KEY', '')
    get_settings.cache_clear()
    sign_in(client, uid='chat-user', email='chat@example.com', name='Chat')
    response = client.post('/assistant/chat', json={'message': 'plan my week'})
    assert response.status_code == 503
    assert db.schedule_previews.count_documents({}) == 0
