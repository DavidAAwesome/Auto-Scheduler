"""Split options: the engine's shapes, the rules they must keep, and the preview/apply path through the API."""
from datetime import date, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.scheduling_engine import Busy, EngineTask, Existing, Prefs, local_span, local_to_abs, plan_schedule
from app.workspace import Availability
from firebase_tokens import sign_in
from schedule_fixtures import TODAY, TOMORROW, add_event, add_task, rows, setup_user

NY = ZoneInfo('America/New_York')
MONDAY = date(2026, 10, 26)


def hours(start=540, end=720, days=range(7)):
    return Availability(days=[{'day': d, 'enabled': d in days, 'periods': [{'start': start, 'end': end}]} for d in range(7)],
                        weekOverrides=[], timeZone='America/New_York', reminders=False)


def at(offset: int, minute: int) -> int:
    return local_to_abs(MONDAY + timedelta(days=offset), minute, NY)


def task(id='t', priority='High', minutes=200, due_offset=3, **kw):
    return EngineTask(id, id.upper(), priority, at(due_offset, 1440), minutes, 0, **kw)


def plan(strategy, tasks, events=(), existing=(), availability=None, prefs=Prefs(), days=7):
    return plan_schedule(list(tasks), availability or hours(), prefs, list(events), list(existing), at(0, 480), days,
                         'repair', split=(('t',), strategy))


def work(result, task_id='t'):
    return [s for s in result.sessions if s.task_id == task_id and s.type == 'work']


def per_day(result, task_id='t'):
    out: dict[str, int] = {}
    for s in work(result, task_id):
        day = local_span(s.start, s.end, NY)[0]
        out[day] = out.get(day, 0) + s.end - s.start
    return out


def lengths(result, task_id='t'):
    return [s.end - s.start for s in work(result, task_id)]


# ------------------------------------------------------------------ shapes

def test_front_loaded_finishes_as_early_as_possible():
    result = plan('front_loaded', [task()])
    assert list(per_day(result).values()) == [150, 50]
    assert lengths(result) == [50, 50, 50, 50]


def test_even_gives_each_day_about_the_same_work_up_to_the_deadline():
    result = plan('even', [task(minutes=240)])
    assert sorted(per_day(result)) == ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']
    assert set(per_day(result).values()) == {60}
    assert lengths(result) == [30] * 8  # above the focus limit, so two equal sessions a day
    assert sum(lengths(result)) == 240


def test_even_uses_spaced_days_rather_than_tiny_sessions():
    result = plan('even', [task(minutes=60, due_offset=6)])
    assert per_day(result) == {'2026-10-26': 30, '2026-11-01': 30}


def test_even_moves_work_from_a_full_day_to_the_lightest_days():
    meeting = Busy('m', 'Meeting', at(1, 540), at(1, 720))  # Tuesday is fully booked
    result = plan('even', [task(minutes=240, due_offset=3)], events=[meeting])
    assert '2026-10-27' not in per_day(result)
    assert sum(per_day(result).values()) == 240


def test_fewer_longer_skips_gaps_too_short_for_a_full_block():
    # Monday leaves only a 40-minute gap before the 9:40-12:00 event. Front-loaded uses it; blocks do not.
    event = Busy('m', 'Meeting', at(0, 580), at(0, 720))
    front = plan('front_loaded', [task(minutes=100, due_offset=2)], events=[event])
    blocks = plan('fewer_longer', [task(minutes=100, due_offset=2)], events=[event])
    assert lengths(front) == [40, 50, 10]
    assert lengths(blocks) == [50, 50]


def test_fewer_longer_puts_one_block_on_each_day_while_days_remain():
    result = plan('fewer_longer', [task(minutes=150)])
    assert list(per_day(result).values()) == [50, 50, 50]


def test_fewer_longer_avoids_a_last_piece_below_the_minimum():
    result = plan('fewer_longer', [task(minutes=105)])
    assert lengths(result) == [50, 40, 15]


# ------------------------------------------------------------------ rules every shape keeps

