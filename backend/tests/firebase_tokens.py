"""Mints tokens shaped like Firebase ID tokens, signed by a test-only RSA key."""
from datetime import datetime, timedelta, timezone

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

PROJECT_ID = 'autoplan-test'
PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PUBLIC_KEY = PRIVATE_KEY.public_key()


def make_token(uid='alice-uid', email='alice@example.com', name='Alice', key=PRIVATE_KEY, **overrides):
    now = datetime.now(timezone.utc)
    claims = {'iss': f'https://securetoken.google.com/{PROJECT_ID}', 'aud': PROJECT_ID, 'sub': uid,
              'iat': now, 'exp': now + timedelta(hours=1), 'auth_time': int(now.timestamp()), 'email': email}
    if name is not None:
        claims['name'] = name
    claims.update(overrides)
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, key, algorithm='RS256')


def sign_in(client, uid='alice-uid', email='alice@example.com', name='Alice'):
    """Acts like the frontend: attach the ID token, then let /auth/me create or load the user."""
    client.headers['Authorization'] = 'Bearer ' + make_token(uid, email, name)
    response = client.get('/auth/me')
    assert response.status_code == 200, response.text
    return response.json()


def sign_out(client):
    client.headers.pop('Authorization', None)
