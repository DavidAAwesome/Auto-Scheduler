"""Pending actions: propose → confirm (exactly once) or cancel, with ownership and staleness checks.

On the mock database the confirm step runs without a transaction (the mock has none); the same code runs in
a transaction on a replica set, which `test_confirm_over_a_real_transaction` covers when TEST_MONGODB_URI is set.
Every deletion here targets disposable records created by the test itself.
"""
import pytest

from app import pending_actions
from firebase_tokens import sign_in, sign_out
from schedule_fixtures import TODAY, TOMORROW, add_task, setup_user
from test_plan_api import interpret, owner, save_auto_sessions


@pytest.fixture
def no_txn(monkeypatch):
    monkeypatch.setattr(pending_actions, 'transactional', lambda db, fn: fn(None))


def counts(db):
    return {n: db[n].count_documents({}) for n in ('tasks', 'events', 'sessions')}


def propose_delete(client, *ids):
    response = client.post('/actions/delete-tasks', json={'taskIds': list(ids)})
    assert response.status_code == 201, response.text
    return response.json()


def test_delete_proposal_names_tasks_and_sessions_and_changes_nothing(environment, monkeypatch, no_txn):
    client, db = environment
    setup_user(client, monkeypatch)
    essay = add_task(client, 'Disposable essay', 'Medium')
    save_auto_sessions(db, essay['id'], [(540, 590), (600, 650)])
    before = counts(db)
    action = propose_delete(client, essay['id'])
    assert action['status'] == 'awaiting_confirmation' and action['type'] == 'delete_tasks'
    assert action['targets'] == [{'id': essay['id'], 'title': 'Disposable essay', 'detail': '2 sessions'}]
    assert action['sessionCount'] == 2 and '“Disposable essay”' in action['summary']
    assert counts(db) == before
    assert [a['id'] for a in client.get('/actions').json()] == [action['id']]  # survives a refresh


def test_confirm_runs_exactly_once(environment, monkeypatch, no_txn):
    client, db = environment
    setup_user(client, monkeypatch)
    keep = add_task(client, 'Keep me', 'High')
    gone = add_task(client, 'Disposable draft', 'Low')
    save_auto_sessions(db, gone['id'], [(540, 590)])
    action = propose_delete(client, gone['id'])
    first = client.post(f"/actions/{action['id']}/confirm", json={'version': action['version']})
    assert first.status_code == 200, first.text
    body = first.json()
    assert body['action']['status'] == 'succeeded' and body['deletedTaskIds'] == [gone['id']] and not body['duplicate']
    assert [t['id'] for t in client.get('/tasks').json()] == [keep['id']]
    assert db.sessions.count_documents({'task_id': gone['id']}) == 0
    after = counts(db)
    again = client.post(f"/actions/{action['id']}/confirm", json={'version': action['version']})
    assert again.status_code == 200 and again.json()['duplicate'] is True
    assert counts(db) == after
    assert client.get('/actions').json() == []


def test_cancel_changes_nothing_and_cannot_be_confirmed(environment, monkeypatch, no_txn):
    client, db = environment
    setup_user(client, monkeypatch)
    task = add_task(client, 'Disposable task', 'Low')
    action = propose_delete(client, task['id'])
    before = counts(db)
    cancelled = client.post(f"/actions/{action['id']}/cancel")
    assert cancelled.status_code == 200 and cancelled.json()['status'] == 'cancelled'
    assert counts(db) == before
    late = client.post(f"/actions/{action['id']}/confirm", json={'version': action['version']})
    assert late.status_code == 409 and 'cancelled' in late.json()['detail']
    assert counts(db) == before


