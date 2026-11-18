"""Changing the account timezone keeps every event at the same real moment.

Events are stored as wall-clock values (date + minutes after midnight) in the account timezone, so a
timezone change has to rewrite them, or a 3 PM meeting saved in New York would silently move three hours
when the account switches to Los Angeles. Weekly availability is deliberately left alone: those hours are
wall-clock rules ("I work 9 to 5") in whichever timezone is selected.

Work sessions already store UTC instants (start_at/end_at), and task deadlines stay as the date and time
the user typed, so neither is rewritten here.
"""
from datetime import date, timedelta
from zoneinfo import ZoneInfo

from bson import ObjectId

from app.scheduling_engine import local_parts, local_to_abs


def _round5(minute: int) -> int:
    # Every current UTC offset is a multiple of 15 minutes; this only guards the 5-minute event grid.
    return int(5 * round(minute / 5))


def convert_span(day: date, start: int, end: int, old: ZoneInfo, new: ZoneInfo,
                 minutes: int | None = None) -> list[tuple[date, int, int]]:
    """The same real interval as wall-clock pieces in `new`, split at local midnight. Usually one piece.
    `minutes` gives the length instead of `end` for a span that was stored in pieces across midnight."""
    first = local_to_abs(day, start, old)
    last = first + minutes if minutes is not None else local_to_abs(day, end, old)
    pieces = []
    cursor = first
    while cursor < last:
        piece_day, piece_start = local_parts(cursor, new)
        next_midnight = local_to_abs(piece_day + timedelta(days=1), 0, new)
        piece_end_abs = min(last, next_midnight)
        piece_end = 1440 if piece_end_abs == next_midnight else local_parts(piece_end_abs, new)[1]
        piece_start, piece_end = _round5(piece_start), _round5(piece_end)
        if piece_end > piece_start:
            pieces.append((piece_day, piece_start, piece_end))
        cursor = piece_end_abs
    return pieces


def _shift_dates(values: list[str], days: int) -> list[str]:
    return [(date.fromisoformat(value) + timedelta(days=days)).isoformat() for value in values]


def _reference_day(doc: dict, today: date) -> date:
    """For a weekly series, the next occurrence (else the first) sets the conversion offset."""
    first = date.fromisoformat(doc['date'])
    repeat = doc.get('repeat')
    if not repeat:
        return first
    until = date.fromisoformat(repeat['until'])
    day = max(first, today)
    for _ in range(7):
        if day > until:
            break
        if day.weekday() in repeat['weekdays']:
            return day
        day += timedelta(days=1)
    return first


def converted_events(doc: dict, old: ZoneInfo, new: ZoneInfo, today: date, minutes: int | None = None) -> list[dict]:
    """Field updates for one stored event: the first entry replaces it, any others are new events.
    `minutes` is the full length when `doc` is the first piece of an event stored in pieces."""
    reference = _reference_day(doc, today)
    pieces = convert_span(reference, doc['start'], doc['end'], old, new, minutes)
    results = []
    for piece_day, start, end in pieces:
        shift = (piece_day - reference).days
        fields = {'date': (date.fromisoformat(doc['date']) + timedelta(days=shift)).isoformat(),
                  'start': start, 'end': end,
                  'skipDates': _shift_dates(doc.get('skipDates', []), shift)}
        if doc.get('repeat'):
            fields['repeat'] = {'weekdays': sorted((day + shift) % 7 for day in doc['repeat']['weekdays']),
                                'until': _shift_dates([doc['repeat']['until']], shift)[0]}
        results.append(fields)
    return results


def _contiguous(pieces: list[dict]) -> bool:
    """Pieces of one split event, in order, still meet at midnight (none was edited or deleted since)."""
    for before, after in zip(pieces, pieces[1:]):
        next_day = (date.fromisoformat(before['date']) + timedelta(days=1)).isoformat()
        if before['end'] != 1440 or after['start'] != 0 or after['date'] != next_day:
            return False
    return True


def _groups(docs: list[dict]) -> list[list[dict]]:
    """Events to convert together: a span stored in pieces across midnight is rejoined, so changing the
    timezone again (or back) doesn't keep it split."""
    by_group: dict = {}
    singles = []
    for doc in docs:
        (by_group.setdefault(doc['split_group'], []) if doc.get('split_group') else singles).append(doc)
    groups = [[doc] for doc in singles]
    for pieces in by_group.values():
        pieces.sort(key=lambda d: (d['date'], d['start']))
        groups.extend([pieces] if _contiguous(pieces) else [[doc] for doc in pieces])
    return groups


def preserve_event_times(db, user_id: str, old_zone: str, new_zone: str, today: date, session=None) -> int:
    """Rewrites the user's events so each keeps its absolute time in the new timezone. Returns events changed.
    Pass the caller's transaction `session` so the rewrite and the new zone are saved together."""
    if old_zone == new_zone:
        return 0
    old, new = ZoneInfo(old_zone), ZoneInfo(new_zone)
    changed = 0
    for pieces in _groups(list(db.events.find({'user_id': user_id}, session=session))):
        doc = pieces[0]
        length = sum(p['end'] - p['start'] for p in pieces) if len(pieces) > 1 else None
        updates = converted_events(doc, old, new, today, length)
        if not updates:
            continue
        group = doc.get('split_group') or (ObjectId() if len(updates) > 1 else None)
        unset = {} if len(updates) > 1 else {'split_group': ''}
        for index, fields in enumerate(updates):
            fields = {**fields, 'split_group': group} if len(updates) > 1 else fields
            if index < len(pieces):
                target = pieces[index]
                if any(target.get(key) != value for key, value in fields.items()) or (unset and 'split_group' in target):
                    db.events.update_one({'_id': target['_id']},
                                         {'$set': fields, **({'$unset': unset} if unset and 'split_group' in target else {})},
                                         session=session)
                    changed += 1
            else:
                copy = {key: value for key, value in doc.items() if key != '_id'}
                db.events.insert_one({**copy, **fields}, session=session)
                changed += 1
        for extra in pieces[len(updates):]:  # rejoined: the span now fits in fewer pieces
            db.events.delete_one({'_id': extra['_id']}, session=session)
            changed += 1
    return changed
