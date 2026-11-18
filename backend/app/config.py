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
    openai_api_key: str
    openai_model: str
    # Sign-up codes are emailed over SMTP (e.g. Gmail with an App Password). No host = email is not set up.
    smtp_host: str = ''
    smtp_port: int = 587
    smtp_username: str = ''
    smtp_password: str = ''
    smtp_from: str = ''
    # Development only: print sign-up codes to the server log instead of failing when SMTP isn't set up.
    email_codes_to_log: bool = False
    # Second model pass that checks the assistant's free-text replies before they are shown.
    assistant_self_review: bool = True


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
    # Named arguments, so adding a setting can never shift the others out of place.
    return Settings(
        mongodb_uri=uri,
        database_name=os.getenv('DATABASE_NAME', 'auto_scheduler'),
        firebase_project_id=project_id,
        allowed_origins=origins,
        openai_api_key=os.getenv('OPENAI_API_KEY', '').strip(),
        openai_model=os.getenv('OPENAI_MODEL', 'gpt-4o-mini').strip() or 'gpt-4o-mini',
        smtp_host=os.getenv('SMTP_HOST', '').strip(),
        smtp_port=int(os.getenv('SMTP_PORT', '587').strip() or 587),
        smtp_username=os.getenv('SMTP_USERNAME', '').strip(),
        # Gmail shows App Passwords in groups of four; the spaces are not part of the password.
        smtp_password=os.getenv('SMTP_PASSWORD', '').replace(' ', ''),
        smtp_from=os.getenv('SMTP_FROM', '').strip(),
        email_codes_to_log=os.getenv('EMAIL_CODES_TO_LOG', '').strip().lower() in {'1', 'true', 'yes'},
        assistant_self_review=os.getenv('ASSISTANT_SELF_REVIEW', 'true').strip().lower() not in {'0', 'false', 'no', 'off'},
    )
