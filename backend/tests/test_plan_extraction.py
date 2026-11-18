"""Input interpretation: text and images become editable drafts. AI responses are mocked; no network."""
import base64
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app import plan_extraction
from app.config import get_settings
from app.plan_drafts import review_all, review_draft
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
    text = '\n'.join(item.sourceText for item in bad.items)  # typed items must come from the message itself
    body = client.post('/plan/interpret', json={'text': text}).json()
    first = body['drafts'][0]
    assert first['draft']['start'] is None and {'start', 'repeat.until'} <= set(first['draft']['unreadable'])
    assert any(i['code'] == 'unreadable' and i['field'] == 'start' for i in first['issues'])


# ---------------------------------------------------------------- natural-language regressions
# NOW is Monday 2026-10-26 8:00 AM in New York (schedule_fixtures).

def one(text):
    return parse_text(text, NOW, NY)[0]


def test_next_weekday_is_the_following_week_and_the_reading_is_stated_not_blocking():
    draft = one('Essay due next Friday 3 hours')
    assert draft.deadline == '2026-11-06'  # the Friday of next week, not this Friday (Oct 30)
    view = review_draft(draft, NOW, NY)
    assert view.ready
    assert any('as Fri, Nov 6' in i.question and not i.blocking for i in view.issues)
    assert one('Essay due Friday 3 hours').deadline == '2026-10-30'


def test_bare_due_hour_is_a_time_asked_as_am_or_pm_and_never_left_in_the_title():
    draft = one('Essay due Friday at 5, 2 hours')
    assert (draft.title, draft.deadline, draft.dueTime) == ('Essay', '2026-10-30', 17 * 60)
    view = review_draft(draft, NOW, NY)
    assert [i.question for i in view.issues if i.blocking] == ['Is "Essay" due at 5 AM or 5 PM?']
    answered = apply_answer(draft, 'dueTime', 'AM', NOW, NY)
    assert answered.dueTime == 5 * 60 and 'dueTime' not in answered.ambiguous


def test_part_of_day_deadline_uses_its_start_and_says_so():
    draft = one('Essay, 2 hours, due tomorrow morning')
    assert (draft.deadline, draft.dueTime) == ('2026-10-27', 8 * 60)
    view = review_draft(draft, NOW, NY)
    assert view.ready
    assert any('8:00 AM' in i.question and not i.blocking for i in view.issues)


def test_stated_work_time_is_a_preferred_start_not_a_deadline_or_event():
    draft = one('Work on essay tomorrow at 3pm for 2 hours, due Friday')
    assert (draft.kind, draft.title) == ('task', 'Work on essay')
    assert (draft.deadline, draft.earliestStart) == ('2026-10-30', '2026-10-27T15:00:00')
    assert draft.date is None and draft.start is None


def test_after_something_not_on_the_list_asks_when_it_can_start():
    draft = one('Read chapter 3 after class, 1 hour, due Friday')
    view = review_draft(draft, NOW, NY)
    assert not view.ready
    assert 'comes after something that isn\'t on your list (class)' in view.issues[0].question
    answered = apply_answer(draft, 'earliestStart', 'Tuesday 2pm', NOW, NY)
    assert answered.earliestStart == '2026-10-27T14:00:00'
    assert review_draft(answered, NOW, NY).ready
    # A time alone means the next time it comes round.
    assert apply_answer(draft, 'earliestStart', '2pm', NOW, NY).earliestStart == '2026-10-26T14:00:00'


def llm_task(title, source, minutes=60, deadline='2026-10-30', ambiguous=()):
    return LlmItem(kind='task', title=title, sourceText=source, minutes=minutes, deadlineDate=deadline, deadlineTime=None,
                   earliestStart=None, priority=None, allowSplit=None, maxSessionMinutes=None, date=None, startTime=None,
                   endTime=None, eventKind=None, location=None, repeatWeekdays=[], repeatStartDate=None, repeatUntil=None,
                   windows=[], dependsOnTitles=[], ambiguousFields=list(ambiguous), unreadableFields=[])


