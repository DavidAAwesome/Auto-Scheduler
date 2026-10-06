import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / '.env')


@dataclass(frozen=True)
class Settings:
    mongodb_uri: str
    database_name: str
    firebase_project_id: str
    allowed_origins: tuple[str, ...]


@lru_cache
def get_settings() -> Settings:
    project_id = os.getenv('FIREBASE_PROJECT_ID', '').strip()
    if not project_id or project_id.startswith('replace-'):
        raise RuntimeError('Set FIREBASE_PROJECT_ID to the Firebase project used by the frontend.')
    uri = os.getenv('MONGODB_URI', '')
    if not uri:
        raise RuntimeError('Set MONGODB_URI before starting the API.')
    origins = tuple(x.strip().rstrip('/') for x in os.getenv(
        'ALLOWED_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174'
    ).split(',') if x.strip())
    if not origins or '*' in origins:
        raise RuntimeError('ALLOWED_ORIGINS must contain explicit frontend origins.')
    return Settings(uri, os.getenv('DATABASE_NAME', 'auto_scheduler'), project_id, origins)
