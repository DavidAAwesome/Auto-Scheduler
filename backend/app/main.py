from fastapi import FastAPI

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