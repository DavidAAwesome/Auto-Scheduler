from pymongo.errors import PyMongoError

from app import avatars
from firebase_tokens import make_token, sign_in, sign_out

JPEG = b'\xff\xd8\xff\xe0' + b'jpeg-bytes' * 20
PNG = b'\x89PNG\r\n\x1a\n' + b'png-bytes' * 20
WEBP = b'RIFF\x00\x00\x00\x00WEBPVP8 ' + b'webp' * 20


def upload(client, data, content_type='image/jpeg', **headers):
    return client.put('/auth/avatar', content=data, headers={'Content-Type': content_type, **headers})


def test_first_upload_is_saved_served_and_survives_a_new_session(environment):
    client, db = environment
    assert sign_in(client)['avatarUrl'] is None
    response = upload(client, JPEG)
    assert response.status_code == 200, response.text
    url = response.json()['avatarUrl']
    assert url.startswith('/avatars/')
    user = db.users.find_one({'firebase_uid': 'alice-uid'})
    assert 'avatarUrl' not in user and user['avatarId'] == url.rsplit('/', 1)[1]
    # The image bytes live in their own collection, never on the user document.
    assert db.avatars.find_one({'_id': user['avatarId']})['user_id'] == str(user['_id'])

    sign_out(client)  # <img> requests carry no token.
    image = client.get(url)
    assert image.status_code == 200 and image.content == JPEG
    assert image.headers['content-type'] == 'image/jpeg'
    assert 'immutable' in image.headers['cache-control']
    assert image.headers['x-content-type-options'] == 'nosniff'
    assert sign_in(client)['avatarUrl'] == url  # Refresh or logout/login reads it back from /auth/me.


def test_replacement_gets_a_new_url_and_only_then_drops_the_old_image(environment):
    client, db = environment
    sign_in(client)
    first = upload(client, JPEG).json()['avatarUrl']
    second = upload(client, PNG, 'image/png').json()['avatarUrl']
    third = upload(client, WEBP, 'image/webp').json()['avatarUrl']
    assert len({first, second, third}) == 3
    assert client.get(first).status_code == 404 and client.get(second).status_code == 404
    assert client.get(third).headers['content-type'] == 'image/webp'
    assert db.avatars.count_documents({}) == 1


def test_failed_profile_save_keeps_the_previous_avatar(environment, monkeypatch):
    client, db = environment
    sign_in(client)
    original = upload(client, JPEG).json()['avatarUrl']
    users = type(db.users)
    real = users.find_one_and_update

    def broken(self, *args, **kwargs):
        if self.name == 'users' and 'avatarId' in args[1].get('$set', {}):
            raise PyMongoError('write failed')
        return real(self, *args, **kwargs)

    monkeypatch.setattr(users, 'find_one_and_update', broken)
    response = upload(client, PNG, 'image/png')
    monkeypatch.setattr(users, 'find_one_and_update', real)
    assert response.status_code >= 500 and 'detail' in response.json()
    assert sign_in(client)['avatarUrl'] == original
    assert client.get(original).status_code == 200
    assert db.avatars.count_documents({}) == 1  # The half-saved replacement was cleaned up.


def test_rejects_unsupported_mismatched_empty_and_oversized_files(environment, monkeypatch):
    client, db = environment
    sign_in(client)
    original = upload(client, JPEG).json()['avatarUrl']
    assert upload(client, b'GIF89a...', 'image/gif').status_code == 415
    assert upload(client, b'<svg/>', 'image/svg+xml').status_code == 415
    assert upload(client, b'<html>not an image</html>', 'image/png').status_code == 415
    assert upload(client, b'', 'image/jpeg').status_code == 415
    monkeypatch.setattr(avatars, 'MAX_AVATAR_BYTES', 64)
    response = upload(client, JPEG + b'x' * 64)
    assert response.status_code == 413
    assert response.json()['detail'] == 'Choose an image of 5 MB or less.'
    assert sign_in(client)['avatarUrl'] == original
    assert db.avatars.count_documents({}) == 1


def test_documented_limit_is_five_megabytes(environment):
    client, _ = environment
    sign_in(client)
    assert avatars.MAX_AVATAR_BYTES == 5 * 1024 * 1024
    assert upload(client, JPEG + b'\0' * avatars.MAX_AVATAR_BYTES).status_code == 413


def test_upload_and_delete_require_sign_in_and_only_touch_your_own_avatar(environment):
    client, db = environment
    sign_in(client)
    alice = upload(client, JPEG).json()['avatarUrl']
    sign_in(client, uid='bob-uid', email='bob@example.com', name='Bob')
    bob = upload(client, PNG, 'image/png').json()['avatarUrl']
    assert client.delete('/auth/avatar').json()['avatarUrl'] is None
    assert client.get(bob).status_code == 404
    assert client.get(alice).status_code == 200
    assert sign_in(client)['avatarUrl'] == alice

    sign_out(client)
    assert upload(client, JPEG).status_code == 401
    assert client.delete('/auth/avatar').status_code == 401
    client.headers['Authorization'] = 'Bearer ' + make_token(uid='alice-uid', aud='other-project')
    assert upload(client, JPEG).status_code == 401
    assert db.users.find_one({'firebase_uid': 'alice-uid'})['avatarId'] == alice.rsplit('/', 1)[1]


def test_cross_origin_upload_is_rejected(environment):
    client, _ = environment
    sign_in(client)
    assert upload(client, JPEG, Origin='https://evil.example').status_code == 403


def test_unknown_or_malformed_ids_are_not_found(environment):
    client, _ = environment
    assert client.get('/avatars/does-not-exist-123456').status_code == 404
    assert client.get('/avatars/%24where').status_code == 404


def test_account_deletion_removes_avatar_images(environment):
    client, db = environment
    sign_in(client)
    url = upload(client, JPEG).json()['avatarUrl']
    assert client.delete('/auth/account').status_code == 204
    assert db.avatars.count_documents({}) == 0
    assert client.get(url).status_code == 404
