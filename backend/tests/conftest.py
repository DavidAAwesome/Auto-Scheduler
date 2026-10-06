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
    name = 'autoplan_auth_test_' + uuid.uuid4().hex
    db = mongo[name]
    with TestClient(create_app(db)) as client:
        yield client, db
    mongo.drop_database(name)  # Only the unique database created by this fixture.
    mongo.close()
    get_settings.cache_clear()
