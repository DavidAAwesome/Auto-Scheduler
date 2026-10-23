from conftest import sign_in

TASK = {'title': 'Prepare Sprint 1', 'deadline': '2026-10-09', 'minutes': 90, 'priority': 'High', 'category': 'Project'}


def test_first_request_creates_mongodb_profile_for_firebase_user(environment):
    client, db = environment
    user = sign_in(client)
    assert user == {'id': 'alice-uid', 'name': 'Alice', 'email': 'alice@example.com'}
    saved = db.users.find_one({'_id': 'alice-uid'})
    assert saved['email'] == 'alice@example.com' and saved['name'] == 'Alice'
    assert 'password_hash' not in saved  # Firebase owns credentials; MongoDB never stores passwords.
    assert client.get('/protected').json()['uid'] == 'alice-uid'
    assert client.get('/auth/me').headers['cache-control'] == 'no-store'
    sign_in(client)  # Repeat sign-ins update the same profile instead of duplicating it.
    assert db.users.count_documents({}) == 1


def test_name_falls_back_to_email_prefix(environment):
    client, _ = environment
    assert sign_in(client, 'bob-uid', 'bob@example.com', '')['name'] == 'bob'


def test_missing_and_invalid_tokens_are_rejected(environment):
    client, db = environment
    assert client.get('/protected').status_code == 401
    assert client.get('/auth/me', headers={'Authorization': 'Bearer nonsense'}).status_code == 401
    assert client.get('/auth/me', headers={'Authorization': 'Bearer valid||a@b.c|A'}).status_code == 401
    assert db.users.count_documents({}) == 0


def test_delete_account_removes_only_that_users_data(environment):
    client, db = environment
    sign_in(client)
    client.post('/tasks', json=TASK)
    client.put('/availability', json=client.get('/availability').json())
    sign_in(client, 'bob-uid', 'bob@example.com', 'Bob')
    client.post('/tasks', json=TASK)
    sign_in(client)
    assert client.delete('/auth/account').status_code == 204
    assert db.users.find_one({'_id': 'alice-uid'}) is None
    assert db.tasks.count_documents({'user_id': 'alice-uid'}) == 0
    assert db.availability.count_documents({'user_id': 'alice-uid'}) == 0
    assert db.tasks.count_documents({'user_id': 'bob-uid'}) == 1
    assert db.users.find_one({'_id': 'bob-uid'}) is not None


def test_cross_origin_mutations_rejected_and_cors_allows_frontend(environment):
    client, db = environment
    sign_in(client)
    response = client.post('/tasks', json=TASK, headers={'Origin': 'https://untrusted.example'})
    assert response.status_code == 403
    assert db.tasks.count_documents({}) == 0
    response = client.options('/tasks', headers={'Origin': 'http://localhost:5173', 'Access-Control-Request-Method': 'POST',
                                                 'Access-Control-Request-Headers': 'authorization,content-type'})
    assert response.status_code == 200
    assert response.headers['access-control-allow-origin'] == 'http://localhost:5173'
