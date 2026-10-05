"""One MongoDB-backed authentication flow; replaces the unused Firebase verifier."""
from datetime import datetime, timedelta, timezone
import secrets
import re

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, field_validator
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.database import get_database

router = APIRouter(prefix='/auth', tags=['auth'])
security = HTTPBearer(auto_error=False)
password_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)
DUMMY_HASH = password_hasher.hash(secrets.token_urlsafe(32))
COOKIE_NAME = 'autoplan_session'


class LoginInput(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)

    @field_validator('email')
    @classmethod
    def normalize_email(cls, value):
        value = value.strip().lower()
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value):
            raise ValueError('Enter a valid email address.')
        return value


class SignupInput(LoginInput):
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=128)

    @field_validator('name')
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('Enter your name.')
        return value

    @field_validator('password')
    @classmethod
    def nonblank_password(cls, value):
        if not value.strip():
            raise ValueError('Password cannot contain only spaces.')
        return value


class PublicUser(BaseModel):
    id: str
    name: str
    email: str


def public_user(user):
    return PublicUser(id=str(user['_id']), name=user['name'], email=user['email'])


def unauthorized():
    return HTTPException(status_code=401, detail='Please sign in again.', headers={'WWW-Authenticate': 'Bearer'})


def read_token(request: Request, credentials: HTTPAuthorizationCredentials | None):
    return credentials.credentials if credentials else request.cookies.get(COOKIE_NAME)


def decode_token(token):
    if not token:
        raise unauthorized()
    try:
        return jwt.decode(token, get_settings().jwt_secret, algorithms=['HS256'],
                          issuer='autoplan', audience='autoplan-api',
                          options={'require': ['sub', 'jti', 'iat', 'exp']})
    except jwt.InvalidTokenError:
        raise unauthorized() from None


def get_current_user(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(security),
                     db=Depends(get_database)):
    claims = decode_token(read_token(request, credentials))
    if not ObjectId.is_valid(claims['sub']):
        raise unauthorized()
    session = db.sessions.find_one({'jti': claims['jti'], 'user_id': claims['sub'],
                                    'expires_at': {'$gt': datetime.now(timezone.utc)}})
    if not session:
        raise unauthorized()
    user = db.users.find_one({'_id': ObjectId(claims['sub'])}, {'name': 1, 'email': 1})
    if not user:
        raise unauthorized()
    return user


def issue_session(user, request, response, db):
    # Rotate the presented session rather than leaving the old cookie usable.
    old_token = request.cookies.get(COOKIE_NAME)
    if old_token:
        try:
            old_claims = decode_token(old_token)
            db.sessions.delete_one({'jti': old_claims['jti']})
        except HTTPException:
            pass
    now = datetime.now(timezone.utc)
    settings = get_settings()
    expires = now + timedelta(seconds=settings.session_seconds)
    jti = secrets.token_urlsafe(32)
    uid = str(user['_id'])
    token = jwt.encode({'sub': uid, 'jti': jti, 'iat': now, 'exp': expires,
                        'iss': 'autoplan', 'aud': 'autoplan-api'}, settings.jwt_secret, algorithm='HS256')
    db.sessions.insert_one({'jti': jti, 'user_id': uid, 'expires_at': expires})
    response.set_cookie(COOKIE_NAME, token, max_age=settings.session_seconds, httponly=True,
                        secure=settings.cookie_secure, samesite='lax', path='/')
    response.headers['Cache-Control'] = 'no-store'


@router.post('/signup', response_model=PublicUser, status_code=201)
def signup(data: SignupInput, request: Request, response: Response, db=Depends(get_database)):
    user = {'name': data.name, 'email': data.email, 'password_hash': password_hasher.hash(data.password),
            'created_at': datetime.now(timezone.utc)}
    try:
        user['_id'] = db.users.insert_one(user).inserted_id
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail='An account with this email already exists.') from None
    issue_session(user, request, response, db)
    return public_user(user)


@router.post('/login', response_model=PublicUser)
def login(data: LoginInput, request: Request, response: Response, db=Depends(get_database)):
    user = db.users.find_one({'email': data.email})
    try:
        valid = password_hasher.verify(user['password_hash'] if user else DUMMY_HASH, data.password)
    except (VerificationError, InvalidHashError):
        valid = False
    if not user or not valid:
        raise HTTPException(status_code=401, detail='Incorrect email or password.')
    if password_hasher.check_needs_rehash(user['password_hash']):
        db.users.update_one({'_id': user['_id']}, {'$set': {'password_hash': password_hasher.hash(data.password)}})
    issue_session(user, request, response, db)
    return public_user(user)


@router.get('/me', response_model=PublicUser)
def current_user(response: Response, user=Depends(get_current_user)):
    response.headers['Cache-Control'] = 'no-store'
    return public_user(user)


@router.post('/logout', status_code=204)
def logout(request: Request, response: Response, credentials: HTTPAuthorizationCredentials | None = Depends(security),
           db=Depends(get_database)):
    try:
        claims = decode_token(read_token(request, credentials))
        db.sessions.delete_one({'jti': claims['jti']})
    except HTTPException:
        pass  # Logout is idempotent, including already-expired sessions.
    response.delete_cookie(COOKIE_NAME, path='/', httponly=True, secure=get_settings().cookie_secure, samesite='lax')
    response.headers['Cache-Control'] = 'no-store'
