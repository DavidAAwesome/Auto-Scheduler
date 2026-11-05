"""Dates are worked out in code from the user's words and local time, whatever the AI computed."""
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from app import plan_extraction
from app.plan_drafts import PlanDraft, review_draft
from app.plan_extraction import Extraction, LlmItem, next_weekday, parse_text, resolve_stated_dates

NY = ZoneInfo('America/New_York')
THU = datetime(2026, 11, 5, 15, 0, tzinfo=NY)  # Thursday 3 PM
DAYS = [('Monday', 0, '2026-11-09'), ('Tuesday', 1, '2026-11-10'), ('Wednesday', 2, '2026-11-11'), ('Thursday', 3, '2026-11-05'),
        ('Friday', 4, '2026-11-06'), ('Saturday', 5, '2026-11-07'), ('Sunday', 6, '2026-11-08')]
WRONG = '2026-11-04'


def item(source, **extra):
    fields = dict(kind='task', title='Item', sourceText=source, minutes=60, deadlineDate=None, deadlineTime=None, earliestStart=None,
                  priority='High', allowSplit=None, maxSessionMinutes=None, date=None, startTime=None, endTime=None, eventKind=None,
                  location=None, repeatWeekdays=[], repeatStartDate=None, repeatUntil=None, windows=[], dependsOnTitles=[],
                  ambiguousFields=[], unreadableFields=[])
    return LlmItem(**{**fields, **extra})


def read(monkeypatch, *items, now=THU):
    monkeypatch.setattr(plan_extraction, 'call_model', lambda inputs: Extraction(items=list(items), notes=[]))
    return plan_extraction.extract_with_model('text', None, now, NY, [])[0]


# ------------------------------------------------------------------ every weekday from a Thursday

@pytest.mark.parametrize('name, weekday, expected', DAYS)
def test_a_due_weekday_is_the_next_one_whatever_the_ai_said(monkeypatch, name, weekday, expected):
    draft = read(monkeypatch, item(f'Essay due {name}', deadlineDate=WRONG))[0]
    assert draft.deadline == expected and date.fromisoformat(draft.deadline).weekday() == weekday


@pytest.mark.parametrize('name, weekday, expected', DAYS)
def test_an_event_weekday_lands_on_that_weekday_whatever_the_ai_said(monkeypatch, name, weekday, expected):
    item_ = item(f'team meeting {name} 5-6 PM', kind='fixed_event', minutes=None, date='2026-11-07', startTime='17:00', endTime='18:00')
    draft = read(monkeypatch, item_)[0]
    assert (draft.date, date.fromisoformat(draft.date).weekday()) == (expected, weekday)


@pytest.mark.parametrize('name, weekday, expected', DAYS)
def test_the_built_in_parser_agrees(name, weekday, expected):
    assert parse_text(f'Essay 2 hours due {name}', THU, NY, {})[0].deadline == expected
    assert parse_text(f'team meeting {name} 5-6 PM', THU, NY, {})[0].date == expected


@pytest.mark.parametrize('name', ['mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun'])
def test_short_names_work_too(monkeypatch, name):
    draft = read(monkeypatch, item(f'Essay due {name}', deadlineDate=WRONG))[0]
    assert date.fromisoformat(draft.deadline).strftime('%a').lower() == name[:3]
    assert draft.deadline >= '2026-11-05'


# ------------------------------------------------------------------ today only if the time hasn't passed

@pytest.mark.parametrize('minute, expected', [(None, '2026-11-05'), (17 * 60, '2026-11-05'), (15 * 60 + 1, '2026-11-05'),
                                              (15 * 60, '2026-11-12'), (9 * 60, '2026-11-12')])
def test_today_counts_only_until_its_time_passes(minute, expected):
    assert next_weekday(3, THU, minute).isoformat() == expected


def test_a_due_time_already_gone_today_means_next_week(monkeypatch):
    assert read(monkeypatch, item('Essay due Thursday 9am', deadlineDate='2026-11-05', deadlineTime='09:00'))[0].deadline == '2026-11-12'
    assert read(monkeypatch, item('Essay due Thursday 5pm', deadlineDate=WRONG, deadlineTime='17:00'))[0].deadline == '2026-11-05'


def test_an_event_already_started_today_means_next_week():
    assert parse_text('team meeting Thursday 10-11 AM', THU, NY, {})[0].date == '2026-11-12'
    assert parse_text('team meeting Thursday 4-5 PM', THU, NY, {})[0].date == '2026-11-05'


def test_local_time_decides_not_utc():
    late = datetime(2026, 11, 5, 23, 30, tzinfo=NY)  # already Friday in UTC
    assert parse_text('Essay due Friday', late.astimezone(ZoneInfo('UTC')), NY, {})[0].deadline == '2026-11-06'
    tokyo = ZoneInfo('Asia/Tokyo')
    assert parse_text('Essay due Friday', THU.astimezone(ZoneInfo('UTC')), tokyo, {})[0].deadline == '2026-11-06'  # Friday there


