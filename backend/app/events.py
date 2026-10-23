"""Events: fixed-time commitments (classes, meetings, appointments) that aren't "due" but must be attended.
They can repeat weekly, which covers a class schedule. Work sessions are never planned on top of them."""
from datetime import date, timedelta
from typing import Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pymongo import ReturnDocument

from app.auth import get_current_user
from app.database import get_database

router = APIRouter(tags=['events'])
MAX_REPEAT_DAYS = 366


def valid_iso_date(value):
    if date.fromisoformat(value).isoformat() != value:
        raise ValueError('Use a valid YYYY-MM-DD date.')
    return value


class Repeat(BaseModel):
    """Repeats every week on `weekdays` (Monday = 0) from the event's date through `until`."""
    model_config = ConfigDict(extra='forbid')
    weekdays: list[int] = Field(min_length=1, max_length=7)
    until: str

    @field_validator('weekdays')
    @classmethod
    def valid_weekdays(cls, value):
        if any(isinstance(day, bool) or day not in range(7) for day in value) or len(set(value)) != len(value):
            raise ValueError('Choose weekdays from Monday (0) to Sunday (6), each once.')
        return sorted(value)

    @field_validator('until')
    @classmethod
    def valid_until(cls, value):
        return valid_iso_date(value)


class EventInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=80)
    kind: Literal['Class', 'Meeting', 'Appointment', 'Social', 'Other']
    date: str
    start: int = Field(strict=True, ge=0, le=1435, multiple_of=5)
    end: int = Field(strict=True, ge=5, le=1440, multiple_of=5)
    location: str | None = Field(default=None, max_length=120)
    repeat: Repeat | None = None

    @field_validator('title')
    @classmethod
    def title_not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('Enter an event name.')
        return value

    @field_validator('location')
    @classmethod
    def clean_location(cls, value):
        return (value or '').strip() or None

    @field_validator('date')
    @classmethod
    def valid_date(cls, value):
        return valid_iso_date(value)

    @model_validator(mode='after')
    def valid_times(self):
        if self.end <= self.start:
            raise ValueError('An event must end after it starts.')
        if self.repeat:
            first = date.fromisoformat(self.date)
            until = date.fromisoformat(self.repeat.until)
            if until < first:
                raise ValueError('The repeat end date must be on or after the first date.')
            if until > first + timedelta(days=MAX_REPEAT_DAYS):
                raise ValueError('Repeating events can run for up to one year.')
        return self


class EventOutput(EventInput):
    id: str
    # Single occurrences removed from a repeating series (e.g. a cancelled class).
    skipDates: list[str] = []
    # 'manual' = created in AutoPlan; 'google' / 'outlook' = imported by calendar sync (read-only here).
    source: Literal['manual', 'google', 'outlook'] = 'manual'
    calendarName: str | None = None  # imported events: which external calendar it came from
    link: str | None = None  # imported events: open the original in Google Calendar / Outlook


class SkipInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    date: str

    @field_validator('date')
    @classmethod
    def valid_date(cls, value):
        return valid_iso_date(value)


def event_output(doc):
    return EventOutput(**{field: doc.get(field) for field in EventInput.model_fields}, id=str(doc['_id']),
                       skipDates=doc.get('skipDates', []), source=doc.get('source', 'manual'),
                       calendarName=doc.get('calendarName'), link=doc.get('link'))


def occurs_on(doc, day):
    """True when the event (or one occurrence of its weekly series) happens on `day` (YYYY-MM-DD)."""
    if day in doc.get('skipDates', []):
        return False
    repeat = doc.get('repeat')
    if not repeat:
        return doc['date'] == day
    return doc['date'] <= day <= repeat['until'] and date.fromisoformat(day).weekday() in repeat['weekdays']


def event_clash(db, user_id, day, start, end):
    """The user's event occurring on `day` that overlaps [start, end), if any."""
    candidates = db.events.find({'user_id': user_id, 'date': {'$lte': day},
                                 '$or': [{'date': day}, {'repeat.until': {'$gte': day}}],
                                 'start': {'$lt': end}, 'end': {'$gt': start}})
    return next((doc for doc in candidates if occurs_on(doc, day)), None)


def owned_event(event_id, user):
    if not ObjectId.is_valid(event_id):
        raise HTTPException(404, 'Event not found.')
    return {'_id': ObjectId(event_id), 'user_id': str(user['_id'])}


PROVIDER_NAMES = {'google': 'Google Calendar', 'outlook': 'Outlook'}


def editable_event(event_id, user, db):
    """The user's own AutoPlan event. Imported events are read-only copies; they change on the next sync."""
    query = owned_event(event_id, user)
    doc = db.events.find_one(query, {'source': 1})
    if not doc:
        raise HTTPException(404, 'Event not found.')
    if doc.get('source', 'manual') != 'manual':
        raise HTTPException(409, f"This event comes from {PROVIDER_NAMES[doc['source']]}. Change it there, then sync again.")
    return query


@router.get('/events', response_model=list[EventOutput])
def list_events(user=Depends(get_current_user), db=Depends(get_database)):
    return [event_output(doc) for doc in db.events.find({'user_id': str(user['_id'])}).sort([('date', 1), ('start', 1)])]


@router.post('/events', response_model=EventOutput, status_code=201)
def create_event(data: EventInput, user=Depends(get_current_user), db=Depends(get_database)):
    doc = {**data.model_dump(), 'user_id': str(user['_id']), 'skipDates': [], 'source': 'manual'}
    doc['_id'] = db.events.insert_one(doc).inserted_id
    return event_output(doc)


@router.put('/events/{event_id}', response_model=EventOutput)
def update_event(event_id: str, data: EventInput, user=Depends(get_current_user), db=Depends(get_database)):
    """Edits the whole event (every occurrence of a repeating series)."""
    doc = db.events.find_one_and_update(editable_event(event_id, user, db), {'$set': data.model_dump()}, return_document=ReturnDocument.AFTER)
    return event_output(doc)


@router.post('/events/{event_id}/skip', response_model=EventOutput)
def skip_occurrence(event_id: str, data: SkipInput, user=Depends(get_current_user), db=Depends(get_database)):
    """Removes one occurrence of a repeating event, leaving the rest of the series."""
    query = editable_event(event_id, user, db)
    doc = db.events.find_one(query)
    if not doc.get('repeat'):
        raise HTTPException(422, 'Only repeating events have single occurrences. Delete the event instead.')
    if not occurs_on(doc, data.date):
        raise HTTPException(422, 'The event does not happen on that date.')
    doc = db.events.find_one_and_update(query, {'$addToSet': {'skipDates': data.date}}, return_document=ReturnDocument.AFTER)
    return event_output(doc)


@router.delete('/events/{event_id}', status_code=204)
def delete_event(event_id: str, user=Depends(get_current_user), db=Depends(get_database)):
    db.events.delete_one(editable_event(event_id, user, db))
