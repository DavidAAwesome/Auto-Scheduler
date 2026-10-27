import os
import uuid

import mongomock
import pytest
from fastapi.testclient import TestClient
from pymongo import MongoClient

from app import auth
from app.config import get_settings
from firebase_tokens import PROJECT_ID, PUBLIC_KEY
from app.main import create_app


@pytest.fixture(params=['mock', 'mongo'])
def environment(request, monkeypatch):
    monkeypatch.setenv('FIREBASE_PROJECT_ID', PROJECT_ID)
    monkeypatch.setenv('MONGODB_URI', 'mongodb://127.0.0.1:27019')
    monkeypatch.setenv('ALLOWED_ORIGINS', 'http://localhost:5173')
    # Use the test key instead of fetching Google's public keys.
    monkeypatch.setattr(auth, 'signing_key_for', lambda token: PUBLIC_KEY)
    get_settings.cache_clear()
    if request.param == 'mongo':
        uri = os.getenv('TEST_MONGODB_URI')
        if not uri:
            pytest.skip('Set TEST_MONGODB_URI to run against a real MongoDB server.')
        mongo = MongoClient(uri, serverSelectionTimeoutMS=3000, tz_aware=True)
        mongo.admin.command('ping')  # An explicitly requested integration run must fail if inaccessible.
    else:
        mongo = mongomock.MongoClient(tz_aware=True)
    name = 'aptest_' + uuid.uuid4().hex[:24]
    db = mongo[name]
    try:
        with TestClient(create_app(db)) as client:
            yield client, db
    finally:
        mongo.drop_database(name)  # Only the unique database created by this fixture.
        mongo.close()
        get_settings.cache_clear()


@pytest.fixture
def transaction_environment(environment):
    client, db = environment
    if isinstance(db.client, mongomock.MongoClient):
        pytest.skip('Transactions require a real MongoDB replica set; no mock persistence fallback.')
    hello = db.client.admin.command('hello')
    if not hello.get('setName') and hello.get('msg') != 'isdbgrid':
        pytest.skip('Transactions require a replica set or sharded cluster.')
    return client, db
