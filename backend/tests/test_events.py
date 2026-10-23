import pytest
from conftest import sign_in

MEETUP = {'title': 'Team meetup', 'kind': 'Social', 'date': '2026-10-08', 'start': 1080, 'end': 1200, 'location': 'Campus Center'}
# CS class Mon/Wed 10:00-11:20 from Oct 5 through Dec 9 (Monday = 0).
CLASS = {'title': 'CS 450', 'kind': 'Class', 'date': '2026-10-05', 'start': 600, 'end': 680,
         'repeat': {'weekdays': [2, 0], 'until': '2026-12-09'}}
TASK = {'title': 'CV homework', 'deadline': '2026-10-20', 'minutes': 180, 'priority': 'High', 'category': 'Study'}


def test_one_time_event_has_no_due_date_and_round_trips(environment):
    client, db = environment
    sign_in(client)
    created = client.post('/events', json=MEETUP)
    assert created.status_code == 201
    event = created.json()
    assert event['title'] == 'Team meetup' and event['repeat'] is None and event['skipDates'] == []
    assert event['source'] == 'manual' and 'deadline' not in event and 'user_id' not in event
    assert client.get('/events').json() == [event]
    edited = client.put('/events/' + event['id'], json={**MEETUP, 'title': 'Study group', 'location': '  '}).json()
    assert edited['title'] == 'Study group' and edited['location'] is None
    assert client.delete('/events/' + event['id']).status_code == 204
    assert client.get('/events').json() == [] and db.events.count_documents({}) == 0


def test_weekly_class_schedule_and_skipping_one_class(environment):
    client, _ = environment
    sign_in(client)
    event = client.post('/events', json=CLASS).json()
    assert event['repeat'] == {'weekdays': [0, 2], 'until': '2026-12-09'}
    skipped = client.post(f"/events/{event['id']}/skip", json={'date': '2026-10-12'})
    assert skipped.status_code == 200 and skipped.json()['skipDates'] == ['2026-10-12']
    # Not a class day, outside the range, or a one-time event: nothing to skip.
    assert client.post(f"/events/{event['id']}/skip", json={'date': '2026-10-13'}).status_code == 422
    assert client.post(f"/events/{event['id']}/skip", json={'date': '2026-12-14'}).status_code == 422
    once = client.post('/events', json=MEETUP).json()
    assert client.post(f"/events/{once['id']}/skip", json={'date': MEETUP['date']}).status_code == 422


@pytest.mark.parametrize('change', [
    {'title': ' '}, {'kind': 'Party'}, {'start': 700, 'end': 700}, {'start': 601}, {'end': 1445}, {'date': '2026-02-30'},
    {'repeat': {'weekdays': [], 'until': '2026-12-09'}}, {'repeat': {'weekdays': [7], 'until': '2026-12-09'}},
    {'repeat': {'weekdays': [0, 0], 'until': '2026-12-09'}}, {'repeat': {'weekdays': [0], 'until': '2026-10-01'}},
    {'repeat': {'weekdays': [0], 'until': '2027-12-01'}}, {'location': 'x' * 121}, {'user_id': 'someone'},
])
def test_invalid_events_rejected(environment, change):
    client, db = environment
    sign_in(client)
    assert client.post('/events', json={**CLASS, **change}).status_code == 422
    assert db.events.count_documents({}) == 0


def test_work_sessions_cannot_overlap_events(environment):
    client, _ = environment
    sign_in(client)
    task = client.post('/tasks', json=TASK).json()
    event = client.post('/events', json=CLASS).json()
    session = {'taskId': task['id'], 'date': '2026-10-07', 'start': 630, 'end': 720}  # Wednesday, during class
    clash = client.post('/sessions', json=session)
    assert clash.status_code == 409 and 'CS 450' in clash.json()['detail']
    assert client.post('/sessions', json={**session, 'date': '2026-10-06'}).status_code == 201  # Tuesday: no class
    assert client.post('/sessions', json={**session, 'start': 680, 'end': 740}).status_code == 201  # right after class
    # A skipped (cancelled) class frees up the time.
    client.post(f"/events/{event['id']}/skip", json={'date': '2026-10-12'})
    assert client.post('/sessions', json={**session, 'date': '2026-10-12'}).status_code == 201
    client.post('/events', json={**MEETUP, 'date': '2026-10-09', 'start': 900, 'end': 960})
    assert client.post('/sessions', json={**session, 'date': '2026-10-09', 'start': 930, 'end': 990}).status_code == 409


def test_events_are_private_and_deleted_with_account(environment):
    client, db = environment
    sign_in(client)
    event = client.post('/events', json=MEETUP).json()
    sign_in(client, 'bob-uid', 'bob@example.com', 'Bob')
    assert client.get('/events').json() == []
    assert client.put('/events/' + event['id'], json=MEETUP).status_code == 404
    assert client.post(f"/events/{event['id']}/skip", json={'date': MEETUP['date']}).status_code == 404
    assert client.delete('/events/' + event['id']).status_code == 404
    sign_in(client)
    assert client.delete('/auth/account').status_code == 204
    assert db.events.count_documents({}) == 0
