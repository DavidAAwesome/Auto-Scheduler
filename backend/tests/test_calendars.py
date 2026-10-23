import pytest
from firebase_tokens import sign_in

RANGE = {'rangeStart': '2026-10-19', 'rangeEnd': '2026-12-14'}
STANDUP = {'externalId': 'g-1', 'title': 'Team standup', 'kind': 'Meeting', 'date': '2026-10-21', 'start': 540, 'end': 570,
           'calendarName': 'Work', 'link': 'https://calendar.google.com/event?eid=abc', 'location': 'Zoom'}
DENTIST = {'externalId': 'g-2', 'title': 'Dentist', 'date': '2026-10-23', 'start': 660, 'end': 720}
TASK = {'title': 'CV homework', 'deadline': '2026-10-30', 'minutes': 180, 'priority': 'High', 'category': 'Study'}


def sync(client, provider='google', events=(STANDUP, DENTIST), account='alice@gmail.com', **range_):
    return client.put(f'/calendar/{provider}/sync', json={'account': account, **RANGE, **range_, 'events': list(events)})


def test_sync_imports_read_only_events_and_records_connection(environment):
    client, _ = environment
    sign_in(client)
    response = sync(client)
    assert response.status_code == 200
    assert response.json()['eventCount'] == 2 and response.json()['account'] == 'alice@gmail.com'
    events = client.get('/events').json()
    assert {e['title'] for e in events} == {'Team standup', 'Dentist'}
    standup = next(e for e in events if e['title'] == 'Team standup')
    assert standup['source'] == 'google' and standup['calendarName'] == 'Work' and standup['link'].startswith('https://')
    assert standup['repeat'] is None and 'externalId' not in standup and 'user_id' not in standup
    [connection] = client.get('/calendar/connections').json()
    assert connection['provider'] == 'google' and connection['eventCount'] == 2
    # Imported events are read-only copies.
    for request in (client.put('/events/' + standup['id'], json={k: standup[k] for k in ('title', 'kind', 'date', 'start', 'end')}),
                    client.delete('/events/' + standup['id'])):
        assert request.status_code == 409 and 'Google Calendar' in request.json()['detail']


def test_resync_replaces_instead_of_duplicating_and_keeps_manual_events(environment):
    client, _ = environment
    sign_in(client)
    manual = client.post('/events', json={'title': 'Gym', 'kind': 'Other', 'date': '2026-10-21', 'start': 1080, 'end': 1140}).json()
    sync(client)
    sync(client)
    assert len(client.get('/events').json()) == 3
    moved = {**STANDUP, 'start': 600, 'end': 630}
    assert sync(client, events=[moved]).json()['eventCount'] == 1
    titles = sorted((e['title'], e['start']) for e in client.get('/events').json())
    assert titles == [('Gym', 1080), ('Team standup', 600)]
    assert any(e['id'] == manual['id'] for e in client.get('/events').json())


def test_sync_only_replaces_inside_range_unless_account_changes(environment):
    client, _ = environment
    sign_in(client)
    sync(client)
    # A later window keeps the earlier one's events.
    later = {**DENTIST, 'externalId': 'g-3', 'date': '2026-12-20'}
    sync(client, events=[later], rangeStart='2026-12-15', rangeEnd='2027-01-31')
    assert len(client.get('/events').json()) == 3
    # Connecting a different Google account drops the old account's events everywhere.
    sync(client, events=[], account='alice.work@gmail.com')
    assert client.get('/events').json() == []


def test_google_and_outlook_are_separate_and_disconnect_removes_only_that_one(environment):
    client, db = environment
    sign_in(client)
    sync(client)
    sync(client, 'outlook', events=[{**DENTIST, 'externalId': 'o-1', 'title': 'Advisor meeting'}], account='alice@school.edu')
    assert len(client.get('/calendar/connections').json()) == 2
    assert client.delete('/calendar/google').status_code == 204
    assert [e['source'] for e in client.get('/events').json()] == ['outlook']
    assert [c['provider'] for c in client.get('/calendar/connections').json()] == ['outlook']


def test_imported_events_block_work_sessions(environment):
    client, _ = environment
    sign_in(client)
    task = client.post('/tasks', json=TASK).json()
    sync(client)
    clash = client.post('/sessions', json={'taskId': task['id'], 'date': '2026-10-21', 'start': 555, 'end': 600})
    assert clash.status_code == 409 and 'Team standup' in clash.json()['detail']


@pytest.mark.parametrize('change', [
    {'rangeEnd': '2027-06-01'}, {'rangeEnd': '2026-10-01'},
    {'events': [{**STANDUP, 'date': '2026-09-01'}]}, {'events': [{**STANDUP, 'start': 541}]},
    {'events': [{**STANDUP, 'end': 540}]}, {'events': [{**STANDUP, 'surprise': 1}]}, {'account': ''},
])
def test_invalid_sync_rejected(environment, change):
    client, db = environment
    sign_in(client)
    body = {'account': 'alice@gmail.com', **RANGE, 'events': [STANDUP], **change}
    assert client.put('/calendar/google/sync', json=body).status_code == 422
    assert db.events.count_documents({}) == 0
    assert client.put('/calendar/yahoo/sync', json={'account': 'a', **RANGE, 'events': []}).status_code == 422


def test_unsafe_links_are_dropped_and_blank_titles_named(environment):
    client, _ = environment
    sign_in(client)
    sync(client, events=[{**STANDUP, 'link': 'javascript:alert(1)', 'title': '   '}])
    [event] = client.get('/events').json()
    assert event['link'] is None and event['title'] == '(No title)'


def test_calendar_data_is_private_and_removed_with_account(environment):
    client, db = environment
    sign_in(client)
    sync(client)
    sign_in(client, uid='bob-uid', email='bob@example.com', name='Bob')
    assert client.get('/events').json() == [] and client.get('/calendar/connections').json() == []
    sign_in(client)
    assert client.delete('/auth/account').status_code == 204
    assert db.events.count_documents({}) == 0 and db.calendar_connections.count_documents({}) == 0