def test_ai_extraction_drops_phantom_and_repeated_items_and_stray_after_questions():
    from app.plan_extraction import drafts_from_extraction
    extraction = Extraction(items=[
        llm_task('Read chapter 3', 'Read chapter 3 after class, 1 hour, due Friday', ambiguous=['earliestStart']),
        llm_task('Read chapter 3', 'Read chapter 3 after class, 1 hour, due Friday'),  # repeated
        llm_task('', '', minutes=None),  # phantom: nothing to act on
        llm_task('Reading', 'Reading due Friday at 5, 2 hours', minutes=120, ambiguous=['earliestStart']),
    ], notes=[])
    drafts = drafts_from_extraction(extraction)
    assert [(d.title, d.ambiguous) for d in drafts] == [('Read chapter 3', ['earliestStart']), ('Reading', [])]


def test_ai_extraction_fills_missing_titles_and_dates_from_the_item_text():
    """gpt-4o-mini often leaves out names and plain days; the built-in parser reads them from the item's own text."""
    from app.plan_extraction import drafts_from_extraction
    lab = llm_task('', 'Lab report 90 min due tomorrow high priority', minutes=90)
    meeting = LlmItem(**{**llm_task('', 'Advisor meeting today 11-11:30am', minutes=None).model_dump(),
                         'kind': 'fixed_event', 'deadlineDate': None, 'date': None, 'startTime': '11:00',
                         'endTime': '11:30'})
    gym = LlmItem(**{**llm_task('', 'Gym 30 min sometime today, low priority', minutes=30).model_dump(),
                     'kind': 'flexible_event', 'deadlineDate': None})
    unreadable = LlmItem(**{**llm_task('', 'C$#@ 101 Mon 9-10am').model_dump(), 'unreadableFields': ['title']})
    drafts = drafts_from_extraction(Extraction(items=[lab, meeting, gym, unreadable], notes=[]), date(2026, 10, 26))
    assert [d.title for d in drafts] == ['Lab report', 'Advisor meeting', 'Gym', None]
    # Plain days the model left out are read from the same text: the meeting is today, Gym is by today.
    assert (drafts[1].date, drafts[2].deadline) == ('2026-10-26', '2026-10-26')
    # A day the model flagged as unclear is still asked about, not filled in.
    flagged = LlmItem(**{**llm_task('Essay', 'Essay due Friday', deadline=None).model_dump(), 'ambiguousFields': ['deadlineDate']})
    assert drafts_from_extraction(Extraction(items=[flagged], notes=[]), date(2026, 10, 26))[0].deadline is None
    assert 'title' in drafts[3].unreadable  # a name the model could not read is still asked about


def test_ai_weekdays_follow_the_day_names_and_time_questions_need_a_time():
    from app.plan_extraction import drafts_from_extraction
    choir = LlmItem(**{**llm_task('Choir rehearsal', 'Choir rehearsal every Sat and Sun 9:00am-10:00am from Oct 31 until Nov 8',
                                  minutes=None, deadline=None).model_dump(),
                       'kind': 'fixed_event', 'startTime': '09:00', 'endTime': '10:00', 'repeatWeekdays': [0, 6],
                       'repeatStartDate': '2026-10-31', 'repeatUntil': '2026-11-08'})
    gym = LlmItem(**{**llm_task('Gym', 'Gym 30 min sometime today', minutes=30, deadline='2026-10-26').model_dump(),
                     'kind': 'flexible_event', 'ambiguousFields': ['startTime', 'endTime']})
    drafts = drafts_from_extraction(Extraction(items=[choir, gym], notes=[]), date(2026, 10, 26))
    assert drafts[0].repeat.weekdays == [5, 6]  # Saturday and Sunday, not Monday and Sunday
    assert drafts[1].ambiguous == []  # no "Is the end time of Gym AM or PM?" without a time


def test_ai_fragments_of_one_line_collapse_and_noon_is_not_an_am_pm_question():
    from app.plan_extraction import drafts_from_extraction
    whole = 'Gym 30 min sometime today, low priority'
    items = [LlmItem(**{**llm_task('Gym', whole, minutes=30, deadline='2026-10-26').model_dump(), 'kind': 'flexible_event'}),
             llm_task('Gym', '30 min', minutes=30, deadline=None), llm_task('Gym', 'low priority', minutes=None, deadline=None),
             LlmItem(**{**llm_task('Lab report', 'Lab report 60 min due tomorrow at noon').model_dump(),
                        'deadlineTime': '12:00', 'ambiguousFields': ['deadlineTime']})]
    drafts = drafts_from_extraction(Extraction(items=items, notes=[]), date(2026, 10, 26))
    assert [(d.title, d.sourceText) for d in drafts] == [('Gym', whole), ('Lab report', 'Lab report 60 min due tomorrow at noon')]
    assert drafts[1].dueTime == 720 and drafts[1].ambiguous == []


