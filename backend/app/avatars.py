"""Profile avatars: the API is the trusted upload path, so it alone enforces format, size and ownership.

Images live in their own MongoDB collection (never on the user document). Each upload gets a new random id,
so its URL is unique per version and can be cached forever; the old image is removed only after the
user document points at the replacement.
"""
from datetime import datetime, timezone
import re
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from pymongo import ReturnDocument
from pymongo.errors import PyMongoError

from app.auth import get_current_user, public_user
from app.database import get_database

router = APIRouter(tags=['avatars'])

# Keep in step with frontend/src/services/avatarUpload.ts.
MAX_AVATAR_BYTES = 5 * 1024 * 1024
AVATAR_SIGNATURES = {
    'image/jpeg': lambda data: data.startswith(b'\xff\xd8\xff'),
    'image/png': lambda data: data.startswith(b'\x89PNG\r\n\x1a\n'),
    'image/webp': lambda data: data[:4] == b'RIFF' and data[8:12] == b'WEBP',
}
AVATAR_ID = re.compile(r'^[A-Za-z0-9_-]{16,64}$')
FORMAT_ERROR = 'Choose a JPG, PNG, or WebP image.'
SIZE_ERROR = 'Choose an image of 5 MB or less.'


async def read_image(request):
    content_type = request.headers.get('content-type', '').split(';')[0].strip().lower()
    if content_type not in AVATAR_SIGNATURES:
        raise HTTPException(status_code=415, detail=FORMAT_ERROR)
    length = request.headers.get('content-length', '')
    if length.isdigit() and int(length) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail=SIZE_ERROR)
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_AVATAR_BYTES:
            raise HTTPException(status_code=413, detail=SIZE_ERROR)
    # The declared type must match the file's own signature, so nothing else is served as an image.
    if not data or not AVATAR_SIGNATURES[content_type](bytes(data[:12])):
        raise HTTPException(status_code=415, detail=FORMAT_ERROR)
    return content_type, bytes(data)


def save_avatar(db, user, content_type, data):
    owner = str(user['_id'])
    avatar_id = secrets.token_urlsafe(18)
    db.avatars.insert_one({'_id': avatar_id, 'user_id': owner, 'content_type': content_type, 'data': data,
                           'size': len(data), 'created_at': datetime.now(timezone.utc)})
    try:
        previous = db.users.find_one_and_update(
            {'_id': user['_id']},
            {'$set': {'avatarId': avatar_id}, '$unset': {'avatarUrl': '', 'avatarData': ''}},
            return_document=ReturnDocument.BEFORE,
        )
    except PyMongoError:
        db.avatars.delete_one({'_id': avatar_id})
        raise
    if previous is None:
        db.avatars.delete_one({'_id': avatar_id})
        raise HTTPException(status_code=401, detail='Please sign in again.')
    remove_image(db, previous.get('avatarId'), owner)
    return public_user({**previous, 'avatarId': avatar_id})


def remove_image(db, avatar_id, owner):
    """Best effort: the profile already points elsewhere, so a leftover image is harmless."""
    if not avatar_id:
        return
    try:
        db.avatars.delete_one({'_id': avatar_id, 'user_id': owner})
    except PyMongoError:
        pass


@router.put('/auth/avatar')
async def upload_avatar(request: Request, user=Depends(get_current_user), db=Depends(get_database)):
    """Replaces the signed-in user's avatar with the raw image body. There is no user id to target others."""
    content_type, data = await read_image(request)
    return await run_in_threadpool(save_avatar, db, user, content_type, data)


@router.delete('/auth/avatar')
def delete_avatar(user=Depends(get_current_user), db=Depends(get_database)):
    previous = db.users.find_one_and_update(
        {'_id': user['_id']},
        {'$unset': {'avatarId': '', 'avatarUrl': '', 'avatarData': ''}},
        return_document=ReturnDocument.BEFORE,
    )
    if previous is None:
        raise HTTPException(status_code=401, detail='Please sign in again.')
    remove_image(db, previous.get('avatarId'), str(user['_id']))
    return public_user({**previous, 'avatarId': None})


@router.get('/avatars/{avatar_id}')
def read_avatar(avatar_id: str, db=Depends(get_database)):
    """Public like a Firebase download link: <img> can't send a token, and the id is unguessable."""
    doc = db.avatars.find_one({'_id': avatar_id}) if AVATAR_ID.match(avatar_id) else None
    if doc is None:
        raise HTTPException(status_code=404, detail='Avatar not found.')
    return Response(content=bytes(doc['data']), media_type=doc['content_type'], headers={
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
    })
