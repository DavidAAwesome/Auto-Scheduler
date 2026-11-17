"""Chat grounding: the assistant reads the same schedule as the calendar. OpenAI is a fake client; no live calls."""
import json
from types import SimpleNamespace

from app import assistant, self_review
from app.config import get_settings
from firebase_tokens import sign_in
from schedule_fixtures import ACCEPTANCE, TODAY, TOMORROW, acceptance_tasks, add_event, setup_user


class FakeResponses:
    def __init__(self, captured, reply, intent, params, review):
        self.captured, self.reply, self.intent, self.params, self.review = captured, reply, intent, params, review

    def parse(self, **kwargs):
        self.captured.append(kwargs)
        if kwargs['text_format'] is self_review.ReviewResult:
            if isinstance(self.review, Exception):
                raise self.review
            parsed = self.review  # None: keep the draft (an unusable review)
        else:
            parsed = assistant.ChatResponseModel(reply=self.reply, intent=self.intent,
                                                 params=assistant.IntentParams(**self.params))
        return SimpleNamespace(output=[], output_parsed=parsed)


def fake_openai(monkeypatch, reply='Here is your day.', intent='none', review=None, **params):
    captured = []

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.responses = FakeResponses(captured, reply, intent, params, review)

        def with_options(self, **kwargs):
            return self

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
    snapshot = snapshot_from(captured)
    assert snapshot['events'] == [{'title': 'Dinner', 'date': TODAY, 'weekday': 'Monday', 'start': '7:00 PM', 'end': '8:00 PM'}]
    # Weekday names are looked up, never worked out by the model: two weeks of dates with their weekdays.
    assert snapshot['todayWeekday'] == 'Monday' and snapshot['calendar'][5] == {'date': '2026-10-31', 'weekday': 'Saturday'}
    assert len(snapshot['calendar']) == 15


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


def reviewed(revised, *issues):
    return self_review.ReviewResult(revisedReply=revised, issues=[
        self_review.ReviewIssue(severity=sev, quote=q, problem='p', fix='f') for sev, q in issues])


def test_free_text_reply_is_self_reviewed_against_the_request_and_snapshot(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    captured = fake_openai(monkeypatch, reply='Asm are due tomorow.', intent='none',
                           review=reviewed('Asm is due tomorrow.', ('error', 'Asm are due tomorow')))
    body = client.post('/assistant/chat', json={'message': 'When is Asm due?'}).json()
    assert (body['intent'], body['reply']) == ('none', 'Asm is due tomorrow.')
    assert len(captured) == 2
    review = captured[1]
    assert review['text_format'] is self_review.ReviewResult
    material = review['input'][-1]['content']
    assert '<user_request>\nWhen is Asm due?\n</user_request>' in material
    assert '<ai_answer>\nAsm are due tomorow.\n</ai_answer>' in material
    assert any('Snapshot (JSON)' in m['content'] for m in review['input'])
    assert 'up to five issues' in review['input'][0]['content']


def test_model_clarify_question_is_reviewed_but_validator_questions_are_not(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    captured = fake_openai(monkeypatch, reply='u mean Asm due tomorow?', intent='clarify',
                           review=reviewed('Do you mean Asm, due tomorrow?'))
    assert client.post('/assistant/chat', json={'message': 'do the thing'}).json()['reply'] == 'Do you mean Asm, due tomorrow?'
    assert len(captured) == 2
    captured = fake_openai(monkeypatch, intent='request_break', breakMinutes=None, review=reviewed('changed'))
    body = client.post('/assistant/chat', json={'message': 'I need a break'}).json()
    assert body['intent'] == 'clarify' and body['reply'] != 'changed' and len(captured) == 1


def test_action_intents_skip_the_review(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    captured = fake_openai(monkeypatch, reply='Planning.', intent='generate_schedule', review=reviewed('changed'))
    body = client.post('/assistant/chat', json={'message': 'plan my week'}).json()
    assert (body['intent'], body['reply']) == ('generate_schedule', 'Planning.') and len(captured) == 1


def test_failed_or_empty_review_keeps_the_draft(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    for review in (RuntimeError('timeout'), None, reviewed('   ')):
        fake_openai(monkeypatch, reply='Here is your day.', review=review)
        response = client.post('/assistant/chat', json={'message': 'How does my day look?'})
        assert response.status_code == 200 and response.json()['reply'] == 'Here is your day.'


def test_self_review_can_be_turned_off(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    monkeypatch.setenv('ASSISTANT_SELF_REVIEW', 'false')
    captured = fake_openai(monkeypatch, reply='Here is your day.', review=reviewed('changed'))
    assert client.post('/assistant/chat', json={'message': 'Hi'}).json()['reply'] == 'Here is your day.'
    assert len(captured) == 1


def test_short_replies_with_nothing_to_check_skip_the_review(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    for reply, intent in (('which task u mean?', 'clarify'), ('Hi! How can I help?', 'none')):
        captured = fake_openai(monkeypatch, reply=reply, intent=intent, review=reviewed('changed?'))
        assert client.post('/assistant/chat', json={'message': 'hey'}).json()['reply'] == reply and len(captured) == 1


def test_review_cannot_turn_a_question_into_a_statement_or_claim_a_change(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    cases = [('Which Asm session, today or tomorrow?', 'clarify', 'Asm is today.'),
             ('Asm fits tomorrow at 10 AM.', 'none', 'I moved Asm to tomorrow at 10 AM.'),
             ('Asm is due tomorrow.', 'none', 'Asm is due tomorrow. ' + 'More detail. ' * 40)]
    for draft, intent, revision in cases:
        captured = fake_openai(monkeypatch, reply=draft, intent=intent, review=reviewed(revision))
        assert client.post('/assistant/chat', json={'message': 'Asm?'}).json()['reply'] == draft and len(captured) == 2


def test_review_outcomes_are_counted(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    self_review.STATS.clear()
    fake_openai(monkeypatch, reply='Your day has 2 sessions.', review=reviewed('You have 2 sessions today.'))
    client.post('/assistant/chat', json={'message': 'my day?'})
    fake_openai(monkeypatch, reply='Hello there!', review=reviewed('x'))
    client.post('/assistant/chat', json={'message': 'hi'})
    assert self_review.STATS == {'changed': 1, 'skipped': 1}


def test_a_weekday_with_the_wrong_date_is_corrected_from_the_calendar():
    snapshot = {'calendar': [{'date': f'2026-11-{d}', 'weekday': w} for d, w in
                             [(17, 'Tuesday'), (18, 'Wednesday'), (19, 'Thursday'), (20, 'Friday'), (21, 'Saturday'),
                              (22, 'Sunday'), (23, 'Monday')]]}
    fix = assistant.fix_weekday_dates
    assert fix('On Saturday, November 18, you have soccer.', snapshot) == 'On Saturday, November 21, you have soccer.'
    assert fix('Friday, November 17th at 3 PM', snapshot) == 'Friday, November 20th at 3 PM'
    assert fix('Wednesday, November 18 is free.', snapshot) == 'Wednesday, November 18 is free.'
