"""Input interpretation: text and images become editable drafts. AI responses are mocked; no network."""
import base64
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app import plan_extraction
from app.config import get_settings
from app.plan_drafts import PlanDraft, draft_task, review_draft
from app.plan_extraction import (
    Extraction, LlmItem, LlmWindow, _convert_item, apply_answer, drafts_from_extraction, parse_text, without_asides,
)
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


# ------------------------------------------------------------------ preferred times are optional

def flexible_item(windows, ambiguous=()):
    return LlmItem(kind='task', title='Essay', sourceText='Essay', minutes=120, deadlineDate='2026-10-30', deadlineTime=None,
                   earliestStart=None, priority='High', allowSplit=None, maxSessionMinutes=None, date=None, startTime=None,
                   endTime=None, eventKind=None, location=None, repeatWeekdays=[], repeatStartDate=None, repeatUntil=None,
                   windows=windows, dependsOnTitles=[], ambiguousFields=list(ambiguous), unreadableFields=[])


@pytest.mark.parametrize('windows', [[], [LlmWindow(weekdays=[], start='', end='')]])
def test_missing_preferred_times_never_block_a_draft_and_leave_it_on_availability(windows):
    draft = _convert_item(flexible_item(windows), 0, {})
    view = review_draft(draft, NOW, NY)
    assert view.ready and not any(i.field == 'windows' for i in view.issues)
    assert draft.windows == [] and draft_task(draft, {draft.id}).windows == []


def test_unreadable_preferred_times_are_a_note_not_a_question():
    draft = _convert_item(flexible_item([LlmWindow(weekdays=[0], start='evening', end='late')]), 0, {})
    assert draft.windows == [] and 'windows' in draft.unreadable
    view = review_draft(draft, NOW, NY)
    issue = next(i for i in view.issues if i.field == 'windows')
    assert view.ready and not issue.blocking
    assert 'preferred times' in issue.question and 'windows' not in issue.question


@pytest.mark.parametrize('field', ['unreadable', 'ambiguous'])
def test_drafts_already_flagged_on_windows_are_released(field):
    """Drafts held in a browser from before this change still carry the flag."""
    draft = PlanDraft(id='d1', title='Essay', minutes=120, deadline='2026-10-30', **{field: ['windows']})
    assert review_draft(draft, NOW, NY).ready


# ------------------------------------------------------------------ one-time events

def event_extraction(source, weekdays=(1,), **extra):
    return Extraction(notes=[], items=[LlmItem(**{**flexible_item([]).model_dump(), 'kind': 'fixed_event', 'title': 'Class', 'sourceText': source,
                                                  'minutes': None, 'deadlineDate': None, 'startTime': '10:00', 'endTime': '11:30',
                                                  'eventKind': 'Class', 'repeatWeekdays': list(weekdays), **extra})])


def extract(monkeypatch, extraction, image=None):
    monkeypatch.setattr(plan_extraction, 'call_model', lambda inputs: extraction)
    return plan_extraction.extract_with_model('text', image, NOW, NY, [])[0][0]


def test_one_weekday_with_no_repeat_wording_is_one_event(monkeypatch):
    draft = extract(monkeypatch, event_extraction('class Tue 10-11:30', ambiguousFields=['repeatUntil']))
    assert draft.repeat is None and draft.date == '2026-10-27' and draft.ambiguous == []
    assert review_draft(draft, NOW, NY).ready


@pytest.mark.parametrize('source, weekdays, image', [
    ('class every Tue 10-11:30', (1,), None), ('class Tuesdays 10-11:30', (1,), None),
    ('class Tue/Thu 10-11:30', (1, 3), None), ('CS101 Tu 10:00-11:30', (1,), ('image/png', b'x')),
])
def test_stated_repeats_and_timetables_stay_weekly(monkeypatch, source, weekdays, image):
    assert extract(monkeypatch, event_extraction(source, weekdays), image).repeat.weekdays == list(weekdays)


# ------------------------------------------------------------------ values the user did not state

