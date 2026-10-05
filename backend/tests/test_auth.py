from datetime import datetime, timedelta, timezone
import jwt
import pytest
from pymongo.errors import DuplicateKeyError

from app.auth import COOKIE_NAME, password_hasher
from app.config import get_settings

PASSWORD = 'Test-only password 83!'


def signup(client, email='alice@example.com', name='Alice'):
    return client.post('/auth/signup', json={'name': name, 'email': email, 'password': PASSWORD})


def test_signup_persists_normalized_user_and_argon2_hash(environment):
    client, db = environment
    response = signup(client, ' ALICE@Example.com ', ' Alice ')
    assert response.status_code == 201
    assert set(response.json()) == {'id', 'name', 'email'}
    assert response.json()['name'] == 'Alice'
    assert response.json()['email'] == 'alice@example.com'
    saved = db.users.find_one({'email': 'alice@example.com'})
    assert str(saved['_id']) == response.json()['id']
    assert saved['password_hash'].startswith('$argon2id$')
    assert saved['password_hash'] != PASSWORD
    assert password_hasher.verify(saved['password_hash'], PASSWORD)
    assert 'password' not in saved
    assert saved['password_hash'] not in response.text
    cookie = response.headers['set-cookie']
    assert 'HttpOnly' in cookie and 'SameSite=lax' in cookie and 'Max-Age=' in cookie
    assert client.get('/auth/me').json() == response.json()
    assert client.get('/protected').json()['uid'] == response.json()['id']
    assert client.get('/auth/me').headers['cache-control'] == 'no-store'


def test_duplicate_email_and_database_unique_index(environment):
    client, db = environment
    assert signup(client).status_code == 201
    response = signup(client, ' Alice@EXAMPLE.com ')
    assert response.status_code == 409
    assert db.users.count_documents({}) == 1
    with pytest.raises(DuplicateKeyError):
        db.users.insert_one({'email': 'alice@example.com'})


def test_login_wrong_password_and_unknown_email(environment):
    client, _ = environment
    signup(client)
    client.post('/auth/logout')
    for email in ['alice@example.com', 'nobody@example.com']:
        response = client.post('/auth/login', json={'email': email, 'password': 'wrong'})
        assert response.status_code == 401
        assert response.json()['detail'] == 'Incorrect email or password.'
    assert client.get('/auth/me').status_code == 401
    response = client.post('/auth/login', json={'email': ' ALICE@example.com ', 'password': PASSWORD})
    assert response.status_code == 200
    assert set(response.json()) == {'id', 'name', 'email'}
    assert client.get('/auth/me').status_code == 200


def test_missing_forged_expired_and_revoked_tokens(environment):
    client, db = environment
    assert client.get('/protected').status_code == 401
    signup(client)
    token = client.cookies.get(COOKIE_NAME)
    claims = jwt.decode(token, get_settings().jwt_secret, algorithms=['HS256'], audience='autoplan-api', issuer='autoplan')
    client.cookies.clear()
    assert client.get('/protected', headers={'Authorization': 'Bearer nonsense'}).status_code == 401
    forged = jwt.encode(claims, 'different-signing-key-with-at-least-32-characters', algorithm='HS256')
    assert client.get('/protected', headers={'Authorization': 'Bearer '+forged}).status_code == 401
    expired = jwt.encode({**claims, 'exp': datetime.now(timezone.utc)-timedelta(seconds=1)}, get_settings().jwt_secret, algorithm='HS256')
    assert client.get('/auth/me', headers={'Authorization': 'Bearer '+expired}).status_code == 401
    assert client.get('/auth/me', headers={'Authorization': 'Bearer '+token}).status_code == 200
    db.sessions.update_one({'jti': claims['jti']}, {'$set': {'expires_at': datetime.now(timezone.utc)-timedelta(seconds=1)}})
    assert client.get('/auth/me', headers={'Authorization': 'Bearer '+token}).status_code == 401


def test_refresh_and_logout_revokes_replayed_token(environment):
    client, db = environment
    user = signup(client).json()
    token = client.cookies.get(COOKIE_NAME)
    # A browser reload restores the session via /me; no client-side flag is trusted.
    assert client.get('/auth/me').json() == user
    assert client.post('/auth/logout').status_code == 204
    assert db.sessions.count_documents({}) == 0
    assert client.get('/auth/me').status_code == 401
    assert client.get('/protected', headers={'Authorization': 'Bearer '+token}).status_code == 401
    assert client.post('/auth/logout').status_code == 204


def test_sessions_resolve_only_their_user_and_hashes_are_salted(environment):
    client, db = environment
    first = signup(client).json()
    first_token = client.cookies.get(COOKIE_NAME)
    client.cookies.clear()
    second = signup(client, 'bob@example.com', 'Bob').json()
    assert second['id'] != first['id']
    assert client.get('/auth/me').json() == second
    assert client.get('/auth/me', headers={'Authorization': 'Bearer '+first_token}).json() == first
    hashes = [user['password_hash'] for user in db.users.find()]
    assert hashes[0] != hashes[1]


@pytest.mark.parametrize('change', [{'name':' '}, {'email':'bad'}, {'password':'short'}, {'password':'        '}])
def test_signup_validation(environment, change):
    client, db = environment
    data = {'name':'Alice', 'email':'alice@example.com', 'password':PASSWORD, **change}
    response = client.post('/auth/signup', json=data)
    assert response.status_code == 422
    assert db.users.count_documents({}) == 0
    assert 'input' not in response.text  # Never echo submitted passwords in validation responses.


def test_cross_origin_mutations_rejected_and_cors_allows_frontend(environment):
    client, db = environment
    response = client.post('/auth/signup', json={'name':'Alice','email':'alice@example.com','password':PASSWORD}, headers={'Origin':'https://untrusted.example'})
    assert response.status_code == 403
    assert db.users.count_documents({}) == 0
    response = client.options('/auth/login', headers={'Origin':'http://localhost:5173','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'})
    assert response.status_code == 200
    assert response.headers['access-control-allow-credentials'] == 'true'
    assert response.headers['access-control-allow-origin'] == 'http://localhost:5173'


def test_new_login_rotates_existing_session(environment):
    client, db = environment
    signup(client)
    old = client.cookies.get(COOKIE_NAME)
    assert client.post('/auth/login', json={'email':'alice@example.com','password':PASSWORD}).status_code == 200
    assert db.sessions.count_documents({}) == 1
    assert client.get('/auth/me', headers={'Authorization':'Bearer '+old}).status_code == 401
