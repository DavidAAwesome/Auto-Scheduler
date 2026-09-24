from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class TaskCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    priority: str = "medium"
    status: str = "pending"
    due_date: Optional[datetime] = None
    estimated_duration: int = Field(..., gt=0)


class TaskUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    due_date: Optional[datetime] = None
    estimated_duration: Optional[int] = Field(None, gt=0)


class TaskResponse(BaseModel):
    id: str
    title: str
    description: Optional[str] = None
    priority: str
    status: str
    due_date: Optional[datetime] = None
    estimated_duration: int
    created_at: datetime
    updated_at: datetime