from fastapi import FastAPI

from app.routes.tasks import router as task_router


app = FastAPI(
    title="Auto-Scheduler API",
    description="Backend API for the Auto-Scheduler application",
    version="1.0.0"
)


app.include_router(
    task_router,
    prefix="/api/tasks",
    tags=["Tasks"]
)


@app.get("/")
def root():
    return {
        "message": "Auto-Scheduler API is running"
    }


@app.get("/health")
def health_check():
    return {
        "status": "healthy"
    }