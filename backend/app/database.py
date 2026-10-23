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
    # Python installation lacks them, while honoring an explicit custom CA. (Lan's fix, 9ca21b6)
    if settings.mongodb_uri.startswith('mongodb+srv://') and 'tlscafile' not in uri_options:
        options['tlsCAFile'] = certifi.where()
    client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=5000, tz_aware=True, **options)
    try:
        client.admin.command('ping')
    except Exception:
        client.close()
        raise
    return client, client[settings.database_name]


def initialize_indexes(db):
    db.tasks.create_index([('user_id', 1), ('deadline', 1)])
    db.availability.create_index('user_id', unique=True)
    db.sessions.create_index([('user_id', 1), ('date', 1), ('start', 1)])
    db.sessions.create_index([('user_id', 1), ('task_id', 1)])
    db.events.create_index([('user_id', 1), ('date', 1)])


def get_database(request: Request):
    return request.app.state.db
