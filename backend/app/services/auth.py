"""GitHub identity resolution (OAuth / PAT), user upsert and API-token issuance."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.logging_utils import log_event
from app.models import ApiToken, OAuthConnection, PlatformIntegration, User, UserSettings
from app.security import CredentialCipher, generate_api_token
from app.services.errors import SyncError, classify_network_error

logger = logging.getLogger("codesync.auth")

GITHUB_OAUTH_SCOPES = "repo read:user user:email"


class AuthError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


async def fetch_github_user(token: str, settings: Settings, transport=None) -> dict[str, Any]:
    """Validate a token against GitHub and return the authenticated user profile."""
    import httpx

    from app.services.github import GitHubClient

    client = GitHubClient(
        token=token,
        base_url=settings.github_api_base_url,
        timeout=settings.github_timeout_seconds,
        transport=transport,
    )
    try:
        return await client.get_authenticated_user()
    except SyncError as exc:
        raise AuthError("GITHUB_REJECTED", exc.message, 401) from exc
    except httpx.HTTPError as exc:  # pragma: no cover - defensive
        err = classify_network_error(exc)
        raise AuthError("GITHUB_UNAVAILABLE", err.message, 503) from exc
    finally:
        await client.aclose()


async def exchange_oauth_code(code: str, settings: Settings, transport=None) -> dict[str, Any]:
    """Exchange an OAuth authorization code for an access token."""
    import httpx

    try:
        async with httpx.AsyncClient(
            base_url=settings.github_oauth_base_url,
            timeout=settings.github_timeout_seconds,
            transport=transport,
            headers={"Accept": "application/json", "User-Agent": "CodeSync"},
        ) as client:
            resp = await client.post(
                "/login/oauth/access_token",
                data={
                    "client_id": settings.github_client_id,
                    "client_secret": settings.github_client_secret,
                    "code": code,
                },
            )
    except httpx.HTTPError as exc:
        err = classify_network_error(exc)
        raise AuthError("GITHUB_UNAVAILABLE", err.message, 503) from exc

    if resp.status_code >= 400:
        raise AuthError("OAUTH_EXCHANGE_FAILED", "GitHub rejected the authorization code.", 502)
    data = resp.json()
    if "error" in data:
        raise AuthError(
            "OAUTH_EXCHANGE_FAILED",
            str(data.get("error_description") or data.get("error"))[:300],
            400,
        )
    access_token = data.get("access_token")
    if not access_token:
        raise AuthError("OAUTH_EXCHANGE_FAILED", "No access token returned by GitHub.", 502)
    return {
        "access_token": access_token,
        "scope": str(data.get("scope") or ""),
        "token_type": str(data.get("token_type") or "bearer"),
    }


def authorize_url(settings: Settings, state: str) -> str:
    from urllib.parse import urlencode

    params = urlencode(
        {
            "client_id": settings.github_client_id,
            "redirect_uri": f"{settings.public_base_url.rstrip('/')}{settings.api_prefix}"
            "/auth/github/callback",
            "scope": GITHUB_OAUTH_SCOPES,
            "state": state,
            "allow_signup": "true",
        }
    )
    return f"{settings.github_oauth_base_url.rstrip('/')}/login/oauth/authorize?{params}"


def upsert_github_user(
    session: Session,
    profile: dict[str, Any],
    access_token: str,
    settings: Settings,
    scopes: str = "",
) -> User:
    """Create or update the local user + encrypted GitHub connection."""
    github_id = str(profile.get("id") or "") or None
    login = str(profile.get("login") or "").strip() or "unknown"
    email = profile.get("email")

    user: User | None = None
    if github_id:
        user = session.execute(select(User).where(User.github_id == github_id)).scalar_one_or_none()
    if user is None:
        user = session.execute(select(User).where(User.github_login == login)).scalar_one_or_none()

    if user is None:
        user = User(github_login=login, github_id=github_id, email=email)
        session.add(user)
        session.flush()
        session.add(UserSettings(user_id=user.id))
        for platform in ("leetcode", "geeksforgeeks", "codechef", "neetcode"):
            session.add(PlatformIntegration(user_id=user.id, platform=platform, enabled=True))
    else:
        user.github_login = login
        if github_id:
            user.github_id = github_id
        if email:
            user.email = email
        user.is_active = True

    cipher = CredentialCipher(settings.credentials_key)
    if not cipher.configured:
        raise AuthError(
            "CREDENTIALS_NOT_CONFIGURED",
            "CREDENTIALS_KEY is not set; cannot store GitHub credentials.",
            500,
        )

    conn = session.execute(
        select(OAuthConnection).where(
            OAuthConnection.user_id == user.id, OAuthConnection.provider == "github"
        )
    ).scalar_one_or_none()
    if conn is None:
        conn = OAuthConnection(user_id=user.id, provider="github", github_login=login)
        session.add(conn)
    conn.github_login = login
    conn.access_token_encrypted = cipher.encrypt(access_token)
    conn.scopes = scopes[:255]
    conn.revoked_at = None
    session.flush()
    return user


def issue_api_token(session: Session, user: User, name: str = "extension") -> str:
    """Create a new API token; returns the plaintext (only shown once)."""
    plaintext, token_hash = generate_api_token()
    session.add(ApiToken(user_id=user.id, token_hash=token_hash, name=name))
    session.flush()
    log_event(logger, "api_token_issued", user_id=user.id, name=name)
    return plaintext


def revoke_github_connection(session: Session, user_id: int) -> None:
    conn = session.execute(
        select(OAuthConnection).where(
            OAuthConnection.user_id == user_id, OAuthConnection.provider == "github"
        )
    ).scalar_one_or_none()
    if conn is not None and conn.revoked_at is None:
        conn.revoked_at = datetime.now(UTC)


def github_connection_active(session: Session, user_id: int) -> bool:
    conn = session.execute(
        select(OAuthConnection).where(
            OAuthConnection.user_id == user_id,
            OAuthConnection.provider == "github",
            OAuthConnection.revoked_at.is_(None),
        )
    ).scalar_one_or_none()
    return conn is not None


OAUTH_STATE_TTL = timedelta(minutes=10)


def store_oauth_state(store: dict, state_hash: str) -> None:
    now = datetime.now(UTC)
    expired = [k for k, v in store.items() if now - v > OAUTH_STATE_TTL]
    for k in expired:
        store.pop(k, None)
    store[state_hash] = now


def validate_oauth_state(store: dict, state_hash: str) -> bool:
    created = store.pop(state_hash, None)
    if created is None:
        return False
    return datetime.now(UTC) - created <= OAUTH_STATE_TTL
