import os
import uuid

import mongomock
import pytest
from fastapi.testclient import TestClient
from pymongo import MongoClient

from app.config import get_settings
from app.main import create_app


def fake_verify_token(token):
    """Stands in for Firebase: tokens look like 'valid|<uid>|<email>|<name>'."""
    kind, uid, email, name = (token.split('|') + ['', '', '', ''])[:4]
    if kind != 'valid' or not uid:
        raise ValueError('Invalid Firebase ID token')
    return {'uid': uid, 'email': email, 'name': name}


def sign_in(client, uid='alice-uid', email='alice@example.com', name='Alice'):
    """Authenticates later requests as a Firebase user and returns that user's profile."""
    client.headers['Authorization'] = f'Bearer valid|{uid}|{email}|{name}'
    response = client.get('/auth/me')
    assert response.status_code == 200
    return response.json()


@pytest.fixture(params=['mock', 'mongo'])
def environment(request, monkeypatch):
    monkeypatch.setenv('MONGODB_URI', 'mongodb://127.0.0.1:27019')
    monkeypatch.setenv('FIREBASE_PROJECT_ID', 'autoplan-test')
    monkeypatch.setenv('ALLOWED_ORIGINS', 'http://localhost:5173')
    get_settings.cache_clear()
    if request.param == 'mongo':
        uri = os.getenv('TEST_MONGODB_URI')
        if not uri:
            pytest.skip('Set TEST_MONGODB_URI to run against a real MongoDB server.')
        mongo = MongoClient(uri, serverSelectionTimeoutMS=3000, tz_aware=True)
        mongo.admin.command('ping')  # An explicitly requested integration run must fail if inaccessible.
    else:
        mongo = mongomock.MongoClient(tz_aware=True)
    name = 'autoplan_auth_test_' + uuid.uuid4().hex
    db = mongo[name]
    with TestClient(create_app(db, verify_token=fake_verify_token)) as client:
        yield client, db
    mongo.drop_database(name)  # Only the unique database created by this fixture.
    mongo.close()
    get_settings.cache_clear()
