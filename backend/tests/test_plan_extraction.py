"""Input interpretation: text and images become editable drafts. AI responses are mocked; no network."""
import base64
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app import plan_extraction
from app.config import get_settings
from app.plan_drafts import review_draft
from app.plan_extraction import Extraction, LlmItem, apply_answer, parse_text
from schedule_fixtures import NOW, setup_user

NY = ZoneInfo('America/New_York')
PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 64

BULK = """Finish lab report, 3 hours, due Friday 5pm, high priority
Read chapter 4 for 90 min by Thursday, low priority
Team meeting Wednesday 2-3pm in Room 204
CS101 lecture every Mon and Wed 10:00-11:15 until Dec 12
Gym 1 hour sometime Saturday
Essay draft 2h due Nov 3 after Lab report
Mock exam 2 hours in one sitting due Wednesday"""


def by_title(drafts):
    return {d.title: d for d in drafts}


def test_bulk_message_becomes_separate_drafts_with_deadlines_kept_apart_from_dates():
    drafts = by_title(parse_text(BULK, NOW, NY))
    assert list(drafts) == ['Finish lab report', 'Read chapter 4', 'Team meeting', 'CS101 lecture', 'Gym', 'Essay draft',
                            'Mock exam']
    lab = drafts['Finish lab report']
    assert (lab.kind, lab.minutes, lab.deadline, lab.dueTime, lab.priority) == ('task', 180, '2026-10-30', 17 * 60, 'High')
    assert lab.date is None and lab.start is None  # a deadline is not a scheduled time
    assert (drafts['Read chapter 4'].deadline, drafts['Read chapter 4'].priority) == ('2026-10-29', 'Low')
    meeting = drafts['Team meeting']
    assert (meeting.kind, meeting.date, meeting.start, meeting.end, meeting.location) == (
        'fixed_event', '2026-10-28', 14 * 60, 15 * 60, 'Room 204')
    lecture = drafts['CS101 lecture']
    assert lecture.kind == 'fixed_event' and lecture.repeat.weekdays == [0, 2] and lecture.repeat.until == '2026-12-12'
    assert lecture.date is None  # weekly, never silently a one-time event
    gym = drafts['Gym']
    assert (gym.kind, gym.minutes, gym.deadline, gym.earliestStart) == ('flexible_event', 60, '2026-10-31', '2026-10-31T00:00:00')
    assert drafts['Essay draft'].dependsOn == [lab.id]
    assert drafts['Mock exam'].allowSplit is False
    assert 'priority' in drafts['Gym'].assumed and 'priority' not in lab.assumed


def test_review_asks_focused_questions_for_missing_recurrence_bounds_and_am_pm():
    lecture = by_title(parse_text(BULK, NOW, NY))['CS101 lecture']
    view = review_draft(lecture, NOW, NY)
    assert not view.ready
    assert {(i.field, i.code) for i in view.issues} == {('start', 'ambiguous'), ('end', 'ambiguous'),
                                                        ('repeat.startDate', 'missing')}
    answered = apply_answer(lecture, 'start', 'AM', NOW, NY)
    answered = apply_answer(answered, 'repeat.startDate', 'Sep 2', NOW, NY)
    assert answered.id == lecture.id  # the answer updates the same draft
    final = review_draft(answered, NOW, NY)
    assert final.ready and answered.start == 600 and answered.end == 675 and answered.repeat.startDate == '2026-09-02'


def test_relative_dates_use_the_users_timezone_not_utc():
    late_evening = datetime(2026, 10, 26, 23, 30, tzinfo=NY)  # already 27 October in UTC
    draft = parse_text('Quiz prep 30 min due tomorrow', late_evening, NY)[0]
    assert draft.deadline == '2026-10-27'


def test_missing_length_and_deadline_trigger_clarification():
    draft = parse_text('Write cover letter', NOW, NY)[0]
    view = review_draft(draft, NOW, NY)
    assert [i.field for i in view.issues if i.blocking] == ['minutes', 'deadline']
    draft = apply_answer(apply_answer(draft, 'minutes', '45', NOW, NY), 'deadline', 'Friday at 5 PM', NOW, NY)
    assert (draft.minutes, draft.deadline, draft.dueTime) == (45, '2026-10-30', 17 * 60)
    assert review_draft(draft, NOW, NY).ready
    with pytest.raises(ValueError):
        apply_answer(draft, 'start', '3', NOW, NY)  # still ambiguous: an answer needs AM/PM


def timetable_extraction():
    """What a vision model returns for a weekly class timetable photo with no semester dates and one unclear time."""
    def row(title, weekdays, start, end, source, ambiguous=(), room=None):
        return LlmItem(kind='fixed_event', title=title, sourceText=source, minutes=None, deadlineDate=None,
                       deadlineTime=None, earliestStart=None, priority=None, allowSplit=None, maxSessionMinutes=None,
                       date=None, startTime=start, endTime=end, eventKind='Class', location=room, repeatWeekdays=weekdays,
                       repeatStartDate=None, repeatUntil=None, windows=[], dependsOnTitles=[],
                       ambiguousFields=list(ambiguous), unreadableFields=[])
    return Extraction(items=[
        row('CS101 Lecture', [0, 2], '10:00', '11:15', 'CS101 LEC  M W  10:00-11:15  HALL A', room='Hall A'),
        row('MATH 220 Lab', [1], '02:00', '03:50', 'MATH220 LAB  Tu  2:00-3:50', ambiguous=['startTime', 'endTime']),
        row('PHYS 150', [3], '13:00', '14:15', 'PHYS150  Th  1:00-2:15 PM'),
    ], notes=['No semester dates are visible.'])


