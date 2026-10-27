"""Deterministic scheduling engine. Pure: no database access and no wall-clock reads.

Time model
- Every instant is an integer number of minutes since the Unix epoch (UTC).
- Intervals are half-open [start, end): adjacent intervals touch but never overlap.
- Availability, events and lunch are wall-clock values in the user's IANA timezone; they are
  resolved to UTC per local day, so daylight-saving days have 23 or 25 hours.

Rules (hard constraints for every new work session)
- Inside an availability period, at or after now, before the window end and the task's due instant.
- No overlap with events, retained (locked / manual / in-progress) work, protected breaks, lunch,
  or other new sessions.
- Continuous-work limit: a "run" is a sequence of work sessions whose gaps are not rest. A gap is
  rest only if it contains at least `breakMinutes` of time that is not a busy event (a meeting is
  not rest). Each run may hold at most `focusMinutes` of task work; the run counter carries across
  task switches.
- Daily task-work limit per local day.
- Dependencies finish first; earliestStart is honoured; unsplit tasks get one session no longer
  than the focus limit.
- Optional allowed time windows (e.g. weekday evenings) restrict where a task may be placed.

Flexible events (kind "flexible_event", e.g. "gym for an hour sometime Saturday") are placed by the
engine like tasks but are not focus work: they get one contiguous slot unless splitting is allowed,
they use their own allowed windows (or availability when none are given), they do not count toward
the daily or continuous-work limits, and once placed they are busy time that is not rest.

Breaks are reserved during allocation: a placement is only accepted when the run it joins stays
within the focus limit, which keeps the rest gap free. After allocation a break session is
materialised at the start of each rest gap that separates two same-day runs whose combined work
exceeds the focus limit (that is, where the break is what makes continuing legal). No trailing
break is added when no more work follows.

Priority policy and deterministic tie-breaking: High, then Medium, then Low; within a tier the
earliest due instant, then the earliest allowed start, then task id. Dependencies are respected with
this key as tie-break. Deadline risk is reported (`at_risk`, `slack`) but never reorders work: the
user's priorities decide who gets scarce time.

Deadline-risk estimate: usable capacity before a deadline is the free availability before it
(after events, retained work, protected breaks and lunch), limited per day by the daily work limit
minus retained work, multiplied by focus / (focus + break) for break overhead. A task is at risk
when its unretained remaining work exceeds that capacity minus the work of tasks ordered ahead of
it. This is an estimate for warnings only.

Search: a greedy earliest-fit baseline in priority order, then bounded local repair. For each task
that is short, sessions of same- or lower-priority unlocked work (new, or kept saved sessions in
repair mode) that overlap its window are removed one by one (at most MAX_VICTIMS per attempt), the
task is re-placed, then the displaced tasks are re-placed. The move is kept only when the
lexicographic objective strictly improves. Per tier, High then Medium then Low: number of fully
scheduled tasks, then which tasks are full in (due, earliest start, id) order, then scheduled
minutes. Otherwise the state is restored exactly. Fixed events, locked, manual and in-progress sessions are never moved. Attempts are
bounded (MAX_REPAIR_ATTEMPTS in total, MAX_REPAIR_ATTEMPTS_PER_TASK per task).

This is a heuristic. Work it cannot place is reported with reasons; that is not proof that no valid
schedule exists (see app.feasibility for the cases that are actually proven).
"""
from __future__ import annotations

import bisect
import json
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from hashlib import sha256
from zoneinfo import ZoneInfo

from app.workspace import Availability, resolve_available_day

UTC = timezone.utc
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
GRID = 5  # new sessions start on 5-minute boundaries (or on an existing boundary)
PRIORITY_RANK = {'High': 0, 'Medium': 1, 'Low': 2}
MAX_REPAIR_ATTEMPTS = 20
MAX_REPAIR_ATTEMPTS_PER_TASK = 6
MAX_VICTIMS = 4  # sessions removed in one repair attempt
FAR_FUTURE = 2 ** 40
CONTEXT_LOOKBACK = 12 * 60  # recent past work that still counts toward the continuous-work run

HEURISTIC_NOTE = ('AutoPlan places work with a deterministic greedy heuristic. Unallocated minutes mean this '
                  'heuristic found no valid place under your rules; that is not proof that no schedule exists.')


# ---------------------------------------------------------------- time helpers

