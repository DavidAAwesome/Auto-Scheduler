import pytest
from pydantic import ValidationError

from app.workspace import Availability, AvailableDay, TimePeriod, default_availability


def week():
    return [AvailableDay(day=day, enabled=False, periods=[TimePeriod(start=540, end=1020)]).model_dump() for day in range(7)]


def test_reminder_minutes_default_to_15_for_new_and_older_saved_settings():
    assert default_availability().reminderMinutes == 15
    older = Availability(days=week(), timeZone='America/New_York', reminders=True)  # saved before the field existed
    assert older.reminderMinutes == 15


@pytest.mark.parametrize('minutes', [0, 5, 60, 1440])
def test_reminder_minutes_accept_zero_to_one_day(minutes):
    assert Availability(days=week(), timeZone='GMT', reminders=True, reminderMinutes=minutes).reminderMinutes == minutes


@pytest.mark.parametrize('minutes', [-1, 1441, '15', 15.5, None])
def test_reminder_minutes_reject_bad_values(minutes):
    with pytest.raises(ValidationError):
        Availability(days=week(), timeZone='GMT', reminders=True, reminderMinutes=minutes)
