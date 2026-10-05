from fastapi import Request
from pymongo import MongoClient

from app.config import get_settings


def connect_database():
    settings = get_settings()
    client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=5000, tz_aware=True)
    client.admin.command('ping')
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
