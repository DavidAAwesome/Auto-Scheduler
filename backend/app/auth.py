"""Firebase Authentication: the frontend signs users in, the API verifies their ID tokens."""
from datetime import datetime, timezone
from typing import Callable

import firebase_admin
import google.auth.credentials
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import auth as firebase_auth, credentials
from pydantic import BaseModel

from app.config import get_settings
from app.database import get_database

router = APIRouter(prefix='/auth', tags=['auth'])
security = HTTPBearer(auto_error=False)

TokenVerifier = Callable[[str], dict]


class _PublicKeysOnly(credentials.Base):
    """Verifying ID tokens only needs Google's public signing keys, so no service account is required."""

    def get_credential(self):
        return google.auth.credentials.AnonymousCredentials()


def firebase_verifier() -> TokenVerifier:
    try:
        app = firebase_admin.get_app('autoplan')
    except ValueError:
        app = firebase_admin.initialize_app(_PublicKeysOnly(), {'projectId': get_settings().firebase_project_id}, name='autoplan')
    return lambda token: firebase_auth.verify_id_token(token, app=app)


class PublicUser(BaseModel):
    id: str
    name: str
    email: str


def public_user(user):
    return PublicUser(id=user['_id'], name=user['name'], email=user['email'])


def unauthorized():
    return HTTPException(status_code=401, detail='Please sign in again.', headers={'WWW-Authenticate': 'Bearer'})


def get_current_user(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(security),
                     db=Depends(get_database)):
    if not credentials:
        raise unauthorized()
    try:
        claims = request.app.state.verify_token(credentials.credentials)
    except Exception:
        raise unauthorized() from None
    uid = claims.get('uid') or claims.get('sub')
    if not uid:
        raise unauthorized()
    email = claims.get('email') or ''
    name = claims.get('name') or (email.split('@')[0] if email else 'AutoPlan user')
    # Keep a MongoDB profile per Firebase user; tasks and availability reference this uid.
    db.users.update_one({'_id': uid}, {'$set': {'email': email, 'name': name, 'last_seen': datetime.now(timezone.utc)},
                                       '$setOnInsert': {'created_at': datetime.now(timezone.utc)}}, upsert=True)
    return {'_id': uid, 'name': name, 'email': email}


@router.get('/me', response_model=PublicUser)
def current_user(user=Depends(get_current_user)):
    return public_user(user)


@router.delete('/account', status_code=204)
def delete_account(user=Depends(get_current_user), db=Depends(get_database)):
    """Removes the user's AutoPlan data. The frontend then deletes the Firebase account itself."""
    db.tasks.delete_many({'user_id': user['_id']})
    db.sessions.delete_many({'user_id': user['_id']})
    db.events.delete_many({'user_id': user['_id']})
    db.availability.delete_many({'user_id': user['_id']})
    db.users.delete_one({'_id': user['_id']})
