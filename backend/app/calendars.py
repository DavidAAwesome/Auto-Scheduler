"""External calendar sync (Google Calendar, Outlook). The browser fetches events with the user's own
read-only OAuth token and uploads a snapshot; the API stores them as read-only events with source
'google' / 'outlook'. They then block work sessions and count as busy time for the scheduler, like any event."""
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.auth import get_current_user
from app.database import get_database
from app.events import valid_iso_date

router = APIRouter(prefix='/calendar', tags=['calendar'])
Provider = Literal['google', 'outlook']
MAX_RANGE_DAYS = 120
MAX_EVENTS = 3000


class ImportedEvent(BaseModel):
    """One day's part of an external event, already converted to the user's time zone by the browser."""
    model_config = ConfigDict(extra='forbid')
    externalId: str = Field(min_length=1, max_length=1024)
    title: str = Field(min_length=1, max_length=200)
    kind: Literal['Class', 'Meeting', 'Appointment', 'Social', 'Other'] = 'Other'
    date: str
    start: int = Field(strict=True, ge=0, le=1435, multiple_of=5)
    end: int = Field(strict=True, ge=5, le=1440, multiple_of=5)
    location: str | None = Field(default=None, max_length=300)
    calendarName: str | None = Field(default=None, max_length=200)
    link: str | None = Field(default=None, max_length=2048)

    @field_validator('title')
    @classmethod
    def clean_title(cls, value):
        return value.strip()[:80] or '(No title)'

    @field_validator('location', 'calendarName')
    @classmethod
    def clean_optional(cls, value):
        return (value or '').strip()[:120] or None

    @field_validator('link')
    @classmethod
    def https_link(cls, value):
        if value and not value.startswith('https://'):
            return None  # never store a non-https link we'd later render
        return value

    @field_validator('date')
    @classmethod
    def valid_date(cls, value):
        return valid_iso_date(value)

    @model_validator(mode='after')
    def valid_range(self):
        if self.end <= self.start:
            raise ValueError('An imported event must end after it starts.')
        return self


class SyncInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    account: str = Field(min_length=1, max_length=254)  # the connected Google / Microsoft account
    rangeStart: str
    rangeEnd: str
    events: list[ImportedEvent] = Field(max_length=MAX_EVENTS)

    @field_validator('rangeStart', 'rangeEnd')
    @classmethod
    def valid_dates(cls, value):
        return valid_iso_date(value)

    @model_validator(mode='after')
    def events_inside_range(self):
        first, last = date.fromisoformat(self.rangeStart), date.fromisoformat(self.rangeEnd)
        if last < first or last - first > timedelta(days=MAX_RANGE_DAYS):
            raise ValueError(f'Sync up to {MAX_RANGE_DAYS} days at a time.')
        if any(not self.rangeStart <= event.date <= self.rangeEnd for event in self.events):
            raise ValueError('Every imported event must fall inside the synced date range.')
        return self


class Connection(BaseModel):
    provider: Provider
    account: str
    lastSynced: datetime
    rangeStart: str
    rangeEnd: str
    eventCount: int


def connection_output(doc):
    return Connection(provider=doc['provider'], account=doc['account'], lastSynced=doc['last_synced'],
                      rangeStart=doc['range_start'], rangeEnd=doc['range_end'], eventCount=doc['event_count'])


@router.get('/connections', response_model=list[Connection])
def list_connections(user=Depends(get_current_user), db=Depends(get_database)):
    return [connection_output(doc) for doc in db.calendar_connections.find({'user_id': str(user['_id'])}).sort('provider', 1)]


@router.put('/{provider}/sync', response_model=Connection)
def sync_calendar(provider: Provider, data: SyncInput, user=Depends(get_current_user), db=Depends(get_database)):
    """Replaces this provider's imported events in the synced range with the new snapshot (idempotent)."""
    user_id = str(user['_id'])
    previous = db.calendar_connections.find_one({'user_id': user_id, 'provider': provider})
    if previous and previous['account'].lower() != data.account.lower():
        # A different account was connected: drop everything imported from the old one.
        db.events.delete_many({'user_id': user_id, 'source': provider})
    else:
        db.events.delete_many({'user_id': user_id, 'source': provider,
                               'date': {'$gte': data.rangeStart, '$lte': data.rangeEnd}})
    unique = {(e.externalId, e.date): e for e in data.events}  # one copy per event per day
    documents = [{**event.model_dump(), 'user_id': user_id, 'source': provider, 'repeat': None, 'skipDates': []}
                 for event in unique.values()]
    if documents:
        db.events.insert_many(documents)
    connection = {'user_id': user_id, 'provider': provider, 'account': data.account,
                  'last_synced': datetime.now(timezone.utc), 'range_start': data.rangeStart,
                  'range_end': data.rangeEnd, 'event_count': len(documents)}
    db.calendar_connections.replace_one({'user_id': user_id, 'provider': provider}, connection, upsert=True)
    return connection_output(connection)


@router.delete('/{provider}', status_code=204)
def disconnect_calendar(provider: Provider, user=Depends(get_current_user), db=Depends(get_database)):
    """Forgets the connection and removes its imported events. Nothing changes in the external calendar."""
    user_id = str(user['_id'])
    db.events.delete_many({'user_id': user_id, 'source': provider})
    db.calendar_connections.delete_one({'user_id': user_id, 'provider': provider})
