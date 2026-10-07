from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from firebase_tokens import make_token, sign_in, sign_out


def bearer(token):
    return {'Authorization': 'Bearer ' + token}


def test_first_request_creates_user_and_later_requests_reuse_it(environment):
    client, db = environment
    user = sign_in(client, email=' ALICE@Example.com ', name=' Alice ')
    assert set(user) == {'id', 'name', 'email', 'avatarUrl'}
    assert user['name'] == 'Alice' and user['email'] == 'alice@example.com'
    assert user['avatarUrl'] is None
    saved = db.users.find_one({'firebase_uid': 'alice-uid'})
    assert str(saved['_id']) == user['id']
    assert 'password_hash' not in saved
    assert sign_in(client) == user
    assert db.users.count_documents({}) == 1
    assert client.get('/protected').json()['uid'] == user['id']
    assert client.get('/auth/me').headers['cache-control'] == 'no-store'


def test_name_follows_firebase_profile(environment):
    client, db = environment
    # Firebase signup sends a token before the display name is set.
    assert sign_in(client, name=None)['name'] == 'alice'
    assert sign_in(client, name='Alice Smith')['name'] == 'Alice Smith'
    assert sign_in(client, name=None)['name'] == 'Alice Smith'
    assert db.users.count_documents({}) == 1


@pytest.mark.parametrize('token', [
    'nonsense',
    make_token(key=rsa.generate_private_key(public_exponent=65537, key_size=2048)),
    make_token(exp=datetime.now(timezone.utc) - timedelta(minutes=5)),
    make_token(aud='another-project'),
    make_token(iss='https://securetoken.google.com/another-project'),
    make_token(sub=''),
    make_token(auth_time=None),
    make_token(auth_time=int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp())),
])
def test_rejects_invalid_tokens(environment, token):
    client, db = environment
    assert client.get('/auth/me', headers=bearer(token)).status_code == 401
    assert db.users.count_documents({}) == 0


def test_missing_token_is_unauthorized(environment):
    client, _ = environment
    assert client.get('/auth/me').status_code == 401
    assert client.get('/protected').status_code == 401


def test_tokens_resolve_only_their_own_user(environment):
    client, _ = environment
    first = sign_in(client)
    second = sign_in(client, uid='bob-uid', email='bob@example.com', name='Bob')
    assert first['id'] != second['id']
    sign_out(client)
    assert client.get('/auth/me', headers=bearer(make_token())).json() == first
    assert client.get('/auth/me', headers=bearer(make_token('bob-uid', 'bob@example.com', 'Bob'))).json() == second


def test_delete_account_removes_only_own_data(environment):
    client, db = environment
    other = sign_in(client, uid='bob-uid', email='bob@example.com', name='Bob')
    client.post('/tasks', json={'title': 'Keep', 'deadline': '2026-10-09', 'minutes': 30, 'priority': 'Low', 'category': 'Study'})
    sign_in(client)
    client.post('/tasks', json={'title': 'Remove', 'deadline': '2026-10-09', 'minutes': 30, 'priority': 'Low', 'category': 'Study'})
    assert client.delete('/auth/account').status_code == 204
    assert db.users.count_documents({}) == 1
    assert [t['title'] for t in db.tasks.find()] == ['Keep']
    assert db.tasks.find_one()['user_id'] == other['id']


def test_cross_origin_mutations_rejected_and_cors_allows_frontend(environment):
    client, db = environment
    sign_in(client)
    response = client.delete('/auth/account', headers={'Origin': 'https://untrusted.example'})
    assert response.status_code == 403
    assert db.users.count_documents({}) == 1
    response = client.options('/auth/me', headers={'Origin': 'http://localhost:5173', 'Access-Control-Request-Method': 'GET',
                                                  'Access-Control-Request-Headers': 'authorization'})
    assert response.status_code == 200
    assert response.headers['access-control-allow-origin'] == 'http://localhost:5173'


def test_avatar_url_is_stored_and_cleared(environment):
    client, db = environment
    sign_in(client)
    url = 'https://firebasestorage.googleapis.com/v0/b/demo/o/avatars%2Falice%2Favatar.jpg'
    saved = client.put('/auth/avatar', json={'avatarUrl': url}).json()
    assert saved['avatarUrl'] == url
    assert db.users.find_one({'firebase_uid': 'alice-uid'})['avatarUrl'] == url
    assert client.get('/auth/me').json()['avatarUrl'] == url
    cleared = client.put('/auth/avatar', json={'avatarUrl': None}).json()
    assert cleared['avatarUrl'] is None
    assert client.put('/auth/avatar', json={'avatarUrl': 'http://insecure.example/a.png'}).status_code == 422
