"""A draft that cannot fit before its deadline is flagged at once, with options; nothing lands after a deadline."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.plan_extraction import parse_text
from schedule_fixtures import add_event, setup_user

NY = ZoneInfo('America/New_York')
NOW = datetime(2026, 11, 5, 0, 44, tzinfo=NY)  # Thursday, before availability opens at 9 AM
TODAY, TOMORROW = '2026-11-05', '2026-11-06'


def draft(minutes=180, deadline=TODAY, due=None, id='d1', **extra):
    return {'id': id, 'title': 'Study', 'minutes': minutes, 'deadline': deadline, 'dueTime': due, **extra}


def review(client, *drafts):
    response = client.post('/plan/review', json={'drafts': list(drafts)})
    assert response.status_code == 200, response.text
    return response.json()


def warning(view):
    return next((i for i in view['issues'] if i['code'] == 'wont_fit'), None)


def options(issue):
    return {o['id']: o for o in issue['options']}


@pytest.fixture
def user(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, now=NOW, start=9 * 60, end=17 * 60)
    return client


def test_chat_text_is_flagged_as_soon_as_it_is_read(user):
    views = user.post('/plan/interpret', json={'text': 'Study 3 hours due in 30 minutes', 'batchId': 'b'}).json()['drafts']
    assert (views[0]['draft']['minutes'], views[0]['draft']['deadline'], views[0]['draft']['dueTime']) == (180, TODAY, 74)
    issue = warning(views[0])
    assert issue['question'] == "Only 30 min left before the deadline, and none of it is in your available hours, so 3 h can't fit."
    assert issue['blocking'] is False and views[0]['ready'] is True


def test_time_left_is_the_message_when_it_is_all_available(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, now=NOW + timedelta(hours=9, minutes=16), start=9 * 60, end=17 * 60)  # 10 AM
    issue = warning(review(client, draft(due=630))[0])  # due 10:30
    assert issue['question'] == "Only 30 min left before the deadline, so 3 h can't fit."


@pytest.mark.parametrize('due, usable', [(600, 50), (570, 30), (720, 150)])
def test_available_time_counts_the_breaks_the_work_needs(user, due, usable):
    issue = warning(review(user, draft(due=due))[0])
    assert issue['question'].startswith(f"Only {usable // 60} h {usable % 60} min of your available" if usable > 60
                                        else f"Only {usable} min of your available")


def test_a_passed_deadline_says_so_and_only_offers_a_new_one(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, now=NOW + timedelta(hours=10), start=9 * 60, end=17 * 60)
    issue = warning(review(client, draft(due=600))[0])
    assert issue['question'] == "The deadline has passed, so 3 h can't fit."
    assert set(options(issue)) == {'move_deadline'}


def test_events_and_the_daily_limit_reduce_what_is_available(user):
    add_event(user, 'Lecture', 9 * 60, 12 * 60, TODAY)
    assert warning(review(user, draft(120, due=720))[0])['question'].startswith('None of your available time')
    assert warning(review(user, draft(300))[0])['question'].startswith('Only 4 h of your available')  # the 4 h limit


def test_a_task_that_fits_is_not_flagged(user):
    assert warning(review(user, draft(180, TOMORROW))[0]) is None
    assert warning(review(user, draft(50, due=600))[0]) is None


def test_other_drafts_and_unselected_items_are_left_alone(user):
    fixed = {'id': 'e1', 'kind': 'fixed_event', 'title': 'Class', 'date': TODAY, 'start': 540, 'end': 600}
    views = review(user, draft(due=600), draft(id='d2', due=600, include=False), fixed, draft(None, id='d3'))
    assert [bool(warning(v)) for v in views] == [True, False, False, False]


def test_a_one_piece_task_is_measured_by_its_longest_free_block(user):
    add_event(user, 'Lecture', 10 * 60, 11 * 60, TODAY)
    assert warning(review(user, draft(40, due=11 * 60, allowSplit=False))[0]) is None
    short = warning(review(user, draft(50, due=9 * 60 + 40, allowSplit=False))[0])
    assert short and 'schedule_what_fits' not in options(short)


def test_a_flexible_event_is_flagged_too(user):
    view = review(user, draft(120, due=600, kind='flexible_event', allowSplit=False))[0]
    assert warning(view)['question'].startswith('Only 1 h of your available')


# ------------------------------------------------------------------ options

def test_shorten_makes_it_fit(user):
    issue = warning(review(user, draft(due=600))[0])
    shorten = options(issue)['shorten']
    assert (shorten['label'], shorten['patch']) == ('Shorten to 50 min', {'minutes': 50})
    assert warning(review(user, {**draft(due=600), **shorten['patch']})[0]) is None


def test_move_deadline_makes_it_fit_and_preview_places_everything(user):
    move = options(warning(review(user, draft(due=74))[0]))['move_deadline']
    assert move['label'] == 'Move the deadline to Thu, Nov 5, 5:00 PM'
    moved = {**draft(due=74), **move['patch']}
    assert warning(review(user, moved)[0]) is None
    proposal = user.post('/plan/preview', json={'drafts': [moved]}).json()
    assert proposal['tasks'][0]['unallocatedMinutes'] == 0


def test_move_deadline_reaches_later_days_and_end_of_day_keeps_a_valid_time(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, now=NOW, start=20 * 60, end=24 * 60)
    move = options(warning(review(client, draft(300, due=74))[0]))['move_deadline']
    assert move['patch'] == {'deadline': TOMORROW, 'dueTime': 1439}


def test_with_no_time_in_the_window_it_asks_for_a_later_deadline(user):
    move = options(warning(review(user, draft(6000, due=74))[0]))['move_deadline']
    assert (move['label'], move['patch']) == ('Choose a later deadline', {})


def test_schedule_what_fits_previews_exactly_that_amount(user):
    issue = warning(review(user, draft(due=600))[0])
    assert options(issue)['schedule_what_fits']['label'] == 'Schedule the 50 min that fits'
    proposal = user.post('/plan/preview', json={'drafts': [draft(due=600)]})
    assert proposal.status_code == 200  # the warning does not block
    assert proposal.json()['tasks'][0]['newMinutes'] == 50


# ------------------------------------------------------------------ never after the deadline

@pytest.mark.parametrize('due', [74, 545, 570, 593, 600, 631, 720, 1021, 1439])
def test_preview_and_fit_check_stop_at_the_deadline(user, due):
    body = {'drafts': [draft(due=due)], 'horizonDays': 7}
    proposal = user.post('/plan/preview', json=body).json()
    work = [s for s in proposal['sessions'] if s['type'] == 'work']
    assert all(s['date'] == TODAY and s['end'] <= (1440 if due == 1439 else due) for s in work)
    check = user.post('/plan/feasibility', json=body).json()
    item = check['items'][0]
    assert item['scheduledMinutes'] + item['unscheduledMinutes'] == 180
    assert item['scheduledMinutes'] == sum(s['end'] - s['start'] for s in work)
    flagged = warning(review(user, draft(due=due))[0])
    assert bool(flagged) == (item['unscheduledMinutes'] > 0)  # the warning and the scheduler agree


def test_a_split_option_stops_at_the_deadline_too(user):
    response = user.post('/plan/split-options', json={'drafts': [draft(due=600), draft(60, id='d2', deadline=TOMORROW)]})
    assert response.status_code == 200, response.text
    for option in response.json()['options']:
        assert all(s['end'] <= 600 for s in option['preview']['sessions'] if s['taskId'] == 'draft:d1')


# ------------------------------------------------------------------ the built-in parser

@pytest.mark.parametrize('text, minutes, deadline, due', [
    ('Study 3 hours due in 30 minutes', 180, TODAY, 74),
    ('Study 30 minutes due in 3 hours', 30, TODAY, 224),
    ('Essay 1 hour due in an hour', 60, TODAY, 104),
    ('Essay 1 hour due in 24 hours', 60, TOMORROW, 44),
])
def test_due_in_counts_from_now_and_is_not_the_length(text, minutes, deadline, due):
    draft_ = parse_text(text, NOW, NY, {})[0]
    assert (draft_.minutes, draft_.deadline, draft_.dueTime) == (minutes, deadline, due)
    assert draft_.title in {'Study', 'Essay'}
