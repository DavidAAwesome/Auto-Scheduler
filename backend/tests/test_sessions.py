import pytest
from conftest import sign_in

TASK = {'title': 'CV homework', 'deadline': '2026-10-09', 'minutes': 180, 'priority': 'High', 'category': 'Study'}


def make_task(client, **changes):
    response = client.post('/tasks', json={**TASK, **changes})
    assert response.status_code == 201
    return response.json()


def session(task, date='2026-10-07', start=540, end=600):
    return {'taskId': task['id'], 'date': date, 'start': start, 'end': end}


def test_due_time_is_optional_and_defaults_to_1159_pm(environment):
    client, db = environment
    sign_in(client)
    assert make_task(client)['dueTime'] == 23 * 60 + 59
    assert make_task(client, dueTime=17 * 60)['dueTime'] == 17 * 60
    # Tasks saved before due times existed still load, with the default.
    db.tasks.insert_one({**TASK, 'done': False, 'user_id': 'alice-uid'})
    assert {task['dueTime'] for task in client.get('/tasks').json()} == {17 * 60, 23 * 60 + 59}


@pytest.mark.parametrize('due', [-1, 1440, '17:00', True])
def test_invalid_due_time_rejected(environment, due):
    client, _ = environment
    sign_in(client)
    assert client.post('/tasks', json={**TASK, 'dueTime': due}).status_code == 422


def test_large_tasks_allowed_for_multi_day_work(environment):
    client, _ = environment
    sign_in(client)
    assert make_task(client, minutes=40 * 60)['minutes'] == 2400
    assert client.post('/tasks', json={**TASK, 'minutes': 6015}).status_code == 422


def test_task_split_across_days_with_uneven_sessions(environment):
    client, db = environment
    sign_in(client)
    task = make_task(client)
    created = [client.post('/sessions', json=session(task, date, start, end)) for date, start, end in
               [('2026-10-06', 1080, 1110), ('2026-10-07', 540, 690), ('2026-10-09', 600, 630)]]
    assert [r.status_code for r in created] == [201, 201, 201]
    sessions = client.get('/sessions').json()
    assert [s['date'] for s in sessions] == ['2026-10-06', '2026-10-07', '2026-10-09']
    assert sum(s['end'] - s['start'] for s in sessions) == 210
    assert all(s['source'] == 'manual' and s['taskId'] == task['id'] for s in sessions)
    assert 'user_id' not in sessions[0]
    moved = client.put('/sessions/' + sessions[0]['id'], json=session(task, '2026-10-08', 600, 660))
    assert moved.status_code == 200 and moved.json()['date'] == '2026-10-08'
    assert client.delete('/sessions/' + sessions[1]['id']).status_code == 204
    assert len(client.get('/sessions').json()) == 2
    # Deleting the task removes its sessions.
    assert client.delete('/tasks/' + task['id']).status_code == 204
    assert client.get('/sessions').json() == [] and db.sessions.count_documents({}) == 0


def test_sessions_must_finish_before_task_is_due(environment):
    client, _ = environment
    sign_in(client)
    task = make_task(client, dueTime=17 * 60)
    assert client.post('/sessions', json=session(task, '2026-10-10')).status_code == 422
    late = client.post('/sessions', json=session(task, '2026-10-09', 960, 1050))
    assert late.status_code == 422 and 'due' in late.json()['detail']
    assert client.post('/sessions', json=session(task, '2026-10-09', 960, 1020)).status_code == 201
    default_due = make_task(client)
    assert client.post('/sessions', json=session(default_due, '2026-10-09', 1380, 1440)).status_code == 201


def test_sessions_cannot_overlap(environment):
    client, _ = environment
    sign_in(client)
    first, second = make_task(client), make_task(client, title='Essay')
    saved = client.post('/sessions', json=session(first, start=540, end=600)).json()
    clash = client.post('/sessions', json=session(second, start=570, end=630))
    assert clash.status_code == 409 and 'CV homework' in clash.json()['detail']
    assert client.post('/sessions', json=session(second, start=600, end=660)).status_code == 201  # back-to-back is fine
    assert client.put('/sessions/' + saved['id'], json=session(first, start=525, end=585)).status_code == 200  # moving itself


@pytest.mark.parametrize('change', [{'start': 600, 'end': 600}, {'start': 541}, {'end': 1445}, {'date': '2026-02-30'},
                                    {'source': 'ai'}, {'user_id': 'x'}])
def test_invalid_sessions_rejected(environment, change):
    client, db = environment
    sign_in(client)
    task = make_task(client)
    assert client.post('/sessions', json={**session(task), **change}).status_code == 422
    assert db.sessions.count_documents({}) == 0


def test_sessions_are_private(environment):
    client, _ = environment
    sign_in(client)
    task = make_task(client)
    mine = client.post('/sessions', json=session(task)).json()
    sign_in(client, 'bob-uid', 'bob@example.com', 'Bob')
    assert client.get('/sessions').json() == []
    assert client.post('/sessions', json=session(task, start=700, end=760)).status_code == 404
    assert client.put('/sessions/' + mine['id'], json=session(task)).status_code == 404
    assert client.delete('/sessions/' + mine['id']).status_code == 404
    bob_task = make_task(client)
    # Overlap checks are per user: Bob can use the same time slot.
    assert client.post('/sessions', json=session(bob_task)).status_code == 201
    client.headers.pop('Authorization')
    assert client.get('/sessions').status_code == 401
