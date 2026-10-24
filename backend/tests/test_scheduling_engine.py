"""Unit tests for the deterministic scheduling engine and validator (no OpenAI)."""
from datetime import datetime, timezone

import pytest

from app.scheduling_engine import BusyBlock, FixedSession, generate_schedule, detect_dependency_cycles
from app.scheduling_validator import ValidationError, validate_schedule
from app.workspace import Availability, TaskOutput

NOW = datetime(2026, 10, 5, 12, tzinfo=timezone.utc)  # Monday noon UTC


def hours(start=1080, end=1260, enabled=(0,), zone='UTC'):
    """Default: Mon 6–9 PM."""
    return Availability(
        days=[{'day': d, 'enabled': d in enabled, 'periods': [{'start': start, 'end': end}]} for d in range(7)],
        weekOverrides=[],
        timeZone=zone,
        reminders=False,
    )


def task(**kwargs):
    defaults = dict(
        id='t1', title='Essay', minutes=120, remainingMinutes=120, deadline='2026-10-05',
        dueTime=21 * 60, priority='High', category='Study', done=False,
        allowSplit=True, minSessionMinutes=15, maxSessionMinutes=60,
        earliestStart=None, dependsOn=[],
    )
    defaults.update(kwargs)
    return TaskOutput(**defaults)


def test_e2e_split_around_evening_event():
    """Availability 6–9 PM, event 7–8 PM, 120-min task due 9 PM → 6–7 and 8–9 when splitting."""
    busy = [BusyBlock(date='2026-10-05', start=19 * 60, end=20 * 60, label='Dinner')]
    result = generate_schedule([task()], hours(), busy, [], [], NOW, horizon_days=1)
    sessions = [(s.start, s.end) for s in result.sessions]
    assert sessions == [(18 * 60, 19 * 60), (20 * 60, 21 * 60)]
    assert result.tasks[0].status == 'scheduled'
    assert result.tasks[0].scheduledMinutes == 120
    assert result.tasks[0].unscheduledMinutes == 0
    validate_schedule(result, [task()], hours(), busy, [], NOW)


def test_e2e_unsplit_reports_no_contiguous_slot():
    busy = [BusyBlock(date='2026-10-05', start=19 * 60, end=20 * 60, label='Dinner')]
    t = task(allowSplit=False)
    result = generate_schedule([t], hours(), busy, [], [], NOW, horizon_days=1)
    assert result.sessions == []
    assert result.tasks[0].status == 'unscheduled'
    assert result.tasks[0].reason == 'no_contiguous_slot'
    assert result.tasks[0].unscheduledMinutes == 120


def test_competing_deadlines_and_priorities():
    early = task(id='a', title='Early', minutes=60, remainingMinutes=60, deadline='2026-10-05',
                 dueTime=21 * 60, priority='Low', maxSessionMinutes=60)
    urgent = task(id='b', title='Urgent', minutes=60, remainingMinutes=60, deadline='2026-10-05',
                  dueTime=19 * 60, priority='High', maxSessionMinutes=60)
    # Only 6–8 PM free (120 min) if we use 6–8 window
    avail = hours(start=18 * 60, end=20 * 60)
    result = generate_schedule([early, urgent], avail, [], [], [], NOW, horizon_days=1)
    # Urgent due 7 PM gets 6–7; early gets 7–8
    by_task = {s.taskId: s for s in result.sessions}
    assert by_task['b'].start == 18 * 60 and by_task['b'].end == 19 * 60
    assert by_task['a'].start == 19 * 60 and by_task['a'].end == 20 * 60


def test_overlapping_events_block_time():
    busy = [
        BusyBlock(date='2026-10-05', start=18 * 60, end=19 * 60, label='A'),
        BusyBlock(date='2026-10-05', start=18 * 60 + 30, end=19 * 60 + 30, label='B'),
    ]
    result = generate_schedule([task(minutes=60, remainingMinutes=60)], hours(), busy, [], [], NOW, 1)
    # Free after merge: 19:30–21:00 → 90 min; 60 fits at 19:30
    assert result.tasks[0].scheduledMinutes == 60
    assert result.sessions[0].start == 19 * 60 + 30


