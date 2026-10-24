"""Engine and independent-validator tests. Pure functions: no database, no clock, no OpenAI."""
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.schedule_model import SchedulePreferences
from app.scheduling_engine import (
    Busy, EngineTask, Existing, Prefs, from_abs, local_span, local_to_abs, plan_schedule, to_abs,
)
from app.scheduling_service import Context, run_engine
from app.scheduling_validator import EventRef, SavedRef, ValidationError, validate_preview
from app.workspace import Availability, TaskOutput

NY = ZoneInfo('America/New_York')
MONDAY = date(2026, 10, 26)


def hours(start=540, end=720, zone='America/New_York', days=range(7)):
    return Availability(days=[{'day': d, 'enabled': d in days, 'periods': [{'start': start, 'end': end}]} for d in range(7)],
                        weekOverrides=[], timeZone=zone, reminders=False)


def at(day: date, minute: int, zone=NY) -> int:
    return local_to_abs(day, minute, zone)


def task(id, title, priority='High', minutes=60, completed=0, due_day=MONDAY + timedelta(days=1), due_minute=1440, **kw):
    return EngineTask(id, title, priority, at(due_day, due_minute), minutes, completed, **kw)


def plan(tasks, availability=None, events=(), existing=(), now=None, prefs=Prefs(), days=1, **kw):
    availability = availability or hours()
    now = at(MONDAY, 8 * 60) if now is None else now
    return plan_schedule(list(tasks), availability, prefs, list(events), list(existing), now, days, **kw)


def rows(result, zone=NY):
    """(local date, 'HH:MM-HH:MM', type, title) for each session, in order."""
    out = []
    for s in result.sessions:
        day, start, end = local_span(s.start, s.end, zone)
        out.append((day, f'{start // 60:02d}:{start % 60:02d}-{end // 60:02d}:{end % 60:02d}', s.type, s.title))
    return out


def alloc(result, task_id):
    return next(a for a in result.allocations if a.task_id == task_id)


def conserved(result):
    for a in result.allocations:
        assert a.retained + a.new + a.unallocated == a.remaining + a.over_allocated, a
        assert all(s.end > s.start for s in result.sessions)


# ------------------------------------------------------------------ required acceptance case (engine level)

def test_acceptance_breaks_carry_across_task_switch():
    result = plan([task('asm', 'Asm', 'High'), task('rev', 'Test revision', 'Medium')])
    assert [r[1:] for r in rows(result)] == [
        ('09:00-09:50', 'work', 'Asm'),
        ('09:50-10:00', 'break', 'Break'),
        ('10:00-10:10', 'work', 'Asm'),
        ('10:10-10:50', 'work', 'Test revision'),  # switching task does not reset the 50-minute counter
        ('10:50-11:00', 'break', 'Break'),
        ('11:00-11:20', 'work', 'Test revision'),  # no trailing break after the last session
    ]
    assert alloc(result, 'asm').new == 60 and alloc(result, 'rev').new == 60
    assert alloc(result, 'asm').unallocated == alloc(result, 'rev').unallocated == 0
    conserved(result)


def test_identical_inputs_give_identical_output_and_ids_break_ties():
    tasks = [task('b', 'B', 'Medium', 30), task('a', 'A', 'Medium', 30)]
    first, second = plan(tasks), plan(list(reversed(tasks)))
    assert rows(first) == rows(second)
    assert list(dict.fromkeys(s.task_id for s in first.sessions if s.type == 'work')) == ['a', 'b']


# ------------------------------------------------------------------ free time and breaks

def test_event_interrupting_availability_is_skipped_and_meeting_is_not_rest():
    meeting = Busy('m', 'Standup', at(MONDAY, 9 * 60 + 30), at(MONDAY, 10 * 60))
    result = plan([task('asm', 'Asm', minutes=60)], events=[meeting])
    # 30 min before the meeting; the meeting is not rest, so work after it needs a real 10-minute gap first.
    assert [r[1:] for r in rows(result)] == [
        ('09:00-09:30', 'work', 'Asm'),
        ('10:00-10:20', 'work', 'Asm'),
        ('10:20-10:30', 'break', 'Break'),
        ('10:30-10:40', 'work', 'Asm'),
    ]
    conserved(result)