# ------------------------------------------------------------------ other date words

@pytest.mark.parametrize('words, expected', [('today', '2026-11-05'), ('tomorrow', '2026-11-06'), ('Dec 12', '2026-12-12'), ('12/12', '2026-12-12')])
def test_other_date_words_are_worked_out_in_code_too(monkeypatch, words, expected):
    assert read(monkeypatch, item(f'Essay due {words}', deadlineDate=WRONG))[0].deadline == expected


def test_no_date_words_keeps_the_readers_date(monkeypatch):
    assert read(monkeypatch, item('Essay due at the end of the month', deadlineDate='2026-11-30'))[0].deadline == '2026-11-30'


def test_the_deadline_is_the_date_after_due_not_another_date(monkeypatch):
    draft = read(monkeypatch, item('Essay after Monday, due Friday', deadlineDate=WRONG))[0]
    assert draft.deadline == '2026-11-06'
    assert read(monkeypatch, item('Essay not before Monday, due Friday', deadlineDate=WRONG))[0].deadline == '2026-11-06'


def test_a_weekly_event_is_left_as_weekly(monkeypatch):
    item_ = item('Gym every Monday 6-7pm', kind='flexible_event', minutes=None, repeatWeekdays=[0], startTime='18:00', endTime='19:00')
    draft = read(monkeypatch, item_)[0]
    assert draft.repeat.weekdays == [0] and draft.date is None


def test_sometime_saturday_moves_its_earliest_start_with_the_date():
    draft = PlanDraft(id='d1', kind='flexible_event', title='Gym', minutes=60, deadline=WRONG, earliestStart=f'{WRONG}T00:00:00',
                      sourceText='gym sometime Saturday')
    moved = resolve_stated_dates(draft, THU)
    assert (moved.deadline, moved.earliestStart) == ('2026-11-07', '2026-11-07T00:00:00')


def test_one_message_read_twice_as_two_kinds_is_one_item(monkeypatch):
    source = 'team meeting Monday 10-11 AM'
    fixed = item(source, kind='fixed_event', title='Team Meeting', minutes=None, date='2026-11-09', startTime='10:00', endTime='11:00')
    empty = item(source, kind='flexible_event', title='Team Meeting', minutes=None)
    assert [d.kind for d in read(monkeypatch, fixed, empty)] == ['fixed_event']


# ------------------------------------------------------------------ past dates are flagged

@pytest.mark.parametrize('extra', [{'deadline': '2026-11-04'}, {'deadline': '2026-11-05', 'dueTime': 14 * 60}])
def test_a_past_due_date_is_flagged(extra):
    view = review_draft(PlanDraft(id='d1', title='Essay', minutes=60, **extra), THU, NY)
    issue = next(i for i in view.issues if i.code == 'past')
    assert issue.field == 'deadline' and 'has passed' in issue.question and issue.blocking is False


def test_a_past_event_date_is_flagged():
    draft = PlanDraft(id='d1', kind='fixed_event', title='Class', date='2026-11-05', start=600, end=660)
    assert any(i.code == 'past' for i in review_draft(draft, THU, NY).issues)
    assert not any(i.code == 'past' for i in review_draft(draft.model_copy(update={'date': '2026-11-06'}), THU, NY).issues)


@pytest.mark.parametrize('extra', [{'deadline': '2026-11-05'}, {'deadline': '2026-11-05', 'dueTime': 16 * 60}, {'deadline': '2026-11-06'}])
def test_a_date_still_ahead_is_not_flagged(extra):
    assert not any(i.code == 'past' for i in review_draft(PlanDraft(id='d1', title='Essay', minutes=60, **extra), THU, NY).issues)


def test_a_reader_date_in_the_past_with_no_date_words_is_flagged(monkeypatch):
    draft = read(monkeypatch, item('Essay soon', deadlineDate=WRONG))[0]
    assert any(i.code == 'past' for i in review_draft(draft, THU, NY).issues)


@pytest.mark.parametrize('field', ['location', 'date', 'start', 'end', 'repeat.until'])
@pytest.mark.parametrize('flag', ['unreadable', 'ambiguous'])
def test_a_task_is_never_stopped_by_a_field_it_does_not_have(field, flag):
    view = review_draft(PlanDraft(id='d1', title='Read notes', minutes=30, deadline='2026-11-06', **{flag: [field]}), THU, NY)
    assert view.ready and not any(i.blocking for i in view.issues)


def test_an_unreadable_place_does_not_stop_an_event():
    draft = PlanDraft(id='d1', kind='fixed_event', title='Class', date='2026-11-06', start=600, end=660, unreadable=['location'])
    assert review_draft(draft, THU, NY).ready
