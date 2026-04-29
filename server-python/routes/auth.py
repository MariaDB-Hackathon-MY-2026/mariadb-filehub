import os
import random
import string
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException
from jose import jwt
from passlib.context import CryptContext
from pydantic import BaseModel

from db import query
from mailer import send_otp

router = APIRouter()
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")


def make_token(user_id: int, email: str) -> str:
    payload = {
        "id": user_id,
        "email": email,
        "exp": datetime.utcnow() + timedelta(days=7),
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


# ── Schemas ────────────────────────────────────────────────────────────────────

class RegisterIn(BaseModel):
    username: str
    email: str
    password: str

class LoginIn(BaseModel):
    email: str
    password: str

class ForgotIn(BaseModel):
    email: str

class ResetIn(BaseModel):
    email: str
    otp: str
    password: str


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.post("/register", status_code=201)
def register(body: RegisterIn):
    if len(body.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    existing = query("SELECT id FROM users WHERE email = ?", (body.email,))
    if existing:
        raise HTTPException(409, "Email already registered")
    hashed = pwd.hash(body.password)
    result = query(
        "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
        (body.username.strip(), body.email.strip().lower(), hashed),
    )
    user = {"id": result["insert_id"], "username": body.username, "email": body.email}
    return {"token": make_token(user["id"], user["email"]), "user": user}


@router.post("/login")
def login(body: LoginIn):
    rows = query("SELECT * FROM users WHERE email = ?", (body.email.strip().lower(),))
    if not rows or not pwd.verify(body.password, rows[0]["password_hash"]):
        raise HTTPException(401, "Invalid email or password")
    u = rows[0]
    user = {"id": u["id"], "username": u["username"], "email": u["email"]}
    return {"token": make_token(u["id"], u["email"]), "user": user}


@router.post("/forgot-password")
def forgot_password(body: ForgotIn):
    rows = query("SELECT id FROM users WHERE email = ?", (body.email.strip().lower(),))
    if not rows:
        # Don't reveal whether the email exists
        return {"message": "If that email is registered you will receive a code shortly"}
    otp = "".join(random.choices(string.digits, k=6))
    expires = datetime.utcnow() + timedelta(minutes=15)
    query(
        "INSERT INTO password_resets (email, otp, expires_at) VALUES (?, ?, ?) "
        "ON DUPLICATE KEY UPDATE otp = VALUES(otp), expires_at = VALUES(expires_at), used = 0",
        (body.email, otp, expires),
    )
    send_otp(body.email, otp)
    return {"message": "Reset code sent"}


@router.post("/reset-password")
def reset_password(body: ResetIn):
    rows = query(
        "SELECT * FROM password_resets WHERE email = ? AND otp = ? AND used = 0 AND expires_at > NOW()",
        (body.email, body.otp),
    )
    if not rows:
        raise HTTPException(400, "Invalid or expired code")
    if len(body.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    hashed = pwd.hash(body.password)
    query("UPDATE users SET password_hash = ? WHERE email = ?", (hashed, body.email))
    query("UPDATE password_resets SET used = 1 WHERE email = ?", (body.email,))
    return {"message": "Password reset successfully"}
