"""Email verification before sign-up: a 6-digit code, valid 5 minutes, must be entered before an account is made.

Flow: POST /auth/signup-code emails a code -> POST /auth/signup-code/verify checks it and marks the address verified
for 30 minutes -> the browser creates the Firebase account -> the first /auth/me creates the AutoPlan user only for a
verified address (see auth.sync_user). Codes are stored hashed and removed once used.
"""
import hashlib
import hmac
import logging
import re
import secrets
import smtplib
import ssl
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import certifi
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.config import get_settings
from app.database import get_database

router = APIRouter(prefix='/auth/signup-code', tags=['auth'])
log = logging.getLogger('autoplan.signup')

CODE_LENGTH = 6
CODE_LIFETIME = timedelta(minutes=5)
RESEND_AFTER = timedelta(seconds=60)
MAX_SENDS_PER_HOUR = 5
MAX_WRONG_ATTEMPTS = 5
# After a correct code, how long the browser has to finish creating the account.
VERIFIED_FOR = timedelta(minutes=30)
EMAIL_PATTERN = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


class CodeRequest(BaseModel):
    email: str = Field(max_length=254)

    @field_validator('email')
    @classmethod
    def valid_email(cls, value):
        value = value.strip().lower()
        if not EMAIL_PATTERN.match(value):
            raise ValueError('Enter a valid email address.')
        return value


class CodeCheck(CodeRequest):
    code: str = Field(max_length=20)


class CodeSent(BaseModel):
    email: str
    expiresInSeconds: int
    resendInSeconds: int


def now():
    return datetime.now(timezone.utc)


def aware(value):
    """MongoDB may hand back naive UTC datetimes; compare them as UTC."""
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def hash_code(code: str, salt: str) -> str:
    return hashlib.sha256(f'{salt}:{code}'.encode()).hexdigest()


def is_verified(db, email: str) -> bool:
    """True when this address entered a correct code recently enough to finish signing up."""
    record = db.verified_emails.find_one({'email': (email or '').strip().lower()})
    return bool(record and aware(record['expires_at']) > now())


def send_code_email(email: str, code: str):
    settings = get_settings()
    if not settings.smtp_host:
        if settings.email_codes_to_log:
            log.warning('EMAIL_CODES_TO_LOG is on: sign-up code for %s is %s', email, code)
            return
        raise HTTPException(status_code=503, detail='Email sending is not set up on the server yet, so a code cannot be sent.')
    message = EmailMessage()
    message['Subject'] = f'Your AutoPlan code: {code}'
    message['From'] = settings.smtp_from or settings.smtp_username
    message['To'] = email
    message.set_content(
        f'Your AutoPlan verification code is {code}.\n\n'
        'It expires in 5 minutes. If you did not try to create an AutoPlan account, you can ignore this email.\n')
    message.add_alternative(
        '<div style="font-family:Arial,sans-serif;color:#25283c">'
        '<p>Your AutoPlan verification code is:</p>'
        f'<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">{code}</p>'
        '<p>It expires in <b>5 minutes</b>. If you did not try to create an AutoPlan account, you can ignore this email.</p>'
        '</div>', subtype='html')
    try:
        context = ssl.create_default_context(cafile=certifi.where())
        if settings.smtp_port == 465:
            with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=15, context=context) as smtp:
                smtp.login(settings.smtp_username, settings.smtp_password)
                smtp.send_message(message)
        else:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as smtp:
                smtp.starttls(context=context)
                smtp.login(settings.smtp_username, settings.smtp_password)
                smtp.send_message(message)
    except (smtplib.SMTPException, OSError) as error:
        log.error('Could not send the sign-up code email: %s', error)
        raise HTTPException(status_code=502, detail='The verification email could not be sent. Try again in a moment.') from None


@router.post('', response_model=CodeSent, status_code=201)
def send_code(data: CodeRequest, db=Depends(get_database)):
    email = data.email
    if db.users.find_one({'email': email}, {'_id': 1}):
        raise HTTPException(status_code=409, detail='An account with this email already exists. Sign in instead.')
    current = now()
    previous = db.signup_codes.find_one({'email': email})
    window_start, sends = current, 0
    if previous:
        wait = aware(previous['sent_at']) + RESEND_AFTER - current
        if wait.total_seconds() > 0:
            raise HTTPException(status_code=429, detail=f'Wait {int(wait.total_seconds()) + 1} seconds before asking for another code.')
        if current - aware(previous['window_start']) < timedelta(hours=1):
            window_start, sends = aware(previous['window_start']), previous.get('sends', 1)
        if sends >= MAX_SENDS_PER_HOUR:
            raise HTTPException(status_code=429, detail='Too many codes were requested for this email. Try again in an hour.')
    code = f'{secrets.randbelow(10 ** CODE_LENGTH):0{CODE_LENGTH}d}'
    salt = secrets.token_hex(16)
    send_code_email(email, code)
    db.signup_codes.update_one({'email': email}, {'$set': {
        'email': email, 'code_hash': hash_code(code, salt), 'salt': salt, 'attempts': 0,
        'sent_at': current, 'expires_at': current + CODE_LIFETIME, 'window_start': window_start, 'sends': sends + 1,
    }}, upsert=True)
    return CodeSent(email=email, expiresInSeconds=int(CODE_LIFETIME.total_seconds()),
                    resendInSeconds=int(RESEND_AFTER.total_seconds()))


@router.post('/verify')
def verify_code(data: CodeCheck, db=Depends(get_database)):
    email, code = data.email, re.sub(r'\D', '', data.code)
    record = db.signup_codes.find_one({'email': email})
    if not record or not record.get('code_hash'):
        raise HTTPException(status_code=400, detail='Request a code for this email first.')
    if aware(record['expires_at']) <= now():
        raise HTTPException(status_code=410, detail='This code has expired. Request a new one.')
    attempts = record.get('attempts', 0)
    if attempts >= MAX_WRONG_ATTEMPTS:
        raise HTTPException(status_code=429, detail='Too many wrong codes. Request a new one.')
    if len(code) != CODE_LENGTH or not hmac.compare_digest(hash_code(code, record['salt']), record['code_hash']):
        attempts += 1
        db.signup_codes.update_one({'_id': record['_id']}, {'$set': {'attempts': attempts}})
        left = MAX_WRONG_ATTEMPTS - attempts
        if not left:
            raise HTTPException(status_code=429, detail='Too many wrong codes. Request a new one.')
        raise HTTPException(status_code=400, detail=f'That code is not right. {left} {"try" if left == 1 else "tries"} left.')
    # Used up: keep only the send history (for the hourly limit), never the code.
    db.signup_codes.update_one({'_id': record['_id']}, {'$set': {'code_hash': None, 'salt': None, 'expires_at': now()}})
    db.verified_emails.update_one({'email': email}, {'$set': {
        'email': email, 'verified_at': now(), 'expires_at': now() + VERIFIED_FOR}}, upsert=True)
    return {'verified': True, 'email': email}