def test_ai_items_are_cross_checked_against_the_built_in_reading():
    from app.plan_extraction import LlmWindow, drafts_from_extraction
    meeting = LlmItem(**{**llm_task('Advisor meeting', 'Advisor meeting today 11-11:30am', minutes=None).model_dump(),
                         'kind': 'fixed_event', 'date': None, 'deadlineDate': '2026-10-26', 'startTime': '11:00',
                         'endTime': '11:30', 'ambiguousFields': ['startTime', 'endTime']})
    gym = LlmItem(**{**llm_task('Gym', 'Gym 30 min sometime today, low priority', minutes=30).model_dump(),
                     'kind': 'flexible_event', 'allowSplit': True,
                     'windows': [LlmWindow(weekdays=[0], start='08:00', end='23:59')]})
    lab = llm_task('Lab report', 'Lab report 90 min due tomorrow', minutes=90)
    slides = llm_task('Lab slides', 'Lab slides 30 min due tomorrow after Lab report', minutes=30,
                      ambiguous=['earliestStart'])
    drafts = drafts_from_extraction(Extraction(items=[meeting, gym, lab, slides], notes=[]), date(2026, 10, 26))
    assert (drafts[0].date, drafts[0].start, drafts[0].end, drafts[0].ambiguous) == ('2026-10-26', 660, 690, [])
    assert drafts[1].allowSplit is None and drafts[1].unreadable == []  # one block; "23:59" snaps to end of day
    assert (drafts[1].windows[0].start, drafts[1].windows[0].end) == (480, 1440)
    assert drafts[3].dependsOn == [drafts[2].id] and drafts[3].ambiguous == []

    exam = LlmItem(**{**llm_task('Mock exam', 'Mock exam 2 hours in one sitting due tomorrow', minutes=120).model_dump(),
                      'allowSplit': None})
    assert drafts_from_extraction(Extraction(items=[exam], notes=[]), date(2026, 10, 26))[0].allowSplit is False


def test_a_list_of_days_with_a_time_is_one_event_per_day():
    from app.plan_extraction import expand_day_list
    monday = datetime(2026, 11, 16, 15, 0, tzinfo=NY)
    drafts = parse_text('Soccer practice Sat and Sun 9-10am', monday, NY)
    assert [(d.kind, d.title, d.date, d.start, d.end, d.repeat) for d in drafts] == [
        ('fixed_event', 'Soccer practice', '2026-11-21', 540, 600, None),
        ('fixed_event', 'Soccer practice', '2026-11-22', 540, 600, None)]
    assert [d.date for d in parse_text('Gym Mon, Wed and Fri 6-7pm', monday, NY)] == ['2026-11-16', '2026-11-18', '2026-11-20']
    # Recurring wording, deadlines and lines without a time stay one item.
    for text in ('Soccer practice every Sat and Sun 9-10am', 'Soccer practice Saturdays and Sundays 9-10am',
                 'Essay due Fri and Sat 2 hours', 'Meet Monday and Tuesday'):
        assert expand_day_list(text) == [text]


def test_a_model_date_for_a_named_day_is_checked_against_the_calendar():
    from app.plan_extraction import drafts_from_extraction
    # gpt-4o-mini read "Soccer practice Sat 9-10am" (on Monday Nov 16) as a weekly series starting Thu Nov 19.
    wrong = LlmItem(**{**llm_task('Soccer practice', 'Soccer practice Sat 9-10am', minutes=None, deadline=None).model_dump(),
                       'kind': 'fixed_event', 'date': '2026-11-19', 'startTime': '09:00', 'endTime': '10:00',
                       'repeatWeekdays': [5]})
    draft = drafts_from_extraction(Extraction(items=[wrong], notes=[]), date(2026, 11, 16))[0]
    assert (draft.kind, draft.date, draft.start, draft.end, draft.repeat) == ('fixed_event', '2026-11-21', 540, 600, None)


