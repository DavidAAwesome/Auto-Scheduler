from fastapi import Request
import certifi
from pymongo import MongoClient
from urllib.parse import parse_qsl, urlsplit

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


def initialize_indexes(db):
    db.users.create_index('email', unique=True, name='unique_user_email')
    db.sessions.create_index('jti', unique=True)
    db.sessions.create_index('expires_at', expireAfterSeconds=0)
    db.sessions.create_index('user_id')
    db.tasks.create_index([('user_id', 1), ('deadline', 1)])
    db.availability.create_index('user_id', unique=True)


def get_database(request: Request):
    return request.app.state.db