def test_free_gap_counts_as_rest_so_no_extra_break():
    lunch = Prefs(lunch=(10 * 60, 10 * 60 + 30))
    result = plan([task('asm', 'Asm', minutes=90)], prefs=lunch)
    assert [r[1:] for r in rows(result)] == [
        ('09:00-09:50', 'work', 'Asm'),
        ('10:30-11:10', 'work', 'Asm'),  # protected lunch is the rest; no extra break session is needed
    ]


def test_daily_limit_splits_long_task_across_days():
    result = plan([task('big', 'Thesis', minutes=300, due_day=MONDAY + timedelta(days=3), max_session=120)],
                  availability=hours(540, 1020), prefs=Prefs(max_daily=120), days=3)
    per_day = {}
    for day, _span, kind, _t in rows(result):
        if kind == 'work':
            per_day[day] = per_day.get(day, 0)
    for s in result.sessions:
        if s.type == 'work':
            day = local_span(s.start, s.end, NY)[0]
            per_day[day] += s.end - s.start
    assert per_day == {'2026-10-26': 120, '2026-10-27': 120, '2026-10-28': 60}
    assert alloc(result, 'big').unallocated == 0
    conserved(result)


def test_insufficient_capacity_reports_unallocated_minutes_and_reasons():
    result = plan([task('asm', 'Asm', minutes=240, due_day=MONDAY, due_minute=720)])
    a = alloc(result, 'asm')
    assert a.new == 150 and a.unallocated == 90  # 9-12 holds 150 minutes of work once breaks are reserved
    assert [r.code for r in a.reasons] == ['insufficient_capacity']
    assert 'heuristic' in result.explanations[0] or result.explanations  # explanation present
    conserved(result)


def test_unsplit_task_longer_than_focus_limit_is_reported_incompatible():
    result = plan([task('exam', 'Exam', minutes=90, allow_split=False)])
    assert result.sessions == []
    assert [r.code for r in alloc(result, 'exam').reasons] == ['unsplit_exceeds_focus_limit']
    fits = plan([task('quiz', 'Quiz', minutes=45, allow_split=False)])
    assert [r[1:] for r in rows(fits)] == [('09:00-09:45', 'work', 'Quiz')]


def test_past_time_is_never_planned_and_now_is_clipped():
    result = plan([task('asm', 'Asm', minutes=30)], now=at(MONDAY, 10 * 60 + 7))
    assert [r[1:] for r in rows(result)] == [('10:10-10:40', 'work', 'Asm')]


# ------------------------------------------------------------------ ordering, risk, dependencies

def test_task_at_risk_goes_before_higher_priority_work():
    high = task('h', 'Report', 'High', minutes=150, due_day=MONDAY + timedelta(days=3))
    low = task('l', 'Form', 'Low', minutes=40, due_day=MONDAY, due_minute=720)
    result = plan([high, low], days=2)
    assert alloc(result, 'l').at_risk is True
    assert alloc(result, 'l').unallocated == 0
    assert rows(result)[0][1:] == ('09:00-09:40', 'work', 'Form')
    assert result.order == ['l', 'h']


def test_dependencies_finish_first_and_cycles_are_reported():
    a = task('a', 'Outline', 'Low', 30)
    b = task('b', 'Draft', 'High', 30, depends_on=('a',))
    result = plan([b, a])
    works = [s for s in result.sessions if s.type == 'work']
    assert [s.task_id for s in works] == ['a', 'b', 'b'] and works[0].end <= works[1].start
    cyc = plan([task('x', 'X', minutes=30, depends_on=('y',)), task('y', 'Y', minutes=30, depends_on=('x',))])
    assert cyc.sessions == []
    assert {r.code for a in cyc.allocations for r in a.reasons} == {'dependency_cycle'}
    conserved(cyc)