def test_stale_wrong_version_and_foreign_actions_are_rejected(environment, monkeypatch, no_txn):
    client, db = environment
    setup_user(client, monkeypatch)
    task = add_task(client, 'Disposable task', 'Low')
    action = propose_delete(client, task['id'])
    wrong = client.post(f"/actions/{action['id']}/confirm", json={'version': action['version'] + 7})
    assert wrong.status_code == 409 and 'out of date' in wrong.json()['detail']

    sign_out(client)
    sign_in(client, uid='intruder', email='intruder@example.com', name='Other')
    foreign = client.post(f"/actions/{action['id']}/confirm", json={'version': action['version']})
    assert foreign.status_code == 404
    assert client.post('/actions/delete-tasks', json={'taskIds': [task['id']]}).status_code == 404
    assert client.post('/actions/not-an-id/confirm', json={'version': 1}).status_code == 404
    sign_out(client)
    sign_in(client, uid='sched-user', email='sched-user@example.com', name='Sched')

    # The task changes after the proposal: the schedule version moves on, so the old proposal is stale.
    assert client.patch(f"/tasks/{task['id']}/completion", json={'done': True}).status_code == 200
    stale = client.post(f"/actions/{action['id']}/confirm", json={'version': action['version']})
    assert stale.status_code == 409 and 'changed after this was proposed' in stale.json()['detail']
    assert db.tasks.count_documents({}) == 1
    failed = [a for a in client.get('/actions').json() if a['id'] == action['id']][0]
    assert failed['status'] == 'failed' and 'nothing was deleted' in failed['error']  # shown to the user


def test_database_error_is_reported_and_retry_is_safe(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    task = add_task(client, 'Disposable task', 'Low')
    action = propose_delete(client, task['id'])

    def broken(db_, fn):
        raise RuntimeError('replica set unreachable')
    monkeypatch.setattr(pending_actions, 'transactional', broken)
    with pytest.raises(RuntimeError):
        client.post(f"/actions/{action['id']}/confirm", json={'version': action['version']})
    assert db.tasks.count_documents({}) == 1
    assert client.get('/actions').json()[0]['status'] == 'failed'
    monkeypatch.setattr(pending_actions, 'transactional', lambda db_, fn: fn(None))
    retry = client.post(f"/actions/{action['id']}/confirm", json={'version': action['version']})
    assert retry.status_code == 200 and db.tasks.count_documents({}) == 0


def test_confirm_tasks_saves_selected_drafts_once_and_keeps_noon(environment, monkeypatch, no_txn):
    client, db = environment
    setup_user(client, monkeypatch)
    drafts = interpret(client, 'Lab report 60 min due tomorrow at noon high priority\nGym sometime')
    assert drafts[0]['dueTime'] == 12 * 60
    assert client.post('/actions/create-items', json={'drafts': drafts, 'batchId': 'b-noon'}).status_code == 422
    drafts[1]['include'] = False  # the unselected, incomplete item must not block the selected one
    created = client.post('/actions/create-items', json={'drafts': drafts, 'batchId': 'b-noon'})
    assert created.status_code == 201, created.text
    action = created.json()
    assert [t['title'] for t in action['targets']] == ['Lab report'] and 'due 2026-10-27 12:00 PM' in action['targets'][0]['detail']
    assert counts(db)['tasks'] == 0
    result = client.post(f"/actions/{action['id']}/confirm", json={'version': action['version']}).json()
    assert [(t['title'], t['deadline'], t['dueTime']) for t in result['tasks']] == [('Lab report', TOMORROW, 720)]
    assert [(t['title'], t['dueTime']) for t in client.get('/tasks').json()] == [('Lab report', 720)]
    # The same drafts cannot be saved again, by a new proposal or through a plan preview.
    second = client.post('/actions/create-items', json={'drafts': drafts, 'batchId': 'b-noon'}).json()
    again = client.post(f"/actions/{second['id']}/confirm", json={'version': second['version']})
    assert again.status_code == 409 and 'already saved' in again.json()['detail']
    assert counts(db)['tasks'] == 1


def test_unselected_draft_that_a_selected_one_depends_on_is_flagged(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    drafts = interpret(client, f'Outline 30 min due {TODAY} 11am\nEssay 60 min due tomorrow after outline')
    assert drafts[1]['dependsOn'] == [drafts[0]['id']]
    drafts[0]['include'] = False
    views = client.post('/plan/review', json={'drafts': drafts, 'horizonDays': 1}).json()
    assert views[0]['ready'] and not views[1]['ready']
    assert 'not selected' in views[1]['issues'][0]['question']


def test_confirm_over_a_real_transaction(transaction_environment, monkeypatch):
    client, db = transaction_environment
    setup_user(client, monkeypatch)
    task = add_task(client, 'Disposable task', 'Low')
    save_auto_sessions(db, task['id'], [(540, 590)])
    action = propose_delete(client, task['id'])
    assert client.post(f"/actions/{action['id']}/confirm", json={'version': action['version']}).status_code == 200
    assert db.tasks.count_documents({'user_id': str(owner(db)['_id'])}) == 0 and db.sessions.count_documents({}) == 0