@pytest.mark.parametrize('strategy', ['front_loaded', 'even', 'fewer_longer'])
def test_shapes_keep_availability_events_breaks_deadline_and_session_limits(strategy):
    event = Busy('m', 'Meeting', at(1, 600), at(1, 660))
    target = task(minutes=300, due_offset=2)
    result = plan(strategy, [target], events=[event])
    assert sum(lengths(result)) == 300
    for s in work(result):
        _day, start, end = local_span(s.start, s.end, NY)
        assert 540 <= start and end <= 720
        assert s.end <= target.due
        assert not (s.start < event.end and event.start < s.end)
        assert s.end - s.start <= 50  # the focus limit
    assert min(lengths(result)[:-1]) >= target.min_session
    assert all(b.end - b.start == 10 for b in result.sessions if b.type == 'break')


@pytest.mark.parametrize('strategy', ['even', 'fewer_longer'])
def test_higher_priority_work_is_placed_first_and_keeps_its_time(strategy):
    urgent = task('urgent', priority='High', minutes=150, due_offset=0)
    target = task(priority='Low', minutes=120, due_offset=3)
    result = plan(strategy, [urgent, target])
    alone = plan_schedule([urgent], hours(), Prefs(), [], [], at(0, 480), 7, 'repair')
    assert [(s.start, s.end) for s in work(result, 'urgent')] == [(s.start, s.end) for s in work(alone, 'urgent')]
    assert sum(lengths(result)) == 120


@pytest.mark.parametrize('strategy', ['even', 'fewer_longer'])
def test_locked_work_stays_and_only_the_split_task_is_released(strategy):
    locked = Existing('lock', 't', 'work', 'saved', True, 'manual', at(1, 540), at(1, 570), 'T')
    mine = Existing('mine', 't', 'work', 'saved', False, 'auto', at(0, 540), at(0, 590), 'T')
    other = Existing('oth', 'o', 'work', 'saved', False, 'auto', at(1, 600), at(1, 650), 'O')
    result = plan(strategy, [task(minutes=120), task('o', minutes=50)], existing=[locked, mine, other])
    assert {r.session.id for r in result.removals} == {'mine'}
    changes = {s.id: s.change for s in result.sessions if s.id}
    assert changes == {'lock': 'retained', 'oth': 'kept'}
    assert sum(lengths(result)) == 120


@pytest.mark.parametrize('strategy', ['even', 'fewer_longer'])
def test_a_task_waits_for_its_dependency(strategy):
    first = task('first', minutes=50, due_offset=3, priority='Low')
    result = plan(strategy, [first, task(minutes=100, depends_on=('first',))])
    assert min(s.start for s in work(result)) >= max(s.end for s in work(result, 'first'))


def test_work_that_no_shape_can_fit_falls_back_and_is_reported():
    result = plan('even', [task(minutes=400, due_offset=0)])
    allocation = next(a for a in result.allocations if a.task_id == 't')
    assert sum(lengths(result)) + allocation.unallocated == 400
    assert allocation.unallocated > 0


def test_results_are_deterministic_and_unknown_strategies_are_refused():
    assert [(s.start, s.end) for s in plan('even', [task()]).sessions] == [(s.start, s.end) for s in plan('even', [task()]).sessions]
    with pytest.raises(ValueError):
        plan('random', [task()])


# ------------------------------------------------------------------ API

def options(client, task_id):
    response = client.post('/schedule/split-options', json={'taskIds': [task_id]})
    assert response.status_code == 200, response.text
    return response.json()


def new_rows(option, title):
    return [r for r in rows(option['preview']['sessions'], 'new') if r[3] == title]


DUE = '2026-10-29'  # Thursday


