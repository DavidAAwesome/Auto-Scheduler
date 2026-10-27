"""Per-user schedule version. Every change to a scheduling input bumps it, so a preview made against an
older version can be rejected on Apply. Stored on the user document."""
from pymongo import ReturnDocument


def current_schedule_version(db, user_id: str, session=None) -> int:
    from bson import ObjectId
    doc = db.users.find_one({'_id': ObjectId(user_id)}, {'schedule_version': 1}, session=session)
    return int((doc or {}).get('schedule_version', 0))


def bump_schedule_version(db, user_id: str, session=None) -> int:
    from bson import ObjectId
    doc = db.users.find_one_and_update({'_id': ObjectId(user_id)}, {'$inc': {'schedule_version': 1}},
                                       projection={'schedule_version': 1}, return_document=ReturnDocument.AFTER,
                                       session=session)
    return int((doc or {}).get('schedule_version', 0))
