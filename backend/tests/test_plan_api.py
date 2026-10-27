"""Plan entry API: drafts → “Can this fit?” → preview → Apply, through the shared scheduling service.

Frozen at Monday 26 Oct 2026, 8 AM New York; availability 9 AM–noon every day. AI is not used (the
local parser reads text). Apply needs MongoDB transactions: the HTTP Apply tests run only against a
replica set (TEST_MONGODB_URI). The Apply *logic* (ids, dedup, staleness) is also exercised on the mock
database by calling the same function without a transaction; that checks bookkeeping, not atomicity.
"""
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import mongomock
import pytest
from bson import ObjectId
from fastapi import HTTPException
from pymongo.errors import ConnectionFailure

from app.scheduling_service import _apply, schedule_snapshot
from firebase_tokens import sign_in, sign_out
from schedule_fixtures import NOW, TODAY, TOMORROW, add_task, freeze, rows, setup_user

UTC = ZoneInfo('UTC')


def interpret(client, text):
    response = client.post('/plan/interpret', json={'text': text, 'batchId': 'batch-1'})
    assert response.status_code == 200, response.text
    return [v['draft'] for v in response.json()['drafts']]


def counts(db):
    return {name: db[name].count_documents({}) for name in ('tasks', 'events', 'sessions', 'schedule_previews')} | {
        'version': (db.users.find_one({}) or {}).get('schedule_version', 0)}


def feasibility(client, drafts, days=1):
    response = client.post('/plan/feasibility', json={'drafts': drafts, 'horizonDays': days})
    assert response.status_code == 200, response.text
    return response.json()


def plan_preview(client, drafts, days=1, batch='batch-1'):
    response = client.post('/plan/preview', json={'drafts': drafts, 'horizonDays': days, 'batchId': batch})
    assert response.status_code == 200, response.text
    return response.json()


def owner(db):
    return db.users.find_one({'email': 'sched-user@example.com'})


