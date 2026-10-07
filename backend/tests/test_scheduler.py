from datetime import datetime, timedelta, timezone
from random import Random
from zoneinfo import ZoneInfo

import pytest

from app.scheduler import BusyInterval, generate_plan
from app.workspace import Availability, TaskOutput

NOW = datetime(2026, 10, 5, 9, tzinfo=timezone.utc)  # Monday


def hours(start=540, end=1020, enabled=(0,), zone='UTC', periods=None):
    windows = periods or [{'start': start, 'end': end}]
    return Availability(
        days=[{'day': day, 'enabled': day in enabled, 'periods': windows if day in enabled else windows} for day in range(7)],
        weekOverrides=[],
        timeZone=zone,
        reminders=False,
    )


def task(id='a', minutes=60, deadline='2026-10-05', priority='High', done=False):
    return TaskOutput(id=id, title='Task '+id, minutes=minutes, deadline=deadline, priority=priority, category='Project', done=done)


def busy(start, end):
    return BusyInterval(start=start, end=end)


def focus(plan):
    return [b for b in plan.blocks if b.type == 'focus']


def test_split_135_minutes_with_exact_breaks():
    plan = generate_plan([task(minutes=135)], hours(end=720), [], NOW)
    assert [(b.type, b.start.strftime('%H:%M'), b.end.strftime('%H:%M')) for b in plan.blocks] == [
        ('focus','09:00','10:00'), ('break','10:00','10:15'), ('focus','10:15','11:15'),
        ('break','11:15','11:30'), ('focus','11:30','11:45')]
    assert plan.tasks[0].scheduledMinutes == 135
    assert plan.tasks[0].unscheduledMinutes == 0


def test_deadline_before_priority_then_stable_id_and_exclude_done():
    tasks = [task('z',15,priority='Low'), task('b',15), task('a',15),
             task('later',15,deadline='2026-10-06'),task('completed',15,done=True)]
    plan = generate_plan(tasks, hours(enabled=(0,1)), [], NOW)
    assert [b.taskId for b in focus(plan)] == ['a','b','z','later']
    assert len(plan.tasks) == 4
    assert [b.type for b in plan.blocks] == ['focus','break','focus','break','focus','break','focus']


def test_overlapping_busy_intervals_merge_and_never_count_as_breaks():
    intervals = [busy(NOW+timedelta(minutes=30), NOW+timedelta(minutes=75)),
                 busy(NOW+timedelta(minutes=45), NOW+timedelta(minutes=90))]
    plan = generate_plan([task(minutes=60)], hours(end=720), intervals, NOW)
    assert len(plan.busyIntervals) == 1
    assert [(b.type,b.start.strftime('%H:%M'),b.end.strftime('%H:%M')) for b in plan.blocks] == [
        ('focus','09:00','09:30'),('break','10:30','10:45'),('focus','10:45','11:15')]


def test_rounds_inward_and_forward_and_respects_subquarter_busy_boundaries():
    now = NOW+timedelta(seconds=1)
    plan = generate_plan([task(minutes=30)], hours(start=541,end=610),
                         [busy(NOW+timedelta(minutes=29),NOW+timedelta(minutes=31))],now)
    assert [(b.type,b.start.strftime('%H:%M')) for b in plan.blocks] == [('focus','09:45')]
    assert plan.tasks[0].scheduledMinutes == 15
    assert plan.tasks[0].unscheduledMinutes == 15


def test_partial_capacity_includes_break_cost_and_has_no_trailing_break():
    plan = generate_plan([task(minutes=90)], hours(end=615), [], NOW)
    assert len(plan.blocks) == 1  # 60 focus + only 15 remaining: no next focus can fit.
    result = plan.tasks[0]
    assert (result.status,result.scheduledMinutes,result.unscheduledMinutes) == ('partial',60,30)
    assert result.reason == 'insufficient_capacity'
    assert 'under these scheduling rules' in result.message


def test_no_availability_overdue_outside_window_and_completed():
    plan = generate_plan([task('overdue',deadline='2026-10-04'), task(),
                          task('later',deadline='2026-10-12'),task('done',done=True)], hours(enabled=()), [], NOW)
    assert [(t.status,t.reason) for t in plan.tasks] == [
        ('overdue','deadline_passed'),('unscheduled','no_free_availability'),('outside_window','outside_planning_window')]
    assert plan.blocks == []


def test_splits_across_days_and_does_not_require_overnight_break():
    plan = generate_plan([task(minutes=90,deadline='2026-10-06')],hours(end=600,enabled=(0,1)),[],NOW)
    assert [(b.start.day,int((b.end-b.start).total_seconds()/60)) for b in focus(plan)] == [(5,60),(6,30)]
    assert all(b.type == 'focus' for b in plan.blocks)


def test_deadline_never_overflows_into_next_days_free_hours():
    plan = generate_plan([task(minutes=120)],hours(end=600,enabled=(0,1)),[],NOW)
    assert len(focus(plan)) == 1
    assert plan.tasks[0].unscheduledMinutes == 60


