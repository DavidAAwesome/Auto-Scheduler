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
    jwt_secret: str
    session_seconds: int
    cookie_secure: bool
    allowed_origins: tuple[str, ...]


@lru_cache
def get_settings() -> Settings:
    secret = os.getenv('JWT_SECRET', '')
    if len(secret) < 32 or secret.startswith('replace-'):
        raise RuntimeError('Set JWT_SECRET to a random secret of at least 32 characters.')
    uri = os.getenv('MONGODB_URI', '')
    if not uri:
        raise RuntimeError('Set MONGODB_URI before starting the API.')
    seconds = int(os.getenv('SESSION_SECONDS', '604800'))
    if not 60 <= seconds <= 2592000:
        raise RuntimeError('SESSION_SECONDS must be between 60 and 2592000.')
    origins = tuple(x.strip().rstrip('/') for x in os.getenv(
        'ALLOWED_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174'
    ).split(',') if x.strip())
    if not origins or '*' in origins:
        raise RuntimeError('ALLOWED_ORIGINS must contain explicit frontend origins.')
    return Settings(uri, os.getenv('DATABASE_NAME', 'auto_scheduler'), secret, seconds,
                    os.getenv('COOKIE_SECURE', 'false').lower() == 'true', origins)