def save_auto_sessions(db, task_id, spans, day=TODAY):
    """Saved, unlocked scheduler sessions, as an earlier Apply would have left them."""
    zone = ZoneInfo('America/New_York')
    for start, end in spans:
        d = date.fromisoformat(day)
        db.sessions.insert_one({'user_id': str(owner(db)['_id']), 'task_id': task_id, 'type': 'work', 'status': 'saved',
                                'locked': False, 'source': 'auto', 'date': day, 'start': start, 'end': end,
                                'start_at': datetime(d.year, d.month, d.day, start // 60, start % 60, tzinfo=zone).astimezone(UTC),
                                'end_at': datetime(d.year, d.month, d.day, end // 60, end % 60, tzinfo=zone).astimezone(UTC),
                                'schedule_version': 0})


BULK = """Lab report 90 min due tomorrow high priority
Advisor meeting today 11-11:30am
Gym 30 min sometime today, low priority"""


def test_bulk_message_to_preview_changes_no_saved_data(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    drafts = interpret(client, BULK)
    assert [(d['kind'], d['title']) for d in drafts] == [('task', 'Lab report'), ('fixed_event', 'Advisor meeting'),
                                                         ('flexible_event', 'Gym')]
    before = counts(db)
    check = feasibility(client, drafts)
    assert check['status'] == 'fits_without_moving' and check['savedDataChanged'] is False
    assert counts(db) == before  # the check stores nothing, not even a proposal
    assert 'Planning horizon: 1 days' in check['searchLimits']

    proposal = plan_preview(client, drafts)
    assert rows(proposal['sessions']) == [
        (TODAY, '09:00-09:50', 'work', 'Lab report'),
        (TODAY, '09:50-10:00', 'break', 'Break'),
        (TODAY, '10:00-10:40', 'work', 'Lab report'),
        (TODAY, '11:30-12:00', 'work', 'Gym'),  # 10:40-11:00 is too short and the gym is never split
    ]
    assert [(e['title'], e['start'], e['end']) for e in proposal['proposedEvents']] == [('Advisor meeting', 660, 690)]
    assert all(s['taskId'].startswith('draft:') for s in proposal['sessions'] if s['type'] == 'work')
    assert counts(db) == {**before, 'schedule_previews': before['schedule_previews'] + 1}
    assert client.get('/schedule').json()['sessions'] == [] and client.get('/tasks').json() == []


def test_flexible_event_stays_contiguous_in_the_preview(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    drafts = interpret(client, 'Advisor meeting today 10-10:30am\nGym 90 min sometime today')
    proposal = plan_preview(client, drafts)
    gym = [s for s in proposal['sessions'] if s['title'] == 'Gym']
    assert [(s['start'], s['end']) for s in gym] == [(630, 720)]  # one block after the meeting, never split


def test_fixed_event_overlap_is_detected_and_nothing_is_moved(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    assert client.post('/events', json={'title': 'Seminar', 'kind': 'Class', 'date': TODAY, 'start': 600, 'end': 660,
                                         'location': None, 'repeat': None}).status_code == 201
    drafts = interpret(client, 'Dentist today 10:30-11:30am')
    check = feasibility(client, drafts)
    assert check['status'] == 'proven_infeasible'
    item = check['items'][0]
    assert item['status'] == 'fixed_conflict' and item['causes'][0]['proven'] is True
    assert 'Seminar' in item['causes'][0]['message'] and 'never moves fixed events' in item['causes'][0]['message']
    proposal = plan_preview(client, drafts)
    assert [c['code'] for c in proposal['conflicts']] == ['fixed_overlap']
    assert db.events.find_one({'title': 'Seminar'})['start'] == 600  # unchanged


def test_high_priority_draft_displaces_lower_priority_saved_work_and_reports_it(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    reading = add_task(client, 'Reading', 'Low', minutes=150, deadline='2026-10-28')
    save_auto_sessions(db, reading['id'], [(540, 590), (600, 650), (660, 710)])
    drafts = interpret(client, 'Lab 100 min due today at noon, high priority')
    before = counts(db)
    check = feasibility(client, drafts)
    assert check['status'] == 'fits_after_changes', check
    assert check['displaced'] == [{'taskId': reading['id'], 'title': 'Reading', 'priority': 'Low', 'movedSessions': 2,
                                   'unscheduledMinutesBefore': 0, 'unscheduledMinutesAfter': 100}]
    assert counts(db) == before
    proposal = plan_preview(client, drafts)
    removed = sorted(r['session']['start'] for r in proposal['removed'] if r['session']['type'] == 'work')
    assert removed == [600, 660]
    reading_alloc = next(t for t in proposal['tasks'] if t['taskId'] == reading['id'])
    assert reading_alloc['unallocatedMinutes'] == 100 and 'displaced_by_priority' in [r['code'] for r in reading_alloc['reasons']]
    assert db.tasks.count_documents({'_id': ObjectId(reading['id'])}) == 1  # never deleted


def test_insufficient_capacity_is_proven_with_explicit_unscheduled_minutes(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    drafts = interpret(client, 'Thesis chapter 5 hours due today, high priority')
    check = feasibility(client, drafts)
    assert check['status'] == 'proven_infeasible'
    item = check['items'][0]
    assert (item['neededMinutes'], item['unscheduledMinutes']) == (300, 300 - item['scheduledMinutes'])
    cause = item['causes'][0]
    assert cause == {'code': 'insufficient_capacity', 'proven': True, 'message':
                     'Even with no other flexible work, only 180 minutes are free in its window before the deadline, '
                     'and it needs 300.'}


def test_heuristic_failure_is_not_called_proof(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    drafts = interpret(client, 'Portfolio 6 hours due Nov 5, medium priority')
    check = feasibility(client, drafts, days=1)
    assert check['status'] == 'no_plan_found'
    assert not any(c['proven'] for c in check['items'][0]['causes'])
    assert {a['id'] for a in check['alternatives']} == {'horizon-21', 'priority-d1'}


def test_unsplittable_task_over_focus_limit_offers_choices_without_relaxing(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    drafts = interpret(client, 'Mock exam 2 hours in one sitting due tomorrow, high priority')
    check = feasibility(client, drafts)
    assert check['status'] == 'proven_infeasible'
    assert check['items'][0]['causes'][0]['code'] == 'unsplit_exceeds_focus_limit'
    assert [a['patch'] for a in check['alternatives'] if a['draftId'] == 'd1'] == [{'allowSplit': True}]
    proposal = plan_preview(client, drafts)
    conflict = next(c for c in proposal['conflicts'] if c['code'] == 'settings_conflict')
    assert [c['id'] for c in conflict['choices']] == ['allow_split', 'raise_focus_limit', 'make_flexible_event']
    assert [s for s in proposal['sessions'] if s['type'] == 'work'] == []


def test_drafts_with_open_questions_never_reach_the_scheduler(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    drafts = interpret(client, 'Write cover letter')
    before = counts(db)
    for path in ('/plan/feasibility', '/plan/preview'):
        response = client.post(path, json={'drafts': drafts})
        assert response.status_code == 422 and 'How long' in response.json()['detail']
    assert counts(db) == before


def test_locked_sessions_stay_unchanged_in_a_plan_preview(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    reading = add_task(client, 'Reading', 'Low', minutes=60, deadline='2026-10-28')
    locked = client.post('/sessions', json={'taskId': reading['id'], 'date': TODAY, 'start': 540, 'end': 600, 'locked': True})
    assert locked.status_code == 201
    proposal = plan_preview(client, interpret(client, 'Lab 60 min due today at 10am, high priority'))
    kept = next(s for s in proposal['sessions'] if s['id'] == locked.json()['id'])
    assert (kept['change'], kept['start'], kept['end']) == ('retained', 540, 600)
    assert proposal['removed'] == []


def test_preview_calendar_and_chat_read_the_same_proposal(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    proposal = plan_preview(client, interpret(client, BULK))
    snap = schedule_snapshot(owner(db), db, NOW.astimezone(UTC), proposal['previewId'])
    proposed = [(s['date'], s['start'], s['end'], s['type']) for s in snap['pendingPreview']['sessions']]
    from app.scheduling_service import clock
    assert proposed == [(s['date'], clock(s['start']), clock(s['end']), s['type'])
                        for s in proposal['sessions'] if s['change'] == 'new']
    assert snap['pendingPreview']['note'].startswith('PROPOSED, NOT SAVED')
    assert snap['savedSessions'] == []


def test_recurring_class_keeps_local_time_across_daylight_saving(environment, monkeypatch):
    client, _ = environment
    friday = datetime(2026, 10, 30, 8, 0, tzinfo=ZoneInfo('America/New_York'))
    setup_user(client, monkeypatch, now=friday)
    drafts = interpret(client, 'Choir rehearsal every Sat and Sun 9:00am-10:00am from Oct 31 until Nov 8')
    assert drafts[0]['repeat'] == {'weekdays': [5, 6], 'startDate': '2026-10-31', 'until': '2026-11-08'}
    proposal = plan_preview(client, drafts, days=3)
    events = [(e['date'], e['start'], e['startAt']) for e in proposal['proposedEvents']]
    assert events == [('2026-10-31', 540, '2026-10-31T13:00:00Z'), ('2026-11-01', 540, '2026-11-01T14:00:00Z')]


def test_database_failure_while_storing_a_preview_returns_a_safe_error(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    drafts = interpret(client, BULK)
    if not isinstance(db.client, mongomock.MongoClient):
        pytest.skip('Failure injection uses the mock database.')
    original = mongomock.collection.Collection.insert_one

    def failing(self, *args, **kwargs):
        if self.name == 'schedule_previews':
            raise ConnectionFailure('connection reset')
        return original(self, *args, **kwargs)
    monkeypatch.setattr(mongomock.collection.Collection, 'insert_one', failing)
    response = client.post('/plan/preview', json={'drafts': drafts, 'batchId': 'batch-1'})
    assert response.status_code == 503 and response.json()['code'] == 'database_connection'
    assert 'connection reset' not in response.text
    assert db.tasks.count_documents({}) == db.sessions.count_documents({}) == 0


# ------------------------------------------------------------------ Apply logic (mock database, no transaction)

def apply_logic(db, preview_id, now=NOW):
    return _apply(owner(db), db, preview_id, now.astimezone(UTC), None)


def test_apply_creates_tasks_events_and_sessions_once(environment, monkeypatch):
    client, db = environment
    if not isinstance(db.client, mongomock.MongoClient):
        pytest.skip('Logic-only test; the transactional path is covered by test_apply_plan_preview_over_http.')
    setup_user(client, monkeypatch)
    drafts = interpret(client, BULK + '\nLab slides 30 min due tomorrow after Lab report')
    proposal = plan_preview(client, drafts)
    result = apply_logic(db, proposal['previewId'])
    assert result['duplicate'] is False
    tasks = {t.title: t for t in result['tasks']}
    assert set(tasks) == {'Lab report', 'Gym', 'Lab slides'} and tasks['Gym'].kind == 'flexible_event'
    assert tasks['Lab slides'].dependsOn == [tasks['Lab report'].id]  # draft ids became real ids
    assert [e.title for e in result['events']] == ['Advisor meeting']
    saved = result['schedule'].sessions
    assert {s.taskId for s in saved if s.type == 'work'} <= {t.id for t in tasks.values()}
    assert len(saved) == len(proposal['sessions'])
    assert db.tasks.find_one({'title': 'Lab report'})['completedMinutes'] == 0  # scheduled is not completed

    again = apply_logic(db, proposal['previewId'])
    assert again['duplicate'] is True and db.tasks.count_documents({}) == 3
    # A second preview of the same reviewed batch cannot save the drafts twice.
    sneaky = plan_preview(client, drafts)
    with pytest.raises(HTTPException) as caught:
        apply_logic(db, sneaky['previewId'])
    assert caught.value.status_code == 409 and db.tasks.count_documents({}) == 3


def test_stale_preview_is_rejected_and_repeated_generation_does_not_accumulate(environment, monkeypatch):
    client, db = environment
    if not isinstance(db.client, mongomock.MongoClient):
        pytest.skip('Logic-only test.')
    setup_user(client, monkeypatch)
    proposal = plan_preview(client, interpret(client, BULK))
    add_task(client, 'Something new', 'Low')
    with pytest.raises(HTTPException) as caught:
        apply_logic(db, proposal['previewId'])
    assert caught.value.status_code == 409 and db.sessions.count_documents({}) == 0

    fresh = plan_preview(client, interpret(client, BULK), batch='batch-2')
    apply_logic(db, fresh['previewId'])
    total = db.sessions.count_documents({})
    for _ in range(3):  # generate + apply again on the saved plan: same sessions, nothing piles up
        regenerated = client.post('/schedule/preview', json={'horizonDays': 1}).json()
        apply_logic(db, regenerated['previewId'])
        assert db.sessions.count_documents({}) == total


def test_apply_plan_preview_over_http_survives_refresh(transaction_environment, monkeypatch):
    client, db = transaction_environment
    setup_user(client, monkeypatch)
    proposal = plan_preview(client, interpret(client, BULK))
    applied = client.post('/schedule/apply', json={'previewId': proposal['previewId']})
    assert applied.status_code == 200, applied.text
    body = applied.json()
    assert len(body['tasks']) == 2 and len(body['events']) == 1
    sign_out(client)
    sign_in(client, uid='sched-user', email='sched-user@example.com', name='Sched')
    assert len(client.get('/schedule').json()['sessions']) == len(proposal['sessions'])
    assert {t['title'] for t in client.get('/tasks').json()} == {'Lab report', 'Gym'}
    assert client.post('/schedule/apply', json={'previewId': proposal['previewId']}).json()['duplicate'] is True
    assert db.tasks.count_documents({}) == 2


def test_noon_stays_noon_from_text_to_preview_to_saved_task(environment, monkeypatch):
    client, db = environment
    if not isinstance(db.client, mongomock.MongoClient):
        pytest.skip('Logic-only test.')
    setup_user(client, monkeypatch)
    drafts = interpret(client, 'Submit lab report by noon tomorrow 60 min high priority')
    assert (drafts[0]['deadline'], drafts[0]['dueTime']) == (TOMORROW, 720)
    proposal = plan_preview(client, drafts, days=2)
    allocation = proposal['tasks'][0]
    assert allocation['unallocatedMinutes'] == 0
    due_at = datetime(2026, 10, 27, 12, 0, tzinfo=ZoneInfo('America/New_York'))
    assert all(datetime.fromisoformat(s['endAt'].replace('Z', '+00:00')) <= due_at for s in proposal['sessions'])
    apply_logic(db, proposal['previewId'])
    saved = client.get('/tasks').json()[0]
    assert (saved['deadline'], saved['dueTime']) == (TOMORROW, 720)


def test_infeasible_work_is_a_result_not_a_blocking_question(environment, monkeypatch):
    client, db = environment
    if not isinstance(db.client, mongomock.MongoClient):
        pytest.skip('Logic-only test.')
    setup_user(client, monkeypatch)
    drafts = interpret(client, 'Thesis chapter 6 hours due today 12pm high priority')
    views = client.post('/plan/review', json={'drafts': drafts, 'horizonDays': 1}).json()
    assert views[0]['ready'] and not [i for i in views[0]['issues'] if i['blocking']]
    proposal = plan_preview(client, drafts)
    allocation = proposal['tasks'][0]
    assert allocation['newMinutes'] > 0 and allocation['unallocatedMinutes'] == 360 - allocation['newMinutes']
    # A partial plan can be applied: the task is saved with its unscheduled minutes still open.
    apply_logic(db, proposal['previewId'])
    saved = client.get('/tasks').json()[0]
    assert saved['minutes'] == 360 and db.sessions.count_documents({'type': 'work'}) > 0
