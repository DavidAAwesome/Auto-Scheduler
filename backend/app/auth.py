from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from firebase_admin import auth

security = HTTPBearer()


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    token = credentials.credentials

    try:
        decoded_token = auth.verify_id_token(token)

        return decoded_token

    except Exception:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired authentication token"
        )