def test_ai_items_the_message_never_mentions_are_dropped(environment, monkeypatch, with_ai):
    """gpt-4o-mini returned the saved task "Lab report" as a new item for "Lunch with Sam at noon tomorrow"."""
    client, _ = environment
    setup_user(client, monkeypatch)
    lunch = LlmItem(**{**llm_task('Lunch with Sam', 'Lunch with Sam at noon tomorrow', minutes=30, deadline='2026-10-27').model_dump(),
                       'kind': 'flexible_event'})
    ghost = llm_task('Lab report', 'Lab report', minutes=None, deadline=None)
    monkeypatch.setattr(plan_extraction, 'call_model', lambda inputs: Extraction(items=[lunch, ghost], notes=[]))
    drafts = [v['draft'] for v in client.post('/plan/interpret', json={'text': 'Lunch with Sam at noon tomorrow'}).json()['drafts']]
    # Only Lunch, and as an appointment: 12-1 PM tomorrow (1 hour assumed), not a 30-minute flexible item.
    assert [(d['title'], d['kind'], d['date'], d['start'], d['end']) for d in drafts] == \
        [('Lunch with Sam', 'fixed_event', '2026-10-27', 720, 780)]
    assert drafts[0]['deadline'] is None and drafts[0]['dueTime'] is None and 'end' in drafts[0]['assumed']


def test_a_single_clock_time_on_a_day_is_a_one_hour_appointment():
    lunch = one('Lunch with Sam at noon tomorrow')
    assert (lunch.kind, lunch.title, lunch.date, lunch.start, lunch.end, lunch.assumed) == \
        ('fixed_event', 'Lunch with Sam', '2026-10-27', 720, 780, ['end'])
    view = review_draft(lunch, NOW, NY)
    assert view.ready and any('assumed 1 hour' in i.question and not i.blocking for i in view.issues)
    assert (one('Dentist Friday 3pm').start, one('Dentist Friday 3pm').end) == (900, 960)
    # A deadline or a length keeps its meaning.
    assert one('Essay due tomorrow at 5pm 2 hours').kind == 'task'


def test_two_days_with_a_short_source_text_are_not_fragments():
    from app.plan_extraction import drafts_from_extraction
    sat = LlmItem(**{**llm_task('Soccer practice', 'Soccer practice Sat 9-10am', minutes=None, deadline=None).model_dump(),
                     'kind': 'fixed_event', 'date': '2026-11-21', 'startTime': '09:00', 'endTime': '10:00'})
    sun = LlmItem(**{**sat.model_dump(), 'sourceText': 'Soccer practice', 'date': '2026-11-22'})
    drafts = drafts_from_extraction(Extraction(items=[sat, sun], notes=[]), date(2026, 11, 16))
    assert [d.date for d in drafts] == ['2026-11-21', '2026-11-22']


def test_then_splits_work_into_ordered_items():
    drafts = parse_text('Essay draft 2 hours in one sitting, then proofread 30 min after Essay draft', NOW, NY)
    assert [(d.title, d.minutes, d.allowSplit, d.dependsOn) for d in drafts] == [
        ('Essay draft', 120, False, []), ('Proofread', 30, None, ['d1'])]
    assert [d.title for d in parse_text('Study until then 2 hours', NOW, NY)] == ['Study until then']


def test_weekend_next_weekday_and_after_class_fragments():
    tuesday = datetime(2026, 11, 17, 9, 0, tzinfo=NY)
    coffee = parse_text('Coffee with Mia sometime this weekend, 1 hour', tuesday, NY)[0]
    assert (coffee.kind, coffee.title, coffee.deadline, coffee.earliestStart) == \
        ('flexible_event', 'Coffee with Mia', '2026-11-22', '2026-11-21T00:00:00')
    assert parse_text('Report due this weekend 2 hours', tuesday, NY)[0].earliestStart is None
    from app.plan_extraction import drafts_from_extraction
    # The model read "next Friday" (on Tue Nov 17) as Tue Nov 24 at 12 AM: the rule's Fri Nov 27 wins, no time question.
    essay = LlmItem(**{**llm_task('Essay', 'Essay due next Friday 3 hours', minutes=180, deadline='2026-11-24').model_dump(),
                       'deadlineTime': '00:00', 'ambiguousFields': ['deadlineTime']})
    # And split "Read chapter 3 after class, 1 hour, due Friday" into two items with different deadlines.
    whole = llm_task('Read chapter 3', 'Read chapter 3 after class, 1 hour, due Friday', minutes=60, deadline='2026-11-18',
                     ambiguous=['earliestStart'])
    part = llm_task('Read chapter 3', 'Read chapter 3 after class', minutes=None, deadline='2026-11-20')
    weekend = LlmItem(**{**llm_task('Coffee with Mia', 'Coffee with Mia sometime this weekend, 1 hour', deadline='2026-11-20').model_dump(),
                         'kind': 'flexible_event'})
    morning = LlmItem(**{**llm_task('Essay outline', 'Essay outline, 2 hours, due tomorrow morning', minutes=120,
                                    deadline='2026-11-18').model_dump(), 'deadlineTime': '08:00', 'ambiguousFields': ['deadlineTime']})
    drafts = drafts_from_extraction(Extraction(items=[essay, whole, part, weekend, morning], notes=[]), tuesday.date())
    assert [(d.title, d.deadline, d.dueTime) for d in drafts] == [
        ('Essay', '2026-11-27', None), ('Read chapter 3', '2026-11-20', None), ('Coffee with Mia', '2026-11-22', None),
        ('Essay outline', '2026-11-18', 480)]
    assert drafts[0].ambiguous == ['deadline']  # stated as a note: "I read the deadline as Fri, Nov 27"
    assert drafts[2].earliestStart == '2026-11-21T00:00:00'
    assert drafts[3].ambiguous == [] and 'dueTime' in drafts[3].assumed
    views = review_all(drafts, tuesday, NY, set())
    assert not any(i.blocking for i in views[0].issues + views[3].issues)


