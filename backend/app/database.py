from urllib.parse import parse_qsl, urlsplit

import certifi
from fastapi import Request
from pymongo import MongoClient

from app.config import get_settings


def connect_database():
    settings = get_settings()
    options = {}
    uri_options = {key.lower(): value for key, value in parse_qsl(urlsplit(settings.mongodb_uri).query)}
    # Atlas SRV connections use TLS. Supply trusted roots even when the local
    # Python installation lacks them, while honoring an explicit custom CA.
    if settings.mongodb_uri.startswith('mongodb+srv://') and 'tlscafile' not in uri_options:
        options['tlsCAFile'] = certifi.where()
    client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=5000, tz_aware=True, **options)
    try:
        client.admin.command('ping')
    except Exception:
        client.close()
        raise
    return client, client[settings.database_name]


def migrate_session_indexes(db):
    """Keep legacy token uniqueness, but exclude work sessions without a jti.

    Build the replacement before removing the old index. Never delete documents
    or remove the token TTL index. Safe to rerun after an interrupted startup.
    """
    indexes = db.sessions.index_information()
    legacy = [name for name, spec in indexes.items()
              if spec.get('key') == [('jti', 1)] and spec.get('unique')
              and not spec.get('sparse') and not spec.get('partialFilterExpression')]
    if legacy:
        db.sessions.create_index('jti', unique=True,
                                 partialFilterExpression={'jti': {'$exists': True}},
                                 name='unique_present_session_jti')
        for name in legacy:
            db.sessions.drop_index(name)


def initialize_indexes(db):
    migrate_session_indexes(db)
    # Firebase decides who owns an email; uid is the stable identity here.
    if 'unique_user_email' in db.users.index_information():
        db.users.drop_index('unique_user_email')
    db.users.create_index('firebase_uid', unique=True, sparse=True, name='unique_firebase_uid')
    db.users.create_index('email', name='user_email')
    db.tasks.create_index([('user_id', 1), ('deadline', 1)])
    db.availability.create_index('user_id', unique=True)
    db.plans.create_index('user_id', unique=True)
    db.sessions.create_index([('user_id', 1), ('date', 1), ('start', 1)])
    db.sessions.create_index([('user_id', 1), ('task_id', 1)])
    db.events.create_index([('user_id', 1), ('date', 1)])
    db.events.create_index([('user_id', 1), ('source', 1), ('date', 1)])
    db.calendar_connections.create_index([('user_id', 1), ('provider', 1)], unique=True)


def get_database(request: Request):
    return request.app.state.db
