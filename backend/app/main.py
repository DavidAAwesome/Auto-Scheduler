from fastapi import FastAPI, Depends
from app.auth import get_current_user

app = FastAPI(
    title="Auto-Scheduler API",
    description="Backend API for the Auto-Scheduler application",
    version="1.0.0"
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


@app.get("/protected")
def protected_route(user=Depends(get_current_user)):
    return {
        "message": "You are authenticated!",
        "uid": user["uid"]
    }