# ------------------------------------------------------------------ retained work, locked conflicts, accounting

def test_completed_minutes_reduce_remaining_and_scheduled_work_is_not_completed():
    done_part = task('asm', 'Asm', minutes=60, completed=20)
    result = plan([done_part])
    assert alloc(result, 'asm').remaining == 40 and alloc(result, 'asm').new == 40


def test_locked_session_is_kept_counts_as_retained_and_conflict_reported():
    locked = Existing('s1', 'asm', 'work', 'saved', True, 'auto', at(MONDAY, 9 * 60), at(MONDAY, 9 * 60 + 30), 'Asm')
    clash = Busy('e', 'Dentist', at(MONDAY, 9 * 60 + 15), at(MONDAY, 10 * 60))
    result = plan([task('asm', 'Asm', minutes=60)], events=[clash], existing=[locked])
    retained = [s for s in result.sessions if s.change == 'retained']
    assert [(s.id, s.start, s.end) for s in retained] == [('s1', locked.start, locked.end)]  # not moved
    assert [c.code for c in result.conflicts] == ['fixed_overlap']
    assert 'Dentist' in result.conflicts[0].message
    a = alloc(result, 'asm')
    assert (a.retained, a.new, a.unallocated) == (30, 30, 0)
    conserved(result)


def test_retained_work_beyond_remaining_is_over_allocated_not_duplicated():
    locked = Existing('s1', 'asm', 'work', 'saved', True, 'manual', at(MONDAY, 9 * 60), at(MONDAY, 10 * 60), 'Asm')
    result = plan([task('asm', 'Asm', minutes=60, completed=30)], existing=[locked])
    a = alloc(result, 'asm')
    assert (a.remaining, a.retained, a.new, a.unallocated, a.over_allocated) == (30, 60, 0, 0, 30)
    assert any(c.code == 'over_allocated' for c in result.conflicts)


def test_in_progress_session_counts_fully_as_retained():
    running = Existing('s1', 'asm', 'work', 'saved', False, 'auto', at(MONDAY, 9 * 60), at(MONDAY, 9 * 60 + 40), 'Asm')
    result = plan([task('asm', 'Asm', minutes=60)], existing=[running], now=at(MONDAY, 9 * 60 + 20))
    a = alloc(result, 'asm')
    assert (a.retained, a.in_progress, a.new, a.unallocated) == (40, 40, 20, 0)
    # A 10-minute tail would be shorter than the 15-minute minimum, so the rest follows a break.
    assert [r[1:] for r in rows(result)] == [
        ('09:00-09:40', 'work', 'Asm'), ('09:40-09:50', 'break', 'Break'), ('09:50-10:10', 'work', 'Asm'),
    ]


# ------------------------------------------------------------------ repair and requested breaks

def saved(id, task_id, start, end, title, source='auto', locked=False, kind='work'):
    return Existing(id, task_id, kind, 'saved', locked, source, start, end, title)


def test_repair_keeps_unaffected_sessions_and_moves_conflicting_ones():
    tasks = [task('asm', 'Asm', 'High'), task('rev', 'Test revision', 'Medium')]
    first = plan(tasks)
    existing = [saved(f's{i}', s.task_id, s.start, s.end, s.title, kind=s.type) for i, s in enumerate(first.sessions)]
    meeting = Busy('m', 'Advisor', at(MONDAY, 10 * 60 + 10), at(MONDAY, 10 * 60 + 50))
    result = plan(tasks, events=[meeting], existing=existing, mode='repair', days=2)
    kept = {s.id for s in result.sessions if s.change == 'kept'}
    assert {'s0', 's2'} <= kept  # Asm sessions were not affected
    moved = {r.session.id: r.reason for r in result.removals if r.session.type == 'work'}
    assert moved == {'s3': 'It overlaps "Advisor".'}
    assert alloc(result, 'rev').unallocated == 0
    conserved(result)