@pytest.fixture
def with_ai(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-test-not-real')
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_timetable_image_extracts_recurring_classes_and_asks_for_semester_dates_and_am_pm(environment, monkeypatch, with_ai):
    client, db = environment
    setup_user(client, monkeypatch)
    seen = {}

    def fake_model(inputs):
        seen['inputs'] = inputs
        return timetable_extraction()
    monkeypatch.setattr(plan_extraction, 'call_model', fake_model)
    image = {'mediaType': 'image/png', 'dataBase64': base64.b64encode(PNG).decode(), 'name': 'timetable.png'}
    response = client.post('/plan/interpret', json={'text': '', 'image': image, 'batchId': 'tt1'})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['provider'] == 'openai' and body['notes'] == ['No semester dates are visible.']
    image_part = seen['inputs'][-1]['content'][1]
    assert image_part['type'] == 'input_image' and image_part['image_url'].startswith('data:image/png;base64,')
    views = {v['draft']['title']: v for v in body['drafts']}
    assert all(v['draft']['repeat'] and v['draft']['date'] is None for v in views.values())  # recurring, not one-time
    assert views['CS101 Lecture']['draft']['sourceText'].startswith('CS101 LEC')  # original wording for review
    lab = views['MATH 220 Lab']
    assert {i['field'] for i in lab['issues'] if i['blocking']} == {'start', 'end', 'repeat.startDate', 'repeat.until'}
    assert all(not v['ready'] for v in views.values())
    assert db.events.count_documents({}) == 0 and db.tasks.count_documents({}) == 0  # rows shown before saving

    # Focused follow-up answers update the same draft until it is ready.
    draft = lab['draft']
    for field, answer in [('start', 'PM'), ('repeat.startDate', 'Sep 2 to Dec 12')]:
        reply = client.post('/plan/clarify', json={'draft': draft, 'field': field, 'answer': answer})
        assert reply.status_code == 200, reply.text
        draft = reply.json()['draft']
    assert draft['id'] == lab['draft']['id'] and (draft['start'], draft['end']) == (14 * 60, 15 * 60 + 50)
    assert (draft['repeat']['startDate'], draft['repeat']['until']) == ('2026-09-02', '2026-12-12')
    assert reply.json()['ready'], reply.json()
    bad = client.post('/plan/clarify', json={'draft': draft, 'field': 'repeat.until', 'answer': '2026-08-01'})
    assert not bad.json()['ready']  # ends before it starts: answers are checked, not trusted


@pytest.mark.parametrize('image, status', [
    ({'mediaType': 'image/gif', 'dataBase64': base64.b64encode(b'GIF89a').decode()}, 415),
    ({'mediaType': 'image/png', 'dataBase64': base64.b64encode(b'not an image at all').decode()}, 415),
    ({'mediaType': 'image/png', 'dataBase64': base64.b64encode(PNG + b'\x00' * (5 * 1024 * 1024)).decode()}, 413),
    ({'mediaType': 'image/png', 'dataBase64': '%%%not-base64%%%'}, 422),
])
def test_image_type_and_size_are_validated_before_any_provider_call(environment, monkeypatch, with_ai, image, status):
    client, _ = environment
    setup_user(client, monkeypatch)
    monkeypatch.setattr(plan_extraction, 'call_model', lambda inputs: pytest.fail('provider must not be called'))
    assert client.post('/plan/interpret', json={'image': image}).status_code == status


def test_image_without_ai_key_is_refused_clearly(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    get_settings.cache_clear()
    response = client.post('/plan/interpret', json={'image': {'mediaType': 'image/png', 'dataBase64': base64.b64encode(PNG).decode()}})
    assert response.status_code == 503 and 'kept' in response.json()['detail']


def test_provider_failure_is_reported_and_saves_nothing(environment, monkeypatch, with_ai):
    client, db = environment
    setup_user(client, monkeypatch)

    def broken(inputs):
        raise RuntimeError('socket closed')
    monkeypatch.setattr(plan_extraction, 'call_model', broken)
    response = client.post('/plan/interpret', json={'text': 'Essay 2h due Friday'})
    assert response.status_code == 502 and 'input was kept' in response.json()['detail']
    assert db.tasks.count_documents({}) == 0


def test_provider_errors_map_to_safe_messages(monkeypatch, with_ai):
    import httpx
    monkeypatch.setenv('FIREBASE_PROJECT_ID', 'autoplan-test')
    monkeypatch.setenv('MONGODB_URI', 'mongodb://127.0.0.1:27019')
    get_settings.cache_clear()
    from openai import APITimeoutError

    class Client:
        def __init__(self, **_):
            self.responses = self

        def parse(self, **_):
            raise APITimeoutError(request=httpx.Request('POST', 'https://api.openai.com/v1/responses'))
    monkeypatch.setattr('openai.OpenAI', Client)
    with pytest.raises(HTTPException) as caught:
        plan_extraction.call_model([])
    assert caught.value.status_code == 504 and 'kept' in caught.value.detail


def test_text_uses_the_model_when_configured_and_output_is_still_validated(environment, monkeypatch, with_ai):
    client, _ = environment
    setup_user(client, monkeypatch)
    bad = timetable_extraction()
    bad.items[0].startTime = '25:99'  # invalid model output is never trusted
    bad.items[0].repeatUntil = 'next semester'
    monkeypatch.setattr(plan_extraction, 'call_model', lambda inputs: bad)
    body = client.post('/plan/interpret', json={'text': 'my classes'}).json()
    first = body['drafts'][0]
    assert first['draft']['start'] is None and {'start', 'repeat.until'} <= set(first['draft']['unreadable'])
    assert any(i['code'] == 'unreadable' and i['field'] == 'start' for i in first['issues'])