def test_timezone_date_boundary_and_end_of_deadline_day():
    now = datetime(2026,1,1,2,tzinfo=timezone.utc)  # Still Dec 31 in New York.
    plan = generate_plan([task(minutes=60,deadline='2025-12-31')],
                         hours(start=1380,end=1440,enabled=(2,),zone='America/New_York'),[],now)
    assert plan.startDate == '2025-12-31'
    assert plan.endDate == '2026-01-06'
    assert focus(plan)[0].start == datetime(2026,1,1,4,tzinfo=timezone.utc)
    assert focus(plan)[0].end == datetime(2026,1,1,5,tzinfo=timezone.utc)


@pytest.mark.parametrize('day', ['2026-03-08','2026-11-01'])
def test_dst_ambiguous_and_nonexistent_slots_are_skipped(day):
    now = datetime.fromisoformat(day+'T00:00:00').replace(tzinfo=ZoneInfo('America/New_York'))
    plan = generate_plan([task(minutes=240,deadline=day)],
                         hours(start=0,end=240,enabled=(6,),zone='America/New_York'),[],now)
    zone = ZoneInfo('America/New_York')
    for b in plan.blocks:
        assert b.end > b.start
        for stamp in (b.start,b.end):
            local = stamp.astimezone(zone).replace(tzinfo=None)
            assert local.replace(tzinfo=zone,fold=0).utcoffset() == local.replace(tzinfo=zone,fold=1).utcoffset()
    assert plan.tasks[0].unscheduledMinutes > 0


def test_all_day_busy_and_touching_intervals():
    midnight = NOW.replace(hour=0)
    plan = generate_plan([task()],hours(),[busy(midnight,midnight+timedelta(days=1))],NOW)
    assert plan.blocks == []
    assert plan.tasks[0].reason == 'no_free_availability'
    plan = generate_plan([task()],hours(),[busy(NOW-timedelta(hours=1),NOW)],NOW)
    assert focus(plan)[0].start == NOW


def test_repeated_generation_and_shuffled_input_are_identical():
    tasks = [task('b',30),task('a',75)]
    intervals = [busy(NOW+timedelta(hours=2),NOW+timedelta(hours=3)),busy(NOW+timedelta(hours=4),NOW+timedelta(hours=5))]
    one = generate_plan(tasks,hours(),intervals,NOW)
    two = generate_plan(tasks[::-1],hours(),intervals[::-1],NOW)
    assert one == two
    assert len({b.id for b in one.blocks}) == len(one.blocks)


def test_seeded_schedules_conserve_minutes_and_obey_interval_invariants():
    rng = Random(518)
    availability = hours(enabled=range(7))
    for _ in range(20):
        tasks = [task(str(i),rng.randint(1,12)*15,deadline=f'2026-10-{rng.randint(5,11):02}',priority=rng.choice(['High','Medium','Low'])) for i in range(12)]
        intervals = [busy(NOW+timedelta(minutes=15*i), NOW+timedelta(minutes=15*i+20)) for i in rng.sample(range(180),20)]
        plan = generate_plan(tasks,availability,intervals,NOW)
        for previous, following in zip(plan.blocks,plan.blocks[1:]):
            assert previous.end <= following.start
        for b in plan.blocks:
            assert b.start >= NOW
            assert b.start.hour >= 9 and (b.end.hour < 17 or b.end.hour == 17 and b.end.minute == 0)
            assert not any(b.start < event.end and b.end > event.start for event in intervals)
            duration = int((b.end-b.start).total_seconds()/60)
            assert duration in ([15] if b.type == 'break' else [15,30,45,60])
            if b.taskId:
                assert b.start.date().isoformat() <= next(t.deadline for t in tasks if t.id == b.taskId)
        for result in plan.tasks:
            allocated = sum(int((b.end-b.start).total_seconds()/60) for b in focus(plan) if b.taskId == result.taskId)
            assert allocated == result.scheduledMinutes
            assert allocated + result.unscheduledMinutes == result.requestedMinutes
        for day in range(5,12):
            types = [b.type for b in plan.blocks if b.start.day == day]
            if types:
                assert types[0] == types[-1] == 'focus'
                assert all(a != b for a,b in zip(types,types[1:]))


def test_multiple_periods_and_week_override_are_respected():
    availability = Availability(
        days=[{'day': day, 'enabled': day == 0, 'periods': [{'start': 540, 'end': 600}, {'start': 780, 'end': 840}]} for day in range(7)],
        weekOverrides=[{
            'weekStart': '2026-10-05',
            'days': [{'day': day, 'enabled': day == 0, 'periods': [{'start': 900, 'end': 960}]} for day in range(7)],
        }],
        timeZone='UTC',
        reminders=False,
    )
    plan = generate_plan([task(minutes=30)], availability, [], NOW, source='availability_only')
    assert [(b.start.strftime('%H:%M'), b.end.strftime('%H:%M')) for b in focus(plan)] == [('15:00', '15:30')]
