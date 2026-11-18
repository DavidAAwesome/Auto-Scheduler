"""Shared setup for schedule API tests: frozen time at 8 AM America/New_York, availability 9 AM-noon."""
from datetime import datetime
from zoneinfo import ZoneInfo

from app import assistant, plan_routes, schedule_routes
from firebase_tokens import sign_in

NY = ZoneInfo('America/New_York')
NOW = datetime(2026, 10, 26, 8, 0, tzinfo=NY)  # Monday 8:00 AM EDT
TODAY, TOMORROW = '2026-10-26', '2026-10-27'


def freeze(monkeypatch, moment):
    monkeypatch.setattr(schedule_routes, 'utc_now', lambda: moment.astimezone(ZoneInfo('UTC')))
    monkeypatch.setattr(assistant, 'utc_now', lambda: moment.astimezone(ZoneInfo('UTC')))
    monkeypatch.setattr(plan_routes, 'utc_now', lambda: moment.astimezone(ZoneInfo('UTC')))


def setup_user(client, monkeypatch, now=NOW, uid='sched-user', start=9 * 60, end=12 * 60):
    freeze(monkeypatch, now)
    sign_in(client, uid=uid, email=f'{uid}@example.com', name='Sched')
    availability = client.get('/availability').json()
    availability['timeZone'] = 'America/New_York'
    availability['days'] = [{'day': d, 'enabled': True, 'periods': [{'start': start, 'end': end}]} for d in range(7)]
    assert client.put('/availability', json=availability).status_code == 200


def add_task(client, title, priority, minutes=60, deadline=TOMORROW, **extra):
    response = client.post('/tasks', json={'title': title, 'deadline': deadline, 'minutes': minutes, 'priority': priority,
                                           'category': 'Study', **extra})
    assert response.status_code == 201, response.text
    return response.json()


def acceptance_tasks(client):
    return add_task(client, 'Asm', 'High'), add_task(client, 'Test revision', 'Medium')


def add_event(client, title, start, end, date=TODAY):
    response = client.post('/events', json={'title': title, 'kind': 'Meeting', 'date': date, 'start': start, 'end': end,
                                            'location': None, 'repeat': None})
    assert response.status_code == 201, response.text
    return response.json()


def rows(sessions, only_change=None):
    return [(s['date'], f"{s['start'] // 60:02d}:{s['start'] % 60:02d}-{s['end'] // 60:02d}:{s['end'] % 60:02d}",
             s['type'], s['title'])
            for s in sessions if only_change is None or s.get('change') == only_change]


ACCEPTANCE = [
    (TODAY, '09:00-09:50', 'work', 'Asm'),
    (TODAY, '09:50-10:00', 'break', 'Break'),
    (TODAY, '10:00-10:10', 'work', 'Asm'),
    (TODAY, '10:10-10:50', 'work', 'Test revision'),
    (TODAY, '10:50-11:00', 'break', 'Break'),
    (TODAY, '11:00-11:20', 'work', 'Test revision'),
]
