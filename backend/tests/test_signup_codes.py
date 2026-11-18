from datetime import timedelta

import pytest

from app import signup_codes
from firebase_tokens import make_token

EMAIL = 'new.person@example.com'


@pytest.fixture
def sent(monkeypatch):
    """Captures emailed codes instead of sending them."""
    outbox = []
    monkeypatch.setattr(signup_codes, 'send_code_email', lambda email, code: outbox.append((email, code)))
    return outbox


def request_code(client, email=EMAIL):
    return client.post('/auth/signup-code', json={'email': email})


def verify(client, code, email=EMAIL):
    return client.post('/auth/signup-code/verify', json={'email': email, 'code': code})


def first_sign_in(client, email=EMAIL, verified_by_google=False):
    """The browser's first /auth/me after creating the Firebase account (password accounts are not verified by Firebase)."""
    token = make_token(uid='new-uid', email=email, name='New Person', email_verified=True if verified_by_google else None)
    return client.get('/auth/me', headers={'Authorization': 'Bearer ' + token})


def age(db, collection, field, minutes):
    """Moves a stored time into the past."""
    record = db[collection].find_one({'email': EMAIL})
    db[collection].update_one({'_id': record['_id']}, {'$set': {field: record[field] - timedelta(minutes=minutes)}})


def test_correct_code_lets_the_account_be_created(environment, sent):
    client, db = environment
    response = request_code(client, ' New.Person@Example.com ')
    assert response.status_code == 201, response.text
    assert response.json() == {'email': EMAIL, 'expiresInSeconds': 300, 'resendInSeconds': 60}
    assert len(sent) == 1 and sent[0][0] == EMAIL and len(sent[0][1]) == 6 and sent[0][1].isdigit()
    assert verify(client, sent[0][1]).json() == {'verified': True, 'email': EMAIL}
    me = first_sign_in(client)
    assert me.status_code == 200, me.text
    assert me.json()['email'] == EMAIL and me.json()['emailVerified'] is True
    assert db.users.count_documents({'email': EMAIL}) == 1


def test_codes_are_stored_hashed_and_cannot_be_reused(environment, sent):
    client, db = environment
    request_code(client)
    code = sent[0][1]
    stored = db.signup_codes.find_one({'email': EMAIL})
    assert code not in str(stored)
    assert verify(client, code).status_code == 200
    assert verify(client, code).status_code == 400  # Used up.


def test_no_account_without_a_verified_email(environment):
    client, db = environment
    response = first_sign_in(client)
    assert response.status_code == 403
    assert 'Verify your email' in response.json()['detail']
    assert db.users.count_documents({}) == 0


def test_google_confirmed_addresses_need_no_code(environment):
    client, db = environment
    response = first_sign_in(client, verified_by_google=True)
    assert response.status_code == 200 and response.json()['emailVerified'] is True


def test_existing_accounts_still_sign_in(environment):
    client, db = environment
    assert first_sign_in(client, verified_by_google=True).status_code == 200
    db.users.update_one({'email': EMAIL}, {'$unset': {'email_verified': ''}})  # An account from before this feature.
    response = first_sign_in(client)
    assert response.status_code == 200 and response.json()['emailVerified'] is False


def test_wrong_codes_count_down_then_lock(environment, sent):
    client, _ = environment
    request_code(client)
    wrong = '000000' if sent[0][1] != '000000' else '111111'
    messages = [verify(client, wrong).json()['detail'] for _ in range(4)]
    assert messages == ['That code is not right. 4 tries left.', 'That code is not right. 3 tries left.',
                        'That code is not right. 2 tries left.', 'That code is not right. 1 try left.']
    last = verify(client, wrong)
    assert last.status_code == 429
    assert verify(client, sent[0][1]).status_code == 429, 'locked even for the right code'


def test_codes_expire_after_five_minutes(environment, sent):
    client, _ = environment
    request_code(client)
    age(environment[1], 'signup_codes', 'expires_at', 5)
    response = verify(client, sent[0][1])
    assert response.status_code == 410 and 'expired' in response.json()['detail']


def test_a_new_code_replaces_the_old_one_after_a_minute(environment, sent):
    client, db = environment
    request_code(client)
    again = request_code(client)
    assert again.status_code == 429 and 'seconds' in again.json()['detail']
    age(db, 'signup_codes', 'sent_at', 1)
    assert request_code(client).status_code == 201
    assert verify(client, sent[0][1]).status_code == 400, 'the first code no longer works'
    assert verify(client, sent[1][1]).status_code == 200


def test_at_most_five_codes_an_hour(environment, sent):
    client, db = environment
    for _ in range(5):
        assert request_code(client).status_code == 201
        age(db, 'signup_codes', 'sent_at', 1)
    assert request_code(client).status_code == 429
    age(db, 'signup_codes', 'window_start', 60)
    assert request_code(client).status_code == 201


def test_no_code_for_an_email_that_already_has_an_account(environment, sent):
    client, _ = environment
    first_sign_in(client, verified_by_google=True)
    response = request_code(client)
    assert response.status_code == 409 and sent == []


def test_verified_email_must_be_used_within_thirty_minutes(environment, sent):
    client, db = environment
    request_code(client)
    verify(client, sent[0][1])
    age(db, 'verified_emails', 'expires_at', 30)
    assert first_sign_in(client).status_code == 403


@pytest.mark.parametrize('email', ['', 'not-an-email', 'a@b', 'two@@example.com'])
def test_invalid_emails_are_rejected(environment, sent, email):
    client, _ = environment
    assert request_code(client, email).status_code == 422 and sent == []


def test_without_email_setup_the_server_says_so(environment, monkeypatch):
    client, _ = environment
    monkeypatch.delenv('SMTP_HOST', raising=False)
    monkeypatch.delenv('EMAIL_CODES_TO_LOG', raising=False)
    signup_codes.get_settings.cache_clear()
    response = request_code(client)
    assert response.status_code == 503 and 'not set up' in response.json()['detail']