@pytest.mark.parametrize('stated, kept', [
    ('2026-10-26', None),  # today: already passed at 8 AM
    ('2026-10-20T09:00', None),
    ('2026-10-29', '2026-10-29T00:00:00'),
    ('2026-10-29T14:00:00', '2026-10-29T14:00:00'),
])
def test_not_before_is_kept_only_when_it_limits_anything(monkeypatch, stated, kept):
    item = {**flexible_item([]).model_dump(), 'earliestStart': stated}
    assert extract(monkeypatch, Extraction(notes=[], items=[LlmItem(**item)])).earliestStart == kept


@pytest.mark.parametrize('limit, kept', [(120, None), (240, None), (45, 45)])
def test_a_session_limit_of_the_whole_task_is_not_a_limit(monkeypatch, limit, kept):
    item = {**flexible_item([]).model_dump(), 'maxSessionMinutes': limit}
    assert extract(monkeypatch, Extraction(notes=[], items=[LlmItem(**item)])).maxSessionMinutes == kept


@pytest.mark.parametrize('kind, expected', [('Class', 'Class'), ('Meeting', 'Meeting'), ('Other', None)])
def test_an_unnamed_event_takes_the_name_of_its_kind(monkeypatch, kind, expected):
    extraction = event_extraction('class Tue 10-11:30', title=None, eventKind=kind, ambiguousFields=['title'])
    draft = extract(monkeypatch, extraction)
    assert draft.title == expected
    assert ('title' in draft.ambiguous) == (expected is None)


def test_an_item_the_model_returns_twice_becomes_one_draft():
    lab = {**flexible_item([]).model_dump(), 'title': 'Lab report', 'minutes': 180}
    extraction = Extraction(notes=[], items=[LlmItem(**flexible_item([]).model_dump()), LlmItem(**lab),
                                             LlmItem(**{**lab, 'title': 'lab report '}), LlmItem(**{**lab, 'minutes': 60})])
    assert [(d.id, d.title, d.minutes) for d in drafts_from_extraction(extraction)] == [
        ('d1', 'Essay', 120), ('d2', 'Lab report', 180), ('d3', 'Lab report', 60)]


# ------------------------------------------------------------------ set times make a fixed event

def parsed(text):
    drafts = parse_text(text, NOW, NY, {})
    assert len(drafts) == 1
    return drafts[0]


@pytest.mark.parametrize('text, weekdays, start, end', [
    ('Gym every Monday and Wednesday 9–5', [0, 2], 540, 1020),
    ('Gym every Monday and Wednesday 9-5', [0, 2], 540, 1020),
    ('gym every mon and wed 9 to 5', [0, 2], 540, 1020),
    ('Gym every Friday 6-7pm', [4], 1080, 1140),
    ('Yoga Mondays and Wednesdays 10:30-11:30am', [0, 2], 630, 690),
])
def test_every_weekday_with_times_is_a_weekly_fixed_event(text, weekdays, start, end):
    draft = parsed(text)
    assert draft.kind == 'fixed_event' and draft.repeat.weekdays == weekdays and (draft.start, draft.end) == (start, end)
    assert (draft.minutes, draft.deadline, draft.earliestStart) == (None, None, None)
    asked = {i.field for i in review_draft(draft, NOW, NY).issues if i.blocking}
    assert 'deadline' not in asked and 'repeat' not in asked and asked <= {'repeat.startDate', 'repeat.until'}


def test_a_stated_day_with_times_is_a_one_time_fixed_event():
    draft = parsed('Gym Monday 9-5')
    assert (draft.kind, draft.date, draft.start, draft.end, draft.repeat) == ('fixed_event', '2026-10-26', 540, 1020, None)
    assert review_draft(draft, NOW, NY).ready


def test_a_range_that_could_be_morning_or_evening_is_still_asked_about():
    draft = parsed('Gym every Monday 9-10')
    assert draft.kind == 'fixed_event' and {'start', 'end'} <= set(draft.ambiguous)


