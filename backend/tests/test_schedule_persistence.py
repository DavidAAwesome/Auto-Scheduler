import logging

import pytest
from bson import ObjectId
from pymongo.collection import Collection
from pymongo.errors import DuplicateKeyError, OperationFailure

from app.database import initialize_indexes, migrate_session_indexes
from firebase_tokens import sign_in, sign_out
from schedule_fixtures import ACCEPTANCE, TODAY, acceptance_tasks, rows, setup_user


def real_transactions(db):
    if db.client.__class__.__module__.startswith('mongomock'):
        pytest.skip('Persistence and rollback require a real MongoDB replica set.')
    hello = db.client.admin.command('hello')
    if not hello.get('setName') and hello.get('msg') != 'isdbgrid':
        pytest.skip('Persistence and rollback require a real MongoDB replica set.')


def owner_id(db):
    return str(db.users.find_one({'firebase_uid': 'sched-user'})['_id'])


def test_legacy_index_failure_migration_and_reload(environment, monkeypatch, caplog):
    client, db = environment
    real_transactions(db)
    setup_user(client, monkeypatch)
    asm, _ = acceptance_tasks(client)
    db.sessions.create_index('jti', unique=True)  # a legacy auth-token index that rejects documents without jti
    db.sessions.create_index('expires_at', expireAfterSeconds=0)
    old = {'_id': ObjectId(), 'user_id': owner_id(db), 'task_id': asm['id'], 'type': 'work', 'status': 'completed',
           'date': '2026-10-25', 'start': 600, 'end': 630, 'source': 'manual', 'locked': False}
    db.sessions.insert_one(old)
    proposal = client.post('/schedule/preview', json={'horizonDays': 1}).json()
    with caplog.at_level(logging.ERROR, logger='autoplan.database'):
        failed = client.post('/schedule/apply', json={'previewId': proposal['previewId']})
    assert failed.status_code == 409 and failed.json()['code'] == 'database_conflict'
    assert 'mongo_code=11000' in caplog.text and 'path=/schedule/apply' in caplog.text
    assert list(db.sessions.find({})) == [old]  # nothing partially saved
    assert db.schedule_previews.find_one({'_id': ObjectId(proposal['previewId'])})['status'] == 'proposed'
    migrate_session_indexes(db)
    migrate_session_indexes(db)
    assert db.sessions.index_information()['expires_at_1']['expireAfterSeconds'] == 0
    token = db.sessions.insert_one({'jti': 'test-legacy-token'})
    with pytest.raises(DuplicateKeyError):
        db.sessions.insert_one({'jti': 'test-legacy-token'})
    db.sessions.delete_one({'_id': token.inserted_id})
    response = client.post('/schedule/apply', json={'previewId': proposal['previewId']})
    assert response.status_code == 200, response.text
    saved = client.get('/schedule').json()
    assert rows(saved['sessions'])[1:] == ACCEPTANCE  # after yesterday's completed session
    sign_out(client)
    assert client.get('/schedule').status_code == 401
    sign_in(client, uid='sched-user', email='sched-user@example.com', name='Sched')
    assert client.get('/schedule').json() == saved


def test_failure_marking_preview_rolls_back_sessions(environment, monkeypatch):
    client, db = environment
    real_transactions(db)
    setup_user(client, monkeypatch)
    acceptance_tasks(client)
    first = client.post('/schedule/preview', json={'horizonDays': 1}).json()
    assert client.post('/schedule/apply', json={'previewId': first['previewId']}).status_code == 200
    original = list(db.sessions.find({}))
    proposal = client.post('/schedule/preview', json={'horizonDays': 1}).json()
    update = Collection.update_one

    def fail(self, *args, **kwargs):
        if self.name == 'schedule_previews':
            raise OperationFailure('injected forbidden operation', 13)
        return update(self, *args, **kwargs)

    monkeypatch.setattr(Collection, 'update_one', fail)
    response = client.post('/schedule/apply', json={'previewId': proposal['previewId']})
    assert response.status_code == 503 and response.json()['code'] == 'database_authorization'
    assert list(db.sessions.find({})) == original
    assert db.schedule_previews.find_one({'_id': ObjectId(proposal['previewId'])})['status'] == 'proposed'


def test_legacy_sessions_get_utc_timestamps_in_owner_timezone(environment, monkeypatch):
    client, db = environment
    setup_user(client, monkeypatch)
    asm, _ = acceptance_tasks(client)
    legacy = db.sessions.insert_one({'user_id': owner_id(db), 'task_id': asm['id'], 'date': TODAY, 'start': 540, 'end': 600,
                                     'source': 'manual', 'locked': False}).inserted_id
    db.sessions.insert_one({'jti': 'auth-token-doc'})  # unrelated legacy document in the same collection
    initialize_indexes(db)
    initialize_indexes(db)
    doc = db.sessions.find_one({'_id': legacy})
    assert doc['start_at'].replace(tzinfo=None).isoformat() == '2026-10-26T13:00:00'  # 9 AM EDT stored as UTC
    assert (doc['type'], doc['status']) == ('work', 'saved')
    assert rows(client.get('/schedule').json()['sessions']) == [(TODAY, '09:00-10:00', 'work', 'Asm')]