def to_abs(moment: datetime) -> int:
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError('Timestamps must be timezone-aware.')
    return int((moment.astimezone(UTC) - EPOCH).total_seconds() // 60)


def from_abs(minute: int) -> datetime:
    return EPOCH + timedelta(minutes=minute)


def local_to_abs(day: date, minute: int, zone: ZoneInfo) -> int:
    """Wall-clock `minute` after local midnight of `day` (1440 = next midnight) as an absolute minute.

    A wall time inside a spring-forward gap maps to the first real instant after the gap; an
    ambiguous fall-back time maps to its first occurrence.
    """
    day = day + timedelta(days=minute // 1440)
    naive = datetime.combine(day, time()) + timedelta(minutes=minute % 1440)
    first = naive.replace(tzinfo=zone, fold=0).astimezone(UTC)
    if first.astimezone(zone).replace(tzinfo=None) == naive:
        return to_abs(first)
    probe = to_abs(naive.replace(tzinfo=zone, fold=1).astimezone(UTC))
    while from_abs(probe).astimezone(zone).replace(tzinfo=None) < naive:
        probe += 1
    return probe


def local_parts(minute: int, zone: ZoneInfo) -> tuple[date, int]:
    local = from_abs(minute).astimezone(zone)
    return local.date(), local.hour * 60 + local.minute


def local_span(start: int, end: int, zone: ZoneInfo) -> tuple[str, int, int]:
    """Display fields (local date, start minute, end minute) for an interval that starts on that date."""
    day, s = local_parts(start, zone)
    end_day, e = local_parts(end, zone)
    if end_day > day:
        e = min(1440, e + 1440 * (end_day - day).days)
    if e <= s:  # fall-back hour: wall clock repeats, keep the real duration
        e = min(1440, s + (end - start))
    return day.isoformat(), s, e


def ceil_grid(minute: int) -> int:
    return -(-minute // GRID) * GRID


def merge(intervals) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for s, e in sorted((s, e) for s, e in intervals if e > s):
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def subtract(free, blocked) -> list[tuple[int, int]]:
    blocked = merge(blocked)
    out = []
    for s, e in free:
        cursor = s
        for bs, be in blocked:
            if be <= cursor or bs >= e:
                continue
            if bs > cursor:
                out.append((cursor, bs))
            cursor = max(cursor, be)
            if cursor >= e:
                break
        if cursor < e:
            out.append((cursor, e))
    return out


def overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return a_start < b_end and b_start < a_end


def is_rest_gap(start: int, end: int, events: list[tuple[int, int]], break_minutes: int) -> bool:
    """True when [start, end) holds `break_minutes` of contiguous time that is not a busy event."""
    if end - start < break_minutes:
        return False
    return any(e - s >= break_minutes for s, e in subtract([(start, end)], events))


# ---------------------------------------------------------------- inputs / outputs

@dataclass(frozen=True)
class Prefs:
    focus: int = 50
    brk: int = 10
    max_daily: int = 240
    lunch: tuple[int, int] | None = None  # local wall-clock minutes


@dataclass(frozen=True)
class EngineTask:
    id: str
    title: str
    priority: str
    due: int  # absolute minute; work must end by this instant
    estimated: int
    completed: int
    allow_split: bool = True
    min_session: int = 15
    max_session: int = 60
    earliest: int | None = None
    depends_on: tuple[str, ...] = ()
    done: bool = False
    kind: str = 'task'  # task | flexible_event
    windows: tuple[tuple[int, int], ...] = ()  # allowed absolute intervals; empty = no extra restriction

    @property
    def is_work(self) -> bool:
        return self.kind != 'flexible_event'

    @property
    def remaining(self) -> int:
        return max(0, self.estimated - self.completed)


@dataclass(frozen=True)
class Busy:
    id: str
    title: str
    start: int
    end: int


@dataclass(frozen=True)
class Existing:
    """A saved session (any status)."""
    id: str
    task_id: str | None
    type: str  # work | break
    status: str  # saved | completed | cancelled
    locked: bool
    source: str  # manual | auto
    start: int
    end: int
    title: str = ''


@dataclass
class Placed:
    task_id: str | None
    type: str
    start: int
    end: int
    status: str  # proposed | saved
    locked: bool
    source: str
    change: str  # retained | kept | new | truncated
    id: str | None = None
    reason: str | None = None
    title: str = ''


@dataclass
class Reason:
    code: str
    message: str


@dataclass
class Allocation:
    task_id: str
    title: str
    priority: str
    due: int
    estimated: int
    completed: int
    remaining: int
    retained: int = 0
    in_progress: int = 0
    new: int = 0
    unallocated: int = 0
    over_allocated: int = 0
    at_risk: bool = False
    slack: int | None = None
    reasons: list[Reason] = field(default_factory=list)

    @property
    def status(self) -> str:
        if self.remaining == 0:
            return 'complete'
        if self.unallocated == 0:
            return 'scheduled'
        return 'partial' if self.retained + self.new else 'unscheduled'


@dataclass
class Conflict:
    code: str
    message: str
    items: list[dict]
    choices: list[dict] = field(default_factory=list)  # explicit options offered to the user, never applied silently


@dataclass
class Removal:
    session: Existing
    reason: str
    new_end: int | None = None  # set when the session is truncated instead of removed


@dataclass
class EngineResult:
    window_start: int
    window_end: int
    sessions: list[Placed]
    removals: list[Removal]
    allocations: list[Allocation]
    conflicts: list[Conflict]
    order: list[str]
    explanations: list[str]


# ---------------------------------------------------------------- planner

@dataclass
class _Work:
    start: int
    end: int
    task_id: str | None
    fixed: bool  # retained or past context work; never moved by this run
    counts_daily: bool = True
    ref: Placed | None = None


class _Planner:
    def __init__(self, tasks, availability, prefs, zone, events, existing, now, horizon_days, mode,
                 requested_break, not_before, displace=True):
        self.prefs = prefs
        self.zone = zone
        self.mode = mode
        self.displace = displace
        self.now = now
        self.start = ceil_grid(now)
        first_day, _ = local_parts(now, zone)
        self.days = [first_day + timedelta(days=offset) for offset in range(horizon_days)]
        self.window_end = local_to_abs(self.days[-1] + timedelta(days=1), 0, zone)
        self.not_before = not_before or {}
        self.event_items = sorted(events, key=lambda b: (b.start, b.end, b.id))
        self.events = [(b.start, b.end) for b in self.event_items]
        self.task_by_id = {t.id: t for t in tasks}
        self.open_tasks = sorted((t for t in tasks if not t.done), key=lambda t: t.id)
        self.sessions: list[Placed] = []
        self.removals: list[Removal] = []
        self.saved_breaks: list[Existing] = []  # unlocked future automatic breaks
        self.conflicts: list[Conflict] = []
        self.explanations: list[str] = []
        self.work: list[_Work] = []
        self.flex: list[_Work] = []  # placed flexible events: busy, not rest, not counted as work
        self.rest_items: list[tuple[int, int]] = []  # protected breaks and lunch: block work, count as rest
        self.flexible: list[Existing] = []
        self.allocations: dict[str, Allocation] = {}
        self.pending: dict[str, bool] = {}
        self.cyclic: set[str] = set()
        self.need: dict[str, int] = {}
        self.rank: dict[str, int] = {}
        self.displaced_by: dict[str, str] = {}

        self.lunch = []
        if prefs.lunch:
            for day in self.days:
                s, e = local_to_abs(day, prefs.lunch[0], zone), local_to_abs(day, prefs.lunch[1], zone)
                if e > s:
                    self.lunch.append((s, e))
        self.rest_items.extend(self.lunch)
        requested_break = self._clip_requested_break(existing, requested_break)
        self._classify(existing, requested_break)

        self.availability = []
        for day in self.days:
            hours = resolve_available_day(availability, day)
            if not hours.enabled:
                continue
            for period in hours.periods:
                s = max(local_to_abs(day, period.start, zone), self.start)
                e = min(local_to_abs(day, period.end, zone), self.window_end)
                if e > s:
                    self.availability.append((s, e))
        self.availability = merge(self.availability)
        self._allowed: dict[str, list[tuple[int, int]]] = {}

    # -- setup

    def clock(self, minute: int) -> str:
        _, m = local_parts(minute, self.zone)
        return f"{(m // 60) % 12 or 12}:{m % 60:02d} {'AM' if m < 720 else 'PM'}"

    def is_work(self, task_id: str | None) -> bool:
        task = self.task_by_id.get(task_id or '')
        return task is None or task.is_work

    def allowed(self, task: EngineTask) -> list[tuple[int, int]]:
        """Where `task` may be placed: availability (intersected with its windows), or for a flexible event
        its own windows (availability when it has none). Always clipped to [now, window end)."""
        if task.id not in self._allowed:
            windows = merge((max(s, self.start), min(e, self.window_end)) for s, e in task.windows)
            if not task.windows:
                spans = list(self.availability)
            elif task.is_work:
                spans = merge((max(a, b), min(c, d)) for a, c in self.availability for b, d in windows)
            else:
                spans = windows
            self._allowed[task.id] = [(s, e) for s, e in spans if e > s]
        return self._allowed[task.id]

    def _track(self, start: int, end: int, task_id: str | None, fixed: bool, counts_daily: bool = True,
               ref: Placed | None = None):
        bucket = self.work if self.is_work(task_id) else self.flex
        bucket.append(_Work(start, end, task_id, fixed, counts_daily, ref))
        bucket.sort(key=lambda w: (w.start, w.end))

    def _clip_requested_break(self, existing: list[Existing], requested):
        """A requested break never overlaps a fixed event or locked/manual work; the conflict is explained instead."""
        if not requested:
            return None
        s, e = requested
        fixed = [(b.start, b.end, b.title, 'event') for b in self.event_items]
        fixed += [(x.start, x.end, x.title or 'a protected break' if x.type == 'break' else x.title or 'Locked work', 'session')
                  for x in existing
                  if x.status == 'saved' and x.end > s and (x.locked or x.source == 'manual')]
        clash = min((f for f in fixed if overlaps(f[0], f[1], s, e)), key=lambda f: (f[0], f[1]), default=None)
        if clash is None:
            return s, e
        item = {'kind': clash[3], 'title': clash[2], 'start': clash[0], 'end': clash[1]}
        if clash[0] <= s:
            self.conflicts.append(Conflict('break_conflict',
                                           f'"{clash[2]}" runs until {self.clock(clash[1])}, so a break cannot start now. '
                                           f'It was not moved.', [item]))
            return None
        self.conflicts.append(Conflict('break_shortened',
                                       f'Your break ends at {self.clock(clash[0])} because "{clash[2]}" starts then. '
                                       f'"{clash[2]}" was not moved.', [item]))
        return s, clash[0]

    def _classify(self, existing: list[Existing], requested_break):
        now = self.now
        for item in sorted(existing, key=lambda x: (x.start, x.end, x.id)):
            if item.end <= item.start or item.status == 'cancelled':
                continue
            if item.status == 'completed':
                if item.type == 'work' and item.end > now - CONTEXT_LOOKBACK and self.is_work(item.task_id):
                    self.work.append(_Work(item.start, item.end, item.task_id, True))
                continue
            if item.end <= now:
                if item.type == 'work' and item.end > now - CONTEXT_LOOKBACK and self.is_work(item.task_id):
                    # Past and not marked complete: counts toward the run (conservative), not the daily total.
                    self.work.append(_Work(item.start, item.end, item.task_id, True, counts_daily=False))
                continue
            in_progress = item.start < now
            if item.type == 'break':
                if item.locked or in_progress:
                    self.rest_items.append((item.start, item.end))
                    self.sessions.append(self._retained(item, 'Protected break' if item.locked else 'Break in progress'))
                else:
                    self.saved_breaks.append(item)  # recalculated; kept as-is if the new plan needs the same break
                continue
            flexible = item.source == 'auto' and not item.locked
            if in_progress and flexible and requested_break and requested_break[0] < item.end:
                cut = max(item.start + 1, requested_break[0])
                self.removals.append(Removal(item, 'Shortened so your break can start now.', new_end=cut))
                placed = self._retained(item, 'In progress; shortened for your break')
                placed.end, placed.change = cut, 'truncated'
                self.sessions.append(placed)
                self._track(item.start, cut, item.task_id, True, ref=placed)
                continue
            if in_progress or not flexible:
                why = 'In progress' if in_progress else ('Locked' if item.locked else 'Placed by you')
                placed = self._retained(item, why)
                self.sessions.append(placed)
                self._track(item.start, item.end, item.task_id, True, ref=placed)
                continue
            self.flexible.append(item)
        if requested_break:
            s, e = requested_break
            self.sessions.append(Placed(None, 'break', s, e, 'proposed', True, 'manual', 'new',
                                        reason='Requested break', title='Break'))
            self.rest_items.append((s, e))
        self.work.sort(key=lambda w: (w.start, w.end))

    def _retained(self, item: Existing, reason: str) -> Placed:
        return Placed(item.task_id, item.type, item.start, item.end, 'saved', item.locked, item.source,
                      'retained', id=item.id, reason=reason, title=item.title)

    def add_reason(self, task_id: str, code: str, message: str):
        reasons = self.allocations[task_id].reasons
        if not any(r.code == code for r in reasons):
            reasons.append(Reason(code, message))

    def add_conflict(self, conflict: Conflict):
        key = (conflict.code, tuple(i.get('id') for i in conflict.items))
        if not any((c.code, tuple(i.get('id') for i in c.items)) == key for c in self.conflicts):
            self.conflicts.append(conflict)

    # -- queries

    def day(self, minute: int) -> date:
        return local_parts(minute, self.zone)[0]

    def busy(self) -> list[tuple[int, int]]:
        """Time that is occupied but is not rest: events and placed flexible events."""
        return merge([*self.events, *[(w.start, w.end) for w in self.flex]])

    def blockers(self) -> list[tuple[int, int]]:
        return merge([*self.events, *self.rest_items, *[(w.start, w.end) for w in self.work],
                      *[(w.start, w.end) for w in self.flex]])

    def day_work(self, day: date) -> int:
        return sum(w.end - w.start for w in self.work if w.counts_daily and self.day(w.start) == day)

    @staticmethod
    def free_until(t: int, blockers, allowed) -> int:
        span = next(((s, e) for s, e in allowed if s <= t < e), None)
        if span is None:
            return t
        limit = span[1]
        for bs, be in blockers:
            if be <= t:
                continue
            if bs <= t:
                return t
            limit = min(limit, bs)
            break
        return limit

    def run_total(self, start: int, end: int) -> int:
        """Work minutes in the continuous-work run that [start, end) would belong to."""
        busy = self.busy()
        items = sorted([(w.start, w.end) for w in self.work] + [(start, end)])
        index = items.index((start, end))
        total = end - start
        i = index
        while i > 0 and not is_rest_gap(items[i - 1][1], items[i][0], busy, self.prefs.brk):
            total += items[i - 1][1] - items[i - 1][0]
            i -= 1
        i = index
        while i < len(items) - 1 and not is_rest_gap(items[i][1], items[i + 1][0], busy, self.prefs.brk):
            total += items[i + 1][1] - items[i + 1][0]
            i += 1
        return total

    def candidates(self, lo: int, hi: int, allowed) -> list[int]:
        points: set[int] = set()
        for s, e in allowed:
            if e <= lo or s >= hi:
                continue
            first = max(s, lo)
            points.add(first)
            points.update(range(ceil_grid(first), min(e, hi), GRID))
        for w in [*self.work, *self.flex]:
            points.update((w.end, w.end + self.prefs.brk))
        for _s, e in [*self.events, *self.rest_items]:
            points.update((e, e + self.prefs.brk))
        return sorted(p for p in points if lo <= p < hi)

    def best_length(self, t: int, upper: int, need: int, exact: bool) -> int:
        if exact:
            options = [need] if need <= upper else []
        else:
            values = {upper, *range(upper - upper % GRID, 0, -GRID)}
            if need <= upper:
                values.add(need)
            options = sorted((x for x in values if x > 0), reverse=True)
        for length in options:
            if self.run_total(t, t + length) <= self.prefs.focus:
                return length
        return 0

    # -- placement

    def place(self, task: EngineTask, need: int, lo: int, hi: int, notes: set[str]) -> list[Placed]:
        """Earliest valid sessions for `need` minutes inside [lo, hi) and the task's allowed time."""
        placed: list[Placed] = []
        if need <= 0 or hi <= lo:
            return placed
        exact = not task.allow_split
        allowed = self.allowed(task)
        points = self.candidates(lo, hi, allowed)
        blockers = self.blockers()
        i = 0
        while i < len(points) and need > 0:
            t = points[i]
            i += 1
            fu = self.free_until(t, blockers, allowed)
            if fu <= t:
                continue
            if task.is_work:
                daily_left = self.prefs.max_daily - self.day_work(self.day(t))
                if daily_left <= 0:
                    notes.add('daily_limit')
                    continue
                upper = min(need, need if exact else task.max_session, fu - t, hi - t, daily_left, self.prefs.focus)
                if exact and upper < need:
                    if daily_left < need:
                        notes.add('daily_limit')
                    continue
                length = self.best_length(t, upper, need, exact)
                if length <= 0:
                    notes.add('focus_limit')
                    continue
            else:
                upper = min(need, need if exact else task.max_session, fu - t, hi - t)
                if exact and upper < need:
                    continue
                length = upper
            if length < need and length < task.min_session:
                continue  # only the final piece may be shorter than the minimum session
            session = Placed(task.id, 'work', t, t + length, 'proposed', False, 'auto', 'new', title=task.title)
            placed.append(session)
            self._track(t, t + length, task.id, False, ref=session)
            blockers = self.blockers()
            need -= length
            for extra in (t + length, t + length + self.prefs.brk):
                if lo <= extra < hi:
                    position = bisect.bisect_left(points, extra)
                    if position >= len(points) or points[position] != extra:
                        points.insert(position, extra)
            if exact:
                break
        return placed

    def remove_session(self, session: Placed):
        self.sessions = [s for s in self.sessions if s is not session]
        self.work = [w for w in self.work if w.ref is not session]
        self.flex = [w for w in self.flex if w.ref is not session]

    def allocated(self, task_id: str) -> int:
        return sum(s.end - s.start for s in self.sessions
                   if s.task_id == task_id and s.type == 'work' and s.change in {'new', 'kept'})

    def retained_minutes(self, task_id: str) -> int:
        return sum(s.end - s.start for s in self.sessions
                   if s.task_id == task_id and s.type == 'work' and s.change in {'retained', 'truncated'})

    def short(self, task_id: str) -> int:
        return max(0, self.need.get(task_id, 0) - self.allocated(task_id))

    # -- capacity / ordering

    def capacity_before(self, deadline: int) -> int:
        free = subtract([(s, min(e, deadline)) for s, e in self.availability if s < deadline],
                        [*self.events, *self.rest_items, *[(w.start, w.end) for w in [*self.work, *self.flex] if w.fixed]])
        per_day: dict[date, int] = {}
        for s, e in free:
            day = self.day(s)
            per_day[day] = per_day.get(day, 0) + e - s
        fixed_daily = {}
        for w in self.work:
            if w.fixed and w.counts_daily:
                fixed_daily[self.day(w.start)] = fixed_daily.get(self.day(w.start), 0) + w.end - w.start
        total = sum(max(0, min(minutes, self.prefs.max_daily - fixed_daily.get(day, 0))) for day, minutes in per_day.items())
        return total * self.prefs.focus // (self.prefs.focus + self.prefs.brk)

    @staticmethod
    def priority_key(task: EngineTask):
        """The documented, deterministic order: priority, due instant, earliest start, id."""
        return PRIORITY_RANK.get(task.priority, 3), task.due, task.earliest or 0, task.id

    def ordered(self, need: dict[str, int]) -> list[EngineTask]:
        base = sorted(self.open_tasks, key=self.priority_key)
        keys = {}
        for index, task in enumerate(base):
            alloc = self.allocations[task.id]
            if task.is_work:
                cap = self.capacity_before(task.due)
                ahead = sum(min(need[other.id], cap) for other in base[:index] if other.is_work)
                slack = cap - ahead - need[task.id]
                alloc.slack = slack
                alloc.at_risk = need[task.id] > 0 and task.due > self.now and slack < 0
            keys[task.id] = self.priority_key(task)  # deadline risk is a warning only; it never reorders
        ids = {t.id for t in self.open_tasks}
        waiting = {t.id: {d for d in t.depends_on if d in ids} for t in self.open_tasks}
        order: list[EngineTask] = []
        ready = sorted((tid for tid, deps in waiting.items() if not deps), key=keys.get)
        while ready:
            tid = ready.pop(0)
            order.append(self.task_by_id[tid])
            del waiting[tid]
            for other, deps in waiting.items():
                if tid in deps:
                    deps.discard(tid)
                    if not deps:
                        bisect.insort(ready, other, key=keys.get)
        self.cyclic = set(waiting)
        for tid in sorted(waiting):
            self.add_reason(tid, 'dependency_cycle', 'This task is part of (or waits on) a dependency cycle, so it cannot be ordered.')
        return order

    # -- main

    def run(self) -> EngineResult:
        self._detect_conflicts()
        need = self.need
        for task in self.open_tasks:
            retained = self.retained_minutes(task.id)
            alloc = Allocation(task.id, task.title, task.priority, task.due, task.estimated, task.completed,
                               task.remaining, retained=retained)
            alloc.in_progress = sum(s.end - s.start for s in self.sessions if s.task_id == task.id and s.type == 'work'
                                    and s.change in {'retained', 'truncated'} and s.start < self.now)
            self.allocations[task.id] = alloc
            if retained > task.remaining:
                alloc.over_allocated = retained - task.remaining
                self.add_reason(task.id, 'over_allocated', f'Locked, manual or in-progress sessions already hold '
                                f'{alloc.over_allocated} minutes more than the remaining work.')
                self.conflicts.append(Conflict('over_allocated', f'"{task.title}": retained sessions exceed its remaining '
                                               f'work by {alloc.over_allocated} minutes. They were not moved or shortened.',
                                               [{'kind': 'task', 'id': task.id, 'title': task.title}]))
            need[task.id] = max(0, task.remaining - retained)

        if self.mode == 'repair':
            self._keep_flexible(need)
        else:
            for item in self.flexible:
                self.removals.append(Removal(item, 'Replaced by the new schedule.'))
        order = self.ordered(need)
        self.rank = {t.id: i for i, t in enumerate(order)}
        for task in order:
            self._allocate_task(task, need)
        for tid in self.cyclic:
            self.pending[tid] = need[tid] > 0
        if self.displace:
            self._displace(order, need)
        self._materialise_breaks()

        for task in self.open_tasks:
            alloc = self.allocations[task.id]
            alloc.new = sum(s.end - s.start for s in self.sessions
                            if s.task_id == task.id and s.type == 'work' and s.change == 'new')
            kept = sum(s.end - s.start for s in self.sessions
                       if s.task_id == task.id and s.type == 'work' and s.change == 'kept')
            alloc.retained = self.retained_minutes(task.id) + kept
            alloc.unallocated = 0 if alloc.over_allocated else task.remaining - alloc.retained - alloc.new
            if alloc.unallocated < 0:
                raise RuntimeError(f'Duration conservation violated for task {task.id}.')
            if alloc.unallocated and task.id in self.displaced_by:
                self.add_reason(task.id, 'displaced_by_priority',
                                f'Some of its time went to higher-priority "{self.displaced_by[task.id]}". '
                                'The task itself was kept.')
            if alloc.unallocated:
                self.explanations.append(f'{task.title}: {alloc.unallocated} min unallocated '
                                         f'({", ".join(r.code for r in alloc.reasons) or "unknown"}).')
        self.sessions.sort(key=lambda s: (s.start, s.end, 0 if s.type == 'work' else 1, s.task_id or ''))
        return EngineResult(self.start, self.window_end, self.sessions, self.removals,
                            [self.allocations[t.id] for t in self.open_tasks], self.conflicts,
                            [t.id for t in order], self.explanations)

    def _bounds(self, task: EngineTask) -> tuple[int, int]:
        lo = max(self.start, task.earliest or self.start, self.not_before.get(task.id, self.start))
        return lo, min(task.due, self.window_end)

    def _window(self, task: EngineTask) -> tuple[int, int] | None:
        if task.due <= self.now:
            self.add_reason(task.id, 'deadline_passed', 'The deadline has passed; no new work is placed after it.')
            return None
        lo, hi = self._bounds(task)
        for dep in task.depends_on:
            dep_task = self.task_by_id.get(dep)
            if dep_task is None or dep_task.done:
                continue
            if self.pending.get(dep, False):
                self.add_reason(task.id, 'dependency_unallocated',
                                f'It depends on "{dep_task.title}", which could not be fully scheduled first.')
                return None
            ends = [s.end for s in self.sessions if s.task_id == dep and s.type == 'work']
            if ends:
                lo = max(lo, max(ends))
        if lo >= hi:
            self.add_reason(task.id, 'invalid_time_window',
                            'This task cannot be scheduled because its earliest allowed start time is at or after its '
                            'deadline or the planning window end.')
            return None
        return lo, hi

    def _settings_conflict(self, task: EngineTask):
        self.add_reason(task.id, 'unsplit_exceeds_focus_limit',
                        f'Splitting is off and {task.remaining} minutes exceeds your {self.prefs.focus}-minute '
                        'focus limit. Allow splitting or raise the limit.')
        self.add_conflict(Conflict(
            'settings_conflict',
            f'"{task.title}" is {task.remaining} minutes in one piece, but your focus limit is {self.prefs.focus} '
            'minutes of continuous work. Nothing was changed; choose how to handle it.',
            [{'kind': 'task', 'id': task.id, 'title': task.title}],
            choices=[
                {'id': 'allow_split', 'label': f'Allow splitting "{task.title}" into sessions of up to {self.prefs.focus} min'},
                {'id': 'raise_focus_limit', 'label': f'Raise the focus limit to {min(240, task.remaining)} min in Settings'},
                {'id': 'make_flexible_event', 'label': f'Treat "{task.title}" as an event (not counted as focus work)'},
            ]))

    def _allocate_task(self, task: EngineTask, need: dict[str, int]):
        alloc = self.allocations[task.id]
        if task.id in self.cyclic or alloc.over_allocated:
            self.pending[task.id] = need[task.id] - self.allocated(task.id) > 0
            return
        window = self._window(task)
        for session in [s for s in self.sessions if s.task_id == task.id and s.change == 'kept']:
            if window is None or session.start < window[0]:
                self.remove_session(session)
                original = next(f for f in self.flexible if f.id == session.id)
                self.removals.append(Removal(original, 'It would start before its dependency finishes or after the deadline.'))
        missing = need[task.id] - self.allocated(task.id)
        notes: set[str] = set()
        if missing > 0 and not task.allow_split:
            if self.retained_minutes(task.id) or self.allocated(task.id):
                self.add_reason(task.id, 'unsplit_has_sessions', 'Splitting is off, but part of this task already has a session.')
                window = None
            elif task.is_work and task.remaining > self.prefs.focus:
                self._settings_conflict(task)
                window = None
            elif task.is_work and task.remaining > self.prefs.max_daily:
                self.add_reason(task.id, 'unsplit_exceeds_daily_limit',
                                f'Splitting is off and {task.remaining} minutes exceeds your daily work limit.')
                window = None
        if missing > 0 and window:
            self.sessions.extend(self.place(task, missing, window[0], window[1], notes))
        short = need[task.id] - self.allocated(task.id)
        if short > 0 and window:
            self._explain_short(task, short, notes)
        elif short <= 0:
            alloc.reasons = [r for r in alloc.reasons if r.code not in {
                'insufficient_capacity', 'daily_limit', 'no_contiguous_slot', 'beyond_planning_window'}]
        self.pending[task.id] = short > 0

    def _explain_short(self, task: EngineTask, short: int, notes: set[str]):
        alloc = self.allocations[task.id]
        alloc.reasons = [r for r in alloc.reasons if r.code not in {
            'insufficient_capacity', 'daily_limit', 'no_contiguous_slot', 'beyond_planning_window'}]
        where = 'in its allowed times' if task.windows else 'in your available hours'
        if not task.allow_split:
            limits = ' within your focus and daily limits' if task.is_work else ''
            self.add_reason(task.id, 'no_contiguous_slot', f'It needs one uninterrupted block of {short} minutes and no '
                            f'block that long was left {where} before the deadline{limits}, after events and '
                            'higher-priority work.')
        if 'daily_limit' in notes:
            self.add_reason(task.id, 'daily_limit', f'Your daily task-work limit ({self.prefs.max_daily} min) was reached '
                            'on available days before the deadline.')
        if task.due > self.window_end:
            self.add_reason(task.id, 'beyond_planning_window', 'The deadline is after the planning window, so the rest can '
                            'be planned later; extend the window to plan it now.')
        elif task.allow_split:
            self.add_reason(task.id, 'insufficient_capacity', f'{short} minutes did not fit in the free time {where} before '
                            'the deadline after events, breaks, limits and higher-priority work.')

    # -- repair

    def _keep_flexible(self, need: dict[str, int]):
        kept_by_task: dict[str, int] = {}
        for item in self.flexible:
            task = self.task_by_id.get(item.task_id or '')
            reason = None
            if task is None:
                reason = 'Its task no longer exists.'
            elif task.done:
                reason = 'Its task is complete.'
            elif kept_by_task.get(task.id, 0) + item.end - item.start > need.get(task.id, 0):
                reason = 'The task needs fewer minutes now.'
            elif item.end > task.due:
                reason = 'It now ends after the task deadline.'
            elif item.start < max(task.earliest or item.start, self.not_before.get(task.id, item.start)):
                reason = 'It starts before the task may begin.'
            elif item.start < self.start:
                reason = 'It starts in the past.'
            elif not task.allow_split and item.end - item.start != need.get(task.id, 0):
                reason = 'The unsplit task length changed.'
            else:
                clash = next((b for b in self.event_items if overlaps(b.start, b.end, item.start, item.end)), None)
                if clash:
                    reason = f'It overlaps "{clash.title}".'
                elif any(overlaps(s, e, item.start, item.end) for s, e in self.rest_items):
                    reason = 'It overlaps a protected break or lunch.'
                elif any(overlaps(w.start, w.end, item.start, item.end) for w in [*self.work, *self.flex]):
                    reason = 'It overlaps fixed work.'
                elif not any(s <= item.start and item.end <= e for s, e in self.allowed(task)):
                    reason = 'It is outside your available hours.' if not task.windows else 'It is outside its allowed times.'
                elif task.is_work and self.day_work(self.day(item.start)) + item.end - item.start > self.prefs.max_daily:
                    reason = 'It would exceed your daily work limit.'
                elif task.is_work and self.run_total(item.start, item.end) > self.prefs.focus:
                    reason = 'It would exceed your focus limit without a break.'
            if reason:
                self.removals.append(Removal(item, reason))
                continue
            placed = Placed(item.task_id, 'work', item.start, item.end, 'saved', False, 'auto', 'kept', id=item.id,
                            reason='Unaffected; kept as saved', title=item.title)
            self.sessions.append(placed)
            self._track(item.start, item.end, item.task_id, False, ref=placed)
            kept_by_task[task.id] = kept_by_task.get(task.id, 0) + item.end - item.start

    def _snapshot(self):
        return (list(self.work), list(self.flex), list(self.sessions), list(self.removals), dict(self.pending),
                {k: list(v.reasons) for k, v in self.allocations.items()}, list(self.conflicts), dict(self.displaced_by))

    def _restore(self, snap):
        work, flex, sessions, removals, pending, reasons, conflicts, displaced = snap
        self.work, self.flex, self.sessions = list(work), list(flex), list(sessions)
        self.removals, self.pending, self.conflicts = list(removals), dict(pending), list(conflicts)
        self.displaced_by = dict(displaced)
        for k, value in reasons.items():
            self.allocations[k].reasons = list(value)

    def _dependencies_hold(self) -> bool:
        for task in self.open_tasks:
            starts = [s.start for s in self.sessions if s.task_id == task.id and s.change in {'new', 'kept'}]
            if not starts:
                continue
            for dep in task.depends_on:
                ends = [s.end for s in self.sessions if s.task_id == dep and s.type == 'work']
                if ends and max(ends) > min(starts):
                    return False
        return True

    def score(self) -> tuple:
        """Lexicographic objective (higher is better). Per tier High, Medium, Low: the number of fully
        scheduled tasks; then which tasks are full, earliest deadline first (so an earlier deadline is
        never traded for a later one); then scheduled minutes (useful partial work)."""
        out: list = []
        for rank in (0, 1, 2):
            tier = sorted((t for t in self.open_tasks if PRIORITY_RANK.get(t.priority, 3) == rank
                           and self.need.get(t.id, 0) > 0), key=self.priority_key)
            full = tuple(int(self.short(t.id) == 0) for t in tier)
            out += [sum(full), full, sum(min(self.need[t.id], self.allocated(t.id)) for t in tier)]
        return tuple(out)

    def _displace(self, order: list[EngineTask], need: dict[str, int]):
        """Bounded local repair (see the module docstring). Never touches fixed or retained items."""
        attempts = 0
        for task in order:
            per_task = 0
            if task.id in self.cyclic or self.allocations[task.id].over_allocated or task.due <= self.now:
                continue
            while self.short(task.id) > 0 and per_task < MAX_REPAIR_ATTEMPTS_PER_TASK and attempts < MAX_REPAIR_ATTEMPTS:
                lo, hi = self._bounds(task)
                tier = PRIORITY_RANK.get(task.priority, 3)
                victims = sorted(
                    (s for s in self.sessions
                     if s.change in {'new', 'kept'} and s.type == 'work' and s.task_id != task.id
                     and s.task_id in self.task_by_id
                     and PRIORITY_RANK.get(self.task_by_id[s.task_id].priority, 3) >= tier
                     and s.task_id not in task.depends_on and overlaps(s.start, s.end, lo, hi)
                     and any(overlaps(s.start, s.end, a, b) for a, b in self.allowed(task))),
                    key=lambda s: (-PRIORITY_RANK.get(self.task_by_id[s.task_id].priority, 3),
                                   -self.task_by_id[s.task_id].due, -s.start, s.task_id or ''))
                if not victims:
                    break
                attempts += 1
                per_task += 1
                before_score, before_short = self.score(), self.short(task.id)
                snap = self._snapshot()
                removed: list[Placed] = []
                for victim in victims[:MAX_VICTIMS]:
                    self.remove_session(victim)
                    removed.append(victim)
                    self._allocate_task(task, need)
                    if self.short(task.id) < before_short:
                        break
                if self.short(task.id) >= before_short:
                    self._restore(snap)
                    break
                for victim_id in dict.fromkeys(v.task_id for v in removed):
                    self._allocate_task(self.task_by_id[victim_id], need)
                if self.score() <= before_score or not self._dependencies_hold():
                    self._restore(snap)
                    break
                for victim in removed:
                    if PRIORITY_RANK.get(self.task_by_id[victim.task_id].priority, 3) > tier:
                        self.displaced_by.setdefault(victim.task_id, task.title)
                    if victim.change == 'kept':
                        original = next(f for f in self.flexible if f.id == victim.id)
                        self.removals.append(Removal(original, f'Moved so "{task.title}" ({task.priority} priority) fits '
                                                     'before its deadline.'))

    def _detect_conflicts(self):
        fixed = [('event', b.id, b.title, b.start, b.end) for b in self.event_items]
        fixed += [('break' if s.type == 'break' else 'session', s.id, s.title or ('Break' if s.type == 'break' else 'Work'),
                   s.start, s.end) for s in self.sessions]
        fixed += [('lunch', None, 'Lunch', s, e) for s, e in self.lunch]
        fixed.sort(key=lambda x: (x[3], x[4], x[1] or ''))
        for i, a in enumerate(fixed):
            for b in fixed[i + 1:]:
                if b[3] >= a[4]:
                    break
                kinds = {a[0], b[0]}
                if kinds == {'event', 'lunch'}:
                    continue  # an event over lunch is the user's choice
                if kinds == {'event'} and not (str(a[1]).startswith('draft:') or str(b[1]).startswith('draft:')):
                    continue  # overlapping saved calendar events are not AutoPlan's to resolve
                if a[1] is None and b[1] is None and 'lunch' in kinds:
                    continue
                if 'break' in kinds and (a[1] is None or b[1] is None) and 'event' in kinds:
                    continue  # the requested break was already clipped and explained
                self.conflicts.append(Conflict(
                    'fixed_overlap', f'"{a[2]}" overlaps "{b[2]}" ({self.clock(max(a[3], b[3]))}). Neither was moved; '
                    'change one of them.',
                    [{'kind': x[0], 'id': x[1], 'title': x[2], 'start': x[3], 'end': x[4]} for x in (a, b)]))

    def _materialise_breaks(self):
        busy = self.busy()
        runs: list[list[int]] = []  # [start, end, total work]
        for s, e in sorted((w.start, w.end) for w in self.work):
            if runs and not is_rest_gap(runs[-1][1], s, busy, self.prefs.brk):
                runs[-1][1] = e
                runs[-1][2] += e - s
            else:
                runs.append([s, e, e - s])
        for (_a_start, a_end, a_total), (b_start, _b_end, b_total) in zip(runs, runs[1:]):
            if a_total + b_total <= self.prefs.focus:
                continue  # the gap is rest, but continuing would be legal without it
            if self.day(a_end) != self.day(b_start) or b_start <= self.now:
                continue
            if any(s >= a_end and e <= b_start and e - s >= self.prefs.brk for s, e in self.rest_items):
                continue  # lunch or a protected break already provides the rest
            free = subtract([(max(a_end, self.start), b_start)], [*busy, *self.rest_items])
            stretch = next(((s, e) for s, e in free if e - s >= self.prefs.brk), None)
            if stretch is None:
                continue
            start, end = stretch[0], stretch[0] + self.prefs.brk
            same = next((b for b in self.saved_breaks if (b.start, b.end) == (start, end)), None)
            if same:
                self.saved_breaks.remove(same)
                placed = self._retained(same, 'Unchanged break')
                placed.change = 'kept'
                self.sessions.append(placed)
            else:
                self.sessions.append(Placed(None, 'break', start, end, 'proposed', False, 'auto',
                                            'new', reason='Reserved break after reaching the focus limit', title='Break'))
        for item in self.saved_breaks:
            self.removals.append(Removal(item, 'Breaks are recalculated around the new schedule.'))
        self.saved_breaks = []


def plan_schedule(tasks: list[EngineTask], availability: Availability, prefs: Prefs, events: list[Busy],
                  existing: list[Existing], now: int, horizon_days: int = 7, mode: str = 'generate',
                  requested_break: tuple[int, int] | None = None,
                  not_before: dict[str, int] | None = None, displace: bool = True) -> EngineResult:
    if mode not in {'generate', 'repair'}:
        raise ValueError('mode must be generate or repair')
    if prefs.focus <= 0 or prefs.brk <= 0 or prefs.max_daily <= 0:
        raise ValueError('Focus, break and daily limits must be positive.')
    zone = ZoneInfo(availability.timeZone)
    planner = _Planner(tasks, availability, prefs, zone, events, existing, now, horizon_days, mode,
                       requested_break, not_before, displace)
    return planner.run()


def resolve_windows(windows, first_day: date, last_day: date, zone: ZoneInfo) -> tuple[tuple[int, int], ...]:
    """Recurring local windows ({weekdays, start, end}; empty weekdays = every day) as absolute intervals."""
    out = []
    day = first_day
    while day <= last_day:
        for w in windows:
            weekdays = w['weekdays'] if isinstance(w, dict) else w.weekdays
            start = w['start'] if isinstance(w, dict) else w.start
            end = w['end'] if isinstance(w, dict) else w.end
            if not weekdays or day.weekday() in weekdays:
                s, e = local_to_abs(day, start, zone), local_to_abs(day, end, zone)
                if e > s:
                    out.append((s, e))
        day += timedelta(days=1)
    return tuple(merge(out))


def fingerprint(payload: dict) -> str:
    return sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()