def test_api_offers_distinct_previews_that_save_nothing(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    essay = add_task(client, 'Essay', 'High', minutes=240, deadline=DUE)
    result = options(client, essay['id'])
    assert [o['id'] for o in result['options']] == ['front_loaded', 'even', 'fewer_longer']
    assert (result['title'], result['remainingMinutes']) == ('Essay', 240)
    assert len({o['preview']['previewId'] for o in result['options']}) == 3
    assert len({tuple(new_rows(o, 'Essay')) for o in result['options']}) == 3
    for option in result['options']:
        assert option['preview']['mode'] == 'split'
        assert option['scheduledMinutes'] == 240 and option['unallocatedMinutes'] == 0
        assert option['sessionCount'] == len(new_rows(option, 'Essay'))
    assert client.get('/schedule').json()['sessions'] == []
    assert db.schedule_previews.count_documents({'status': 'proposed'}) == 3


def test_api_options_sit_around_existing_events_and_other_tasks(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    add_event(client, 'Standup', 9 * 60, 10 * 60, TOMORROW)
    other = add_task(client, 'Lab', 'High', minutes=50, deadline=TODAY)
    low = add_task(client, 'Essay', 'Low', minutes=240, deadline=DUE)
    for option in options(client, low['id'])['options']:
        sessions = option['preview']['sessions']
        assert not [s for s in sessions if s['date'] == TOMORROW and s['start'] < 10 * 60]
        lab = [s for s in sessions if s['taskId'] == other['id']]
        assert [(s['date'], s['start']) for s in lab] == [(TODAY, 9 * 60)]
        assert option['otherNewMinutes'] == 50


def test_api_explains_when_alternatives_collapse(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    small = add_task(client, 'Quiz', 'Medium', minutes=20, deadline=TOMORROW)
    result = options(client, small['id'])
    assert [o['id'] for o in result['options']] == ['front_loaded']
    assert any('same sessions' in note for note in result['notes'])


def test_api_says_when_the_deadline_is_past_the_window(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    far = add_task(client, 'Thesis', 'Low', minutes=240, deadline='2026-12-20')
    assert any('more than 21 days' in note for note in options(client, far['id'])['notes'])


def test_api_keeps_other_tasks_automatic_sessions_far_ahead(transaction_environment, monkeypatch):
    client, _ = transaction_environment
    setup_user(client, monkeypatch)
    add_task(client, 'Later', 'Medium', minutes=50, deadline='2026-11-10', earliestStart='2026-11-09T00:00:00-05:00')
    far = client.post('/schedule/preview', json={'horizonDays': 21}).json()
    assert client.post('/schedule/apply', json={'previewId': far['previewId']}).status_code == 200
    essay = add_task(client, 'Essay', 'High', minutes=100, deadline=TOMORROW)
    for option in options(client, essay['id'])['options']:
        assert option['movedSessions'] == 0
        assert [s['change'] for s in option['preview']['sessions'] if s['title'] == 'Later'] == ['kept']


@pytest.mark.parametrize('body, status, text', [
    ({'minutes': 60, 'allowSplit': False}, 422, 'Splitting is off'),
    ({'minutes': 60, 'kind': 'flexible_event'}, 422, 'flexible event'),
    ({'minutes': 60, 'deadline': '2026-10-25'}, 422, 'has passed'),
])
def test_api_refuses_tasks_that_cannot_be_split(environment, monkeypatch, body, status, text):
    client, _ = environment
    setup_user(client, monkeypatch)
    item = add_task(client, 'Item', 'High', **{'deadline': TOMORROW, **body})
    response = client.post('/schedule/split-options', json={'taskIds': [item['id']]})
    assert response.status_code == status and text in response.json()['detail']


def test_api_scopes_tasks_to_their_owner(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    item = add_task(client, 'Mine', 'High', deadline=TOMORROW)
    assert client.post('/schedule/split-options', json={'taskIds': ['nope']}).status_code == 404
    sign_in(client, uid='someone-else', email='else@example.com', name='Else')
    assert client.post('/schedule/split-options', json={'taskIds': [item['id']]}).status_code == 404


def test_api_apply_saves_the_picked_option_and_makes_the_others_stale(transaction_environment, monkeypatch):
    client, _ = transaction_environment
    setup_user(client, monkeypatch)
    essay = add_task(client, 'Essay', 'High', minutes=240, deadline=DUE)
    first, even, third = options(client, essay['id'])['options']
    applied = client.post('/schedule/apply', json={'previewId': even['preview']['previewId']})
    assert applied.status_code == 200, applied.text
    saved = applied.json()['schedule']['sessions']
    assert rows(saved) == rows(even['preview']['sessions'], 'new')
    assert client.post('/schedule/apply', json={'previewId': even['preview']['previewId']}).json()['duplicate'] is True
    assert client.post('/schedule/apply', json={'previewId': first['preview']['previewId']}).status_code == 409
    assert client.post('/schedule/apply', json={'previewId': third['preview']['previewId']}).status_code == 409


def test_api_reshaping_replaces_saved_sessions_of_the_task_only(transaction_environment, monkeypatch):
    client, _ = transaction_environment
    setup_user(client, monkeypatch)
    essay = add_task(client, 'Essay', 'High', minutes=240, deadline=DUE)
    add_task(client, 'Lab', 'Low', minutes=50, deadline=DUE)
    plan_preview = client.post('/schedule/preview', json={'horizonDays': 7}).json()
    assert client.post('/schedule/apply', json={'previewId': plan_preview['previewId']}).status_code == 200
    before = {s['id'] for s in client.get('/schedule').json()['sessions'] if s['title'] == 'Lab'}

    even = next(o for o in options(client, essay['id'])['options'] if o['id'] == 'even')
    assert {r['session']['title'] for r in even['preview']['removed'] if r['session']['type'] == 'work'} == {'Essay'}
    assert client.post('/schedule/apply', json={'previewId': even['preview']['previewId']}).status_code == 200
    saved = client.get('/schedule').json()['sessions']
    assert {s['id'] for s in saved if s['title'] == 'Lab'} == before
    assert sum(s['end'] - s['start'] for s in saved if s['title'] == 'Essay') == 240
    assert len({s['date'] for s in saved if s['title'] == 'Essay'}) == 4


# ------------------------------------------------------------------ several tasks and drafts

TWO_DRAFTS = [{'id': 'a', 'title': 'Essay', 'minutes': 120, 'deadline': DUE}, {'id': 'b', 'title': 'Lab', 'minutes': 100, 'deadline': DUE}]


def test_the_same_shape_applies_to_every_task_being_split():
    result = plan_schedule([task('a', minutes=120), task('b', minutes=120)], hours(), Prefs(), [], [], at(0, 480), 7,
                           'repair', split=(('a', 'b'), 'even'))
    assert len(per_day(result, 'a')) > 1 and len(per_day(result, 'b')) > 1


def test_api_splits_several_saved_tasks_and_notes_any_it_cannot(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    essay = add_task(client, 'Essay', 'High', minutes=120, deadline=DUE)
    lab = add_task(client, 'Lab', 'High', minutes=120, deadline=DUE)
    whole = add_task(client, 'Exam', 'High', minutes=30, deadline=DUE, allowSplit=False)
    response = client.post('/schedule/split-options', json={'taskIds': [essay['id'], lab['id'], whole['id']]})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['taskIds'] == [essay['id'], lab['id']]
    assert (result['title'], result['remainingMinutes']) == ('Essay and Lab', 240)
    assert any('Splitting is off for "Exam"' in note for note in result['notes'])
    assert all(o['scheduledMinutes'] == 240 for o in result['options'])


def test_api_splits_drafts_under_review_and_saves_nothing(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    response = client.post('/plan/split-options', json={'drafts': TWO_DRAFTS, 'batchId': 'b1'})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['taskIds'] == ['draft:a', 'draft:b'] and len(result['options']) >= 2
    assert all(o['preview']['mode'] == 'plan' for o in result['options'])
    assert db.tasks.count_documents({}) == 0


def test_api_a_draft_flagged_on_preferred_times_still_gets_options(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    drafts = [{**draft, 'unreadable': ['windows']} for draft in TWO_DRAFTS]
    assert client.post('/plan/review', json={'drafts': drafts}).json()[0]['ready'] is True
    assert client.post('/plan/split-options', json={'drafts': drafts}).status_code == 200


def test_api_applying_a_draft_option_saves_the_tasks_with_that_split(transaction_environment, monkeypatch):
    client, _ = transaction_environment
    setup_user(client, monkeypatch)
    options_ = client.post('/plan/split-options', json={'drafts': TWO_DRAFTS, 'batchId': 'b1'}).json()['options']
    picked = next(o for o in options_ if o['id'] == 'even')
    applied = client.post('/schedule/apply', json={'previewId': picked['preview']['previewId']})
    assert applied.status_code == 200, applied.text
    assert {t['title'] for t in applied.json()['tasks']} == {'Essay', 'Lab'}
    assert rows(applied.json()['schedule']['sessions']) == rows(picked['preview']['sessions'], 'new')