def test_repair_moves_lower_priority_flexible_work_for_urgent_work():
    low = task('low', 'Reading', 'Low', minutes=50, due_day=MONDAY + timedelta(days=2))
    urgent = task('hi', 'Lab', 'High', minutes=50, due_day=MONDAY, due_minute=10 * 60)
    existing = [saved('r1', 'low', at(MONDAY, 9 * 60), at(MONDAY, 9 * 60 + 50), 'Reading')]
    result = plan([low, urgent], existing=existing, mode='repair', days=2)
    assert any(r.session.id == 'r1' and 'Lab' in r.reason for r in result.removals)
    assert alloc(result, 'hi').unallocated == 0
    assert alloc(result, 'low').unallocated == 0  # the moved work found another place
    conserved(result)


def test_requested_break_now_truncates_running_flexible_work_and_replans_it():
    running = saved('s1', 'asm', at(MONDAY, 9 * 60), at(MONDAY, 9 * 60 + 50), 'Asm')
    result = plan([task('asm', 'Asm', minutes=60)], existing=[running], now=at(MONDAY, 9 * 60 + 20),
                  mode='repair', requested_break=(at(MONDAY, 9 * 60 + 20), at(MONDAY, 9 * 60 + 50)))
    breaks = [s for s in result.sessions if s.type == 'break' and s.locked]
    assert [(s.start, s.end) for s in breaks] == [(at(MONDAY, 9 * 60 + 20), at(MONDAY, 9 * 60 + 50))]
    assert [r.new_end for r in result.removals] == [at(MONDAY, 9 * 60 + 20)]
    a = alloc(result, 'asm')
    assert (a.retained, a.new, a.unallocated) == (20, 40, 0)
    assert all(not (s.type == 'work' and s.start < at(MONDAY, 9 * 60 + 50) and s.end > at(MONDAY, 9 * 60 + 20))
               for s in result.sessions)
    conserved(result)


def test_requested_break_never_moves_a_fixed_event():
    meeting = Busy('m', 'Seminar', at(MONDAY, 9 * 60 + 15), at(MONDAY, 10 * 60))
    shortened = plan([], events=[meeting], now=at(MONDAY, 9 * 60), mode='repair',
                     requested_break=(at(MONDAY, 9 * 60), at(MONDAY, 9 * 60 + 30)))
    assert [(s.start, s.end) for s in shortened.sessions] == [(at(MONDAY, 9 * 60), at(MONDAY, 9 * 60 + 15))]
    assert [c.code for c in shortened.conflicts] == ['break_shortened']
    blocked = plan([], events=[meeting], now=at(MONDAY, 9 * 60 + 20), mode='repair',
                   requested_break=(at(MONDAY, 9 * 60 + 20), at(MONDAY, 9 * 60 + 50)))
    assert blocked.sessions == []
    assert [c.code for c in blocked.conflicts] == ['break_conflict']
    assert 'Seminar' in blocked.conflicts[0].message and 'not moved' in blocked.conflicts[0].message


# ------------------------------------------------------------------ daylight saving

@pytest.mark.parametrize('day, real_minutes', [(date(2026, 3, 8), 120), (date(2026, 11, 1), 240)])
def test_dst_days_use_real_instants(day, real_minutes):
    """Availability 1:00-4:00 AM local is 2h of real time on spring-forward day and 4h on fall-back day."""
    availability = hours(60, 240)
    now = local_to_abs(day, 0, NY)
    result = plan_schedule([EngineTask('t', 'T', 'High', local_to_abs(day, 1440, NY), 600, 0, max_session=600)],
                           availability, Prefs(focus=240, brk=10, max_daily=600), [], [], now, 1)
    worked = sum(s.end - s.start for s in result.sessions if s.type == 'work')
    assert worked == real_minutes
    for s in result.sessions:
        assert from_abs(s.start).tzinfo == timezone.utc


