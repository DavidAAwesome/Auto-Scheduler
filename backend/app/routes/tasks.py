from datetime import datetime, timezone

from bson import ObjectId
from fastapi import APIRouter, HTTPException

from app.database import db
from app.models.task import TaskCreate, TaskUpdate, TaskResponse


router = APIRouter()

tasks_collection = db["tasks"]


def serialize_task(task):
    return {
        "id": str(task["_id"]),
        "title": task["title"],
        "description": task.get("description"),
        "priority": task["priority"],
        "status": task["status"],
        "due_date": task.get("due_date"),
        "estimated_duration": task["estimated_duration"],
        "created_at": task["created_at"],
        "updated_at": task["updated_at"],
    }


@router.post("/", response_model=TaskResponse)
def create_task(task: TaskCreate):
    now = datetime.now(timezone.utc)

    task_data = task.model_dump()
    task_data["created_at"] = now
    task_data["updated_at"] = now

    result = tasks_collection.insert_one(task_data)

    created_task = tasks_collection.find_one({"_id": result.inserted_id})

    return serialize_task(created_task)


@router.get("/", response_model=list[TaskResponse])
def get_tasks():
    tasks = tasks_collection.find()

    return [serialize_task(task) for task in tasks]


@router.get("/{task_id}", response_model=TaskResponse)
def get_task(task_id: str):
    if not ObjectId.is_valid(task_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid task ID"
        )

    task = tasks_collection.find_one({
        "_id": ObjectId(task_id)
    })

    if task is None:
        raise HTTPException(
            status_code=404,
            detail="Task not found"
        )

    return serialize_task(task)


@router.put("/{task_id}", response_model=TaskResponse)
def update_task(task_id: str, task: TaskUpdate):
    if not ObjectId.is_valid(task_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid task ID"
        )

    update_data = task.model_dump(exclude_unset=True)

    if not update_data:
        raise HTTPException(
            status_code=400,
            detail="No fields provided for update"
        )

    update_data["updated_at"] = datetime.now(timezone.utc)

    result = tasks_collection.update_one(
        {"_id": ObjectId(task_id)},
        {"$set": update_data}
    )

    if result.matched_count == 0:
        raise HTTPException(
            status_code=404,
            detail="Task not found"
        )

    updated_task = tasks_collection.find_one({
        "_id": ObjectId(task_id)
    })

    return serialize_task(updated_task)


@router.delete("/{task_id}")
def delete_task(task_id: str):
    if not ObjectId.is_valid(task_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid task ID"
        )

    result = tasks_collection.delete_one({
        "_id": ObjectId(task_id)
    })

    if result.deleted_count == 0:
        raise HTTPException(
            status_code=404,
            detail="Task not found"
        )

    return {
        "message": "Task deleted successfully"
    }