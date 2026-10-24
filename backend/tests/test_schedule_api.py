"""Schedule API: preview, apply, repair and breaks through the shared service. OpenAI is never called."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from bson import ObjectId
from pymongo.collection import Collection
from pymongo.errors import OperationFailure

from app import schedule_routes
from app.openai_interpret import InterpretResult
from firebase_tokens import sign_in, sign_out
from schedule_fixtures import (
    ACCEPTANCE, NOW, TODAY, acceptance_tasks, add_event, add_task, freeze, rows, setup_user,
)


def preview(client, path='/schedule/preview', **body):
    response = client.post(path, json={'horizonDays': 1, **body})
    assert response.status_code == 200, response.text
    return response.json()


def apply(client, preview_id):
    return client.post('/schedule/apply', json={'previewId': preview_id})


# ------------------------------------------------------------------ required acceptance test

def test_acceptance_preview_apply_refresh(transaction_environment, monkeypatch):
    client, db = transaction_environment
    setup_user(client, monkeypatch)
    asm, rev = acceptance_tasks(client)

    proposal = preview(client)
    assert rows(proposal['sessions']) == ACCEPTANCE
    assert all(s['status'] == 'proposed' and s['change'] == 'new' for s in proposal['sessions'])
    assert {s['taskId'] for s in proposal['sessions'] if s['type'] == 'break'} == {None}
    allocation = {t['taskId']: t for t in proposal['tasks']}
    for task in (asm, rev):
        a = allocation[task['id']]
        assert (a['remainingMinutes'], a['retainedMinutes'], a['newMinutes'], a['unallocatedMinutes']) == (60, 0, 60, 0)
        assert sum(s['end'] - s['start'] for s in proposal['sessions'] if s['taskId'] == task['id']) == 60
    assert proposal['firstProposedDate'] == TODAY
    assert proposal['days'] == [{'date': TODAY, 'workMinutes': 120, 'newWorkMinutes': 120, 'breakCount': 2, 'sessionCount': 6}]
    assert client.get('/schedule').json()['sessions'] == []  # a preview saves nothing

    applied = apply(client, proposal['previewId'])
    assert applied.status_code == 200, applied.text
    body = applied.json()
    assert body['duplicate'] is False
    assert rows(body['schedule']['sessions']) == ACCEPTANCE
    assert all(s['status'] == 'saved' for s in body['schedule']['sessions'])
    assert {s['scheduleVersion'] for s in body['schedule']['sessions']} == {body['schedule']['scheduleVersion']}

    # Refresh: a new sign-in reads the same schedule back from MongoDB, with UTC timestamps.
    sign_out(client)
    sign_in(client, uid='sched-user', email='sched-user@example.com', name='Sched')
    reloaded = client.get('/schedule').json()
    assert rows(reloaded['sessions']) == ACCEPTANCE
    assert reloaded['sessions'][0]['startAt'] in ('2026-10-26T13:00:00Z', '2026-10-26T13:00:00+00:00')
    assert db.sessions.count_documents({'type': 'break'}) == 2

    # Applying the same preview again is idempotent: no duplicate sessions.
    again = apply(client, proposal['previewId'])
    assert again.status_code == 200 and again.json()['duplicate'] is True
    assert len(client.get('/schedule').json()['sessions']) == 6


def test_concurrent_apply_requests_save_once(transaction_environment, monkeypatch):
    client, db = transaction_environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    proposal = preview(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: apply(client, proposal['previewId']), range(2)))
    assert sorted(r.status_code for r in results) == [200, 200]
    assert sorted(r.json()['duplicate'] for r in results) == [False, True]
    assert db.sessions.count_documents({'preview_id': proposal['previewId']}) == 6


# ------------------------------------------------------------------ stale and duplicate protection

def test_stale_preview_after_task_change_is_rejected(transaction_environment, monkeypatch):
    client, _ = transaction_environment
    setup_user(client, monkeypatch)
    asm, _ = acceptance_tasks(client)
    proposal = preview(client)
    client.put(f"/tasks/{asm['id']}", json={'title': 'Asm v2', 'deadline': asm['deadline'], 'minutes': 60,
                                             'priority': 'High', 'category': 'Study'})
    response = apply(client, proposal['previewId'])
    assert response.status_code == 409 and 'stale' in response.json()['detail']
    assert client.get('/schedule').json()['sessions'] == []


def test_older_preview_rejected_after_a_newer_one_is_applied(transaction_environment, monkeypatch):
    client, _ = transaction_environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    first, second = preview(client), preview(client)
    assert apply(client, second['previewId']).status_code == 200
    response = apply(client, first['previewId'])
    assert response.status_code == 409
    assert len(client.get('/schedule').json()['sessions']) == 6


def test_preview_that_starts_in_the_past_by_apply_time_is_rejected(transaction_environment, monkeypatch):
    client, _ = transaction_environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    proposal = preview(client)
    freeze(monkeypatch, NOW + timedelta(hours=1, minutes=30))  # 9:30: the first session already began
    response = apply(client, proposal['previewId'])
    assert response.status_code == 409
    assert client.get('/schedule').json()['sessions'] == []


def test_foreign_preview_is_not_found(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    proposal = preview(client)
    sign_out(client)
    sign_in(client, uid='other', email='other@example.com', name='Other')
    assert apply(client, proposal['previewId']).status_code == 404
    assert client.get(f"/schedule/preview/{proposal['previewId']}").status_code == 404


# ------------------------------------------------------------------ failed saves

def test_failed_database_save_keeps_previous_schedule(transaction_environment, monkeypatch):
    client, db = transaction_environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    assert apply(client, preview(client)['previewId']).status_code == 200
    before = sorted(map(str, db.sessions.find({}, {'_id': 1})))
    add_event(client, 'Advisor', 10 * 60 + 10, 10 * 60 + 50)
    proposal = preview(client, '/schedule/repair', horizonDays=2)
    original = Collection.insert_many

    def failing(self, *args, **kwargs):
        if self.name == 'sessions':
            raise OperationFailure('injected write failure', 13)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Collection, 'insert_many', failing)
    response = apply(client, proposal['previewId'])
    assert response.status_code == 503 and response.json()['code'] == 'database_authorization'
    assert sorted(map(str, db.sessions.find({}, {'_id': 1}))) == before  # deletes were rolled back too
    assert db.schedule_previews.find_one({'_id': ObjectId(proposal['previewId'])})['status'] == 'proposed'


def test_server_without_transactions_never_reports_a_save(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    proposal = preview(client)

    def unsupported(*args, **kwargs):
        raise OperationFailure('Transaction numbers are only allowed on a replica set member or mongos', 20)

    monkeypatch.setattr(db.client, 'start_session', unsupported)
    response = apply(client, proposal['previewId'])
    assert response.status_code == 503 and response.json()['code'] == 'transactions_unsupported'
    assert client.get('/schedule').json()['sessions'] == []


# ------------------------------------------------------------------ scenarios

def test_event_interrupting_available_time(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    add_task(client, 'Asm', 'High', 60)
    add_event(client, 'Standup', 9 * 60 + 30, 10 * 60)
    proposal = preview(client)
    assert rows(proposal['sessions']) == [
        (TODAY, '09:00-09:30', 'work', 'Asm'),
        (TODAY, '10:00-10:20', 'work', 'Asm'),
        (TODAY, '10:20-10:30', 'break', 'Break'),  # the meeting was not rest
        (TODAY, '10:30-10:40', 'work', 'Asm'),
    ]


def test_new_event_conflicting_with_saved_flexible_work_is_repaired(transaction_environment, monkeypatch):
    client, _ = transaction_environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    saved = apply(client, preview(client)['previewId']).json()['schedule']['sessions']
    add_event(client, 'Advisor', 10 * 60 + 10, 10 * 60 + 50)

    repair = preview(client, '/schedule/repair', horizonDays=2)
    moved = [r for r in repair['removed'] if r['session']['type'] == 'work']
    assert [(r['session']['title'], r['session']['start'], r['reason']) for r in moved] == [
        ('Test revision', 610, 'It overlaps "Advisor".')]
    kept = {s['id'] for s in repair['sessions'] if s['change'] == 'kept'}
    assert {s['id'] for s in saved if s['title'] == 'Asm'} <= kept  # unaffected sessions are preserved
    assert all(t['unallocatedMinutes'] == 0 for t in repair['tasks'])

    assert apply(client, repair['previewId']).status_code == 200
    after = client.get('/schedule').json()['sessions']
    assert not [s for s in after if s['date'] == TODAY and s['start'] < 650 and s['end'] > 610]
    minutes = {}
    for s in after:
        if s['type'] == 'work':
            minutes[s['title']] = minutes.get(s['title'], 0) + s['end'] - s['start']
    assert minutes == {'Asm': 60, 'Test revision': 60}  # nothing lost or duplicated


def test_insufficient_capacity_is_reported_honestly(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    big = add_task(client, 'Report', 'High', 240, deadline=TODAY, dueTime=12 * 60)
    proposal = preview(client)
    a = next(t for t in proposal['tasks'] if t['taskId'] == big['id'])
    assert (a['newMinutes'], a['unallocatedMinutes'], a['status']) == (150, 90, 'partial')
    assert [r['code'] for r in a['reasons']] == ['insufficient_capacity']
    assert 'not proof' in proposal['note']


def test_locked_session_conflict_is_reported_not_moved(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    asm = add_task(client, 'Asm', 'High', 60)
    locked = client.post('/sessions', json={'taskId': asm['id'], 'date': TODAY, 'start': 540, 'end': 570, 'locked': True})
    assert locked.status_code == 201
    add_event(client, 'Dentist', 9 * 60 + 15, 10 * 60)  # an imported/added event can collide with locked work
    proposal = preview(client)
    retained = [s for s in proposal['sessions'] if s['change'] == 'retained']
    assert [(s['id'], s['start'], s['end']) for s in retained] == [(locked.json()['id'], 540, 570)]
    assert [c['code'] for c in proposal['conflicts']] == ['fixed_overlap']
    a = proposal['tasks'][0]
    assert (a['retainedMinutes'], a['newMinutes'], a['unallocatedMinutes']) == (30, 30, 0)


def test_requested_break_now_previews_protected_break_and_repairs(transaction_environment, monkeypatch):
    client, _ = transaction_environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    assert apply(client, preview(client)['previewId']).status_code == 200
    freeze(monkeypatch, NOW + timedelta(hours=1, minutes=20))  # 9:20, during Asm 9:00-9:50

    proposal = preview(client, '/schedule/break', minutes=30)
    breaks = [s for s in proposal['sessions'] if s['type'] == 'break' and s['locked']]
    assert [(s['start'], s['end'], s['status']) for s in breaks] == [(560, 590, 'proposed')]
    truncated = [r for r in proposal['removed'] if r['newEndAt']]
    assert [(r['session']['title'], r['session']['start']) for r in truncated] == [('Asm', 540)]
    assert all(t['unallocatedMinutes'] == 0 for t in proposal['tasks'])

    assert apply(client, proposal['previewId']).status_code == 200
    saved = client.get('/schedule').json()['sessions']
    assert (TODAY, '09:00-09:20', 'work', 'Asm') in rows(saved)
    assert (TODAY, '09:20-09:50', 'break', 'Break') in rows(saved)
    assert not [s for s in saved if s['type'] == 'work' and s['start'] < 590 and s['end'] > 560]


def test_break_that_moves_no_work_keeps_saved_breaks_unchanged(transaction_environment, monkeypatch):
    client, _ = transaction_environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    assert apply(client, preview(client)['previewId']).status_code == 200
    saved_breaks = {s['id'] for s in client.get('/schedule').json()['sessions'] if s['type'] == 'break'}

    proposal = preview(client, '/schedule/break', minutes=30)  # 8:00-8:30, before any work
    assert proposal['removed'] == []
    assert [(s['start'], s['end']) for s in proposal['sessions'] if s['change'] == 'new'] == [(480, 510)]
    assert {s['id'] for s in proposal['sessions'] if s['type'] == 'break' and s['change'] == 'kept'} == saved_breaks
    assert apply(client, proposal['previewId']).status_code == 200
    assert {s['id'] for s in client.get('/schedule').json()['sessions'] if s['type'] == 'break' and not s['locked']} == saved_breaks


def test_requested_break_during_fixed_event_explains_the_conflict(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, now=NOW + timedelta(hours=1, minutes=20))
    add_event(client, 'Lecture', 9 * 60, 10 * 60)
    proposal = preview(client, '/schedule/break', minutes=30)
    assert [s for s in proposal['sessions'] if s['type'] == 'break'] == []
    assert proposal['conflicts'][0]['code'] == 'break_conflict'
    assert 'Lecture' in proposal['conflicts'][0]['message'] and 'not moved' in proposal['conflicts'][0]['message']


def test_long_task_splits_across_days_with_preferences(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, end=17 * 60)
    response = client.put('/schedule/preferences', json={'focusMinutes': 50, 'breakMinutes': 10, 'maxDailyWorkMinutes': 120,
                                                         'lunch': {'start': 720, 'end': 780}})
    assert response.status_code == 200
    add_task(client, 'Thesis', 'High', 300, deadline='2026-10-29', maxSessionMinutes=120)
    proposal = preview(client, horizonDays=4)
    per_day = {d['date']: d['workMinutes'] for d in proposal['days']}
    assert per_day == {'2026-10-26': 120, '2026-10-27': 120, '2026-10-28': 60}
    assert not [s for s in proposal['sessions'] if s['start'] < 780 and s['end'] > 720]  # lunch protected
    assert client.put('/schedule/preferences', json={'focusMinutes': 5}).status_code == 422


def test_completing_a_session_counts_completed_minutes(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    asm = add_task(client, 'Asm', 'High', 60)
    session = client.post('/sessions', json={'taskId': asm['id'], 'date': TODAY, 'start': 420, 'end': 450}).json()
    assert client.get(f"/tasks/{asm['id']}").json()['completedMinutes'] == 0  # scheduled is not completed
    done = client.patch(f"/sessions/{session['id']}/status", json={'status': 'completed'})
    assert done.status_code == 200 and done.json()['status'] == 'completed'
    task = client.get(f"/tasks/{asm['id']}").json()
    assert (task['completedMinutes'], task['remainingMinutes']) == (30, 30)
    assert client.patch(f"/sessions/{session['id']}/status", json={'status': 'completed'}).status_code == 200
    assert client.get(f"/tasks/{asm['id']}").json()['completedMinutes'] == 30  # repeated request is a no-op
    proposal = preview(client)
    assert proposal['tasks'][0]['remainingMinutes'] == 30 and proposal['tasks'][0]['newMinutes'] == 30


def test_interpret_builds_preview_through_the_same_service(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    monkeypatch.setattr(schedule_routes, 'interpret_request', lambda message, **kw: InterpretResult(
        intent='generate_schedule', reply='Preview ready.', runScheduler=True))
    button = preview(client, horizonDays=7)
    chat = client.post('/schedule/interpret', json={'message': 'plan my week'}).json()['preview']
    strip = lambda p: [(s['startAt'], s['endAt'], s['type'], s['title']) for s in p['sessions']]
    assert strip(chat) == strip(button)
