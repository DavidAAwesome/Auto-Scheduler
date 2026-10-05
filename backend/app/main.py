from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from pymongo.errors import PyMongoError

from app.auth import get_current_user, router
from app.config import get_settings
from app.database import connect_database, initialize_indexes
from app.workspace import router as workspace_router


def create_app(database=None):
    @asynccontextmanager
    async def lifespan(app):
        get_settings()  # Fail startup clearly on missing or unsafe configuration.
        client = None
        try:
            if database is None:
                client, db = connect_database()
            else:
                db = database
            initialize_indexes(db)
            app.state.db = db
            yield
        finally:
            if client is not None:
                client.close()

    app = FastAPI(title='AutoPlan API', version='1.0.0', lifespan=lifespan)
    # Read origin list without requiring database credentials at module import.
    import os
    origins = [x.strip().rstrip('/') for x in os.getenv('ALLOWED_ORIGINS',
        'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174').split(',') if x.strip()]

    @app.middleware('http')
    async def check_origin(request: Request, call_next):
        # SameSite is defense-in-depth; enforce Origin for browser mutations.
        if request.method in {'POST', 'PUT', 'PATCH', 'DELETE'}:
            origin = request.headers.get('origin')
            if (origin and origin not in origins) or (not origin and request.headers.get('sec-fetch-site') == 'cross-site'):
                return JSONResponse(status_code=403, content={'detail': 'Request origin is not allowed.'})
        response = await call_next(request)
        if request.url.path.startswith(('/auth', '/tasks', '/availability', '/protected')):
            response.headers['Cache-Control'] = 'no-store'
        return response

    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True,
                       allow_methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
                       allow_headers=['Content-Type', 'Authorization'])

    @app.exception_handler(PyMongoError)
    async def database_error(request: Request, exc: PyMongoError):
        return JSONResponse(status_code=503, content={'detail': 'Database is unavailable. Please try again later.'})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        return JSONResponse(status_code=422, content={'detail': [
            {'loc': list(error['loc']), 'msg': error['msg'], 'type': error['type']}
            for error in exc.errors()
        ]})

    app.include_router(router)
    app.include_router(workspace_router)

    @app.get('/')
    def root():
        return {'message': 'AutoPlan API is running'}

    @app.get('/health')
    def health():
        return {'status': 'healthy'}

    @app.get('/protected')
    def protected(user=Depends(get_current_user)):
        return {'message': 'You are authenticated!', 'uid': str(user['_id'])}

    return app


app = create_app()