# ------------------------------------------------------------------ independent validator

def _ctx(tasks, availability, prefs=SchedulePreferences(), events=(), existing=()):
    zone = ZoneInfo(availability.timeZone)
    return Context('u', tasks, availability, prefs, zone, list(events), [], list(existing), {t.id: t.title for t in tasks},
                   0, MONDAY.isoformat(), MONDAY.isoformat())


def _task_output(id, title, priority):
    return TaskOutput(id=id, title=title, deadline='2026-10-27', minutes=60, priority=priority, category='Study', done=False)


def _preview():
    tasks = [_task_output('asm', 'Asm', 'High'), _task_output('rev', 'Test revision', 'Medium')]
    ctx = _ctx(tasks, hours())
    now = from_abs(at(MONDAY, 8 * 60))
    return run_engine(ctx, now, 1, 'generate', {}), ctx, now


def _validate(preview, ctx, now):
    validate_preview(preview, tasks=ctx.tasks, availability=ctx.availability, prefs=ctx.prefs,
                     events=[EventRef(b.title, b.start, b.end) for b in ctx.events],
                     saved=[SavedRef(x.id, x.task_id, x.type, x.status, x.locked, x.source, x.start, x.end) for x in ctx.existing],
                     now=now)


def test_validator_accepts_engine_output_and_rejects_corruption():
    preview, ctx, now = _preview()
    _validate(preview, ctx, now)

    no_break = preview.model_copy(deep=True)
    no_break.sessions = [s for s in no_break.sessions if s.type != 'break']
    with pytest.raises(ValidationError) as exc:
        _validate(no_break, ctx, now)
    assert exc.value.code == 'missing_break'

    overlap = preview.model_copy(deep=True)
    overlap.sessions[2].startAt = overlap.sessions[1].startAt
    with pytest.raises(ValidationError) as exc:
        _validate(overlap, ctx, now)
    assert exc.value.code in {'overlap', 'duration_mismatch'}

    lost = preview.model_copy(deep=True)
    lost.tasks[0].unallocatedMinutes += 15
    with pytest.raises(ValidationError) as exc:
        _validate(lost, ctx, now)
    assert exc.value.code == 'duration_mismatch'

    with pytest.raises(ValidationError) as exc:
        _validate(preview, ctx, now + timedelta(hours=2))  # applying after the sessions began
    assert exc.value.code == 'past'

    foreign = preview.model_copy(deep=True)
    foreign.sessions[0].taskId = 'someone-elses-task'
    with pytest.raises(ValidationError) as exc:
        _validate(foreign, ctx, now)
    assert exc.value.code == 'ownership'


def test_validator_enforces_focus_and_daily_limits():
    preview, ctx, now = _preview()
    stricter = ctx.prefs.model_copy(update={'focusMinutes': 30})
    with pytest.raises(ValidationError) as exc:
        validate_preview(preview, tasks=ctx.tasks, availability=ctx.availability, prefs=stricter, events=[], saved=[], now=now)
    assert exc.value.code == 'focus_limit'
    tight = ctx.prefs.model_copy(update={'maxDailyWorkMinutes': 60})
    with pytest.raises(ValidationError) as exc:
        validate_preview(preview, tasks=ctx.tasks, availability=ctx.availability, prefs=tight, events=[], saved=[], now=now)
    assert exc.value.code == 'daily_limit'


def test_timestamps_are_utc_and_display_fields_are_local():
    preview, _ctx_, _now = _preview()
    first = preview.sessions[0]
    assert first.startAt == datetime(2026, 10, 26, 13, 0, tzinfo=timezone.utc)  # 9:00 EDT
    assert (first.date, first.start, first.end) == ('2026-10-26', 540, 590)
    assert to_abs(first.endAt) - to_abs(first.startAt) == 50