def test_an_item_the_cross_check_makes_identical_is_kept_once():
    from app.plan_extraction import drafts_from_extraction
    event = LlmItem(**{**llm_task('Lunch with Sam', 'Lunch with Sam at noon tomorrow', minutes=None, deadline=None).model_dump(),
                       'kind': 'fixed_event', 'date': '2026-11-18', 'startTime': '12:00', 'endTime': '13:00'})
    flexible = LlmItem(**{**llm_task('Lunch with Sam', 'Lunch with Sam at noon tomorrow', minutes=30, deadline='2026-11-18').model_dump(),
                          'kind': 'flexible_event'})
    drafts = drafts_from_extraction(Extraction(items=[event, flexible], notes=[]), date(2026, 11, 17))
    assert [(d.kind, d.date, d.start, d.end) for d in drafts] == [('fixed_event', '2026-11-18', 720, 780)]


def llm_event(title, source, day=None, start=None, end=None, deadline=None):
    return LlmItem(**{**llm_task(title, source, minutes=None, deadline=deadline).model_dump(),
                      'kind': 'fixed_event', 'date': day, 'startTime': start, 'endTime': end})


def test_hollow_events_and_renamed_twins_are_dropped():
    """Nov 17 suite: "Gym: fixed, ? time ?" beside the real Gym item, a "due Friday" event lifted out of a task line,
    a hollow "Meeting" lifted out of "before the meeting on Friday", and "Dentist" returned twice under two names."""
    from app.plan_extraction import drafts_from_extraction
    today = date(2026, 11, 17)
    gym = LlmItem(**{**llm_task('Gym', 'Gym 30 min sometime today, low priority', minutes=30, deadline='2026-11-17')
                     .model_dump(), 'kind': 'flexible_event'})
    items = [gym, llm_event('Gym', 'Gym'),
             llm_task('Read chapter 3', 'Read chapter 3 after class, 1 hour, due Friday', deadline='2026-11-20'),
             llm_event('due Friday', 'due Friday'),
             llm_task('Write report', 'Write report before the meeting on Friday, 2 hours', minutes=120, deadline='2026-11-18'),
             llm_event('Meeting', 'before the meeting on Friday', start='15:00', end='16:00')]
    drafts = drafts_from_extraction(Extraction(items=items, notes=[]), today)
    assert [d.title for d in drafts] == ['Gym', 'Read chapter 3', 'Write report']
    assert drafts[2].deadline == '2026-11-20'  # "before the meeting on Friday" is due Friday, not the model's Wednesday
    twins = [llm_event('Dentist', 'Dentist tomorrow at 9am', '2026-11-18', '09:00', '10:00'),
             llm_event('Dentist appointment', 'Dentist tomorrow at 9am', '2026-11-18', '09:00', '10:00')]
    assert [d.title for d in drafts_from_extraction(Extraction(items=twins, notes=[]), today)] == ['Dentist']
    # Two named events that happen to share a time are both kept.
    pair = [llm_event('Dentist', 'Dentist tomorrow at 9am', '2026-11-18', '09:00', '10:00'),
            llm_event('Standup', 'Standup tomorrow at 9am', '2026-11-18', '09:00', '10:00')]
    assert len(drafts_from_extraction(Extraction(items=pair, notes=[]), today)) == 2


