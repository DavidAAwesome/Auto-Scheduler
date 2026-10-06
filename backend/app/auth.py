"""Firebase owns sign-in; the API verifies Firebase ID tokens and keeps one MongoDB user per Firebase uid."""
from datetime import datetime, timezone
from functools import lru_cache
import ssl

import certifi
import jwt
from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.database import get_database

router = APIRouter(prefix='/auth', tags=['auth'])
security = HTTPBearer(auto_error=False)
FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'


class PublicUser(BaseModel):
    id: str
    name: str
    email: str


def public_user(user):
    return PublicUser(id=str(user['_id']), name=user['name'], email=user['email'])


def unauthorized():
    return HTTPException(status_code=401, detail='Please sign in again.', headers={'WWW-Authenticate': 'Bearer'})


@lru_cache
def jwks_client():
    # Explicit CA bundle for Python installs that lack system roots (see database.py).
    return jwt.PyJWKClient(FIREBASE_JWKS_URL, cache_keys=True,
                           ssl_context=ssl.create_default_context(cafile=certifi.where()))


def signing_key_for(token):
    try:
        return jwks_client().get_signing_key_from_jwt(token).key
    except jwt.PyJWKClientConnectionError:
        raise HTTPException(status_code=503, detail='Cannot reach Firebase to verify your sign-in. Try again shortly.') from None
    except jwt.PyJWKClientError:
        raise unauthorized() from None


def verify_firebase_token(token):
    """Checks signature, expiry, audience and issuer as Firebase documents for ID tokens."""
    if not token:
        raise unauthorized()
    project_id = get_settings().firebase_project_id
    try:
        claims = jwt.decode(token, signing_key_for(token), algorithms=['RS256'], audience=project_id,
                            issuer=f'https://securetoken.google.com/{project_id}', leeway=30,
                            options={'require': ['sub', 'iat', 'exp', 'auth_time']})
    except jwt.InvalidTokenError:
        raise unauthorized() from None
    if not claims['sub'] or claims['auth_time'] > datetime.now(timezone.utc).timestamp() + 30:
        raise unauthorized()
    return claims


def sync_user(claims, db):
    """Creates the user on first sight and keeps name/email in step with Firebase."""
    email = (claims.get('email') or '').strip().lower()
    updates = {'email': email}
    if claims.get('name'):
        updates['name'] = claims['name'].strip()[:80]
    query = {'firebase_uid': claims['sub']}
    change = {'$set': updates, '$setOnInsert': {'created_at': datetime.now(timezone.utc)}}
    if 'name' not in updates:
        change['$setOnInsert']['name'] = email.split('@')[0] or 'AutoPlan user'
    try:
        return db.users.find_one_and_update(query, change, upsert=True, return_document=ReturnDocument.AFTER)
    except DuplicateKeyError:  # A concurrent first request created the user.
        return db.users.find_one_and_update(query, {'$set': updates}, return_document=ReturnDocument.AFTER)


def get_current_user(credentials: HTTPAuthorizationCredentials | None = Depends(security), db=Depends(get_database)):
    claims = verify_firebase_token(credentials.credentials if credentials else None)
    return sync_user(claims, db)


@router.get('/me', response_model=PublicUser)
def current_user(response: Response, user=Depends(get_current_user)):
    response.headers['Cache-Control'] = 'no-store'
    return public_user(user)


@router.delete('/account', status_code=204)
def delete_account(user=Depends(get_current_user), db=Depends(get_database)):
    """Removes AutoPlan data; the client then deletes the Firebase account itself."""
    uid = str(user['_id'])
    for collection in (db.tasks, db.availability, db.plans):
        collection.delete_many({'user_id': uid})
    db.users.delete_one({'_id': user['_id']})