def test_insufficient_availability():
    result = generate_schedule([task()], hours(start=18 * 60, end=18 * 60 + 30), [], [], [], NOW, 1)
    assert result.tasks[0].status in {'partial', 'unscheduled'}
    assert result.tasks[0].unscheduledMinutes >= 90
    assert result.tasks[0].scheduledMinutes + result.tasks[0].unscheduledMinutes == 120


def test_duration_conservation_with_fixed_session():
    fixed = [FixedSession(id='s1', taskId='t1', date='2026-10-05', start=18 * 60, end=19 * 60,
                          locked=True, source='manual')]
    result = generate_schedule([task()], hours(), [], fixed, [], NOW, 1)
    outcome = result.tasks[0]
    assert outcome.scheduledMinutes + outcome.unscheduledMinutes == 120
    # 60 fixed + up to 60 more after 7 PM if free (7–9 free = 120, need 60)
    assert outcome.scheduledMinutes == 120
    assert sum(s.end - s.start for s in result.sessions) == 60


def test_locked_sessions_not_moved():
    fixed = [FixedSession(id='lock', taskId='t1', date='2026-10-05', start=20 * 60, end=21 * 60,
                          locked=True, source='auto')]
    busy = [BusyBlock(date='2026-10-05', start=19 * 60, end=20 * 60, label='E')]
    result = generate_schedule([task()], hours(), busy, fixed, [], NOW, 1)
    # Locked 8–9 kept as fixed (not in proposed); proposed should be 6–7
    assert [(s.start, s.end) for s in result.sessions] == [(18 * 60, 19 * 60)]
    assert result.tasks[0].scheduledMinutes == 120


def test_dependency_order_and_cycle():
    a = task(id='a', title='A', minutes=60, remainingMinutes=60, dueTime=21 * 60, dependsOn=[])
    b = task(id='b', title='B', minutes=60, remainingMinutes=60, dueTime=21 * 60, dependsOn=['a'])
    result = generate_schedule([b, a], hours(start=18 * 60, end=20 * 60), [], [], [], NOW, 1)
    assert result.sessions[0].taskId == 'a'
    assert result.sessions[1].taskId == 'b'
    assert result.sessions[0].end <= result.sessions[1].start

    cyclic = [
        task(id='x', title='X', minutes=30, remainingMinutes=30, dependsOn=['y']),
        task(id='y', title='Y', minutes=30, remainingMinutes=30, dependsOn=['x']),
    ]
    assert detect_dependency_cycles(cyclic) == {'x', 'y'}
    cyc_result = generate_schedule(cyclic, hours(), [], [], [], NOW, 1)
    assert all(t.reason == 'dependency_cycle' for t in cyc_result.tasks)


def test_stable_tie_break_identical_inputs():
    tasks = [
        task(id='m', title='M', minutes=30, remainingMinutes=30, priority='Medium'),
        task(id='h', title='H', minutes=30, remainingMinutes=30, priority='Medium'),
    ]
    a = generate_schedule(tasks, hours(start=18 * 60, end=20 * 60), [], [], [], NOW, 1)
    b = generate_schedule(tasks, hours(start=18 * 60, end=20 * 60), [], [], [], NOW, 1)
    assert a.model_dump() == b.model_dump()
    assert [s.taskId for s in a.sessions] == ['h', 'm']  # id order when equal deadline/priority


def test_validator_rejects_overlap():
    busy = [BusyBlock(date='2026-10-05', start=18 * 60, end=19 * 60, label='E')]
    result = generate_schedule([task(minutes=60, remainingMinutes=60)], hours(), [], [], [], NOW, 1)
    # Manually corrupt: place over busy
    result.sessions[0].start = 18 * 60
    result.sessions[0].end = 19 * 60
    with pytest.raises(ValidationError) as exc:
        validate_schedule(result, [task(minutes=60, remainingMinutes=60)], hours(), busy, [], NOW)
    assert exc.value.code == 'overlap'


def test_timezone_aware_no_past_scheduling():
    # now = Monday 12:00 UTC = 12:00 local UTC; availability morning already past
    avail = hours(start=8 * 60, end=10 * 60)
    result = generate_schedule([task(minutes=60, remainingMinutes=60, dueTime=23 * 60 + 59)], avail, [], [], [], NOW, 1)
    assert result.sessions == []
    assert result.tasks[0].unscheduledMinutes == 60
