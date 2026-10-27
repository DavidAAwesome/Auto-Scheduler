"""Engine scenarios for plan entry: splitting with breaks, flexible events, windows, priority repair,
capacity, locked work, deterministic ties and daylight-saving. Pure: no database, no clock, no AI."""
from datetime import date, timedelta
from zoneinfo import ZoneInfo

from app.scheduling_engine import Busy, Prefs, local_span, plan_schedule, resolve_windows
from app.workspace import TimeWindow
from test_scheduling_engine import MONDAY, NY, alloc, at, conserved, hours, plan, rows, saved, task


def works(result, task_id=None):
    return [s for s in result.sessions if s.type == 'work' and (task_id is None or s.task_id == task_id)]


def test_long_task_splits_across_days_with_reserved_breaks_and_daily_limit():
    thesis = task('t', 'Thesis', minutes=300, due_day=MONDAY + timedelta(days=3), max_session=120)
    result = plan([thesis], availability=hours(540, 720), prefs=Prefs(max_daily=150), days=3)
    per_day: dict[str, int] = {}
    for s in works(result):
        per_day[local_span(s.start, s.end, NY)[0]] = per_day.get(local_span(s.start, s.end, NY)[0], 0) + s.end - s.start
    assert per_day == {'2026-10-26': 150, '2026-10-27': 150}
    monday = [r for r in rows(result) if r[0] == '2026-10-26']
    assert monday == [('2026-10-26', '09:00-09:50', 'work', 'Thesis'), ('2026-10-26', '09:50-10:00', 'break', 'Break'),
                      ('2026-10-26', '10:00-10:50', 'work', 'Thesis'), ('2026-10-26', '10:50-11:00', 'break', 'Break'),
                      ('2026-10-26', '11:00-11:50', 'work', 'Thesis')]
    assert all(s.end - s.start <= 50 for s in works(result))  # never more than the focus limit in a row
    assert alloc(result, 't').unallocated == 0
    conserved(result)


def test_flexible_event_gets_one_contiguous_slot_and_is_not_focus_work():
    meeting = Busy('m', 'Standup', at(MONDAY, 9 * 60 + 30), at(MONDAY, 10 * 60))
    gym = task('g', 'Gym', 'Medium', minutes=90, kind='flexible_event', allow_split=False, max_session=90)
    result = plan([gym], events=[meeting])
    assert [r[1:] for r in rows(result)] == [('10:00-11:30', 'work', 'Gym')]  # 9:00-9:30 is too short; no split
    assert result.conflicts == []  # 90 minutes exceeds the 50-minute focus limit, but a flexible event is not focus work
    assert alloc(result, 'g').unallocated == 0


def test_flexible_event_without_a_long_enough_gap_is_not_split():
    meeting = Busy('m', 'Standup', at(MONDAY, 10 * 60), at(MONDAY, 10 * 60 + 30))
    coffee = task('c', 'Coffee with Sam', 'Medium', minutes=100, kind='flexible_event', allow_split=False,
                  max_session=100, due_day=MONDAY, due_minute=12 * 60)
    result = plan([coffee], events=[meeting])
    assert works(result) == []
    assert [r.code for r in alloc(result, 'c').reasons] == ['no_contiguous_slot']
    assert alloc(result, 'c').unallocated == 100


def test_flexible_event_is_busy_time_that_is_not_rest_for_work_around_it():
    gym = task('g', 'Gym', 'High', minutes=30, kind='flexible_event', allow_split=False, max_session=30)
    essay = task('e', 'Essay', 'Medium', minutes=60)
    result = plan([gym, essay])
    assert [r[1:] for r in rows(result)] == [
        ('09:00-09:30', 'work', 'Gym'),
        ('09:30-10:20', 'work', 'Essay'),
        ('10:20-10:30', 'break', 'Break'),
        ('10:30-10:40', 'work', 'Essay'),
    ]


def test_allowed_windows_restrict_where_work_goes():
    evenings = resolve_windows([TimeWindow(weekdays=[], start=17 * 60, end=21 * 60)], MONDAY, MONDAY + timedelta(days=1), NY)
    reading = task('r', 'Reading', minutes=45, windows=evenings)
    result = plan([reading], availability=hours(9 * 60, 21 * 60))
    assert [r[1:] for r in rows(result)] == [('17:00-17:45', 'work', 'Reading')]


def test_high_priority_work_displaces_lower_priority_flexible_sessions_without_deleting_the_task():
    """Saved Low work fills the morning; urgent High work arrives. The Low task keeps existing, and the
    minutes it loses are reported as unscheduled with the reason."""
    low = task('low', 'Reading', 'Low', minutes=150, due_day=MONDAY + timedelta(days=2))
    existing = [saved('r1', 'low', at(MONDAY, 9 * 60), at(MONDAY, 9 * 60 + 50), 'Reading'),
                saved('b1', None, at(MONDAY, 9 * 60 + 50), at(MONDAY, 10 * 60), 'Break', kind='break'),
                saved('r2', 'low', at(MONDAY, 10 * 60), at(MONDAY, 10 * 60 + 50), 'Reading'),
                saved('b2', None, at(MONDAY, 10 * 60 + 50), at(MONDAY, 11 * 60), 'Break', kind='break'),
                saved('r3', 'low', at(MONDAY, 11 * 60), at(MONDAY, 11 * 60 + 50), 'Reading')]
    urgent = task('hi', 'Lab', 'High', minutes=100, due_day=MONDAY, due_minute=12 * 60)
    calm = plan([low, urgent], existing=existing, mode='repair', displace=False)
    assert alloc(calm, 'hi').unallocated == 100  # no unused capacity: without moving anything, nothing fits
    result = plan([low, urgent], existing=existing, mode='repair')
    assert alloc(result, 'hi').unallocated == 0
    moved = {r.session.id: r.reason for r in result.removals if r.session.type == 'work'}
    assert set(moved) == {'r2', 'r3'} and all('Lab' in reason for reason in moved.values())
    reading = alloc(result, 'low')
    assert reading.remaining == 150 and reading.unallocated == 100  # the task is kept; its lost minutes are explicit
    assert 'displaced_by_priority' in [r.code for r in reading.reasons]
    assert [s.id for s in result.sessions if s.change == 'kept' and s.type == 'work'] == ['r1']  # least movement
    conserved(result)