def test_event_day_in_deadline_field_assumed_day_and_pm_due_time_are_stated():
    from app.plan_extraction import drafts_from_extraction
    today = date(2026, 11, 17)
    doctor = llm_event('Doctor appt', 'Doctor appt next Tuesday at 2:30', start='14:30', end='15:30', deadline='2026-11-24')
    mom = llm_event('Call mom', 'Call mom at noon', start='12:00', end='13:00', deadline='2026-11-18')
    pset = LlmItem(**{**llm_task('Problem set', 'Problem set due Friday at 5, 2 hours', minutes=120,
                                 deadline='2026-11-20').model_dump(), 'deadlineTime': '17:00'})
    essay = LlmItem(**{**llm_task('Essay', 'Essay due next Friday 3 hours', minutes=180, deadline='2026-11-24')
                       .model_dump(), 'unreadableFields': ['title']})
    week = llm_task('Laundry', 'Laundry, 1 hour, low priority, sometime this week', deadline='2026-11-20')
    d = {x.title: x for x in drafts_from_extraction(Extraction(items=[doctor, mom, pset, essay, week], notes=[]), today)}
    assert (d['Doctor appt'].date, d['Doctor appt'].deadline, d['Doctor appt'].ambiguous) == ('2026-11-24', None, ['date'])
    assert (d['Call mom'].date, d['Call mom'].ambiguous) == ('2026-11-18', ['date'])
    assert d['Problem set'].dueTime == 17 * 60 and 'dueTimeMeridiem' in d['Problem set'].assumed
    assert (d['Essay'].deadline, d['Essay'].unreadable) == ('2026-11-27', [])
    assert 'deadline' in d['Laundry'].ambiguous
    views = {v.draft.title: v for v in review_all(list(d.values()), datetime(2026, 11, 17, 15, tzinfo=NY), NY, set())}
    notes = {t: [i.question for i in v.issues if not i.blocking] for t, v in views.items()}
    assert any('Tue, Nov 24' in n for n in notes['Doctor appt'])
    assert any('as 5:00 PM' in n and '5:00 AM' in n for n in notes['Problem set'])
    assert all(v.ready for v in views.values())  # every reading above is a note, never a blocking question


def test_one_line_read_two_ways_is_one_item_and_an_invented_meeting_is_dropped():
    from app.plan_extraction import drafts_from_extraction
    today = date(2026, 11, 17)
    coffee_text = 'Coffee with Mia sometime this weekend, 1 hour'
    coffee = LlmItem(**{**llm_task('Coffee with Mia', coffee_text, deadline='2026-11-22').model_dump(),
                        'kind': 'flexible_event', 'earliestStart': '2026-11-21T00:00:00'})
    bare = llm_task('Coffee with Mia', coffee_text, deadline=None)
    drafts = drafts_from_extraction(Extraction(items=[bare, coffee], notes=[]), today)
    assert [(d.kind, d.deadline) for d in drafts] == [('flexible_event', '2026-11-22')]
    club = llm_event('Book club', 'Book club on the 28th at 6pm', '2026-11-28', '18:00', '19:00')
    shell = llm_task('Book club', 'Book club on the 28th at 6pm', minutes=None, deadline=None)
    assert [d.kind for d in drafts_from_extraction(Extraction(items=[club, shell], notes=[]), today)] == ['fixed_event']
    report = llm_task('Write report', 'Write report before the meeting on Friday, 2 hours', minutes=120)
    meeting = llm_event('Meeting', 'before the meeting on Friday', '2026-11-18', '14:00', '15:00')
    assert [d.title for d in drafts_from_extraction(Extraction(items=[report, meeting], notes=[]), today)] == ['Write report']
    cover = llm_task('Cover letter', 'Write cover letter half an hour by end of week', minutes=30, deadline='2026-11-18')
    (draft,) = drafts_from_extraction(Extraction(items=[cover], notes=[]), today)
    assert (draft.deadline, draft.ambiguous) == ('2026-11-20', ['deadline'])


def test_an_item_with_a_made_up_name_is_not_from_the_message():
    from app.plan_extraction import _mentioned
    text = 'Book club on the 28th at 6pm'
    assert _mentioned(llm_event('Book club', text, '2026-11-28', '18:00', '19:00'), text)
    assert not _mentioned(llm_task('Check availability', text, minutes=None, deadline=None), text)
    assert _mentioned(llm_task('Essay revisions', 'essay revisons 2hrs due tmrw', minutes=120), 'essay revisons 2hrs due tmrw')
