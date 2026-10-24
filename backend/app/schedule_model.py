"""Canonical schedule format shared by the calendar, Today's Tasks, chat, preview and apply.

Every session (saved or proposed, work or break) has the same shape. Timestamps are UTC; `date`,
`start` and `end` are display fields in the schedule's timezone (minutes after local midnight).
A task's deadline (`dueAt`) is never a session date: work for a task due tomorrow can be today.
"""
from __future__ import annotations

from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

SessionType = Literal['work', 'break']
SessionStatus = Literal['proposed', 'saved', 'completed', 'cancelled']
SessionChange = Literal['retained', 'kept', 'new', 'truncated']


class LunchWindow(BaseModel):
    model_config = ConfigDict(extra='forbid')
    start: int = Field(strict=True, ge=0, le=1435)
    end: int = Field(strict=True, ge=5, le=1440)

    @model_validator(mode='after')
    def ordered(self):
        if self.end <= self.start:
            raise ValueError('Lunch must end after it starts.')
        return self


class SchedulePreferences(BaseModel):
    """Editable product defaults for pacing work; not medical advice."""
    model_config = ConfigDict(extra='forbid')
    focusMinutes: int = Field(default=50, strict=True, ge=10, le=240)
    breakMinutes: int = Field(default=10, strict=True, ge=5, le=120)
    maxDailyWorkMinutes: int = Field(default=240, strict=True, ge=15, le=1440)
    lunch: LunchWindow | None = None


class ScheduleSession(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str
    taskId: str | None  # parent task; null for breaks
    title: str
    type: SessionType
    status: SessionStatus
    locked: bool
    source: Literal['manual', 'auto']
    scheduleVersion: int
    startAt: AwareDatetime
    endAt: AwareDatetime
    date: str
    start: int
    end: int
    change: SessionChange | None = None  # previews only
    reason: str | None = None


class AllocationReason(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: str
    message: str


class TaskAllocation(BaseModel):
    """Per-task accounting. Invariant: retained + new + unallocated == remaining + overAllocated."""
    model_config = ConfigDict(extra='forbid')
    taskId: str
    title: str
    priority: str
    dueAt: AwareDatetime
    estimatedMinutes: int
    completedMinutes: int
    remainingMinutes: int  # estimated - completed; the workload being planned
    retainedMinutes: int  # locked, manual, in-progress and (in repair) kept saved sessions
    inProgressMinutes: int  # part of retainedMinutes that belongs to a session already under way
    newMinutes: int
    unallocatedMinutes: int
    overAllocatedMinutes: int
    atRisk: bool
    slackMinutes: int | None
    status: Literal['scheduled', 'partial', 'unscheduled', 'complete']
    reasons: list[AllocationReason]


class ConflictItem(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: str
    id: str | None = None
    title: str
    startAt: AwareDatetime | None = None
    endAt: AwareDatetime | None = None


class ScheduleConflict(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: str
    message: str
    items: list[ConflictItem]


class SessionRemoval(BaseModel):
    """A saved session the preview deletes (or shortens, when newEndAt is set) on Apply."""
    model_config = ConfigDict(extra='forbid')
    session: ScheduleSession
    reason: str
    newEndAt: AwareDatetime | None = None


class DaySummary(BaseModel):
    model_config = ConfigDict(extra='forbid')
    date: str
    workMinutes: int
    newWorkMinutes: int
    breakCount: int
    sessionCount: int


class SchedulePreview(BaseModel):
    model_config = ConfigDict(extra='forbid')
    previewId: str
    status: Literal['proposed', 'applied']
    mode: Literal['generate', 'repair', 'break']
    baseScheduleVersion: int
    generatedAt: AwareDatetime
    timeZone: str
    windowStart: AwareDatetime
    windowEnd: AwareDatetime
    startDate: str
    endDate: str
    preferences: SchedulePreferences
    sessions: list[ScheduleSession]  # complete future schedule in the window after Apply
    removed: list[SessionRemoval]
    tasks: list[TaskAllocation]
    conflicts: list[ScheduleConflict]
    days: list[DaySummary]
    firstProposedDate: str | None
    explanations: list[str]
    note: str
    inputFingerprint: str


class SavedSchedule(BaseModel):
    model_config = ConfigDict(extra='forbid')
    scheduleVersion: int
    timeZone: str
    sessions: list[ScheduleSession]