@pytest.mark.parametrize('text, kind', [
    ('Read chapters 2-3 by Friday', 'task'), ('Review chapters 2-3 on Friday 1 hour', 'task'),
    ('Essay 2-3 hours due Friday', 'task'), ('gym sometime Saturday 1 hour', 'flexible_event'),
])
def test_numbers_that_are_not_clock_times_stay_as_they_were(text, kind):
    draft = parsed(text)
    assert draft.kind == kind and draft.start is None and draft.end is None


def gym_item(**extra):
    return LlmItem(**{**flexible_item([]).model_dump(), 'kind': 'flexible_event', 'title': 'Gym', 'minutes': 480, 'deadlineDate': None,
                      'priority': None, 'sourceText': 'Gym every Monday and Wednesday 9–5', **extra})


@pytest.mark.parametrize('extra', [
    {'repeatWeekdays': [0, 2], 'startTime': '09:00', 'endTime': '17:00'},
    {'repeatWeekdays': [0, 2], 'windows': [LlmWindow(weekdays=[0, 2], start='09:00', end='17:00')]},
    {'windows': [LlmWindow(weekdays=[0, 2], start='09:00', end='17:00')]},
    {'repeatWeekdays': [0, 2], 'startTime': '09:00', 'endTime': '05:00', 'ambiguousFields': ['startTime', 'endTime', 'minutes']},
])
def test_the_ai_reading_gym_as_flexible_becomes_a_weekly_fixed_event(extra):
    draft = _convert_item(gym_item(**extra), 0, {})
    assert draft.kind == 'fixed_event' and draft.repeat.weekdays == [0, 2] and (draft.start, draft.end) == (540, 1020)
    assert (draft.minutes, draft.deadline, draft.windows, draft.ambiguous, draft.assumed) == (None, None, [], [], [])
    issues = review_draft(draft, NOW, NY).issues
    assert {i.field for i in issues if i.blocking} == {'repeat.startDate', 'repeat.until'}
    assert not any('Repeating flexible' in i.question or 'By when' in i.question for i in issues)


def test_every_weekday_with_no_time_asks_for_the_time_instead_of_refusing():
    draft = _convert_item(gym_item(minutes=None, repeatWeekdays=[0]), 0, {})
    assert draft.kind == 'fixed_event'
    assert {'start', 'end'} <= {i.field for i in review_draft(draft, NOW, NY).issues if i.blocking}


def test_the_ai_reading_a_dated_time_range_as_a_task_becomes_a_one_time_fixed_event():
    item = gym_item(kind='task', date='2026-10-27', startTime='09:00', endTime='10:00', minutes=60, sourceText='Gym Tue 9-10am')
    draft = _convert_item(item, 0, {})
    assert (draft.kind, draft.date, draft.start, draft.end, draft.minutes) == ('fixed_event', '2026-10-27', 540, 600, None)


@pytest.mark.parametrize('extra', [
    {'minutes': 60, 'windows': [LlmWindow(weekdays=[0, 1, 2, 3, 4], start='17:00', end='21:00')], 'sourceText': 'Gym 1 hour weekday evenings', 'deadlineDate': '2026-10-30'},
    {'minutes': 60, 'deadlineDate': '2026-10-31', 'sourceText': 'Gym 1 hour sometime Saturday'},
])
def test_activities_with_a_length_and_no_set_time_stay_flexible(extra):
    assert _convert_item(gym_item(**extra), 0, {}).kind == 'flexible_event'


def test_a_task_with_a_deadline_stays_a_task_and_still_needs_one_without():
    assert _convert_item(flexible_item([]), 0, {}).kind == 'task'
    no_deadline = LlmItem(**{**flexible_item([]).model_dump(), 'deadlineDate': None})
    assert any(i.field == 'deadline' and i.blocking for i in review_draft(_convert_item(no_deadline, 0, {}), NOW, NY).issues)


@pytest.mark.parametrize('field', ['deadline', 'minutes', 'earliestStart', 'dueTime'])
@pytest.mark.parametrize('flag', ['unreadable', 'ambiguous'])
def test_a_fixed_event_is_never_asked_about_fields_it_does_not_have(field, flag):
    draft = PlanDraft(id='d1', kind='fixed_event', title='Gym', date='2026-10-27', start=540, end=600, **{flag: [field]})
    view = review_draft(draft, NOW, NY)
    assert view.ready and view.issues == []