def test_locked_sessions_are_never_moved_even_for_high_priority_work():
    low = task('low', 'Reading', 'Low', minutes=50, due_day=MONDAY + timedelta(days=2))
    locked = saved('r1', 'low', at(MONDAY, 9 * 60), at(MONDAY, 12 * 60), 'Reading', locked=True)
    urgent = task('hi', 'Lab', 'High', minutes=60, due_day=MONDAY, due_minute=12 * 60)
    result = plan([low, urgent], existing=[locked], mode='repair')
    kept = next(s for s in result.sessions if s.id == 'r1')
    assert (kept.change, kept.start, kept.end) == ('retained', at(MONDAY, 9 * 60), at(MONDAY, 12 * 60))
    assert result.removals == []
    assert alloc(result, 'hi').unallocated == 60


def test_insufficient_capacity_reports_explicit_unscheduled_minutes_per_tier():
    a = task('a', 'Report', 'High', minutes=120, due_day=MONDAY, due_minute=12 * 60)
    b = task('b', 'Slides', 'Medium', minutes=60, due_day=MONDAY, due_minute=12 * 60)
    c = task('c', 'Email', 'Low', minutes=30, due_day=MONDAY, due_minute=12 * 60)
    result = plan([c, b, a])
    assert alloc(result, 'a').unallocated == 0
    assert (alloc(result, 'b').new, alloc(result, 'b').unallocated) == (30, 30)
    assert alloc(result, 'c').unallocated == 30
    assert all(r.code == 'insufficient_capacity' for r in alloc(result, 'c').reasons)
    conserved(result)


def test_bounded_repair_rearranges_same_tier_work_so_both_tasks_fit():
    """Greedy places the split task first and leaves no 60-minute gap; local repair swaps them."""
    two_periods = hours(9 * 60, 10 * 60)
    two_periods.days[0].periods.append(two_periods.days[0].periods[0].model_copy(update={'start': 630, 'end': 680}))
    split = task('a', 'Flashcards', 'High', minutes=30, due_day=MONDAY, due_minute=12 * 60)
    whole = task('b', 'Practice exam', 'High', minutes=60, due_day=MONDAY, due_minute=12 * 60, allow_split=False)
    greedy = plan([split, whole], availability=two_periods, prefs=Prefs(focus=60), displace=False)
    assert alloc(greedy, 'b').unallocated == 60
    result = plan([split, whole], availability=two_periods, prefs=Prefs(focus=60))
    assert [r[1:] for r in rows(result)] == [('09:00-10:00', 'work', 'Practice exam'), ('10:00-10:10', 'break', 'Break'),
                                             ('10:30-11:00', 'work', 'Flashcards')]
    assert alloc(result, 'a').unallocated == alloc(result, 'b').unallocated == 0


def test_repair_never_trades_an_earlier_deadline_for_more_minutes():
    """Same tier, both cannot be full: keep the earlier-deadline task complete (documented tie-break)."""
    one_hour = hours(9 * 60, 10 * 60 + 40)
    first = task('a', 'Quiz prep', 'High', minutes=60, due_day=MONDAY, due_minute=11 * 60)
    second = task('b', 'Essay', 'High', minutes=60, due_day=MONDAY, due_minute=12 * 60, allow_split=False)
    result = plan([first, second], availability=one_hour, prefs=Prefs(focus=60))
    assert alloc(result, 'a').unallocated == 0
    assert alloc(result, 'b').unallocated == 60


def test_unsplittable_task_over_focus_limit_is_a_settings_conflict_with_choices():
    result = plan([task('exam', 'Mock exam', minutes=120, allow_split=False)])
    conflict = next(c for c in result.conflicts if c.code == 'settings_conflict')
    assert [c['id'] for c in conflict.choices] == ['allow_split', 'raise_focus_limit', 'make_flexible_event']
    assert works(result) == []  # nothing is relaxed silently


def test_daylight_saving_fall_back_keeps_local_wall_clock_times():
    saturday = date(2026, 10, 31)  # New York leaves daylight time on Sunday 1 November 2026
    work = task('w', 'Problem set', minutes=100, due_day=saturday + timedelta(days=2), max_session=50)
    result = plan([work], now=at(saturday, 8 * 60), availability=hours(9 * 60, 9 * 60 + 50), days=2)
    sessions = works(result)
    assert [local_span(s.start, s.end, NY)[1:] for s in sessions] == [(540, 590), (540, 590)]
    assert sessions[1].start - sessions[0].start == 25 * 60  # the Sunday has 25 hours
    utc = ZoneInfo('UTC')
    from app.scheduling_engine import from_abs
    assert [from_abs(s.start).astimezone(utc).hour for s in sessions] == [13, 14]
