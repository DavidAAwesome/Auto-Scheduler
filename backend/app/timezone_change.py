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

from app.scheduling_engine import local_parts, local_to_abs


def _round5(minute: int) -> int:
    # Every current UTC offset is a multiple of 15 minutes; this only guards the 5-minute event grid.
    return int(5 * round(minute / 5))


def convert_span(day: date, start: int, end: int, old: ZoneInfo, new: ZoneInfo) -> list[tuple[date, int, int]]:
    """The same real interval as wall-clock pieces in `new`, split at local midnight. Usually one piece."""
    first, last = local_to_abs(day, start, old), local_to_abs(day, end, old)
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


def converted_events(doc: dict, old: ZoneInfo, new: ZoneInfo, today: date) -> list[dict]:
    """Field updates for one stored event: the first entry replaces it, any others are new events."""
    reference = _reference_day(doc, today)
    pieces = convert_span(reference, doc['start'], doc['end'], old, new)
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


def preserve_event_times(db, user_id: str, old_zone: str, new_zone: str, today: date) -> int:
    """Rewrites the user's events so each keeps its absolute time in the new timezone. Returns events changed."""
    if old_zone == new_zone:
        return 0
    old, new = ZoneInfo(old_zone), ZoneInfo(new_zone)
    changed = 0
    for doc in list(db.events.find({'user_id': user_id})):
        updates = converted_events(doc, old, new, today)
        if not updates:
            continue
        first, extra = updates[0], updates[1:]
        if any(first.get(key) != doc.get(key) for key in first):
            db.events.update_one({'_id': doc['_id']}, {'$set': first})
            changed += 1
        for fields in extra:
            copy = {key: value for key, value in doc.items() if key != '_id'}
            db.events.insert_one({**copy, **fields})
            changed += 1
    return changed
