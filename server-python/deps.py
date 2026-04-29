import os
from fastapi import Header, HTTPException
from jose import jwt, JWTError

SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")


def get_current_user(authorization: str = Header(default=None)) -> dict:
    """FastAPI dependency — validates Bearer JWT and returns the payload dict."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    try:
        payload = jwt.decode(authorization[7:], SECRET, algorithms=["HS256"])
        return payload  # {"id": int, "email": str}
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
