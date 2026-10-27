"""The account timezone is the single source of truth. Changing it keeps events at the same real moment,
while weekly availability stays as wall-clock hours in the selected zone."""
from datetime import date
from zoneinfo import ZoneInfo

from firebase_tokens import sign_in, sign_out
from app.timezone_change import convert_span, converted_events

NY, LA, LONDON = ZoneInfo('America/New_York'), ZoneInfo('America/Los_Angeles'), ZoneInfo('Europe/London')
D = date(2026, 10, 27)
TODAY = date(2026, 10, 27)


def test_same_day_conversion():
    assert convert_span(D, 15 * 60, 16 * 60, NY, LA) == [(D, 12 * 60, 13 * 60)]


def test_conversion_can_move_to_the_previous_day():
    assert convert_span(D, 60, 120, NY, LA) == [(date(2026, 10, 26), 22 * 60, 23 * 60)]


def test_event_crossing_local_midnight_is_split():
    # 8-11 PM in Los Angeles is 11 PM-2 AM in New York.
    assert convert_span(D, 20 * 60, 23 * 60, LA, NY) == [(D, 23 * 60, 1440), (date(2026, 10, 28), 0, 120)]


def test_event_ending_at_midnight_keeps_1440():
    assert convert_span(D, 21 * 60, 1440, LA, LA) == [(D, 21 * 60, 1440)]


def test_dst_uses_each_dates_own_offset():
    # The US springs forward on 8 Mar 2026; the UK only on 29 Mar.
    assert convert_span(date(2026, 3, 1), 600, 660, NY, LONDON) == [(date(2026, 3, 1), 15 * 60, 16 * 60)]
    assert convert_span(date(2026, 3, 9), 600, 660, NY, LONDON) == [(date(2026, 3, 9), 14 * 60, 15 * 60)]
    # A wall time inside the spring-forward gap maps to the first real instant after it.
    assert convert_span(date(2026, 3, 8), 150, 210, NY, NY) == [(date(2026, 3, 8), 180, 210)]


def test_weekly_series_shifts_weekdays_skips_and_until():
    # Mondays 10-11 PM in Los Angeles are Tuesdays 1-2 AM in New York.
    doc = {'date': '2026-10-26', 'start': 22 * 60, 'end': 23 * 60, 'skipDates': ['2026-11-02'],
           'repeat': {'weekdays': [0], 'until': '2026-12-14'}}
    assert converted_events(doc, LA, NY, TODAY) == [{
        'date': '2026-10-27', 'start': 60, 'end': 120, 'skipDates': ['2026-11-03'],
        'repeat': {'weekdays': [1], 'until': '2026-12-15'}}]


def test_weekly_series_uses_the_next_occurrence_for_its_offset():
    # Started before the US DST change; the next class (after it) decides the converted time.
    doc = {'date': '2026-10-05', 'start': 600, 'end': 660, 'skipDates': [],
           'repeat': {'weekdays': [0], 'until': '2026-12-14'}}
    # 2 Nov 2026 (Monday): New York is UTC-5, London UTC+0.
    assert converted_events(doc, NY, LONDON, date(2026, 11, 2))[0]['start'] == 15 * 60


def availability(client, zone):
    data = client.get('/availability').json()
    data['timeZone'] = zone
    data['days'][0] = {'day': 0, 'enabled': True, 'periods': [{'start': 540, 'end': 1020}]}
    response = client.put('/availability', json=data)
    assert response.status_code == 200, response.text
    return response.json()


def test_unsaved_account_reports_saved_false(environment):
    client, _ = environment
    sign_in(client)
    first = client.get('/availability').json()
    assert first['saved'] is False and first['timeZone'] == 'Etc/GMT'
    assert availability(client, 'America/New_York')['saved'] is True
    restored = client.get('/availability').json()
    assert restored['saved'] is True and restored['timeZone'] == 'America/New_York'


def test_changing_timezone_keeps_events_and_sessions_at_the_same_instant(environment):
    client, db = environment
    user = sign_in(client)
    availability(client, 'America/New_York')
    meeting = client.post('/events', json={'title': 'Advisor', 'kind': 'Meeting', 'date': '2026-11-10',
                                           'start': 15 * 60, 'end': 16 * 60}).json()
    late = client.post('/events', json={'title': 'Late call', 'kind': 'Meeting', 'date': '2026-11-10',
                                        'start': 60, 'end': 120}).json()
    db.sessions.insert_one({'user_id': user['id'], 'marker': 'session', 'start_at': '2026-11-10T20:00:00+00:00'})
    saved = availability(client, 'America/Los_Angeles')
    # Weekly hours are wall-clock rules in the selected zone: unchanged.
    assert saved['days'][0]['periods'] == [{'start': 540, 'end': 1020}]
    events = {e['id']: e for e in client.get('/events').json()}
    assert (events[meeting['id']]['date'], events[meeting['id']]['start'], events[meeting['id']]['end']) == ('2026-11-10', 720, 780)
    assert (events[late['id']]['date'], events[late['id']]['start'], events[late['id']]['end']) == ('2026-11-09', 22 * 60, 23 * 60)
    assert db.sessions.find_one({'marker': 'session'})['start_at'] == '2026-11-10T20:00:00+00:00'
    # Saving again with the same zone changes nothing.
    availability(client, 'America/Los_Angeles')
    assert client.get('/events').json() == sorted(events.values(), key=lambda e: (e['date'], e['start']))


def test_first_save_never_shifts_existing_events(environment):
    client, _ = environment
    sign_in(client)
    event = client.post('/events', json={'title': 'Gym', 'kind': 'Other', 'date': '2026-11-10', 'start': 600, 'end': 660}).json()
    availability(client, 'Asia/Tokyo')
    assert client.get('/events').json() == [event]


def test_timezone_and_events_are_isolated_between_users(environment):
    client, _ = environment
    sign_in(client, uid='a', email='a@example.com', name='A')
    availability(client, 'America/New_York')
    sign_out(client)
    sign_in(client, uid='b', email='b@example.com', name='B')
    availability(client, 'Europe/London')
    theirs = client.post('/events', json={'title': 'B event', 'kind': 'Other', 'date': '2026-11-10', 'start': 600, 'end': 660}).json()
    sign_out(client)
    sign_in(client, uid='a', email='a@example.com', name='A')
    assert client.get('/availability').json()['timeZone'] == 'America/New_York'
    availability(client, 'Asia/Tokyo')
    sign_out(client)
    sign_in(client, uid='b', email='b@example.com', name='B')
    assert client.get('/availability').json()['timeZone'] == 'Europe/London'
    assert client.get('/events').json() == [theirs]
