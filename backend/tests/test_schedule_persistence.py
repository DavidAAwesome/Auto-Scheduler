import logging
import pytest
from bson import ObjectId
from pymongo.collection import Collection
from pymongo.errors import DuplicateKeyError, OperationFailure
from app.database import migrate_session_indexes
from firebase_tokens import sign_in, sign_out
from test_schedule_api import _setup


def real_transactions(db):
    if db.client.__class__.__module__.startswith('mongomock'):
        pytest.skip('Persistence and rollback require a real MongoDB replica set.')
    hello = db.client.admin.command('hello')
    if not hello.get('setName') and hello.get('msg') != 'isdbgrid':
        pytest.skip('Persistence and rollback require a real MongoDB replica set.')


def test_legacy_index_failure_migration_and_reload(environment, monkeypatch, caplog):
    client, db = environment
    real_transactions(db)
    task = _setup(client, monkeypatch)
    db.sessions.create_index('jti', unique=True)
    db.sessions.create_index('expires_at', expireAfterSeconds=0)
    # Retain an existing block and verify the failed replacement rolls it back.
    old = {'_id':ObjectId(), 'user_id':str(db.users.find_one({'firebase_uid':'sched-user'})['_id']),
           'task_id':task['id'], 'date':'2026-10-05', 'start':1080, 'end':1140,
           'source':'auto','locked':False}
    db.sessions.insert_one(old)
    preview = client.post('/schedule/preview', json={'horizonDays':1}).json()
    with caplog.at_level(logging.ERROR, logger='autoplan.database'):
        failed = client.post('/schedule/apply', json={'previewId':preview['previewId']})
    assert failed.status_code == 409
    assert failed.json()['code'] == 'database_conflict'
    assert 'mongo_code=11000' in caplog.text
    assert 'path=/schedule/apply' in caplog.text
    assert list(db.sessions.find({})) == [old]
    assert db.schedule_previews.find_one({'_id':ObjectId(preview['previewId'])})['status'] == 'pending'
    migrate_session_indexes(db)
    migrate_session_indexes(db)
    assert db.sessions.index_information()['expires_at_1']['expireAfterSeconds'] == 0
    assert list(db.sessions.find({})) == [old]
    # Token uniqueness is preserved, and work sessions may omit jti.
    token = db.sessions.insert_one({'jti':'test-legacy-token'})
    with pytest.raises(DuplicateKeyError):
        db.sessions.insert_one({'jti':'test-legacy-token'})
    db.sessions.delete_one({'_id':token.inserted_id})
    response = client.post('/schedule/apply', json={'previewId':preview['previewId']})
    assert response.status_code == 200, response.text
    saved = client.get('/sessions').json()
    assert len(saved) == 2
    assert client.post('/schedule/apply', json={'previewId':preview['previewId']}).json() == response.json()
    sign_out(client)
    assert client.get('/sessions').status_code == 401
    sign_in(client,uid='sched-user',email='sched@example.com',name='Sched')
    assert client.get('/sessions').json() == saved


def test_failure_marking_preview_rolls_back_sessions(environment, monkeypatch):
    client,db=environment
    real_transactions(db)
    _setup(client,monkeypatch)
    first=client.post('/schedule/preview',json={'horizonDays':1}).json()
    assert client.post('/schedule/apply',json={'previewId':first['previewId']}).status_code == 200
    original=list(db.sessions.find({}))
    preview=client.post('/schedule/preview',json={'horizonDays':1}).json()
    update=Collection.update_one
    def fail(self,*args,**kwargs):
        if self.name == 'schedule_previews':
            raise OperationFailure('injected forbidden operation',13)
        return update(self,*args,**kwargs)
    monkeypatch.setattr(Collection,'update_one',fail)
    response=client.post('/schedule/apply',json={'previewId':preview['previewId']})
    assert response.status_code == 503
    assert response.json()['code'] == 'database_authorization'
    assert list(db.sessions.find({})) == original
    assert db.schedule_previews.find_one({'_id':ObjectId(preview['previewId'])})['status'] == 'pending'


def test_unsupported_transactions_dont_change_saved_data(environment, monkeypatch):
    client, db = environment
    _setup(client, monkeypatch)
    preview=client.post('/schedule/preview', json={'horizonDays':1}).json()
    def unsupported(*args, **kwargs):
        raise OperationFailure('Transaction numbers are only allowed on a replica set member or mongos',20)
    monkeypatch.setattr(db.client, 'start_session', unsupported)
    response=client.post('/schedule/apply',json={'previewId':preview['previewId']})
    assert response.status_code == 503
    assert response.json()['code'] == 'transactions_unsupported'
    assert client.get('/sessions').json() == []
    assert db.schedule_previews.find_one({'_id':ObjectId(preview['previewId'])})['status'] == 'pending'