# ------------------------------------------------------------------ checks use the current values

@pytest.mark.parametrize('flag', ['unreadable', 'ambiguous'])
def test_a_field_with_a_value_is_never_asked_about(flag):
    draft = PlanDraft(id='d1', title='Read chapter', minutes=10, deadline='2026-10-30', location='Library', **{flag: ['title', 'minutes', 'location']})
    view = review_draft(draft, NOW, NY)
    assert view.ready and view.issues == []
    assert (view.draft.unreadable, view.draft.ambiguous) == ([], [])  # the highlight goes too


def test_the_ai_flagging_a_name_it_also_returned_needs_no_answer():
    item = LlmItem(**{**flexible_item([]).model_dump(), 'title': 'Read chapter', 'unreadableFields': ['title']})
    assert review_draft(_convert_item(item, 0, {}), NOW, NY).ready


def test_a_flagged_field_with_no_value_is_still_asked_about():
    draft = PlanDraft(id='d1', title=None, minutes=None, deadline='2026-10-30', unreadable=['title', 'minutes'])
    view = review_draft(draft, NOW, NY)
    assert {i.field for i in view.issues if i.blocking} == {'title', 'minutes'} and not view.ready
    filled = review_draft(view.draft.model_copy(update={'title': 'Read', 'minutes': 30}), NOW, NY)
    assert filled.ready and filled.issues == []


@pytest.mark.parametrize('field, extra', [
    ('start', {'kind': 'fixed_event', 'title': 'Class', 'date': '2026-10-27', 'start': 600, 'end': 690}),
    ('deadline', {'title': 'Essay', 'minutes': 60, 'deadline': '2026-10-30'}),
])
def test_a_value_that_is_itself_in_doubt_is_still_confirmed(field, extra):
    view = review_draft(PlanDraft(id='d1', ambiguous=[field], **extra), NOW, NY)
    assert any(i.field == field and i.blocking for i in view.issues)


# ------------------------------------------------------------------ too short to split

@pytest.mark.parametrize('minutes, shortest, can_split', [(10, None, False), (25, None, False), (30, None, True), (60, 40, False), (80, 40, True)])
def test_short_tasks_become_one_session(minutes, shortest, can_split):
    draft = PlanDraft(id='d1', title='Read', minutes=minutes, deadline='2026-10-30', allowSplit=True, minSessionMinutes=shortest)
    task = draft_task(draft, {'d1'})
    assert task.allowSplit is can_split
    if not can_split:
        assert task.maxSessionMinutes >= minutes


# ------------------------------------------------------------------ parenthetical notes

@pytest.mark.parametrize('text, expected', [
    ("Read chapter, 10 minutes, due Friday (I'm so tired)", 'Read chapter, 10 minutes, due Friday'),
    ('Essay (ugh) 2 hours due Friday (wish me luck!)', 'Essay 2 hours due Friday'),
    ('Essay (2 hours) due Friday', 'Essay (2 hours) due Friday'),
    ('Lab report (due Friday)', 'Lab report (due Friday)'),
    ('Review (high priority) 1 hour due Monday', 'Review (high priority) 1 hour due Monday'),
    ('Class 10-11am Tuesday (Room 204)', 'Class 10-11am Tuesday (Room 204)'),
    ('Essay 2 hours due Friday', 'Essay 2 hours due Friday'),
])
def test_notes_in_parentheses_go_unless_they_are_details(text, expected):
    assert without_asides(text) == expected


def test_a_note_never_reaches_the_task_name(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    view = client.post('/plan/interpret', json={'text': "Read chapter, 10 minutes, due Friday (I'm so tired)", 'batchId': 'b'}).json()['drafts'][0]
    assert (view['draft']['title'], view['draft']['minutes']) == ('Read chapter', 10)
    assert 'tired' not in view['draft']['sourceText']
