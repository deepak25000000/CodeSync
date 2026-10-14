"""Shared FastAPI dependencies: DB session, auth, rate limiting, scheduler access."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import Database
from app.models import ApiToken, User
from app.security import hash_api_token
from app.services.sync_worker import SyncScheduler

BROWSER_ID_RE = None  # reserved


def get_database(request: Request) -> Database:
    return request.app.state.db


def get_db_session(request: Request) -> Iterator[Session]:
    db: Database = request.app.state.db
    session = db.session_factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_scheduler(request: Request) -> SyncScheduler:
    return request.app.state.sync_scheduler


def get_app_settings(request: Request) -> Settings:
    """Settings bound to this app instance (test/app factories override them)."""
    return request.app.state.settings


def get_github_transport(request: Request):  # pragma: no cover - typing helper
    return getattr(request.app.state, "github_transport", None)


def _unauthenticated(detail: str, code: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": code, "message": detail},
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(
    request: Request,
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> User:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise _unauthenticated("Missing bearer token.", "AUTH_REQUIRED")
    token = auth[len("Bearer ") :].strip()
    if not token:
        raise _unauthenticated("Missing bearer token.", "AUTH_REQUIRED")
    token_hash = hash_api_token(token)
    row = session.execute(
        select(ApiToken).where(ApiToken.token_hash == token_hash, ApiToken.revoked_at.is_(None))
    ).scalar_one_or_none()
    if row is None:
        raise _unauthenticated("Invalid or revoked API token.", "AUTH_INVALID")
    user = session.get(User, row.user_id)
    if user is None or not user.is_active:
        raise _unauthenticated("Account is inactive.", "AUTH_INVALID")
    row.last_used_at = datetime.now(UTC)

    # Rate limit keyed by token hash (or client IP when no token was sent).
    if settings.rate_limit_enabled:
        limiter = request.app.state.rate_limiter
        allowed, remaining, retry_after = limiter.check(token_hash)
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={
                    "code": "RATE_LIMITED",
                    "message": "Too many requests; slow down.",
                    "retry_after": round(retry_after, 2),
                },
                headers={"Retry-After": str(int(retry_after) + 1), "X-RateLimit-Remaining": "0"},
            )
        request.state.rate_remaining = remaining
    return user


def require_settings(request: Request) -> Settings:
    return request.app.state.settings
